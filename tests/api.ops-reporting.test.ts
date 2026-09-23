import { afterEach, describe, expect, it } from "vitest"
import { GET as workflowGet, POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import { GET as courtOpsGet, POST as courtOpsPost } from "@/app/api/d2/court-ops/route"
import { GET as opsReportingGet, POST as opsReportingPost } from "@/app/api/d2/ops-reporting/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function postWorkflow(body: unknown, key: string) {
  return workflowPost(
    new Request("http://127.0.0.1/api/d1/document-workflow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    })
  )
}

function postCourtOps(body: unknown, key: string) {
  return courtOpsPost(
    new Request("http://127.0.0.1/api/d2/court-ops", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    })
  )
}

function getOpsReport(params: URLSearchParams) {
  return opsReportingGet(new Request(`http://127.0.0.1/api/d2/ops-reporting?${params.toString()}`))
}

function postOpsReport(body: unknown, key: string) {
  return opsReportingPost(
    new Request("http://127.0.0.1/api/d2/ops-reporting", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    })
  )
}

function seedOpsMatter(classification: "internal" | "privileged" = "internal") {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Ops reporting matter",
    courtId: "SHC",
    classification,
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  addMember(store, matter.id, "clerk_a", "firmA")
  return matter.id
}

describe("GET /api/d2/ops-reporting", () => {
  it("returns persisted workflow + court-ops activity rows with filters and pagination", async () => {
    const matterId = seedOpsMatter("internal")
    const doc = uploadDocument(getRuntimeStore(), {
      firmId: "firmA",
      matterId,
      bytes: Buffer.from("%PDF-ops-report%"),
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "00a2157a-9f8c-4c4a-847f-772d8cbc2e5e",
    })
    recordCaseNumber(getRuntimeStore(), matterId, "CP 1234", "SHC")

    const workflowTransition = await postWorkflow(
      {
        action: "transition",
        actorId: "associate_a",
        documentId: doc.docId,
        nextStatus: "processing",
      },
      "93e2b34e-48f3-4b17-a52b-c931fc7cdde8"
    )
    expect(workflowTransition.status).toBe(200)

    const queue = await courtOpsGet(
      new Request(`http://127.0.0.1/api/d2/court-ops?userId=associate_a&matterId=${matterId}&limit=10&cursor=0`)
    )
    expect(queue.status).toBe(200)
    const queueJson = (await queue.json()) as { items: Array<{ queueType: string; id: string }> }
    const followUp = queueJson.items.find((row) => row.queueType === "follow_up")
    if (!followUp) throw new Error("expected follow_up queue item")

    const resolved = await postCourtOps(
      {
        action: "resolve_follow_up",
        actorId: "partner_a",
        followUpId: followUp.id,
        reason: "resolved in ops reporting test",
      },
      "76ea6d1a-b9dc-4358-885c-b8f2d2e9cb4a"
    )
    expect(resolved.status).toBe(200)

    const firstPage = await getOpsReport(
      new URLSearchParams({
        actorId: "associate_a",
        matterId,
        limit: "1",
        cursor: "0",
      })
    )
    expect(firstPage.status).toBe(200)
    const firstJson = (await firstPage.json()) as {
      items: Array<{ source: string; action: string }>
      total: number
      nextCursor: string | null
    }
    expect(firstJson.total).toBeGreaterThanOrEqual(2)
    expect(firstJson.items).toHaveLength(1)
    expect(firstJson.nextCursor).toBe("1")

    const filtered = await getOpsReport(
      new URLSearchParams({
        actorId: "associate_a",
        source: "court_ops",
        action: "court_ops_resolve_follow_up",
        q: "resolved",
        limit: "10",
        cursor: "0",
      })
    )
    expect(filtered.status).toBe(200)
    const filteredJson = (await filtered.json()) as {
      items: Array<{ source: string; action: string }>
    }
    expect(
      filteredJson.items.some(
        (row) => row.source === "court_ops" && row.action === "court_ops_resolve_follow_up"
      )
    ).toBe(true)

    const workflowFiltered = await getOpsReport(
      new URLSearchParams({
        actorId: "associate_a",
        source: "workflow_event",
        action: "workflow_transition",
        status: "processing",
        limit: "10",
        cursor: "0",
      })
    )
    expect(workflowFiltered.status).toBe(200)
    const workflowFilteredJson = (await workflowFiltered.json()) as {
      items: Array<{ source: string; action: string; status: string | null }>
    }
    expect(
      workflowFilteredJson.items.some(
        (row) =>
          row.source === "workflow_event" &&
          row.action === "workflow_transition" &&
          row.status === "processing"
      )
    ).toBe(true)
  })

  it("enforces actor role and clearance boundaries", async () => {
    const matterId = seedOpsMatter("privileged")
    const doc = uploadDocument(getRuntimeStore(), {
      firmId: "firmA",
      matterId,
      bytes: Buffer.from("%PDF-privileged-ops-report%"),
      sourceChannel: "web",
      classification: "privileged",
      idempotencyKey: "9666bfcc-251e-4a1a-938d-50f3d9875777",
    })
    const privilegedTransition = await postWorkflow(
      {
        action: "transition",
        actorId: "partner_a",
        documentId: doc.docId,
        nextStatus: "processing",
      },
      "cad8d1fe-f26d-4cfc-8d79-c516d6f08465"
    )
    expect(privilegedTransition.status).toBe(200)

    const clerkView = await getOpsReport(
      new URLSearchParams({
        actorId: "clerk_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(clerkView.status).toBe(200)
    const clerkJson = (await clerkView.json()) as { total: number }
    expect(clerkJson.total).toBe(0)

    const partnerView = await getOpsReport(
      new URLSearchParams({
        actorId: "partner_a",
        source: "workflow_event",
        limit: "10",
        cursor: "0",
      })
    )
    expect(partnerView.status).toBe(200)
    const partnerJson = (await partnerView.json()) as {
      items: Array<{ source: string }>
    }
    expect(partnerJson.items.some((row) => row.source === "workflow_event")).toBe(true)

    const unknown = await getOpsReport(new URLSearchParams({ actorId: "ghost", limit: "10", cursor: "0" }))
    expect(unknown.status).toBe(404)
    const denied = await getOpsReport(
      new URLSearchParams({ actorId: "client_a", limit: "10", cursor: "0" })
    )
    expect(denied.status).toBe(403)

    const workflowListStillWorks = await workflowGet(
      new Request(
        `http://127.0.0.1/api/d1/document-workflow?view=queue&userId=partner_a&matterId=${matterId}&limit=10&cursor=0`
      )
    )
    expect(workflowListStillWorks.status).toBe(200)
  })

  it("provides alert digests plus attestation/escalation governance views and actions", async () => {
    const matterId = seedOpsMatter("internal")
    const doc = uploadDocument(getRuntimeStore(), {
      firmId: "firmA",
      matterId,
      bytes: Buffer.from("%PDF-ops-alert%"),
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "6f5de356-4865-4d89-9d32-afd12846f7b8",
    })
    recordCaseNumber(getRuntimeStore(), matterId, "CP 1234", "SHC")
    const workflowTransition = await postWorkflow(
      {
        action: "transition",
        actorId: "associate_a",
        documentId: doc.docId,
        nextStatus: "processing",
      },
      "d39930f2-ac3f-4e0c-a79a-f790d3f281d4"
    )
    expect(workflowTransition.status).toBe(200)

    const alertView = await getOpsReport(
      new URLSearchParams({
        view: "alert_digests",
        actorId: "associate_a",
        matterId,
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(alertView.status).toBe(200)
    const alertJson = (await alertView.json()) as {
      items: Array<{ matterId: string; severity: string }>
    }
    expect(alertJson.items.some((row) => row.matterId === matterId)).toBe(true)
    const severity = alertJson.items[0]?.severity ?? "low"
    expect(["low", "medium", "high", "critical"]).toContain(severity)

    const deniedAcknowledge = await postOpsReport(
      {
        action: "acknowledge_workflow_ops_alert_digest",
        actorId: "associate_a",
        matterId,
        reason: "associate cannot govern",
      },
      "0c2a3a06-4ebe-42a5-9c4f-dcb33c0fd096"
    )
    expect(deniedAcknowledge.status).toBe(403)

    const acknowledge = await postOpsReport(
      {
        action: "acknowledge_workflow_ops_alert_digest",
        actorId: "partner_a",
        matterId,
        reason: "partner acknowledged digest",
      },
      "6a2bd6fc-9844-4a4f-b3e4-7eaec4854f20"
    )
    expect(acknowledge.status).toBe(200)
    const acknowledgeJson = (await acknowledge.json()) as {
      result: { digest: { acknowledgedBy: string | null; acknowledgedReason: string | null } }
      reused: boolean
    }
    expect(acknowledgeJson.reused).toBe(false)
    expect(acknowledgeJson.result.digest.acknowledgedBy).toBe("partner_a")
    expect(acknowledgeJson.result.digest.acknowledgedReason).toBe("partner acknowledged digest")

    const acknowledgeReplay = await postOpsReport(
      {
        action: "acknowledge_workflow_ops_alert_digest",
        actorId: "partner_a",
        matterId,
        reason: "partner acknowledged digest",
      },
      "6a2bd6fc-9844-4a4f-b3e4-7eaec4854f20"
    )
    expect(acknowledgeReplay.status).toBe(200)
    const acknowledgeReplayJson = (await acknowledgeReplay.json()) as { reused: boolean }
    expect(acknowledgeReplayJson.reused).toBe(true)

    const snoozeUntil = Date.now() + 60_000
    const snooze = await postOpsReport(
      {
        action: "snooze_workflow_ops_alert_digest",
        actorId: "partner_a",
        matterId,
        snoozedUntil: snoozeUntil,
        reason: "awaiting staffing confirmation",
      },
      "7f8d5764-9ea6-40e9-a2b5-ac6058c5f6fd"
    )
    expect(snooze.status).toBe(200)
    const snoozeJson = (await snooze.json()) as {
      result: { digest: { snoozedBy: string | null; snoozedUntil: number | null } }
    }
    expect(snoozeJson.result.digest.snoozedBy).toBe("partner_a")
    expect((snoozeJson.result.digest.snoozedUntil ?? 0) >= snoozeUntil).toBe(true)

    const attest = await postOpsReport(
      {
        action: "attest_workflow_ops_alert_digest",
        actorId: "partner_a",
        matterId,
        reason: "partner attestation complete",
      },
      "30287a12-06b5-4fcd-a304-89de9f63a2e0"
    )
    expect(attest.status).toBe(200)
    const attestJson = (await attest.json()) as {
      result: { attestation: { attestationStatus: string; lastAttestedBy: string | null } }
    }
    expect(attestJson.result.attestation.attestationStatus).toBe("attested")
    expect(attestJson.result.attestation.lastAttestedBy).toBe("partner_a")

    const escalateOpen = await postOpsReport(
      {
        action: "open_workflow_ops_alert_escalation",
        actorId: "partner_a",
        matterId,
        reason: "stale queue requires escalation",
      },
      "5f7a32ec-8778-43a4-b228-d56e91d5c545"
    )
    expect(escalateOpen.status).toBe(200)
    const escalateOpenJson = (await escalateOpen.json()) as {
      result: { escalation: { escalationStatus: string } }
    }
    expect(escalateOpenJson.result.escalation.escalationStatus).toBe("open")

    const assignOwner = await postOpsReport(
      {
        action: "assign_workflow_ops_alert_escalation_owner",
        actorId: "partner_a",
        matterId,
        ownerId: "clerk_a",
        reason: "queue owner assignment",
      },
      "8ac8f00e-2ec7-4ddf-b695-2af6c8a6406a"
    )
    expect(assignOwner.status).toBe(200)
    const assignOwnerJson = (await assignOwner.json()) as {
      result: { escalation: { escalationStatus: string; ownerId: string | null } }
    }
    expect(assignOwnerJson.result.escalation.escalationStatus).toBe("assigned")
    expect(assignOwnerJson.result.escalation.ownerId).toBe("clerk_a")

    const resolveEscalation = await postOpsReport(
      {
        action: "resolve_workflow_ops_alert_escalation",
        actorId: "partner_a",
        matterId,
        reason: "issue remediated",
      },
      "1eeb3a16-fde5-4462-8bb8-f23df95af206"
    )
    expect(resolveEscalation.status).toBe(200)
    const resolveEscalationJson = (await resolveEscalation.json()) as {
      result: { escalation: { escalationStatus: string; resolutionReason: string | null } }
    }
    expect(resolveEscalationJson.result.escalation.escalationStatus).toBe("resolved")
    expect(resolveEscalationJson.result.escalation.resolutionReason).toBe("issue remediated")

    const disputeOpen = await postOpsReport(
      {
        action: "open_workflow_ops_alert_attestation_dispute",
        actorId: "partner_a",
        matterId,
        reason: "contested attestation",
      },
      "8f1baf12-f7da-493f-b90b-3d6dbd7e4d04"
    )
    expect(disputeOpen.status).toBe(200)
    const disputeOpenJson = (await disputeOpen.json()) as {
      result: {
        attestation: { attestationStatus: string }
        dispute: { disputeStatus: string; openedAt: number | null }
      }
    }
    expect(disputeOpenJson.result.attestation.attestationStatus).toBe("reopened")
    expect(disputeOpenJson.result.dispute.disputeStatus).toBe("open")
    expect(disputeOpenJson.result.dispute.openedAt).not.toBeNull()

    const disputeAssign = await postOpsReport(
      {
        action: "assign_workflow_ops_alert_attestation_dispute_reviewer",
        actorId: "partner_a",
        matterId,
        reviewerId: "associate_a",
        reason: "assign reviewer",
      },
      "22d5adf4-f8ee-4c17-a95c-15f68a8ea189"
    )
    expect(disputeAssign.status).toBe(200)
    const disputeAssignJson = (await disputeAssign.json()) as {
      result: { dispute: { disputeStatus: string; reviewerId: string | null } }
    }
    expect(disputeAssignJson.result.dispute.disputeStatus).toBe("review_assigned")
    expect(disputeAssignJson.result.dispute.reviewerId).toBe("associate_a")

    const disputeResolve = await postOpsReport(
      {
        action: "resolve_workflow_ops_alert_attestation_dispute",
        actorId: "partner_a",
        matterId,
        resolutionOutcome: "upheld",
        reason: "review completed",
      },
      "d5f15f89-3447-4a72-a3db-17ae0f86461f"
    )
    expect(disputeResolve.status).toBe(200)
    const disputeResolveJson = (await disputeResolve.json()) as {
      result: {
        attestation: { attestationStatus: string }
        dispute: { disputeStatus: string; resolutionOutcome: string | null }
      }
    }
    expect(disputeResolveJson.result.dispute.disputeStatus).toBe("resolved")
    expect(disputeResolveJson.result.dispute.resolutionOutcome).toBe("upheld")
    expect(disputeResolveJson.result.attestation.attestationStatus).toBe("attested")

    const closureCheckpoint = await postOpsReport(
      {
        action: "checkpoint_workflow_ops_alert_escalation_closure",
        actorId: "partner_a",
        matterId,
        reason: "closure checkpoint recorded",
      },
      "47c44f47-c95e-43e2-9357-4953060fc84f"
    )
    expect(closureCheckpoint.status).toBe(200)
    const closureCheckpointJson = (await closureCheckpoint.json()) as {
      result: { closure: { closureStatus: string; checkpointAt: number | null } }
    }
    expect(closureCheckpointJson.result.closure.closureStatus).toBe("checkpoint_recorded")
    expect(closureCheckpointJson.result.closure.checkpointAt).not.toBeNull()

    const closureClose = await postOpsReport(
      {
        action: "close_workflow_ops_alert_escalation_closure",
        actorId: "partner_a",
        matterId,
        reason: "closure accepted",
      },
      "3f82e9f8-c894-4b98-9c8d-98a8242ab246"
    )
    expect(closureClose.status).toBe(200)
    const closureCloseJson = (await closureClose.json()) as {
      result: {
        escalation: { escalationStatus: string }
        closure: { closureStatus: string; closedAt: number | null }
      }
    }
    expect(closureCloseJson.result.escalation.escalationStatus).toBe("resolved")
    expect(closureCloseJson.result.closure.closureStatus).toBe("closed")
    expect(closureCloseJson.result.closure.closedAt).not.toBeNull()

    const closureReopen = await postOpsReport(
      {
        action: "reopen_workflow_ops_alert_escalation_closure",
        actorId: "partner_a",
        matterId,
        reason: "closure evidence contested",
      },
      "85787620-e0a6-4f8a-b327-c88145d4f59a"
    )
    expect(closureReopen.status).toBe(200)
    const closureReopenJson = (await closureReopen.json()) as {
      result: {
        escalation: { escalationStatus: string }
        closure: { closureStatus: string; reopenedAt: number | null }
      }
    }
    expect(closureReopenJson.result.escalation.escalationStatus).toBe("open")
    expect(closureReopenJson.result.closure.closureStatus).toBe("reopened")
    expect(closureReopenJson.result.closure.reopenedAt).not.toBeNull()

    const enforcementStart = await postOpsReport(
      {
        action: "start_workflow_ops_alert_dispute_enforcement",
        actorId: "partner_a",
        matterId,
        ownerId: "associate_a",
        reason: "start enforcement review",
      },
      "9b54222d-2a29-4743-8245-6b7ec6f46418"
    )
    expect(enforcementStart.status).toBe(200)
    const enforcementStartJson = (await enforcementStart.json()) as {
      result: { enforcement: { enforcementStatus: string; ownerId: string | null } }
    }
    expect(enforcementStartJson.result.enforcement.enforcementStatus).toBe("in_progress")
    expect(enforcementStartJson.result.enforcement.ownerId).toBe("associate_a")

    const enforcementComplete = await postOpsReport(
      {
        action: "complete_workflow_ops_alert_dispute_enforcement",
        actorId: "partner_a",
        matterId,
        reason: "enforcement completed",
      },
      "0f1de97d-c6a0-42c6-a4da-8f7af5edf6cf"
    )
    expect(enforcementComplete.status).toBe(200)
    const enforcementCompleteJson = (await enforcementComplete.json()) as {
      result: { enforcement: { enforcementStatus: string; enforcedAt: number | null } }
    }
    expect(enforcementCompleteJson.result.enforcement.enforcementStatus).toBe("enforced")
    expect(enforcementCompleteJson.result.enforcement.enforcedAt).not.toBeNull()

    const reconciliationFlag = await postOpsReport(
      {
        action: "flag_workflow_ops_alert_closure_reopen_debt",
        actorId: "partner_a",
        matterId,
        reason: "reopen debt identified",
      },
      "d7ec1e76-93d0-4292-87a1-0263f5d96ab9"
    )
    expect(reconciliationFlag.status).toBe(200)
    const reconciliationFlagJson = (await reconciliationFlag.json()) as {
      result: { reconciliation: { reconciliationStatus: string; outstandingDebtCount: number } }
    }
    expect(reconciliationFlagJson.result.reconciliation.reconciliationStatus).toBe("debt_open")
    expect(reconciliationFlagJson.result.reconciliation.outstandingDebtCount).toBeGreaterThanOrEqual(1)

    const reconciliationStart = await postOpsReport(
      {
        action: "start_workflow_ops_alert_closure_debt_reconciliation",
        actorId: "partner_a",
        matterId,
        ownerId: "clerk_a",
        reason: "start reconciliation",
      },
      "0e04089d-e7cb-4fa9-aecf-454d043fbd8f"
    )
    expect(reconciliationStart.status).toBe(200)
    const reconciliationStartJson = (await reconciliationStart.json()) as {
      result: { reconciliation: { reconciliationStatus: string; reconcilingOwnerId: string | null } }
    }
    expect(reconciliationStartJson.result.reconciliation.reconciliationStatus).toBe("reconciling")
    expect(reconciliationStartJson.result.reconciliation.reconcilingOwnerId).toBe("clerk_a")

    const reconciliationResolve = await postOpsReport(
      {
        action: "resolve_workflow_ops_alert_closure_debt_reconciliation",
        actorId: "partner_a",
        matterId,
        reason: "debt reconciled",
      },
      "426f607e-5ebd-4407-af66-49c05398d4e2"
    )
    expect(reconciliationResolve.status).toBe(200)
    const reconciliationResolveJson = (await reconciliationResolve.json()) as {
      result: { reconciliation: { reconciliationStatus: string; outstandingDebtCount: number } }
    }
    expect(reconciliationResolveJson.result.reconciliation.reconciliationStatus).toBe("reconciled")
    expect(reconciliationResolveJson.result.reconciliation.outstandingDebtCount).toBe(0)

    const enforcementAttest = await postOpsReport(
      {
        action: "attest_workflow_ops_alert_dispute_enforcement",
        actorId: "partner_a",
        matterId,
        reason: "enforcement attested",
      },
      "3b1e9a69-c65f-4ea7-a9d0-dd3e7e2d0747"
    )
    expect(enforcementAttest.status).toBe(200)
    const enforcementAttestJson = (await enforcementAttest.json()) as {
      result: { enforcementAttestation: { attestationStatus: string; lastAttestedBy: string | null } }
    }
    expect(enforcementAttestJson.result.enforcementAttestation.attestationStatus).toBe("attested")
    expect(enforcementAttestJson.result.enforcementAttestation.lastAttestedBy).toBe("partner_a")

    const enforcementAttestationReopen = await postOpsReport(
      {
        action: "reopen_workflow_ops_alert_dispute_enforcement_attestation",
        actorId: "partner_a",
        matterId,
        reason: "attestation follow-up required",
      },
      "2e89bdbc-c45c-40ca-b43d-58acb7d6f8bc"
    )
    expect(enforcementAttestationReopen.status).toBe(200)
    const enforcementAttestationReopenJson = (await enforcementAttestationReopen.json()) as {
      result: {
        enforcement: { enforcementStatus: string }
        enforcementAttestation: { attestationStatus: string }
      }
    }
    expect(enforcementAttestationReopenJson.result.enforcement.enforcementStatus).toBe("in_progress")
    expect(enforcementAttestationReopenJson.result.enforcementAttestation.attestationStatus).toBe(
      "reopened"
    )

    const enforcementRecomplete = await postOpsReport(
      {
        action: "complete_workflow_ops_alert_dispute_enforcement",
        actorId: "partner_a",
        matterId,
        reason: "enforcement re-completed after attestation reopen",
      },
      "5c4467a2-5f3c-452e-acf6-74f2f31492d3"
    )
    expect(enforcementRecomplete.status).toBe(200)
    const enforcementRecompleteJson = (await enforcementRecomplete.json()) as {
      result: { enforcement: { enforcementStatus: string } }
    }
    expect(enforcementRecompleteJson.result.enforcement.enforcementStatus).toBe("enforced")

    const varianceOpen = await postOpsReport(
      {
        action: "open_workflow_ops_alert_closure_debt_variance",
        actorId: "partner_a",
        matterId,
        reason: "variance detected",
      },
      "c891e12a-4a39-497e-b7a0-bafbc3e7def4"
    )
    expect(varianceOpen.status).toBe(200)
    const varianceOpenJson = (await varianceOpen.json()) as {
      result: { variance: { varianceStatus: string; outstandingVarianceCount: number } }
    }
    expect(varianceOpenJson.result.variance.varianceStatus).toBe("variance_open")
    expect(varianceOpenJson.result.variance.outstandingVarianceCount).toBeGreaterThanOrEqual(1)

    const varianceAssign = await postOpsReport(
      {
        action: "assign_workflow_ops_alert_closure_debt_variance_owner",
        actorId: "partner_a",
        matterId,
        ownerId: "associate_a",
        reason: "variance review assignment",
      },
      "8bda1d98-dac1-42cc-a7d8-bf4d05963784"
    )
    expect(varianceAssign.status).toBe(200)
    const varianceAssignJson = (await varianceAssign.json()) as {
      result: { variance: { varianceStatus: string; reviewOwnerId: string | null } }
    }
    expect(varianceAssignJson.result.variance.varianceStatus).toBe("variance_reviewing")
    expect(varianceAssignJson.result.variance.reviewOwnerId).toBe("associate_a")

    const varianceResolve = await postOpsReport(
      {
        action: "resolve_workflow_ops_alert_closure_debt_variance",
        actorId: "partner_a",
        matterId,
        reason: "variance resolved",
      },
      "8acde31e-862a-4a17-a5e8-f9c19f92ea0e"
    )
    expect(varianceResolve.status).toBe(200)
    const varianceResolveJson = (await varianceResolve.json()) as {
      result: { variance: { varianceStatus: string; outstandingVarianceCount: number } }
    }
    expect(varianceResolveJson.result.variance.varianceStatus).toBe("variance_resolved")
    expect(varianceResolveJson.result.variance.outstandingVarianceCount).toBe(0)

    const waiverCreate = await postOpsReport(
      {
        action: "create_workflow_ops_alert_enforcement_waiver",
        actorId: "partner_a",
        matterId,
        reason: "waiver request opened",
      },
      "4f052e0d-26fd-47c7-b025-e723eab9f680"
    )
    expect(waiverCreate.status).toBe(200)
    const waiverCreateJson = (await waiverCreate.json()) as {
      result: { enforcementWaiver: { waiverStatus: string; requestedBy: string | null } }
    }
    expect(waiverCreateJson.result.enforcementWaiver.waiverStatus).toBe("pending_attestation")
    expect(waiverCreateJson.result.enforcementWaiver.requestedBy).toBe("partner_a")

    const waiverAttest = await postOpsReport(
      {
        action: "attest_workflow_ops_alert_enforcement_waiver",
        actorId: "partner_a",
        matterId,
        reason: "waiver attested",
      },
      "8135ecef-f97d-4f75-9de2-01f2f3e79f88"
    )
    expect(waiverAttest.status).toBe(200)
    const waiverAttestJson = (await waiverAttest.json()) as {
      result: { enforcementWaiver: { waiverStatus: string; attestedBy: string | null } }
    }
    expect(waiverAttestJson.result.enforcementWaiver.waiverStatus).toBe("attested")
    expect(waiverAttestJson.result.enforcementWaiver.attestedBy).toBe("partner_a")

    const waiverExpiry = Date.now() + 120_000
    const waiverWaive = await postOpsReport(
      {
        action: "waive_workflow_ops_alert_enforcement_waiver",
        actorId: "partner_a",
        matterId,
        waiverExpiresAt: waiverExpiry,
        reason: "waiver approved",
      },
      "72711dea-a895-4f3c-ba2c-3dff64ecf4ca"
    )
    expect(waiverWaive.status).toBe(200)
    const waiverWaiveJson = (await waiverWaive.json()) as {
      result: {
        enforcementWaiver: { waiverStatus: string; waivedBy: string | null; waiverExpiresAt: number | null }
      }
    }
    expect(waiverWaiveJson.result.enforcementWaiver.waiverStatus).toBe("waived")
    expect(waiverWaiveJson.result.enforcementWaiver.waivedBy).toBe("partner_a")
    expect((waiverWaiveJson.result.enforcementWaiver.waiverExpiresAt ?? 0) >= waiverExpiry).toBe(true)

    const waiverExpiryAcknowledge = await postOpsReport(
      {
        action: "acknowledge_workflow_ops_alert_waiver_expiry_digest",
        actorId: "partner_a",
        matterId,
        reason: "expiry digest acknowledged",
      },
      "f7518f37-fd14-436f-ab4f-e96f2c08fdee"
    )
    expect(waiverExpiryAcknowledge.status).toBe(200)
    const waiverExpiryAcknowledgeJson = (await waiverExpiryAcknowledge.json()) as {
      result: { waiverExpiryDigest: { expiryStatus: string; acknowledgedBy: string | null } }
    }
    expect(waiverExpiryAcknowledgeJson.result.waiverExpiryDigest.expiryStatus).toBe("acknowledged")
    expect(waiverExpiryAcknowledgeJson.result.waiverExpiryDigest.acknowledgedBy).toBe("partner_a")

    const waiverExpiryExtendedTo = Date.now() + 48 * 60 * 60 * 1000
    const waiverExpiryExtend = await postOpsReport(
      {
        action: "extend_workflow_ops_alert_waiver_expiry_digest",
        actorId: "partner_a",
        matterId,
        waiverExpiresAt: waiverExpiryExtendedTo,
        reason: "extension approved",
      },
      "56f32f9f-74c0-488b-9146-1b7c66fdcfc0"
    )
    expect(waiverExpiryExtend.status).toBe(200)
    const waiverExpiryExtendJson = (await waiverExpiryExtend.json()) as {
      result: {
        enforcementWaiver: { waiverExpiresAt: number | null }
        waiverExpiryDigest: { expiryStatus: string; extendedBy: string | null }
      }
    }
    expect((waiverExpiryExtendJson.result.enforcementWaiver.waiverExpiresAt ?? 0) >= waiverExpiryExtendedTo).toBe(
      true
    )
    expect(waiverExpiryExtendJson.result.waiverExpiryDigest.expiryStatus).toBe("extended")
    expect(waiverExpiryExtendJson.result.waiverExpiryDigest.extendedBy).toBe("partner_a")

    const varianceReopenForQueue = await postOpsReport(
      {
        action: "open_workflow_ops_alert_closure_debt_variance",
        actorId: "partner_a",
        matterId,
        reason: "variance reopened for remediation queue",
      },
      "c040eb98-df3a-476f-962c-5ec3356f324e"
    )
    expect(varianceReopenForQueue.status).toBe(200)

    const remediationQueue = await postOpsReport(
      {
        action: "queue_workflow_ops_alert_variance_remediation",
        actorId: "partner_a",
        matterId,
        reason: "queue remediation",
      },
      "33ef17f5-1f37-4a2e-a745-8534f2441088"
    )
    expect(remediationQueue.status).toBe(200)
    const remediationQueueJson = (await remediationQueue.json()) as {
      result: { remediationQueue: { queueStatus: string } }
    }
    expect(remediationQueueJson.result.remediationQueue.queueStatus).toBe("queued")

    const remediationAssign = await postOpsReport(
      {
        action: "assign_workflow_ops_alert_variance_remediation_owner",
        actorId: "partner_a",
        matterId,
        ownerId: "associate_a",
        reason: "assign remediation owner",
      },
      "7ddace0f-131b-43a2-bf1f-748bcfb60338"
    )
    expect(remediationAssign.status).toBe(200)
    const remediationAssignJson = (await remediationAssign.json()) as {
      result: { remediationQueue: { queueStatus: string; ownerId: string | null } }
    }
    expect(remediationAssignJson.result.remediationQueue.queueStatus).toBe("assigned")
    expect(remediationAssignJson.result.remediationQueue.ownerId).toBe("associate_a")

    const remediationSlaAcknowledge = await postOpsReport(
      {
        action: "acknowledge_workflow_ops_alert_variance_remediation_sla_ledger",
        actorId: "partner_a",
        matterId,
        reason: "SLA noted by partner",
      },
      "f3fda729-4fda-4de8-ad76-365dc62c6642"
    )
    expect(remediationSlaAcknowledge.status).toBe(200)
    const remediationSlaAcknowledgeJson = (await remediationSlaAcknowledge.json()) as {
      result: { remediationSlaLedger: { slaStatus: string; acknowledgedBy: string | null } }
    }
    expect(remediationSlaAcknowledgeJson.result.remediationSlaLedger.slaStatus).toBe("acknowledged")
    expect(remediationSlaAcknowledgeJson.result.remediationSlaLedger.acknowledgedBy).toBe("partner_a")

    const waiverExpiryDisputeOpen = await postOpsReport(
      {
        action: "open_workflow_ops_alert_waiver_expiry_dispute",
        actorId: "partner_a",
        matterId,
        reason: "waiver expiry disputed",
      },
      "95bc8a7d-5ccf-4f0a-b290-05c6e6d57f3e"
    )
    expect(waiverExpiryDisputeOpen.status).toBe(200)
    const waiverExpiryDisputeOpenJson = (await waiverExpiryDisputeOpen.json()) as {
      result: { waiverExpiryDispute: { disputeStatus: string; openedBy: string | null } }
    }
    expect(waiverExpiryDisputeOpenJson.result.waiverExpiryDispute.disputeStatus).toBe("open")
    expect(waiverExpiryDisputeOpenJson.result.waiverExpiryDispute.openedBy).toBe("partner_a")

    const waiverExpiryDisputeAssign = await postOpsReport(
      {
        action: "assign_workflow_ops_alert_waiver_expiry_dispute_reviewer",
        actorId: "partner_a",
        matterId,
        reviewerId: "associate_a",
        reason: "assign dispute reviewer",
      },
      "822df220-d9f7-422a-9f6a-7a8f4ebd226f"
    )
    expect(waiverExpiryDisputeAssign.status).toBe(200)
    const waiverExpiryDisputeAssignJson = (await waiverExpiryDisputeAssign.json()) as {
      result: { waiverExpiryDispute: { disputeStatus: string; reviewerId: string | null } }
    }
    expect(waiverExpiryDisputeAssignJson.result.waiverExpiryDispute.disputeStatus).toBe("review_assigned")
    expect(waiverExpiryDisputeAssignJson.result.waiverExpiryDispute.reviewerId).toBe("associate_a")

    const waiverExpiryDisputeResolve = await postOpsReport(
      {
        action: "resolve_workflow_ops_alert_waiver_expiry_dispute",
        actorId: "partner_a",
        matterId,
        resolutionOutcome: "extension_granted",
        reason: "waiver expiry dispute resolved",
      },
      "62fe7fb5-b4d8-45eb-a7b8-9ff5b6f9f83f"
    )
    expect(waiverExpiryDisputeResolve.status).toBe(200)
    const waiverExpiryDisputeResolveJson = (await waiverExpiryDisputeResolve.json()) as {
      result: {
        waiverExpiryDispute: { disputeStatus: string; resolutionOutcome: string | null; resolvedBy: string | null }
      }
    }
    expect(waiverExpiryDisputeResolveJson.result.waiverExpiryDispute.disputeStatus).toBe("resolved")
    expect(waiverExpiryDisputeResolveJson.result.waiverExpiryDispute.resolutionOutcome).toBe(
      "extension_granted"
    )
    expect(waiverExpiryDisputeResolveJson.result.waiverExpiryDispute.resolvedBy).toBe("partner_a")

    const remediationSlaBreachEscalationOpen = await postOpsReport(
      {
        action: "open_workflow_ops_alert_variance_remediation_sla_breach_escalation",
        actorId: "partner_a",
        matterId,
        reason: "sla breach escalation opened",
      },
      "1f6f4513-42ca-49b5-b4db-fd73e390f943"
    )
    expect(remediationSlaBreachEscalationOpen.status).toBe(200)
    const remediationSlaBreachEscalationOpenJson = (await remediationSlaBreachEscalationOpen.json()) as {
      result: { remediationSlaBreachEscalation: { escalationStatus: string } }
    }
    expect(remediationSlaBreachEscalationOpenJson.result.remediationSlaBreachEscalation.escalationStatus).toBe(
      "open"
    )

    const remediationSlaBreachEscalationAssign = await postOpsReport(
      {
        action: "assign_workflow_ops_alert_variance_remediation_sla_breach_escalation_owner",
        actorId: "partner_a",
        matterId,
        ownerId: "associate_a",
        reason: "assign SLA breach escalation owner",
      },
      "0ca0f4dd-b7cb-44c9-a40e-e9f8ad11d9ca"
    )
    expect(remediationSlaBreachEscalationAssign.status).toBe(200)
    const remediationSlaBreachEscalationAssignJson =
      (await remediationSlaBreachEscalationAssign.json()) as {
        result: {
          remediationSlaBreachEscalation: { escalationStatus: string; ownerId: string | null }
        }
      }
    expect(
      remediationSlaBreachEscalationAssignJson.result.remediationSlaBreachEscalation.escalationStatus
    ).toBe("assigned")
    expect(remediationSlaBreachEscalationAssignJson.result.remediationSlaBreachEscalation.ownerId).toBe(
      "associate_a"
    )

    const remediationSlaBreachEscalationResolve = await postOpsReport(
      {
        action: "resolve_workflow_ops_alert_variance_remediation_sla_breach_escalation",
        actorId: "partner_a",
        matterId,
        reason: "SLA breach escalation resolved",
      },
      "ccb46daa-df9b-4102-bf51-2120a3fca0bc"
    )
    expect(remediationSlaBreachEscalationResolve.status).toBe(200)
    const remediationSlaBreachEscalationResolveJson =
      (await remediationSlaBreachEscalationResolve.json()) as {
        result: {
          remediationSlaBreachEscalation: { escalationStatus: string; resolvedAt: number | null }
        }
      }
    expect(
      remediationSlaBreachEscalationResolveJson.result.remediationSlaBreachEscalation.escalationStatus
    ).toBe("resolved")
    expect(remediationSlaBreachEscalationResolveJson.result.remediationSlaBreachEscalation.resolvedAt).not.toBeNull()

    const waiverExpiryDisputeAdjudicationOpen = await postOpsReport(
      {
        action: "open_workflow_ops_alert_waiver_expiry_dispute_adjudication",
        actorId: "partner_a",
        matterId,
        reason: "waiver expiry dispute adjudication opened",
      },
      "a91c0f22-6d4a-4b7e-9f11-2d8c4b6e1a70"
    )
    expect(waiverExpiryDisputeAdjudicationOpen.status).toBe(200)
    const waiverExpiryDisputeAdjudicationOpenJson = (await waiverExpiryDisputeAdjudicationOpen.json()) as {
      result: { waiverExpiryDisputeAdjudication: { adjudicationStatus: string } }
    }
    expect(waiverExpiryDisputeAdjudicationOpenJson.result.waiverExpiryDisputeAdjudication.adjudicationStatus).toBe(
      "open"
    )

    const waiverExpiryDisputeAdjudicationAssign = await postOpsReport(
      {
        action: "assign_workflow_ops_alert_waiver_expiry_dispute_adjudication_panel_owner",
        actorId: "partner_a",
        matterId,
        panelOwnerId: "associate_a",
        reason: "assign adjudication panel owner",
      },
      "b72e91aa-3c18-4f60-8d44-5f1a0c9e2b31"
    )
    expect(waiverExpiryDisputeAdjudicationAssign.status).toBe(200)
    const waiverExpiryDisputeAdjudicationAssignJson =
      (await waiverExpiryDisputeAdjudicationAssign.json()) as {
        result: {
          waiverExpiryDisputeAdjudication: { adjudicationStatus: string; panelOwnerId: string | null }
        }
      }
    expect(waiverExpiryDisputeAdjudicationAssignJson.result.waiverExpiryDisputeAdjudication.adjudicationStatus).toBe(
      "panel_assigned"
    )
    expect(waiverExpiryDisputeAdjudicationAssignJson.result.waiverExpiryDisputeAdjudication.panelOwnerId).toBe(
      "associate_a"
    )

    const waiverExpiryDisputeAdjudicationSloOpen = await postOpsReport(
      {
        action: "open_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_stewardship",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO stewardship opened",
      },
      "a11c0f22-6d4a-4b7e-9f11-2d8c4b6e1a81"
    )
    expect(waiverExpiryDisputeAdjudicationSloOpen.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloOpenJson =
      (await waiverExpiryDisputeAdjudicationSloOpen.json()) as {
        result: { waiverExpiryDisputeAdjudicationSlo: { sloStatus: string } }
      }
    expect(waiverExpiryDisputeAdjudicationSloOpenJson.result.waiverExpiryDisputeAdjudicationSlo.sloStatus).toBe(
      "watch"
    )

    const waiverExpiryDisputeAdjudicationSloExtend = await postOpsReport(
      {
        action: "extend_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_deadline",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO deadline extended",
      },
      "b82e91aa-3c18-4f60-8d44-5f1a0c9e2b42"
    )
    expect(waiverExpiryDisputeAdjudicationSloExtend.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloExtendJson =
      (await waiverExpiryDisputeAdjudicationSloExtend.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSlo: {
            sloStatus: string
            extendedDueAt: number | null
          }
        }
      }
    expect(
      waiverExpiryDisputeAdjudicationSloExtendJson.result.waiverExpiryDisputeAdjudicationSlo.sloStatus
    ).toBe("deadline_extended")
    expect(
      waiverExpiryDisputeAdjudicationSloExtendJson.result.waiverExpiryDisputeAdjudicationSlo.extendedDueAt
    ).not.toBeNull()

    const waiverExpiryDisputeAdjudicationSloAcknowledge = await postOpsReport(
      {
        action: "acknowledge_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO breach acknowledged",
      },
      "c29d44f0-91ab-4e22-a7f6-0b3c5d8e9a23"
    )
    expect(waiverExpiryDisputeAdjudicationSloAcknowledge.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloAcknowledgeJson =
      (await waiverExpiryDisputeAdjudicationSloAcknowledge.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSlo: {
            sloStatus: string
            breachAcknowledgedAt: number | null
          }
        }
      }
    expect(
      waiverExpiryDisputeAdjudicationSloAcknowledgeJson.result.waiverExpiryDisputeAdjudicationSlo.sloStatus
    ).toBe("breach_acknowledged")
    expect(
      waiverExpiryDisputeAdjudicationSloAcknowledgeJson.result.waiverExpiryDisputeAdjudicationSlo
        .breachAcknowledgedAt
    ).not.toBeNull()

    const waiverExpiryDisputeAdjudicationSloDebtRecord = await postOpsReport(
      {
        action: "record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation",
        actorId: "partner_a",
        matterId,
        debtRetiredMs: 120_000,
        reason: "adjudication SLO debt remediation recorded",
      },
      "a29d44f0-91ab-4e22-a7f6-0b3c5d8e9a24"
    )
    expect(waiverExpiryDisputeAdjudicationSloDebtRecord.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloDebtRecordJson =
      (await waiverExpiryDisputeAdjudicationSloDebtRecord.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSloDebtRemediation: {
            debtStatus: string
            debtRetiredMs: number
          }
        }
      }
    expect(
      waiverExpiryDisputeAdjudicationSloDebtRecordJson.result.waiverExpiryDisputeAdjudicationSloDebtRemediation
        .debtStatus
    ).toBe("remediation_recorded")
    expect(
      waiverExpiryDisputeAdjudicationSloDebtRecordJson.result.waiverExpiryDisputeAdjudicationSloDebtRemediation
        .debtRetiredMs
    ).toBe(120_000)

    const waiverExpiryDisputeAdjudicationSloTierDownshift = await postOpsReport(
      {
        action: "downshift_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_tier",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO tier downshifted",
      },
      "b39d44f0-91ab-4e22-a7f6-0b3c5d8e9a25"
    )
    expect(waiverExpiryDisputeAdjudicationSloTierDownshift.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloTierDownshiftJson =
      (await waiverExpiryDisputeAdjudicationSloTierDownshift.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSloDebtRemediation: { debtStatus: string }
        }
      }
    expect(
      waiverExpiryDisputeAdjudicationSloTierDownshiftJson.result
        .waiverExpiryDisputeAdjudicationSloDebtRemediation.debtStatus
    ).toBe("tier_downshifted")

    const waiverExpiryDisputeAdjudicationSloBreachClosure = await postOpsReport(
      {
        action: "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach_closure",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO breach closure attested",
      },
      "c49d44f0-91ab-4e22-a7f6-0b3c5d8e9a26"
    )
    expect(waiverExpiryDisputeAdjudicationSloBreachClosure.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloBreachClosureJson =
      (await waiverExpiryDisputeAdjudicationSloBreachClosure.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSloDebtRemediation: {
            debtStatus: string
            breachClosureAttestedBy: string | null
          }
        }
      }
    expect(
      waiverExpiryDisputeAdjudicationSloBreachClosureJson.result
        .waiverExpiryDisputeAdjudicationSloDebtRemediation.debtStatus
    ).toBe("breach_closure_attested")
    expect(
      waiverExpiryDisputeAdjudicationSloBreachClosureJson.result
        .waiverExpiryDisputeAdjudicationSloDebtRemediation.breachClosureAttestedBy
    ).toBe("partner_a")

    const waiverExpiryDisputeAdjudicationSloDebtBurndownTarget = await postOpsReport(
      {
        action: "set_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_target",
        actorId: "partner_a",
        matterId,
        retirementTargetAt: Date.now() + 48 * 60 * 60 * 1000,
        reason: "adjudication SLO debt burndown target set",
      },
      "d59d44f0-91ab-4e22-a7f6-0b3c5d8e9a27"
    )
    expect(waiverExpiryDisputeAdjudicationSloDebtBurndownTarget.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloDebtBurndownTargetJson =
      (await waiverExpiryDisputeAdjudicationSloDebtBurndownTarget.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSloDebtBurndown: {
            burndownStatus: string
            remainingDebtMs: number
          }
        }
      }
    expect(
      waiverExpiryDisputeAdjudicationSloDebtBurndownTargetJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndown.burndownStatus
    ).toBe("target_set")

    const waiverExpiryDisputeAdjudicationSloDebtBacklog = await postOpsReport(
      {
        action: "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_backlog",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO debt backlog attested",
      },
      "e69d44f0-91ab-4e22-a7f6-0b3c5d8e9a28"
    )
    expect(waiverExpiryDisputeAdjudicationSloDebtBacklog.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloDebtBacklogJson =
      (await waiverExpiryDisputeAdjudicationSloDebtBacklog.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSloDebtBurndown: {
            burndownStatus: string
            backlogAttestedBy: string | null
          }
        }
      }
    expect(
      waiverExpiryDisputeAdjudicationSloDebtBacklogJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndown.burndownStatus
    ).toBe("backlog_attested")
    expect(
      waiverExpiryDisputeAdjudicationSloDebtBacklogJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndown.backlogAttestedBy
    ).toBe("partner_a")

    const waiverExpiryDisputeAdjudicationSloDebtBurndownCheckpoint = await postOpsReport(
      {
        action: "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO debt burndown checkpointed",
      },
      "f79d44f0-91ab-4e22-a7f6-0b3c5d8e9a29"
    )
    expect(waiverExpiryDisputeAdjudicationSloDebtBurndownCheckpoint.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloDebtBurndownCheckpointJson =
      (await waiverExpiryDisputeAdjudicationSloDebtBurndownCheckpoint.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSloDebtBurndown: {
            burndownStatus: string
            checkpointedBy: string | null
          }
        }
      }
    expect(
      waiverExpiryDisputeAdjudicationSloDebtBurndownCheckpointJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndown.burndownStatus
    ).toBe("burndown_checkpointed")
    expect(
      waiverExpiryDisputeAdjudicationSloDebtBurndownCheckpointJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndown.checkpointedBy
    ).toBe("partner_a")

    const waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementDrift = await postOpsReport(
      {
        action:
          "acknowledge_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_drift",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO debt burndown settlement drift acknowledged",
      },
      "a79d44f0-91ab-4e22-a7f6-0b3c5d8e9a30"
    )
    expect(waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementDrift.status).toBe(200)

    const waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementTargetLock = await postOpsReport(
      {
        action:
          "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_target_lock",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO debt burndown settlement target lock attested",
      },
      "b89d44f0-91ab-4e22-a7f6-0b3c5d8e9a31"
    )
    expect(waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementTargetLock.status).toBe(200)

    const waiverExpiryDisputeAdjudicationSloDebtBurndownRollbackResolution = await postOpsReport(
      {
        action:
          "close_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_rollback_resolution",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO debt burndown rollback resolution closed",
      },
      "c99d44f0-91ab-4e22-a7f6-0b3c5d8e9a32"
    )
    expect(waiverExpiryDisputeAdjudicationSloDebtBurndownRollbackResolution.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloDebtBurndownRollbackResolutionJson =
      (await waiverExpiryDisputeAdjudicationSloDebtBurndownRollbackResolution.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSloDebtBurndownSettlement: {
            settlementStatus: string
          }
        }
      }
    expect(
      waiverExpiryDisputeAdjudicationSloDebtBurndownRollbackResolutionJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndownSettlement.settlementStatus
    ).toBe("rollback_resolution_closed")

    const waiverExpiryDisputeAdjudicationResolve = await postOpsReport(
      {
        action: "resolve_workflow_ops_alert_waiver_expiry_dispute_adjudication",
        actorId: "partner_a",
        matterId,
        resolutionOutcome: "extension_granted",
        reason: "waiver expiry dispute adjudication resolved",
      },
      "c18d44f0-91ab-4e22-a7f6-0b3c5d8e9a12"
    )
    expect(waiverExpiryDisputeAdjudicationResolve.status).toBe(200)
    const waiverExpiryDisputeAdjudicationResolveJson =
      (await waiverExpiryDisputeAdjudicationResolve.json()) as {
        result: {
          waiverExpiryDisputeAdjudication: {
            adjudicationStatus: string
            resolutionOutcome: string | null
          }
        }
      }
    expect(waiverExpiryDisputeAdjudicationResolveJson.result.waiverExpiryDisputeAdjudication.adjudicationStatus).toBe(
      "resolved"
    )
    expect(
      waiverExpiryDisputeAdjudicationResolveJson.result.waiverExpiryDisputeAdjudication.resolutionOutcome
    ).toBe("extension_granted")

    const remediationSlaBreachResolutionCheckpointOpen = await postOpsReport(
      {
        action: "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint",
        actorId: "partner_a",
        matterId,
        checkpointOwnerId: "associate_a",
        reason: "resolution checkpoint opened",
      },
      "d44a0b91-7c2e-4f18-9a55-1e6b8c0d3f27"
    )
    expect(remediationSlaBreachResolutionCheckpointOpen.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointOpenJson =
      (await remediationSlaBreachResolutionCheckpointOpen.json()) as {
        result: { remediationSlaBreachResolutionCheckpoint: { checkpointStatus: string } }
      }
    expect(
      remediationSlaBreachResolutionCheckpointOpenJson.result.remediationSlaBreachResolutionCheckpoint
        .checkpointStatus
    ).toBe("open")

    const remediationSlaBreachResolutionCheckpointRecord = await postOpsReport(
      {
        action: "record_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint",
        actorId: "partner_a",
        matterId,
        reason: "resolution checkpoint recorded",
      },
      "e91f3c20-8a47-4b16-bd33-6c2a0e1f5d84"
    )
    expect(remediationSlaBreachResolutionCheckpointRecord.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointRecordJson =
      (await remediationSlaBreachResolutionCheckpointRecord.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpoint: {
            checkpointStatus: string
            checkpointRecordedAt: number | null
          }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointRecordJson.result.remediationSlaBreachResolutionCheckpoint
        .checkpointStatus
    ).toBe("checkpoint_recorded")
    expect(
      remediationSlaBreachResolutionCheckpointRecordJson.result.remediationSlaBreachResolutionCheckpoint
        .checkpointRecordedAt
    ).not.toBeNull()

    const remediationSlaBreachResolutionCheckpointReopen = await postOpsReport(
      {
        action: "reopen_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint",
        actorId: "partner_a",
        matterId,
        reason: "resolution checkpoint reopened",
      },
      "f07b1a55-2d94-4c80-ae11-9d6e4b8c2a73"
    )
    expect(remediationSlaBreachResolutionCheckpointReopen.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointReopenJson =
      (await remediationSlaBreachResolutionCheckpointReopen.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpoint: {
            checkpointStatus: string
            reopenPressureCount: number
          }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointReopenJson.result.remediationSlaBreachResolutionCheckpoint
        .checkpointStatus
    ).toBe("reopened")
    expect(
      remediationSlaBreachResolutionCheckpointReopenJson.result.remediationSlaBreachResolutionCheckpoint
        .reopenPressureCount
    ).toBeGreaterThanOrEqual(1)

    const remediationSlaBreachResolutionCheckpointExpiryOpen = await postOpsReport(
      {
        action:
          "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation",
        actorId: "partner_a",
        matterId,
        reason: "resolution checkpoint expiry attestation opened",
      },
      "d55a0b91-7c2e-4f18-9a55-1e6b8c0d3f38"
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryOpen.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryOpenJson =
      (await remediationSlaBreachResolutionCheckpointExpiryOpen.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestation: { attestationStatus: string }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryOpenJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestation.attestationStatus
    ).toBe("open")

    const remediationSlaBreachResolutionCheckpointExpiryAttest = await postOpsReport(
      {
        action: "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry",
        actorId: "partner_a",
        matterId,
        reason: "resolution checkpoint expiry attested",
      },
      "e02f3c20-8a47-4b16-bd33-6c2a0e1f5d95"
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryAttest.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryAttestJson =
      (await remediationSlaBreachResolutionCheckpointExpiryAttest.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestation: {
            attestationStatus: string
            attestedBy: string | null
          }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryAttestJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestation.attestationStatus
    ).toBe("attested")
    expect(
      remediationSlaBreachResolutionCheckpointExpiryAttestJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestation.attestedBy
    ).toBe("partner_a")

    const remediationSlaBreachResolutionCheckpointExpiryAcknowledge = await postOpsReport(
      {
        action:
          "acknowledge_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry",
        actorId: "partner_a",
        matterId,
        reason: "resolution checkpoint expiry acknowledged",
      },
      "f18b1a55-2d94-4c80-ae11-9d6e4b8c2a84"
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryAcknowledge.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryAcknowledgeJson =
      (await remediationSlaBreachResolutionCheckpointExpiryAcknowledge.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestation: {
            attestationStatus: string
            expiryAcknowledgedBy: string | null
          }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryAcknowledgeJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestation.attestationStatus
    ).toBe("expiry_acknowledged")
    expect(
      remediationSlaBreachResolutionCheckpointExpiryAcknowledgeJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestation.expiryAcknowledgedBy
    ).toBe("partner_a")

    const remediationSlaBreachResolutionCheckpointExpiryExceptionOpen = await postOpsReport(
      {
        action:
          "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception",
        actorId: "partner_a",
        matterId,
        reason: "checkpoint expiry attestation exception opened",
      },
      "a18b1a55-2d94-4c80-ae11-9d6e4b8c2a85"
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryExceptionOpen.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryExceptionOpenJson =
      (await remediationSlaBreachResolutionCheckpointExpiryExceptionOpen.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation: {
            exceptionStatus: string
          }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryExceptionOpenJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
        .exceptionStatus
    ).toBe("exception_open")

    const remediationSlaBreachResolutionCheckpointExpiryExceptionAssign = await postOpsReport(
      {
        action:
          "assign_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_owner",
        actorId: "partner_a",
        matterId,
        assigneeId: "associate_a",
        reason: "checkpoint expiry attestation exception owner assigned",
      },
      "b28b1a55-2d94-4c80-ae11-9d6e4b8c2a86"
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryExceptionAssign.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryExceptionAssignJson =
      (await remediationSlaBreachResolutionCheckpointExpiryExceptionAssign.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation: {
            exceptionStatus: string
            assigneeId: string | null
          }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryExceptionAssignJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
        .exceptionStatus
    ).toBe("exception_assigned")
    expect(
      remediationSlaBreachResolutionCheckpointExpiryExceptionAssignJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation.assigneeId
    ).toBe("associate_a")

    const remediationSlaBreachResolutionCheckpointExpiryExceptionReconcile = await postOpsReport(
      {
        action:
          "reconcile_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception",
        actorId: "partner_a",
        matterId,
        reason: "checkpoint expiry attestation exception reconciled",
      },
      "c38b1a55-2d94-4c80-ae11-9d6e4b8c2a87"
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryExceptionReconcile.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryExceptionReconcileJson =
      (await remediationSlaBreachResolutionCheckpointExpiryExceptionReconcile.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation: {
            exceptionStatus: string
            reconciledBy: string | null
          }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryExceptionReconcileJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
        .exceptionStatus
    ).toBe("exception_reconciled")
    expect(
      remediationSlaBreachResolutionCheckpointExpiryExceptionReconcileJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation.reconciledBy
    ).toBe("partner_a")

    const remediationSlaBreachResolutionCheckpointExpiryQueueTriage = await postOpsReport(
      {
        action:
          "triage_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue",
        actorId: "partner_a",
        matterId,
        reason: "checkpoint expiry attestation queue triaged",
      },
      "d48b1a55-2d94-4c80-ae11-9d6e4b8c2a88"
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryQueueTriage.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryQueueTriageJson =
      (await remediationSlaBreachResolutionCheckpointExpiryQueueTriage.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestration: {
            queueStatus: string
          }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryQueueTriageJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestration.queueStatus
    ).toBe("queue_triaged")

    const remediationSlaBreachResolutionCheckpointExpiryQueueHandoff = await postOpsReport(
      {
        action:
          "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_handoff",
        actorId: "partner_a",
        matterId,
        handoffToOwnerId: "associate_a",
        reason: "checkpoint expiry attestation queue handoff attested",
      },
      "e58b1a55-2d94-4c80-ae11-9d6e4b8c2a89"
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryQueueHandoff.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryQueueHandoffJson =
      (await remediationSlaBreachResolutionCheckpointExpiryQueueHandoff.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestration: {
            queueStatus: string
            handoffToOwnerId: string | null
          }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryQueueHandoffJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestration.queueStatus
    ).toBe("handoff_attested")
    expect(
      remediationSlaBreachResolutionCheckpointExpiryQueueHandoffJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestration.handoffToOwnerId
    ).toBe("associate_a")

    const remediationSlaBreachResolutionCheckpointExpiryQueueDrain = await postOpsReport(
      {
        action:
          "checkpoint_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_auto_drain",
        actorId: "partner_a",
        matterId,
        reason: "checkpoint expiry attestation queue auto-drain checkpointed",
      },
      "f68b1a55-2d94-4c80-ae11-9d6e4b8c2a90"
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryQueueDrain.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryQueueDrainJson =
      (await remediationSlaBreachResolutionCheckpointExpiryQueueDrain.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestration: {
            queueStatus: string
            autoDrainCheckpointedBy: string | null
          }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryQueueDrainJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestration.queueStatus
    ).toBe("queue_auto_drained")
    expect(
      remediationSlaBreachResolutionCheckpointExpiryQueueDrainJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestration
        .autoDrainCheckpointedBy
    ).toBe("partner_a")

    const remediationSlaBreachResolutionCheckpointExpiryQueueDrainHandoffTimeout = await postOpsReport(
      {
        action:
          "escalate_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_handoff_timeout",
        actorId: "partner_a",
        matterId,
        reason: "checkpoint expiry attestation queue drain handoff timeout escalated",
      },
      "d09d44f0-91ab-4e22-a7f6-0b3c5d8e9a33"
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryQueueDrainHandoffTimeout.status).toBe(200)

    const remediationSlaBreachResolutionCheckpointExpiryQueueDrainStaleReassignment =
      await postOpsReport(
        {
          action:
            "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_stale_reassignment",
          actorId: "partner_a",
          matterId,
          reassignedOwnerId: "associate_a",
          reason: "checkpoint expiry attestation queue drain stale reassignment attested",
        },
        "e19d44f0-91ab-4e22-a7f6-0b3c5d8e9a34"
      )
    expect(remediationSlaBreachResolutionCheckpointExpiryQueueDrainStaleReassignment.status).toBe(200)

    const remediationSlaBreachResolutionCheckpointExpiryQueueDrainForcedOverride = await postOpsReport(
      {
        action:
          "checkpoint_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_forced_drain_override",
        actorId: "partner_a",
        matterId,
        overrideNote: "forced drain override for overdue queue throughput",
        reason: "checkpoint expiry attestation queue drain forced override checkpointed",
      },
      "f29d44f0-91ab-4e22-a7f6-0b3c5d8e9a35"
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryQueueDrainForcedOverride.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryQueueDrainForcedOverrideJson =
      (await remediationSlaBreachResolutionCheckpointExpiryQueueDrainForcedOverride.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrain: {
            drainStatus: string
          }
        }
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryQueueDrainForcedOverrideJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrain.drainStatus
    ).toBe("forced_drain_checkpointed")

    const settlementPostResolutionVerification = await postOpsReport(
      {
        action:
          "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_post_resolution_verification",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO debt burndown settlement post-resolution verification checkpointed",
      },
      "a39d44f0-91ab-4e22-a7f6-0b3c5d8e9a36"
    )
    expect(settlementPostResolutionVerification.status).toBe(200)

    const settlementLockRelease = await postOpsReport(
      {
        action:
          "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_lock_release",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO debt burndown settlement lock release attested",
      },
      "b49d44f0-91ab-4e22-a7f6-0b3c5d8e9a37"
    )
    expect(settlementLockRelease.status).toBe(200)
    const settlementLockReleaseJson = (await settlementLockRelease.json()) as {
      result: {
        waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestation: {
          settlementAttestationStatus: string
        }
      }
    }
    expect(
      settlementLockReleaseJson.result.waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestation
        .settlementAttestationStatus
    ).toBe("settlement_verified")

    const queueDrainForcedReconciliation = await postOpsReport(
      {
        action:
          "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_forced_reconciliation",
        actorId: "partner_a",
        matterId,
        reason: "checkpoint expiry attestation queue drain forced reconciliation attested",
      },
      "c59d44f0-91ab-4e22-a7f6-0b3c5d8e9a38"
    )
    expect(queueDrainForcedReconciliation.status).toBe(200)
    const queueDrainForcedReconciliationJson = (await queueDrainForcedReconciliation.json()) as {
      result: {
        remediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliation: {
          reconciliationStatus: string
        }
      }
    }
    expect(
      queueDrainForcedReconciliationJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliation
        .reconciliationStatus
    ).toBe("forced_drain_attested")

    const queueDrainTimeoutReentry = await postOpsReport(
      {
        action:
          "control_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_timeout_reentry",
        actorId: "partner_a",
        matterId,
        timeoutReentryWindowHours: 6,
        reason: "checkpoint expiry attestation queue drain timeout reentry controlled",
      },
      "d69d44f0-91ab-4e22-a7f6-0b3c5d8e9a39"
    )
    expect(queueDrainTimeoutReentry.status).toBe(200)

    const settlementVerificationOverridePetition = await postOpsReport(
      {
        action:
          "petition_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_verification_override",
        actorId: "partner_a",
        matterId,
        overrideReason: "runtime settlement verification override petition",
        reason: "adjudication SLO settlement verification override petitioned",
      },
      "e79d44f0-91ab-4e22-a7f6-0b4c5d8e9a40"
    )
    expect(settlementVerificationOverridePetition.status).toBe(200)
    const settlementVerificationOverridePetitionJson =
      (await settlementVerificationOverridePetition.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitration: {
            settlementArbitrationStatus: string
          }
        }
      }
    expect(
      settlementVerificationOverridePetitionJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitration.settlementArbitrationStatus
    ).toBe("verification_override_petitioned")

    const settlementArbitrationPanelConfirmation = await postOpsReport(
      {
        action:
          "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_panel_confirmation",
        actorId: "partner_a",
        matterId,
        reason: "adjudication SLO settlement arbitration panel confirmation attested",
      },
      "f89d44f0-91ab-4e22-a7f6-0b4c5d8e9a41"
    )
    expect(settlementArbitrationPanelConfirmation.status).toBe(200)

    const settlementArbitrationFinalRuling = await postOpsReport(
      {
        action:
          "issue_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_final_ruling",
        actorId: "partner_a",
        matterId,
        rulingSummary: "runtime final ruling for disposition finalization",
        reason: "adjudication SLO settlement arbitration final ruling issued",
      },
      "b0ad550f-91ab-4e22-a7f6-0b4c5d8e9a50"
    )
    expect(settlementArbitrationFinalRuling.status).toBe(200)
    const settlementArbitrationFinalRulingJson = (await settlementArbitrationFinalRuling.json()) as {
      result: {
        waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalization: {
          dispositionFinalizationStatus: string
        }
      }
    }
    expect(
      settlementArbitrationFinalRulingJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalization
        .dispositionFinalizationStatus
    ).toBe("final_ruling_issued")

    const queueReentryException = await postOpsReport(
      {
        action:
          "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_exception",
        actorId: "partner_a",
        matterId,
        reason: "checkpoint expiry attestation queue reentry exception attested",
      },
      "a99d44f0-91ab-4e22-a7f6-0b4c5d8e9a42"
    )
    expect(queueReentryException.status).toBe(200)
    const queueReentryExceptionJson = (await queueReentryException.json()) as {
      result: {
        remediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliance: {
          complianceStatus: string
        }
      }
    }
    expect(
      queueReentryExceptionJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliance
        .complianceStatus
    ).toBe("reentry_exception_attested")

    const queueReentryTimeoutWaiver = await postOpsReport(
      {
        action:
          "checkpoint_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_timeout_waiver",
        actorId: "partner_a",
        matterId,
        waiverHours: 4,
        reason: "checkpoint expiry attestation queue reentry timeout waiver checkpointed",
      },
      "c0bd660f-91ab-4e22-a8f6-0b4c5d8e9a51"
    )
    expect(queueReentryTimeoutWaiver.status).toBe(200)

    const queueReentryReconciliationResume = await postOpsReport(
      {
        action:
          "control_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_reconciliation_resume",
        actorId: "partner_a",
        matterId,
        reason: "checkpoint expiry attestation queue reentry reconciliation resumed",
      },
      "d0cd770f-91ab-4e22-a9f6-0b4c5d8e9a52"
    )
    expect(queueReentryReconciliationResume.status).toBe(200)

    const queueReentryExceptionDebtAssign = await postOpsReport(
      {
        action:
          "assign_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_exception_debt",
        actorId: "partner_a",
        matterId,
        debtAssigneeId: "associate_a",
        reason: "checkpoint expiry attestation queue reentry exception debt assigned",
      },
      "e0dd880f-91ab-4e22-aaf6-0b4c5d8e9a53"
    )
    expect(queueReentryExceptionDebtAssign.status).toBe(200)
    const queueReentryExceptionDebtAssignJson = (await queueReentryExceptionDebtAssign.json()) as {
      result: {
        remediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirement: {
          debtRetirementStatus: string
        }
      }
    }
    expect(
      queueReentryExceptionDebtAssignJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirement
        .debtRetirementStatus
    ).toBe("exception_debt_assigned")

    const settlementArbitrationRulingPublication = await postOpsReport(
      {
        action:
          "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_ruling_publication",
        actorId: "partner_a",
        matterId,
        rulingPublicationChannel: "internal_panel_registry",
        reason: "adjudication SLO settlement arbitration ruling publication checkpointed",
      },
      "f1ae660f-91ab-4e22-a8f6-0b4c5d8e9a60"
    )
    expect(settlementArbitrationRulingPublication.status).toBe(200)

    const settlementArbitrationPublicationCorrection = await postOpsReport(
      {
        action:
          "log_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_publication_correction",
        actorId: "partner_a",
        matterId,
        correctionNote: "runtime publication correction for governance slice",
        reason: "adjudication SLO settlement arbitration publication correction logged",
      },
      "f2be770f-91ab-4e22-a9f6-0b4c5d8e9a61"
    )
    expect(settlementArbitrationPublicationCorrection.status).toBe(200)
    const settlementArbitrationPublicationCorrectionJson =
      (await settlementArbitrationPublicationCorrection.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernance: {
            publicationGovernanceStatus: string
            arbitrationPublicationExceptionBacklogCount: number
          }
        }
      }
    expect(
      settlementArbitrationPublicationCorrectionJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernance
        .publicationGovernanceStatus
    ).toBe("publication_correction_logged")
    expect(
      settlementArbitrationPublicationCorrectionJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernance
        .arbitrationPublicationExceptionBacklogCount
    ).toBeGreaterThanOrEqual(1)

    const queueReentryDebtRetirementAttest = await postOpsReport(
      {
        action:
          "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement",
        actorId: "partner_a",
        matterId,
        debtRetiredCount: 1,
        reason: "checkpoint expiry attestation queue reentry debt retirement attested",
      },
      "f3ce880f-91ab-4e22-aaf6-0b4c5d8e9a62"
    )
    expect(queueReentryDebtRetirementAttest.status).toBe(200)

    const queueReentryDebtRetirementDisputeOpen = await postOpsReport(
      {
        action:
          "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute",
        actorId: "partner_a",
        matterId,
        disputeReason: "runtime retirement dispute for reconciliation slice",
        reason: "checkpoint expiry attestation queue reentry debt retirement dispute opened",
      },
      "f4de990f-91ab-4e22-abf6-0b4c5d8e9a63"
    )
    expect(queueReentryDebtRetirementDisputeOpen.status).toBe(200)
    const queueReentryDebtRetirementDisputeOpenJson =
      (await queueReentryDebtRetirementDisputeOpen.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliation: {
            disputeReconciliationStatus: string
            queueReentryRetirementReconciliationDriftCount: number
          }
        }
      }
    expect(
      queueReentryDebtRetirementDisputeOpenJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliation
        .disputeReconciliationStatus
    ).toBe("retirement_dispute_opened")
    expect(
      queueReentryDebtRetirementDisputeOpenJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliation
        .queueReentryRetirementReconciliationDriftCount
    ).toBeGreaterThanOrEqual(1)

    const externalDistributionChannelRegister = await postOpsReport(
      {
        action:
          "register_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_channel",
        actorId: "partner_a",
        matterId,
        distributionChannelRegistry: "partner_external_registry_stub",
        reason: "adjudication SLO external distribution channel registered",
      },
      "f5efaa0f-91ab-4e22-acf7-0b4c5d8e9a64"
    )
    expect(externalDistributionChannelRegister.status).toBe(200)
    const externalDistributionChannelRegisterJson =
      (await externalDistributionChannelRegister.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedger: {
            externalDistributionAuditLedgerStatus: string
            distributionAttestationBacklogCount: number
          }
        }
      }
    expect(
      externalDistributionChannelRegisterJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedger
        .externalDistributionAuditLedgerStatus
    ).toBe("distribution_channel_registered")

    const externalDistributionSignerRoster = await postOpsReport(
      {
        action:
          "record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_attestation_signer_roster",
        actorId: "partner_a",
        matterId,
        attestationSignerRoster: "partner_a,clerk_a",
        reason: "adjudication SLO external distribution attestation signer roster recorded",
      },
      "f5efab1f-91ab-4e22-acf7-0b4c5d8e9a6a"
    )
    expect(externalDistributionSignerRoster.status).toBe(200)

    const externalDistributionPublicationFreeze = await postOpsReport(
      {
        action:
          "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_publication_freeze",
        actorId: "partner_a",
        matterId,
        publicationFreezeReason: "partner handoff slice publication freeze",
        reason: "adjudication SLO external distribution publication freeze checkpointed",
      },
      "f5efab2f-91ab-4e22-acf7-0b4c5d8e9a6b"
    )
    expect(externalDistributionPublicationFreeze.status).toBe(200)

    const partnerHandoffOutboundRegistry = await postOpsReport(
      {
        action:
          "register_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_partner_handoff_outbound_registry",
        actorId: "partner_a",
        matterId,
        outboundPartnerHandoffRegistry: "partner_handoff_outbound_registry_stub",
        reason: "adjudication SLO external distribution partner handoff outbound registry registered",
      },
      "f5efab3f-91ab-4e22-acf7-0b4c5d8e9a6c"
    )
    expect(partnerHandoffOutboundRegistry.status).toBe(200)
    const partnerHandoffOutboundRegistryJson = (await partnerHandoffOutboundRegistry.json()) as {
      result: {
        waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestation: {
          partnerHandoffAttestationStatus: string
          partnerHandoffBacklogCount: number
        }
      }
    }
    expect(
      partnerHandoffOutboundRegistryJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestation
        .partnerHandoffAttestationStatus
    ).toBe("outbound_registry_registered")
    expect(
      partnerHandoffOutboundRegistryJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestation
        .partnerHandoffBacklogCount
    ).toBeGreaterThanOrEqual(1)

    const partnerHandoffAttest = await postOpsReport(
      {
        action:
          "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_partner_handoff",
        actorId: "partner_a",
        matterId,
        partnerHandoffReference: "partner-handoff-ref-stub",
        reason: "adjudication SLO external distribution partner handoff attested",
      },
      "f5efab3a-91ab-4e22-acf7-0b4c5d8e9a6d"
    )
    expect(partnerHandoffAttest.status).toBe(200)

    const outboundRegistryAttestationLedgerCheckpoint = await postOpsReport(
      {
        action:
          "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_partner_handoff_outbound_registry_attestation_ledger",
        actorId: "partner_a",
        matterId,
        outboundAttestationLedgerReference: "outbound-attestation-ledger-stub",
        reason: "adjudication SLO external distribution outbound registry attestation ledger checkpointed",
      },
      "f5efab3b-91ab-4e22-acf7-0b4c5d8e9a6e"
    )
    expect(outboundRegistryAttestationLedgerCheckpoint.status).toBe(200)
    const outboundRegistryAttestationLedgerCheckpointJson =
      (await outboundRegistryAttestationLedgerCheckpoint.json()) as {
        result: {
          waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedger: {
            outboundRegistryAttestationLedgerStatus: string
          }
        }
      }
    expect(
      outboundRegistryAttestationLedgerCheckpointJson.result
        .waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedger
        .outboundRegistryAttestationLedgerStatus
    ).toBe("outbound_attestation_ledger_checkpointed")

    const outboundRegistryAttestationLedgerView = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledgers",
        actorId: "associate_a",
        matterId,
        outboundRegistryAttestationLedgerStatus: "outbound_attestation_ledger_checkpointed",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(outboundRegistryAttestationLedgerView.status).toBe(200)

    const queueReentryDebtRetirementDisputeResolve = await postOpsReport(
      {
        action:
          "resolve_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute",
        actorId: "partner_a",
        matterId,
        resolution: "uphold_retirement",
        reason: "checkpoint expiry attestation queue reentry debt retirement dispute resolved",
      },
      "f6ffbb1f-91ab-4e22-adf8-0b4c5d8e9a65"
    )
    expect(queueReentryDebtRetirementDisputeResolve.status).toBe(200)

    const disputeReconciliationClosureAttest = await postOpsReport(
      {
        action:
          "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure",
        actorId: "partner_a",
        matterId,
        reason: "checkpoint expiry attestation queue reentry debt retirement dispute reconciliation closure attested",
      },
      "f7aac21f-91ab-4e22-aef9-0b4c5d8e9a66"
    )
    expect(disputeReconciliationClosureAttest.status).toBe(200)
    const disputeReconciliationClosureAttestJson =
      (await disputeReconciliationClosureAttest.json()) as {
        result: {
          remediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerification: {
            closureVerificationStatus: string
          }
        }
      }
    expect(
      disputeReconciliationClosureAttestJson.result
        .remediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerification
        .closureVerificationStatus
    ).toBe("reconciliation_closure_attested")

    const remediationResolve = await postOpsReport(
      {
        action: "resolve_workflow_ops_alert_variance_remediation",
        actorId: "partner_a",
        matterId,
        reason: "remediation resolved",
      },
      "665f2411-4fcf-4af8-ad2e-4fc65f073ffc"
    )
    expect(remediationResolve.status).toBe(200)
    const remediationResolveJson = (await remediationResolve.json()) as {
      result: {
        remediationQueue: { queueStatus: string; ownerId: string | null }
        variance: { varianceStatus: string }
      }
    }
    expect(remediationResolveJson.result.remediationQueue.queueStatus).toBe("resolved")
    expect(remediationResolveJson.result.remediationQueue.ownerId).toBe("associate_a")
    expect(remediationResolveJson.result.variance.varianceStatus).toBe("variance_resolved")

    const remediationSlaResolve = await postOpsReport(
      {
        action: "resolve_workflow_ops_alert_variance_remediation_sla_ledger",
        actorId: "partner_a",
        matterId,
        reason: "SLA closure attested",
      },
      "29f19e95-e852-4715-ae54-5207d2e4354f"
    )
    expect(remediationSlaResolve.status).toBe(200)
    const remediationSlaResolveJson = (await remediationSlaResolve.json()) as {
      result: { remediationSlaLedger: { slaStatus: string; resolvedBy: string | null } }
    }
    expect(remediationSlaResolveJson.result.remediationSlaLedger.slaStatus).toBe("resolved")
    expect(remediationSlaResolveJson.result.remediationSlaLedger.resolvedBy).toBe("partner_a")

    const attestationView = await getOpsReport(
      new URLSearchParams({
        view: "alert_attestations",
        actorId: "associate_a",
        matterId,
        attestationStatus: "attested",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(attestationView.status).toBe(200)
    const attestationViewJson = (await attestationView.json()) as {
      items: Array<{ matterId: string; attestationStatus: string }>
    }
    expect(
      attestationViewJson.items.some(
        (row) => row.matterId === matterId && row.attestationStatus === "attested"
      )
    ).toBe(true)

    const escalationView = await getOpsReport(
      new URLSearchParams({
        view: "alert_escalation_ledgers",
        actorId: "associate_a",
        matterId,
        escalationStatus: "open",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(escalationView.status).toBe(200)
    const escalationViewJson = (await escalationView.json()) as {
      items: Array<{ matterId: string; escalationStatus: string }>
    }
    expect(
      escalationViewJson.items.some(
        (row) => row.matterId === matterId && row.escalationStatus === "open"
      )
    ).toBe(true)

    const disputeView = await getOpsReport(
      new URLSearchParams({
        view: "alert_attestation_disputes",
        actorId: "associate_a",
        matterId,
        disputeStatus: "resolved",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(disputeView.status).toBe(200)
    const disputeViewJson = (await disputeView.json()) as {
      items: Array<{ matterId: string; disputeStatus: string; reviewerId: string | null }>
    }
    expect(
      disputeViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.disputeStatus === "resolved" &&
          row.reviewerId === "associate_a"
      )
    ).toBe(true)

    const closureView = await getOpsReport(
      new URLSearchParams({
        view: "alert_escalation_closures",
        actorId: "associate_a",
        matterId,
        closureStatus: "reopened",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureView.status).toBe(200)
    const closureViewJson = (await closureView.json()) as {
      items: Array<{ matterId: string; closureStatus: string }>
    }
    expect(
      closureViewJson.items.some(
        (row) => row.matterId === matterId && row.closureStatus === "reopened"
      )
    ).toBe(true)

    const enforcementView = await getOpsReport(
      new URLSearchParams({
        view: "alert_dispute_enforcement_ledgers",
        actorId: "associate_a",
        matterId,
        enforcementStatus: "waived",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(enforcementView.status).toBe(200)
    const enforcementViewJson = (await enforcementView.json()) as {
      items: Array<{ matterId: string; enforcementStatus: string; ownerId: string | null }>
    }
    expect(
      enforcementViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.enforcementStatus === "waived" &&
          row.ownerId === "associate_a"
      )
    ).toBe(true)

    const reconciliationView = await getOpsReport(
      new URLSearchParams({
        view: "alert_closure_debt_reconciliation_digests",
        actorId: "associate_a",
        matterId,
        reconciliationStatus: "reconciled",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(reconciliationView.status).toBe(200)
    const reconciliationViewJson = (await reconciliationView.json()) as {
      items: Array<{ matterId: string; reconciliationStatus: string; outstandingDebtCount: number }>
    }
    expect(
      reconciliationViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.reconciliationStatus === "reconciled" &&
          row.outstandingDebtCount === 0
      )
    ).toBe(true)

    const enforcementAttestationView = await getOpsReport(
      new URLSearchParams({
        view: "alert_enforcement_attestations",
        actorId: "associate_a",
        matterId,
        enforcementAttestationStatus: "reopened",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(enforcementAttestationView.status).toBe(200)
    const enforcementAttestationViewJson = (await enforcementAttestationView.json()) as {
      items: Array<{ matterId: string; attestationStatus: string; lastAttestedBy: string | null }>
    }
    expect(
      enforcementAttestationViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.attestationStatus === "reopened" &&
          row.lastAttestedBy === "partner_a"
      )
    ).toBe(true)

    const varianceView = await getOpsReport(
      new URLSearchParams({
        view: "alert_closure_debt_variance_digests",
        actorId: "associate_a",
        matterId,
        varianceStatus: "variance_resolved",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(varianceView.status).toBe(200)
    const varianceViewJson = (await varianceView.json()) as {
      items: Array<{ matterId: string; varianceStatus: string; outstandingVarianceCount: number }>
    }
    expect(
      varianceViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.varianceStatus === "variance_resolved" &&
          row.outstandingVarianceCount === 0
      )
    ).toBe(true)

    const waiverView = await getOpsReport(
      new URLSearchParams({
        view: "alert_enforcement_waiver_ledgers",
        actorId: "associate_a",
        matterId,
        waiverStatus: "waived",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(waiverView.status).toBe(200)
    const waiverViewJson = (await waiverView.json()) as {
      items: Array<{ matterId: string; waiverStatus: string; waivedBy: string | null }>
    }
    expect(
      waiverViewJson.items.some(
        (row) => row.matterId === matterId && row.waiverStatus === "waived" && row.waivedBy === "partner_a"
      )
    ).toBe(true)

    const remediationQueueView = await getOpsReport(
      new URLSearchParams({
        view: "alert_variance_remediation_queues",
        actorId: "associate_a",
        matterId,
        remediationQueueStatus: "resolved",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(remediationQueueView.status).toBe(200)
    const remediationQueueViewJson = (await remediationQueueView.json()) as {
      items: Array<{ matterId: string; queueStatus: string; ownerId: string | null }>
    }
    expect(
      remediationQueueViewJson.items.some(
        (row) =>
          row.matterId === matterId && row.queueStatus === "resolved" && row.ownerId === "associate_a"
      )
    ).toBe(true)

    const waiverExpiryView = await getOpsReport(
      new URLSearchParams({
        view: "alert_waiver_expiry_digests",
        actorId: "associate_a",
        matterId,
        waiverExpiryStatus: "extended",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(waiverExpiryView.status).toBe(200)
    const waiverExpiryViewJson = (await waiverExpiryView.json()) as {
      items: Array<{ matterId: string; expiryStatus: string; extendedBy: string | null }>
    }
    expect(
      waiverExpiryViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.expiryStatus === "extended" &&
          row.extendedBy === "partner_a"
      )
    ).toBe(true)

    const remediationSlaView = await getOpsReport(
      new URLSearchParams({
        view: "alert_variance_remediation_sla_ledgers",
        actorId: "associate_a",
        matterId,
        remediationSlaStatus: "resolved",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(remediationSlaView.status).toBe(200)
    const remediationSlaViewJson = (await remediationSlaView.json()) as {
      items: Array<{ matterId: string; slaStatus: string; resolvedBy: string | null }>
    }
    expect(
      remediationSlaViewJson.items.some(
        (row) =>
          row.matterId === matterId && row.slaStatus === "resolved" && row.resolvedBy === "partner_a"
      )
    ).toBe(true)

    const waiverExpiryDisputeView = await getOpsReport(
      new URLSearchParams({
        view: "alert_waiver_expiry_disputes",
        actorId: "associate_a",
        matterId,
        waiverExpiryDisputeStatus: "resolved",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(waiverExpiryDisputeView.status).toBe(200)
    const waiverExpiryDisputeViewJson = (await waiverExpiryDisputeView.json()) as {
      items: Array<{ matterId: string; disputeStatus: string; reviewerId: string | null }>
    }
    expect(
      waiverExpiryDisputeViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.disputeStatus === "resolved" &&
          row.reviewerId === "associate_a"
      )
    ).toBe(true)

    const remediationSlaBreachEscalationView = await getOpsReport(
      new URLSearchParams({
        view: "alert_variance_remediation_sla_breach_escalations",
        actorId: "associate_a",
        matterId,
        remediationSlaBreachEscalationStatus: "resolved",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(remediationSlaBreachEscalationView.status).toBe(200)
    const remediationSlaBreachEscalationViewJson = (await remediationSlaBreachEscalationView.json()) as {
      items: Array<{ matterId: string; escalationStatus: string; ownerId: string | null }>
    }
    expect(
      remediationSlaBreachEscalationViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.escalationStatus === "resolved" &&
          row.ownerId === "associate_a"
      )
    ).toBe(true)

    const waiverExpiryDisputeAdjudicationView = await getOpsReport(
      new URLSearchParams({
        view: "alert_waiver_expiry_dispute_adjudications",
        actorId: "associate_a",
        matterId,
        waiverExpiryDisputeAdjudicationStatus: "resolved",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(waiverExpiryDisputeAdjudicationView.status).toBe(200)
    const waiverExpiryDisputeAdjudicationViewJson = (await waiverExpiryDisputeAdjudicationView.json()) as {
      items: Array<{ matterId: string; adjudicationStatus: string; panelOwnerId: string | null }>
    }
    expect(
      waiverExpiryDisputeAdjudicationViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.adjudicationStatus === "resolved" &&
          row.panelOwnerId === "associate_a"
      )
    ).toBe(true)

    const remediationSlaBreachResolutionCheckpointView = await getOpsReport(
      new URLSearchParams({
        view: "alert_variance_remediation_sla_breach_resolution_checkpoints",
        actorId: "associate_a",
        matterId,
        remediationSlaBreachResolutionCheckpointStatus: "reopened",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(remediationSlaBreachResolutionCheckpointView.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointViewJson =
      (await remediationSlaBreachResolutionCheckpointView.json()) as {
        items: Array<{ matterId: string; checkpointStatus: string; reopenPressureCount: number }>
      }
    expect(
      remediationSlaBreachResolutionCheckpointViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.checkpointStatus === "reopened" &&
          row.reopenPressureCount >= 1
      )
    ).toBe(true)

    const waiverExpiryDisputeAdjudicationSloView = await getOpsReport(
      new URLSearchParams({
        view: "alert_waiver_expiry_dispute_adjudication_slo_stewardships",
        actorId: "associate_a",
        matterId,
        waiverExpiryDisputeAdjudicationSloStatus: "breach_acknowledged",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(waiverExpiryDisputeAdjudicationSloView.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloViewJson =
      (await waiverExpiryDisputeAdjudicationSloView.json()) as {
        items: Array<{ matterId: string; sloStatus: string; stewardId: string | null }>
      }
    expect(
      waiverExpiryDisputeAdjudicationSloViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.sloStatus === "breach_acknowledged" &&
          row.stewardId === "partner_a"
      )
    ).toBe(true)

    const remediationSlaBreachResolutionCheckpointExpiryView = await getOpsReport(
      new URLSearchParams({
        view: "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations",
        actorId: "associate_a",
        matterId,
        remediationSlaBreachResolutionCheckpointExpiryAttestationStatus: "expiry_acknowledged",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryView.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryViewJson =
      (await remediationSlaBreachResolutionCheckpointExpiryView.json()) as {
        items: Array<{
          matterId: string
          attestationStatus: string
          expiryAcknowledgedBy: string | null
        }>
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.attestationStatus === "expiry_acknowledged" &&
          row.expiryAcknowledgedBy === "partner_a"
      )
    ).toBe(true)

    const waiverExpiryDisputeAdjudicationSloDebtView = await getOpsReport(
      new URLSearchParams({
        view: "alert_waiver_expiry_dispute_adjudication_slo_debt_remediations",
        actorId: "associate_a",
        matterId,
        waiverExpiryDisputeAdjudicationSloDebtStatus: "breach_closure_attested",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(waiverExpiryDisputeAdjudicationSloDebtView.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloDebtViewJson =
      (await waiverExpiryDisputeAdjudicationSloDebtView.json()) as {
        items: Array<{ matterId: string; debtStatus: string; breachClosureAttestedBy: string | null }>
      }
    expect(
      waiverExpiryDisputeAdjudicationSloDebtViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.debtStatus === "breach_closure_attested" &&
          row.breachClosureAttestedBy === "partner_a"
      )
    ).toBe(true)

    const remediationSlaBreachResolutionCheckpointExpiryExceptionView = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations",
        actorId: "associate_a",
        matterId,
        remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionStatus: "exception_reconciled",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryExceptionView.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryExceptionViewJson =
      (await remediationSlaBreachResolutionCheckpointExpiryExceptionView.json()) as {
        items: Array<{ matterId: string; exceptionStatus: string; reconciledBy: string | null }>
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryExceptionViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.exceptionStatus === "exception_reconciled" &&
          row.reconciledBy === "partner_a"
      )
    ).toBe(true)

    const waiverExpiryDisputeAdjudicationSloDebtBurndownView = await getOpsReport(
      new URLSearchParams({
        view: "alert_waiver_expiry_dispute_adjudication_slo_debt_burndowns",
        actorId: "associate_a",
        matterId,
        burndownStatus: "burndown_checkpointed",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(waiverExpiryDisputeAdjudicationSloDebtBurndownView.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloDebtBurndownViewJson =
      (await waiverExpiryDisputeAdjudicationSloDebtBurndownView.json()) as {
        items: Array<{
          matterId: string
          burndownStatus: string
          checkpointedBy: string | null
        }>
      }
    expect(
      waiverExpiryDisputeAdjudicationSloDebtBurndownViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.burndownStatus === "burndown_checkpointed" &&
          row.checkpointedBy === "partner_a"
      )
    ).toBe(true)

    const remediationSlaBreachResolutionCheckpointExpiryQueueView = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_orchestrations",
        actorId: "associate_a",
        matterId,
        queueStatus: "queue_auto_drained",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryQueueView.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryQueueViewJson =
      (await remediationSlaBreachResolutionCheckpointExpiryQueueView.json()) as {
        items: Array<{
          matterId: string
          queueStatus: string
          autoDrainCheckpointedBy: string | null
        }>
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryQueueViewJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.queueStatus === "queue_auto_drained" &&
          row.autoDrainCheckpointedBy === "partner_a"
      )
    ).toBe(true)

    const waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementView = await getOpsReport(
      new URLSearchParams({
        view: "alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlements",
        actorId: "associate_a",
        matterId,
        settlementStatus: "rollback_resolution_closed",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementView.status).toBe(200)
    const waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementViewJson =
      (await waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementView.json()) as {
        items: Array<{ matterId: string; settlementStatus: string }>
      }
    expect(
      waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementViewJson.items.some(
        (row) => row.matterId === matterId && row.settlementStatus === "rollback_resolution_closed"
      )
    ).toBe(true)

    const remediationSlaBreachResolutionCheckpointExpiryQueueDrainView = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drains",
        actorId: "associate_a",
        matterId,
        drainStatus: "forced_drain_checkpointed",
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(remediationSlaBreachResolutionCheckpointExpiryQueueDrainView.status).toBe(200)
    const remediationSlaBreachResolutionCheckpointExpiryQueueDrainViewJson =
      (await remediationSlaBreachResolutionCheckpointExpiryQueueDrainView.json()) as {
        items: Array<{ matterId: string; drainStatus: string }>
      }
    expect(
      remediationSlaBreachResolutionCheckpointExpiryQueueDrainViewJson.items.some(
        (row) => row.matterId === matterId && row.drainStatus === "forced_drain_checkpointed"
      )
    ).toBe(true)
  })

  it("lists custody handoff external transport receipt acknowledgment and reconciliation rows after governance seed", async () => {
    const matterId = seedOpsMatter("internal")
    const doc = uploadDocument(getRuntimeStore(), {
      firmId: "firmA",
      matterId,
      bytes: Buffer.from("%PDF-external-transport-ack%"),
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "a0b2157a-9f8c-4c4a-847f-772d8cbc2e5f",
    })
    const workflowTransition = await postWorkflow(
      {
        action: "transition",
        actorId: "associate_a",
        documentId: doc.docId,
        nextStatus: "processing",
      },
      "93e2b34e-48f3-4b17-a52b-c931fc7cdde9"
    )
    expect(workflowTransition.status).toBe(200)

    const res = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgments",
        actorId: "associate_a",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{
        matterId: string
        archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus: string
        externalTransportChannel: string
        provenanceTags: string[]
      }>
    }
    expect(
      json.items.some(
        (row) =>
          row.matterId === matterId &&
          row.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus ===
            "archival_export_custody_handoff_external_transport_receipt_acknowledgment_pending" &&
          row.externalTransportChannel === "blocked_todo_firm" &&
          row.provenanceTags.includes("transport_stub:true")
      )
    ).toBe(true)

    const reconciliationRes = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliations",
        actorId: "associate_a",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(reconciliationRes.status).toBe(200)
    const reconciliationJson = (await reconciliationRes.json()) as {
      items: Array<{
        matterId: string
        archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus: string
        externalTransportChannel: string
        provenanceTags: string[]
      }>
    }
    expect(
      reconciliationJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus ===
            "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_pending" &&
          row.externalTransportChannel === "blocked_todo_firm" &&
          row.provenanceTags.includes("transport_stub:true")
      )
    ).toBe(true)

    const ackReconAuditLedgerRes = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers",
        actorId: "associate_a",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(ackReconAuditLedgerRes.status).toBe(200)
    const ackReconAuditLedgerJson = (await ackReconAuditLedgerRes.json()) as {
      items: Array<{
        matterId: string
        externalDistributionAuditLedgerStatus: string
        externalTransportChannel: string
        provenanceTags: string[]
      }>
    }
    expect(
      ackReconAuditLedgerJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.externalDistributionAuditLedgerStatus ===
            "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending" &&
          row.externalTransportChannel === "blocked_todo_firm" &&
          row.provenanceTags.includes("transport_stub:true")
      )
    ).toBe(true)

    const ackReconPartnerHandoffRes = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestations",
        actorId: "associate_a",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(ackReconPartnerHandoffRes.status).toBe(200)
    const ackReconPartnerHandoffJson = (await ackReconPartnerHandoffRes.json()) as {
      items: Array<{
        matterId: string
        partnerHandoffAttestationStatus: string
        externalTransportChannel: string
        provenanceTags: string[]
      }>
    }
    expect(
      ackReconPartnerHandoffJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.partnerHandoffAttestationStatus ===
            "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending" &&
          row.externalTransportChannel === "blocked_todo_firm" &&
          row.provenanceTags.includes("transport_stub:true")
      )
    ).toBe(true)

    const ackReconAuditLedgerPartnerHandoffRes = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations",
        actorId: "associate_a",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(ackReconAuditLedgerPartnerHandoffRes.status).toBe(200)
    const ackReconAuditLedgerPartnerHandoffJson = (await ackReconAuditLedgerPartnerHandoffRes.json()) as {
      items: Array<{
        matterId: string
        partnerHandoffAttestationStatus: string
        externalTransportChannel: string
        provenanceTags: string[]
      }>
    }
    expect(
      ackReconAuditLedgerPartnerHandoffJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.partnerHandoffAttestationStatus ===
            "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_pending" &&
          row.externalTransportChannel === "blocked_todo_firm" &&
          row.provenanceTags.includes("transport_stub:true")
      )
    ).toBe(true)

    const ackReconOutboundRegistryLedgerRes = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledgers",
        actorId: "associate_a",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(ackReconOutboundRegistryLedgerRes.status).toBe(200)
    const ackReconOutboundRegistryLedgerJson = (await ackReconOutboundRegistryLedgerRes.json()) as {
      items: Array<{
        matterId: string
        outboundRegistryAttestationLedgerStatus: string
        externalTransportChannel: string
        provenanceTags: string[]
      }>
    }
    expect(
      ackReconOutboundRegistryLedgerJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.outboundRegistryAttestationLedgerStatus ===
            "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending" &&
          row.externalTransportChannel === "blocked_todo_firm" &&
          row.provenanceTags.includes("transport_stub:true")
      )
    ).toBe(true)

    const custodyAckReconSealVerificationTransportBoundaryRes = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations",
        actorId: "associate_a",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(custodyAckReconSealVerificationTransportBoundaryRes.status).toBe(200)
    const custodyAckReconSealVerificationTransportBoundaryJson =
      (await custodyAckReconSealVerificationTransportBoundaryRes.json()) as {
        items: Array<{
          matterId: string
          partnerDeliveryTransportBoundaryReceiptReconciliationStatus: string
          externalTransportChannel: string
          provenanceTags: string[]
        }>
      }
    expect(
      custodyAckReconSealVerificationTransportBoundaryJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.partnerDeliveryTransportBoundaryReceiptReconciliationStatus ===
            "transport_boundary_receipt_reconciliation_pending" &&
          row.externalTransportChannel === "blocked_todo_firm" &&
          row.provenanceTags.includes("transport_stub:true")
      )
    ).toBe(true)

    const closureAckReconSealVerificationTransportBoundaryRes = await getOpsReport(
      new URLSearchParams({
        view:
          "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations",
        actorId: "associate_a",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureAckReconSealVerificationTransportBoundaryRes.status).toBe(200)
    const closureAckReconSealVerificationTransportBoundaryJson =
      (await closureAckReconSealVerificationTransportBoundaryRes.json()) as {
        items: Array<{
          matterId: string
          partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus: string
          externalTransportChannel: string
          provenanceTags: string[]
        }>
      }
    expect(
      closureAckReconSealVerificationTransportBoundaryJson.items.some(
        (row) =>
          row.matterId === matterId &&
          row.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus ===
            "transport_boundary_receipt_reconciliation_closure_attestation_pending" &&
          row.externalTransportChannel === "blocked_todo_firm" &&
          row.provenanceTags.includes("transport_stub:true")
      )
    ).toBe(true)
  })
})
