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
        escalationStatus: "resolved",
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
  })
})
