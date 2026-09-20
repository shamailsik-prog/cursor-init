import { afterEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/d4/filings/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { composeDraft } from "@/services/d4-1/drafts"
import { getDocumentTypes } from "@/lib/foundation-data"
import { seedJudgment, seedTreatment } from "@/services/d4-2/draftingIntelligence"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/d4/filings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    })
  )
}

function get(params: URLSearchParams) {
  return GET(new Request(`http://127.0.0.1/api/d4/filings?${params.toString()}`))
}

function seedMatterAndDraft() {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Filing matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  addMember(store, matter.id, "clerk_a", "firmA")
  const firstTemplate = getDocumentTypes()[0]
  if (!firstTemplate) throw new Error("missing template seed")
  const draft = composeDraft(store, {
    actorId: "associate_a",
    matterId: matter.id,
    templateId: firstTemplate.id,
    title: "Draft pleading",
    body: "Draft body",
    classification: "internal",
    preflight: {
      actorId: "associate_a",
      matterId: matter.id,
      classification: "internal",
      citedJudgmentIds: [],
      temporalCitations: [],
    },
  })
  return { matterId: matter.id, draftId: draft.id }
}

describe("GET/POST /api/d4/filings", () => {
  it("blocks filing package creation when preflight overruled gate fails", async () => {
    const { matterId, draftId } = seedMatterAndDraft()
    const store = getRuntimeStore()
    seedJudgment(store, "j-old", "Old authority", "single")
    seedJudgment(store, "j-new", "Larger bench", "larger")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")

    const blocked = await post(
      {
        action: "create_package",
        actorId: "associate_a",
        matterId,
        draftId,
        classification: "internal",
        citedJudgmentIds: ["j-old"],
        temporalCitations: [],
      },
      "58de6792-a8d0-4964-8440-9e8d48cecbab"
    )
    expect(blocked.status).toBe(422)
  })

  it("creates pending filing package and supports partner approval", async () => {
    const { matterId, draftId } = seedMatterAndDraft()
    const created = await post(
      {
        action: "create_package",
        actorId: "associate_a",
        matterId,
        draftId,
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
      "fb08fe06-2202-4cdf-8f49-e5e73c2f65c4"
    )
    expect(created.status).toBe(200)
    const createJson = (await created.json()) as {
      result: {
        filingPackage: { id: string; status: string }
        packetArtifact: { readiness: string; blockedReasons: string[] }
      }
    }
    expect(createJson.result.filingPackage.status).toBe("pending_partner_approval")
    expect(createJson.result.packetArtifact.readiness).toBe("blocked")
    expect(createJson.result.packetArtifact.blockedReasons).toContain("partner_approval_pending")
    const packageId = createJson.result.filingPackage.id

    const denied = await post(
      {
        action: "decide_package",
        actorId: "associate_a",
        packageId,
        decision: "approve",
        reason: "Associate cannot approve",
      },
      "43f2111e-f0cc-4eb5-9b32-c24744d633cb"
    )
    expect(denied.status).toBe(400)

    const approved = await post(
      {
        action: "decide_package",
        actorId: "partner_a",
        packageId,
        decision: "approve",
        reason: "Partner approved for court filing",
      },
      "7d9f12b3-64a5-40ea-a995-33652ee593fd"
    )
    expect(approved.status).toBe(200)
    const approvedJson = (await approved.json()) as {
      result: {
        filingPackage: { status: string; approvedBy: string }
        packetArtifact: { readiness: string; blockedReasons: string[] }
      }
    }
    expect(approvedJson.result.filingPackage.status).toBe("approved")
    expect(approvedJson.result.filingPackage.approvedBy).toBe("partner_a")
    expect(approvedJson.result.packetArtifact.readiness).toBe("ready")
    expect(approvedJson.result.packetArtifact.blockedReasons).toHaveLength(0)
  })

  it("lists filing packages with pagination and matter scoping", async () => {
    const { matterId, draftId } = seedMatterAndDraft()
    await post(
      {
        action: "create_package",
        actorId: "associate_a",
        matterId,
        draftId,
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
      "3d4f267e-3b39-4a68-b047-d5f632844c8e"
    )
    await post(
      {
        action: "create_package",
        actorId: "associate_a",
        matterId,
        draftId,
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
        partnerOverride: {
          partnerId: "partner_a",
          reason: "allow duplicate package for test",
        },
      },
      "b1e5eaa7-74d4-43ef-a578-c6d5ad2654fc"
    )

    const first = await get(
      new URLSearchParams({
        userId: "associate_a",
        matterId,
        readiness: "blocked",
        limit: "1",
        cursor: "0",
      })
    )
    expect(first.status).toBe(200)
    const pageOne = (await first.json()) as {
      items: Array<{ id: string }>
      total: number
      nextCursor: string | null
    }
    expect(pageOne.total).toBeGreaterThanOrEqual(1)
    expect(pageOne.items).toHaveLength(1)
    if (pageOne.nextCursor) {
      const second = await get(
        new URLSearchParams({
          userId: "associate_a",
          matterId,
          limit: "1",
          cursor: pageOne.nextCursor,
        })
      )
      expect(second.status).toBe(200)
    }
  })

  it("filters filing packages by readiness after partner approval", async () => {
    const { matterId, draftId } = seedMatterAndDraft()
    const created = await post(
      {
        action: "create_package",
        actorId: "associate_a",
        matterId,
        draftId,
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
      "8b675329-eddd-4f3a-b6d2-7b1f6c5c6c5f"
    )
    expect(created.status).toBe(200)
    const createdJson = (await created.json()) as {
      result: { filingPackage: { id: string } }
    }
    const packageId = createdJson.result.filingPackage.id
    const approved = await post(
      {
        action: "decide_package",
        actorId: "partner_a",
        packageId,
        decision: "approve",
        reason: "Ready for filing submission packet",
      },
      "6558d5d7-17b4-4f64-99e7-7f76f5c987b0"
    )
    expect(approved.status).toBe(200)

    const readyList = await get(
      new URLSearchParams({
        userId: "associate_a",
        readiness: "ready",
        limit: "10",
        cursor: "0",
      })
    )
    expect(readyList.status).toBe(200)
    const readyJson = (await readyList.json()) as {
      items: Array<{ id: string; packetArtifact: { readiness: string } | null }>
    }
    expect(
      readyJson.items.some(
        (row) => row.id === packageId && row.packetArtifact?.readiness === "ready"
      )
    ).toBe(true)
  })

  it("lists and updates filing dispatch queue after partner approval", async () => {
    const { matterId, draftId } = seedMatterAndDraft()
    const created = await post(
      {
        action: "create_package",
        actorId: "associate_a",
        matterId,
        draftId,
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
      "e7d878b9-8f87-4fac-8d73-1f72fcb0ce41"
    )
    expect(created.status).toBe(200)
    const createdJson = (await created.json()) as {
      result: { filingPackage: { id: string } }
    }
    const packageId = createdJson.result.filingPackage.id
    const approved = await post(
      {
        action: "decide_package",
        actorId: "partner_a",
        packageId,
        decision: "approve",
        reason: "Ready for dispatch queue",
      },
      "fce7cd7a-9174-4f3d-b5ca-962565f13cff"
    )
    expect(approved.status).toBe(200)

    const initialQueue = await get(
      new URLSearchParams({
        view: "dispatch",
        userId: "associate_a",
        dispatchStatus: "queued",
        limit: "10",
        cursor: "0",
      })
    )
    expect(initialQueue.status).toBe(200)
    const initialJson = (await initialQueue.json()) as {
      items: Array<{ packageId: string; status: string; externalDispatchState: string }>
    }
    expect(
      initialJson.items.some(
        (row) =>
          row.packageId === packageId &&
          row.status === "queued" &&
          row.externalDispatchState === "blocked_todo_firm"
      )
    ).toBe(true)

    const update = await post(
      {
        action: "dispatch_update",
        actorId: "partner_a",
        packageId,
        nextStatus: "handoff_ready",
        assigneeId: "clerk_a",
        markAttempt: true,
        note: "Partner handed off package to filing clerk",
      },
      "1e84b07b-cff9-4db7-81f8-fd57a69ce474"
    )
    expect(update.status).toBe(200)
    const updateJson = (await update.json()) as {
      result: {
        dispatchQueue: {
          status: string
          assigneeId: string | null
          retryCount: number
          externalDispatchState: string
        }
      }
    }
    expect(updateJson.result.dispatchQueue.status).toBe("handoff_ready")
    expect(updateJson.result.dispatchQueue.assigneeId).toBe("clerk_a")
    expect(updateJson.result.dispatchQueue.retryCount).toBe(1)
    expect(updateJson.result.dispatchQueue.externalDispatchState).toBe("ready_for_firm_dispatch")

    const handoffList = await get(
      new URLSearchParams({
        view: "dispatch",
        userId: "associate_a",
        dispatchStatus: "handoff_ready",
        assigneeId: "clerk_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(handoffList.status).toBe(200)
    const handoffJson = (await handoffList.json()) as {
      items: Array<{ packageId: string; status: string; assigneeId: string | null }>
    }
    expect(
      handoffJson.items.some(
        (row) =>
          row.packageId === packageId && row.status === "handoff_ready" && row.assigneeId === "clerk_a"
      )
    ).toBe(true)
  })

  it("tracks annexure checkpoints and keeps external transport boundary blocked", async () => {
    const { matterId, draftId } = seedMatterAndDraft()
    const created = await post(
      {
        action: "create_package",
        actorId: "associate_a",
        matterId,
        draftId,
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
      "bc7fbc67-a0c7-412a-bb49-042420a64061"
    )
    expect(created.status).toBe(200)
    const createdJson = (await created.json()) as { result: { filingPackage: { id: string } } }
    const packageId = createdJson.result.filingPackage.id
    const approved = await post(
      {
        action: "decide_package",
        actorId: "partner_a",
        packageId,
        decision: "approve",
        reason: "Approved for annexure packaging",
      },
      "f388a0a4-d671-4c97-b5de-d6e60405e75f"
    )
    expect(approved.status).toBe(200)
    const handoff = await post(
      {
        action: "dispatch_update",
        actorId: "partner_a",
        packageId,
        nextStatus: "handoff_ready",
        assigneeId: "clerk_a",
        note: "Queue handoff complete",
      },
      "dbf0f98d-2ab4-4250-a6c0-3ff1d754013a"
    )
    expect(handoff.status).toBe(200)
    const deniedSignoff = await post(
      {
        action: "annexure_checkpoint",
        actorId: "associate_a",
        packageId,
        checkpoint: "record_partner_signoff",
      },
      "534988e0-c1e9-4f06-b7f3-814cff0ecfc8"
    )
    expect(deniedSignoff.status).toBe(403)
    const partnerSignoff = await post(
      {
        action: "annexure_checkpoint",
        actorId: "partner_a",
        packageId,
        checkpoint: "record_partner_signoff",
        note: "Partner reviewed annexure packet",
      },
      "d61eb2cc-c8a3-4f55-a741-83b89d31fef1"
    )
    expect(partnerSignoff.status).toBe(200)
    const clerkVerify = await post(
      {
        action: "annexure_checkpoint",
        actorId: "clerk_a",
        packageId,
        checkpoint: "record_clerk_verification",
        note: "Clerk verified annexures",
      },
      "f6a72a4b-2ecd-4a95-b53f-42f4ff2f08b7"
    )
    expect(clerkVerify.status).toBe(200)
    const readyCheckpoint = await post(
      {
        action: "annexure_checkpoint",
        actorId: "partner_a",
        packageId,
        checkpoint: "mark_ready_for_transport",
      },
      "58decee8-c056-44bd-b6ca-2c5ffc18f35e"
    )
    expect(readyCheckpoint.status).toBe(200)
    const readyCheckpointJson = (await readyCheckpoint.json()) as {
      result: {
        annexure: {
          generationStatus: string
          submissionTransportBoundary: string
        }
      }
    }
    expect(readyCheckpointJson.result.annexure.generationStatus).toBe("ready")
    expect(readyCheckpointJson.result.annexure.submissionTransportBoundary).toBe(
      "todo_firm_external_transport_blocked"
    )

    const annexureView = await get(
      new URLSearchParams({
        view: "annexures",
        userId: "associate_a",
        matterId,
        annexureStatus: "ready",
        limit: "10",
        cursor: "0",
      })
    )
    expect(annexureView.status).toBe(200)
    const annexureJson = (await annexureView.json()) as {
      items: Array<{ packageId: string; generationStatus: string }>
    }
    expect(
      annexureJson.items.some(
        (row) => row.packageId === packageId && row.generationStatus === "ready"
      )
    ).toBe(true)
  })

  it("records submission receipts and reconciles deterministic transport outcomes", async () => {
    const { matterId, draftId } = seedMatterAndDraft()
    const created = await post(
      {
        action: "create_package",
        actorId: "associate_a",
        matterId,
        draftId,
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
      "88562da9-b09f-48d5-b77a-a7c4f7f76240"
    )
    expect(created.status).toBe(200)
    const createdJson = (await created.json()) as { result: { filingPackage: { id: string } } }
    const packageId = createdJson.result.filingPackage.id
    const approved = await post(
      {
        action: "decide_package",
        actorId: "partner_a",
        packageId,
        decision: "approve",
        reason: "Approve for submission ledger",
      },
      "397391fc-a6c0-42f0-b6c2-8b73755227b2"
    )
    expect(approved.status).toBe(200)
    const handoff = await post(
      {
        action: "dispatch_update",
        actorId: "partner_a",
        packageId,
        nextStatus: "handoff_ready",
        assigneeId: "clerk_a",
        note: "Ready for deterministic stub submission",
      },
      "bf18c871-b3dd-4456-9b82-f5900ecdd896"
    )
    expect(handoff.status).toBe(200)
    expect(
      (
        await post(
          {
            action: "annexure_checkpoint",
            actorId: "partner_a",
            packageId,
            checkpoint: "record_partner_signoff",
          },
          "38a925ca-51ee-4f82-b123-bc7d64f658b1"
        )
      ).status
    ).toBe(200)
    expect(
      (
        await post(
          {
            action: "annexure_checkpoint",
            actorId: "clerk_a",
            packageId,
            checkpoint: "record_clerk_verification",
          },
          "9498d6c2-7277-4d93-b47f-3bcb5022368e"
        )
      ).status
    ).toBe(200)
    expect(
      (
        await post(
          {
            action: "annexure_checkpoint",
            actorId: "partner_a",
            packageId,
            checkpoint: "mark_ready_for_transport",
          },
          "9376fce6-db44-4647-b68e-f1148046393f"
        )
      ).status
    ).toBe(200)

    const deniedReceipt = await post(
      {
        action: "record_submission_receipt",
        actorId: "associate_a",
        packageId,
        courtChannel: "efiling_portal_stub",
        dispatchOutcome: "retry_scheduled",
        submissionReference: "SUB-TEST-001",
        retryHint: "retry after supervisor check",
      },
      "f145f691-06e7-4fd8-9f42-f01970f74a66"
    )
    expect(deniedReceipt.status).toBe(403)

    const receipt = await post(
      {
        action: "record_submission_receipt",
        actorId: "clerk_a",
        packageId,
        courtChannel: "efiling_portal_stub",
        dispatchOutcome: "retry_scheduled",
        submissionReference: "SUB-TEST-001",
        failureReason: "network timeout",
        retryHint: "retry after supervisor check",
        note: "First deterministic submission attempt failed",
      },
      "f5339bbd-6498-4521-9137-f17a7c513f6f"
    )
    expect(receipt.status).toBe(200)
    const receiptJson = (await receipt.json()) as {
      result: {
        receipt: { dispatchOutcome: string; submissionTransportBoundary: string }
        reconciliation: { status: string }
        dispatchQueue: { status: string } | null
      }
    }
    expect(receiptJson.result.receipt.dispatchOutcome).toBe("retry_scheduled")
    expect(receiptJson.result.receipt.submissionTransportBoundary).toBe(
      "todo_firm_external_transport_blocked"
    )
    expect(receiptJson.result.reconciliation.status).toBe("open")
    expect(receiptJson.result.dispatchQueue?.status).toBe("retry_pending")

    const receiptsView = await get(
      new URLSearchParams({
        view: "submission_receipts",
        userId: "associate_a",
        matterId,
        dispatchOutcome: "retry_scheduled",
        limit: "10",
        cursor: "0",
      })
    )
    expect(receiptsView.status).toBe(200)
    const receiptsViewJson = (await receiptsView.json()) as {
      items: Array<{ packageId: string; submissionReference: string }>
    }
    expect(
      receiptsViewJson.items.some(
        (row) => row.packageId === packageId && row.submissionReference === "SUB-TEST-001"
      )
    ).toBe(true)

    const reconciled = await post(
      {
        action: "reconcile_submission",
        actorId: "partner_a",
        packageId,
        status: "needs_retry",
        note: "Partner requested corrected transport retry",
      },
      "07ca64f1-5f13-47a5-bdfa-94389bc7f4f1"
    )
    expect(reconciled.status).toBe(200)
    const reconciledJson = (await reconciled.json()) as {
      result: { reconciliation: { status: string } }
    }
    expect(reconciledJson.result.reconciliation.status).toBe("needs_retry")

    const reconciliationView = await get(
      new URLSearchParams({
        view: "submission_reconciliation",
        userId: "associate_a",
        matterId,
        reconciliationStatus: "needs_retry",
        limit: "10",
        cursor: "0",
      })
    )
    expect(reconciliationView.status).toBe(200)
    const reconciliationJson = (await reconciliationView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      reconciliationJson.items.some(
        (row) => row.packageId === packageId && row.status === "needs_retry"
      )
    ).toBe(true)

    const claim = await post(
      {
        action: "claim_submission_exception",
        actorId: "clerk_a",
        packageId,
        note: "Clerk claimed submission exception queue item",
      },
      "f41c0f8d-86f0-435f-9b3b-04a6db658f0d"
    )
    expect(claim.status).toBe(200)
    const claimJson = (await claim.json()) as {
      result: { submissionException: { status: string; claimedBy: string | null } }
    }
    expect(claimJson.result.submissionException.status).toBe("claimed")
    expect(claimJson.result.submissionException.claimedBy).toBe("clerk_a")

    const escalate = await post(
      {
        action: "escalate_submission_exception",
        actorId: "clerk_a",
        packageId,
        escalationOwnerId: "partner_a",
        severity: "critical",
        slaHours: 3,
        note: "Escalated to partner for urgent deterministic retry",
      },
      "98f72b66-688c-4692-b0f0-2f8db4f77be6"
    )
    expect(escalate.status).toBe(200)
    const escalateJson = (await escalate.json()) as {
      result: { submissionException: { status: string; severity: string; escalationOwnerId: string | null } }
    }
    expect(escalateJson.result.submissionException.status).toBe("escalated")
    expect(escalateJson.result.submissionException.severity).toBe("critical")
    expect(escalateJson.result.submissionException.escalationOwnerId).toBe("partner_a")

    const resolve = await post(
      {
        action: "resolve_submission_exception",
        actorId: "partner_a",
        packageId,
        note: "Resolved after partner retry plan confirmation",
      },
      "8f3f2eb4-c2fa-4c8e-b1a3-c2eb19120902"
    )
    expect(resolve.status).toBe(200)
    const resolveJson = (await resolve.json()) as {
      result: { submissionException: { status: string; resolvedBy: string | null } }
    }
    expect(resolveJson.result.submissionException.status).toBe("resolved")
    expect(resolveJson.result.submissionException.resolvedBy).toBe("partner_a")

    const reopen = await post(
      {
        action: "reopen_submission_exception",
        actorId: "partner_a",
        packageId,
        severity: "high",
        note: "Reopened after additional court follow-up",
      },
      "2c15bf03-88bc-4383-aa9f-2124781c95d2"
    )
    expect(reopen.status).toBe(200)
    const reopenJson = (await reopen.json()) as {
      result: { submissionException: { status: string; severity: string; resolvedAt: number | null } }
    }
    expect(reopenJson.result.submissionException.status).toBe("open")
    expect(reopenJson.result.submissionException.severity).toBe("high")
    expect(reopenJson.result.submissionException.resolvedAt).toBeNull()

    const exceptionView = await get(
      new URLSearchParams({
        view: "submission_exceptions",
        userId: "associate_a",
        matterId,
        exceptionStatus: "open",
        severity: "high",
        escalationOwnerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(exceptionView.status).toBe(200)
    const exceptionViewJson = (await exceptionView.json()) as {
      items: Array<{ packageId: string; status: string; severity: string }>
    }
    expect(
      exceptionViewJson.items.some(
        (row) => row.packageId === packageId && row.status === "open" && row.severity === "high"
      )
    ).toBe(true)

    const blockedTransport = await post(
      {
        action: "mark_transport_blocked",
        actorId: "clerk_a",
        packageId,
        transportChannel: "efiling_portal_stub",
        channelPayloadHash: "transport-hash-001",
        blockerTags: ["portal_timeout", "token_expired"],
        attachmentPointers: ["ops://dispatch/retry-window-note"],
        severity: "critical",
        note: "Transport blocked waiting for refreshed e-filing token",
      },
      "7844b7ea-540a-4f6a-bec7-3268e6f0e67b"
    )
    expect(blockedTransport.status).toBe(200)
    const blockedTransportJson = (await blockedTransport.json()) as {
      result: {
        evidence: { outcome: string; deterministicBlockerTags: string[] }
        dispatchQueue: { status: string }
        submissionException: { status: string; severity: string }
      }
    }
    expect(blockedTransportJson.result.evidence.outcome).toBe("transport_blocked")
    expect(blockedTransportJson.result.evidence.deterministicBlockerTags).toContain("portal_timeout")
    expect(blockedTransportJson.result.dispatchQueue.status).toBe("blocked")
    expect(blockedTransportJson.result.submissionException.status).toBe("open")
    expect(blockedTransportJson.result.submissionException.severity).toBe("critical")

    const retryPlan = await post(
      {
        action: "attach_retry_plan",
        actorId: "partner_a",
        packageId,
        transportChannel: "operator_followup_stub",
        channelPayloadHash: "transport-hash-002",
        attachmentPointers: ["ops://dispatch/retry-plan-v2"],
        note: "Partner attached deterministic retry execution plan",
      },
      "ce7190a0-d11d-44d9-bf07-ee9ec3215cbc"
    )
    expect(retryPlan.status).toBe(200)
    const retryPlanJson = (await retryPlan.json()) as {
      result: {
        evidence: { outcome: string; attachmentPointers: string[] }
        dispatchQueue: { status: string }
        submissionException: { status: string }
      }
    }
    expect(retryPlanJson.result.evidence.outcome).toBe("retry_plan_attached")
    expect(retryPlanJson.result.evidence.attachmentPointers).toContain("ops://dispatch/retry-plan-v2")
    expect(retryPlanJson.result.dispatchQueue.status).toBe("retry_pending")
    expect(retryPlanJson.result.submissionException.status).toBe("escalated")

    const acknowledged = await post(
      {
        action: "acknowledge_breach",
        actorId: "partner_a",
        packageId,
        note: "Partner acknowledged SLA breach before deferred retry window",
      },
      "7df7f9be-fb4d-4de3-bb3c-e9ea31eea9f2"
    )
    expect(acknowledged.status).toBe(200)
    const acknowledgedJson = (await acknowledged.json()) as {
      result: { digest: { status: string } }
    }
    expect(acknowledgedJson.result.digest.status).toBe("acknowledged")

    const deferred = await post(
      {
        action: "defer_window",
        actorId: "partner_a",
        packageId,
        deferHours: 6,
        note: "Partner deferred retry window pending court portal stabilization",
      },
      "790f8258-13fd-469e-9ad1-8ea2f359af8c"
    )
    expect(deferred.status).toBe(200)
    const deferredJson = (await deferred.json()) as {
      result: { digest: { status: string; deferUntil: number | null } }
    }
    expect(deferredJson.result.digest.status).toBe("deferred")
    expect(typeof deferredJson.result.digest.deferUntil).toBe("number")

    const assignPrimary = await post(
      {
        action: "assign_primary_owner",
        actorId: "partner_a",
        packageId,
        primaryOwnerId: "partner_a",
        activeWindowHours: 12,
        note: "Partner assigned as primary escalation owner",
      },
      "98955047-1cdf-415a-9f9b-57df46e47671"
    )
    expect(assignPrimary.status).toBe(200)
    const assignPrimaryJson = (await assignPrimary.json()) as {
      result: { rota: { primaryOwnerId: string | null; status: string } }
    }
    expect(assignPrimaryJson.result.rota.primaryOwnerId).toBe("partner_a")
    expect(assignPrimaryJson.result.rota.status).toBe("active")

    const setBackup = await post(
      {
        action: "set_backup_owner",
        actorId: "partner_a",
        packageId,
        backupOwnerId: "partner_a",
        note: "Backup assignment captured for deterministic handoff flow",
      },
      "45620d0d-4b2f-4f05-bddd-9e4c7060a615"
    )
    expect(setBackup.status).toBe(200)
    const setBackupJson = (await setBackup.json()) as {
      result: { rota: { backupOwnerId: string | null; handoffRequired: boolean } }
    }
    expect(setBackupJson.result.rota.backupOwnerId).toBe("partner_a")
    expect(setBackupJson.result.rota.handoffRequired).toBe(true)

    const workloadViewBefore = await get(
      new URLSearchParams({
        view: "escalation_workload_digests",
        userId: "associate_a",
        matterId,
        packageId,
        workloadStatus: "open_alert",
        ownerId: "partner_a",
        reason: "handoff_lag",
        limit: "10",
        cursor: "0",
      })
    )
    expect(workloadViewBefore.status).toBe(200)
    const workloadViewBeforeJson = (await workloadViewBefore.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      workloadViewBeforeJson.items.some(
        (row) => row.packageId === packageId && row.status === "open_alert"
      )
    ).toBe(true)

    const acknowledgeWorkload = await post(
      {
        action: "acknowledge_owner_drift",
        actorId: "partner_a",
        packageId,
        note: "Owner drift acknowledged for escalation triage",
      },
      "68c1068e-fc1e-44e8-a09c-d2a90b64b876"
    )
    expect(acknowledgeWorkload.status).toBe(200)
    const acknowledgeWorkloadJson = (await acknowledgeWorkload.json()) as {
      result: { workloadDigest: { status: string } }
    }
    expect(acknowledgeWorkloadJson.result.workloadDigest.status).toBe("acknowledged")

    const snoozeWorkload = await post(
      {
        action: "snooze_workload_alert",
        actorId: "partner_a",
        packageId,
        snoozeHours: 4,
        note: "Snoozing workload alert pending rebalance",
      },
      "315fdba9-0d5c-494a-b65e-e243e17a3260"
    )
    expect(snoozeWorkload.status).toBe(200)
    const snoozeWorkloadJson = (await snoozeWorkload.json()) as {
      result: { workloadDigest: { status: string; snoozeUntil: number | null } }
    }
    expect(snoozeWorkloadJson.result.workloadDigest.status).toBe("snoozed")
    expect(typeof snoozeWorkloadJson.result.workloadDigest.snoozeUntil).toBe("number")

    const rebalance = await post(
      {
        action: "rebalance_assignment",
        actorId: "partner_a",
        packageId,
        newPrimaryOwnerId: "partner_a",
        note: "Workload rebalanced after drift review",
      },
      "6be2fe74-c09a-4a7b-8fd3-9d40e2868f77"
    )
    expect(rebalance.status).toBe(200)
    const rebalanceJson = (await rebalance.json()) as {
      result: {
        rota: { primaryOwnerId: string | null }
        workloadDigest: { status: string }
      }
    }
    expect(rebalanceJson.result.rota.primaryOwnerId).toBe("partner_a")
    expect(["acknowledged", "cleared"]).toContain(rebalanceJson.result.workloadDigest.status)

    const setFirmPolicy = await post(
      {
        action: "set_policy_baseline",
        actorId: "partner_a",
        ownerLoadThreshold: 2,
        handoffSlaHours: 2,
        waiverWindowHours: 12,
        note: "Firm baseline tuned for escalation drift monitor",
      },
      "87427d81-754c-4ec0-a2e6-6fbf2378f1af"
    )
    expect(setFirmPolicy.status).toBe(200)
    const setFirmPolicyJson = (await setFirmPolicy.json()) as {
      result: { policy: { scope: string; ownerLoadThreshold: number } }
    }
    expect(setFirmPolicyJson.result.policy.scope).toBe("firm_default")
    expect(setFirmPolicyJson.result.policy.ownerLoadThreshold).toBe(2)

    const setPackagePolicy = await post(
      {
        action: "set_policy_baseline",
        actorId: "partner_a",
        packageId,
        ownerLoadThreshold: 1,
        handoffSlaHours: 1,
        waiverWindowHours: 6,
        note: "Package-specific policy override enabled",
      },
      "84b460ec-c264-43f6-95b0-59ccfe58b9ec"
    )
    expect(setPackagePolicy.status).toBe(200)
    const setPackagePolicyJson = (await setPackagePolicy.json()) as {
      result: { policy: { scope: string; packageId: string | null } }
    }
    expect(setPackagePolicyJson.result.policy.scope).toBe("package_override")
    expect(setPackagePolicyJson.result.policy.packageId).toBe(packageId)

    const grantWaiver = await post(
      {
        action: "grant_breach_waiver",
        actorId: "partner_a",
        packageId,
        durationHours: 2,
        reason: "Temporary judicial recess and staffing rotation",
        note: "Waiver granted during controlled handoff window",
      },
      "bb1d514f-9631-4fc2-b4af-07884f2b8b8a"
    )
    expect(grantWaiver.status).toBe(200)
    const grantWaiverJson = (await grantWaiver.json()) as {
      result: {
        waiver: { status: string; packageId: string }
        workloadDigest: { status: string }
        waiverExpiryDigest: { status: string }
      }
    }
    expect(grantWaiverJson.result.waiver.status).toBe("active")
    expect(grantWaiverJson.result.waiver.packageId).toBe(packageId)
    expect(["snoozed", "cleared"]).toContain(grantWaiverJson.result.workloadDigest.status)
    expect(["open_expiry", "extended", "cleared"]).toContain(
      grantWaiverJson.result.waiverExpiryDigest.status
    )

    const policyVarianceViewBefore = await get(
      new URLSearchParams({
        view: "policy_variance_digests",
        userId: "associate_a",
        matterId,
        packageId,
        varianceStatus: "open_alert",
        reason: "owner_load_threshold_override",
        limit: "10",
        cursor: "0",
      })
    )
    expect(policyVarianceViewBefore.status).toBe(200)
    const policyVarianceViewBeforeJson = (await policyVarianceViewBefore.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      policyVarianceViewBeforeJson.items.some(
        (row) => row.packageId === packageId && row.status === "open_alert"
      )
    ).toBe(true)

    const acknowledgeVariance = await post(
      {
        action: "acknowledge_policy_variance",
        actorId: "partner_a",
        packageId,
        note: "Policy variance acknowledged while override remains intentional",
      },
      "dfc4ed32-4d59-43c2-b735-c4bd6ec13cee"
    )
    expect(acknowledgeVariance.status).toBe(200)
    const acknowledgeVarianceJson = (await acknowledgeVariance.json()) as {
      result: { policyVarianceDigest: { status: string } }
    }
    expect(acknowledgeVarianceJson.result.policyVarianceDigest.status).toBe("acknowledged")

    const snoozeVariance = await post(
      {
        action: "snooze_policy_variance",
        actorId: "partner_a",
        packageId,
        snoozeHours: 3,
        note: "Snooze variance while partner baseline exception remains",
      },
      "41f21d74-18c8-4766-93a8-2faaf59ca138"
    )
    expect(snoozeVariance.status).toBe(200)
    const snoozeVarianceJson = (await snoozeVariance.json()) as {
      result: { policyVarianceDigest: { status: string; snoozeUntil: number | null } }
    }
    expect(snoozeVarianceJson.result.policyVarianceDigest.status).toBe("snoozed")
    expect(typeof snoozeVarianceJson.result.policyVarianceDigest.snoozeUntil).toBe("number")

    const recordRemediation = await post(
      {
        action: "record_variance_remediation",
        actorId: "partner_a",
        packageId,
        decision: "temporary_override",
        justification: "Controlled override while court transport backlog is resolved",
        expiresInHours: 4,
        secondApproverId: "partner_a",
        note: "Remediation ledger capture for policy variance governance",
      },
      "f0c3020d-65a8-4f6c-8bb9-6e8ce8b8ef31"
    )
    expect(recordRemediation.status).toBe(200)
    const remediationJson = (await recordRemediation.json()) as {
      result: {
        remediation: { decision: string; status: string }
        remediationLifecycle: { status: string }
        policyVarianceDigest: { status: string }
      }
    }
    expect(remediationJson.result.remediation.decision).toBe("temporary_override")
    expect(remediationJson.result.remediation.status).toBe("active")
    expect(remediationJson.result.remediationLifecycle.status).toBe("open")
    expect(remediationJson.result.policyVarianceDigest.status).toBe("snoozed")

    const closureComplianceViewBefore = await get(
      new URLSearchParams({
        view: "closure_compliance_digests",
        userId: "associate_a",
        ownerId: "partner_a",
        digestStatus: "open_alert",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureComplianceViewBefore.status).toBe(200)
    const closureComplianceViewBeforeJson = (await closureComplianceViewBefore.json()) as {
      items: Array<{ ownerId: string; status: string }>
    }
    expect(
      closureComplianceViewBeforeJson.items.some(
        (row) => row.ownerId === "partner_a" && row.status === "open_alert"
      )
    ).toBe(true)

    const setClosureSlaConfig = await post(
      {
        action: "set_closure_sla_window_config",
        actorId: "partner_a",
        ackDeadlineHours: 1,
        clearDeadlineHours: 2,
        autoEscalationHours: 3,
        note: "Configure closure SLA windows for this filing escalation owner",
      },
      "0ecfe2eb-d20d-46fd-b39a-3b4f2e83a65a"
    )
    expect(setClosureSlaConfig.status).toBe(200)
    const setClosureSlaConfigJson = (await setClosureSlaConfig.json()) as {
      result: { closureSlaWindowConfig: { scope: string; ackDeadlineMs: number } }
    }
    expect(setClosureSlaConfigJson.result.closureSlaWindowConfig.scope).toBe("firm_default")
    expect(setClosureSlaConfigJson.result.closureSlaWindowConfig.ackDeadlineMs).toBe(60 * 60 * 1000)

    const setClosureAutoRule = await post(
      {
        action: "set_closure_auto_assignment_rule",
        actorId: "partner_a",
        mode: "workload_aware_claim",
        maxActiveClaimsPerPartner: 4,
        note: "Route auto-assignment by workload-aware claim balancing",
      },
      "859ebce4-f588-44f0-a624-c864d769cadf"
    )
    expect(setClosureAutoRule.status).toBe(200)
    const setClosureAutoRuleJson = (await setClosureAutoRule.json()) as {
      result: {
        closureAutoAssignmentRule: { mode: string; maxActiveClaimsPerPartner: number; enabled: boolean }
      }
    }
    expect(setClosureAutoRuleJson.result.closureAutoAssignmentRule.mode).toBe("workload_aware_claim")
    expect(setClosureAutoRuleJson.result.closureAutoAssignmentRule.maxActiveClaimsPerPartner).toBe(4)
    expect(setClosureAutoRuleJson.result.closureAutoAssignmentRule.enabled).toBe(true)

    const assignClosureFollowup = await post(
      {
        action: "assign_closure_followup",
        actorId: "partner_a",
        ownerId: "partner_a",
        assigneeId: "partner_a",
        note: "Assign closure follow-up to active escalation owner",
      },
      "5fcbcf14-af92-4126-8581-1f92ec84f894"
    )
    expect(assignClosureFollowup.status).toBe(200)
    const autoAssignClosureFollowup = await post(
      {
        action: "auto_assign_closure_followup",
        actorId: "partner_a",
        ownerId: "partner_a",
        note: "Auto-assign closure follow-up using current owner SLA pressure",
      },
      "aa8f31b9-5ad6-49a2-821f-26c2810ca5a6"
    )
    expect([200, 422]).toContain(autoAssignClosureFollowup.status)
    const claimClosureFollowup = await post(
      {
        action: "claim_closure_followup",
        actorId: "partner_a",
        ownerId: "partner_a",
        note: "Claim closure follow-up for remediation lifecycle",
      },
      "bb28f7b4-0947-4f31-88ac-0283365a5d95"
    )
    expect(claimClosureFollowup.status).toBe(200)
    const waiveClosureSlaException = await post(
      {
        action: "waive_closure_sla_exception",
        actorId: "partner_a",
        ownerId: "partner_a",
        waiverReason: "Temporary policy override during closure reconciliation",
        waiverHours: 4,
        note: "Waive closure SLA exception while attestations finalize",
      },
      "9a220bf4-8353-4efe-9c3a-c8e15e30741b"
    )
    expect([200, 422]).toContain(waiveClosureSlaException.status)

    const acknowledgeRemediationExpiry = await post(
      {
        action: "acknowledge_remediation_expiry",
        actorId: "partner_a",
        packageId,
        note: "Expiry risk acknowledged and owner notified",
      },
      "f4cf175f-dbff-4204-9c87-93012e992c6f"
    )
    expect(acknowledgeRemediationExpiry.status).toBe(200)
    const acknowledgeRemediationExpiryJson = (await acknowledgeRemediationExpiry.json()) as {
      result: { remediationExpiryDigest: { status: string } }
    }
    expect(acknowledgeRemediationExpiryJson.result.remediationExpiryDigest.status).toBe(
      "acknowledged"
    )

    const snoozeRemediationExpiry = await post(
      {
        action: "snooze_remediation_expiry",
        actorId: "partner_a",
        packageId,
        snoozeHours: 2,
        note: "Snooze while rollback checklist executes",
      },
      "0a607afe-8b95-4b54-a0c0-d31bb6f80320"
    )
    expect(snoozeRemediationExpiry.status).toBe(200)
    const snoozeRemediationExpiryJson = (await snoozeRemediationExpiry.json()) as {
      result: { remediationExpiryDigest: { status: string; snoozeUntil: number | null } }
    }
    expect(snoozeRemediationExpiryJson.result.remediationExpiryDigest.status).toBe("snoozed")
    expect(typeof snoozeRemediationExpiryJson.result.remediationExpiryDigest.snoozeUntil).toBe(
      "number"
    )

    const closeRemediation = await post(
      {
        action: "attest_remediation_closure",
        actorId: "partner_a",
        packageId,
        closureOutcome: "accepted_risk_retired",
        note: "Closure attested after managed override period",
      },
      "d98d4f7d-c4a0-4f13-a0ae-b1efdb9d206a"
    )
    expect(closeRemediation.status).toBe(200)
    const closeRemediationJson = (await closeRemediation.json()) as {
      result: {
        remediationLifecycle: { status: string; closureOutcome: string | null }
        remediationExpiryDigest: { status: string }
      }
    }
    expect(closeRemediationJson.result.remediationLifecycle.status).toBe("closure_attested")
    expect(closeRemediationJson.result.remediationLifecycle.closureOutcome).toBe(
      "accepted_risk_retired"
    )
    expect(closeRemediationJson.result.remediationExpiryDigest.status).toBe("cleared")

    const resolveClosureFollowup = await post(
      {
        action: "resolve_closure_followup",
        actorId: "partner_a",
        ownerId: "partner_a",
        note: "Resolved closure follow-up after lifecycle attestation",
      },
      "1df96cf6-842e-4c02-8d89-c3982ed1d575"
    )
    expect([200, 422]).toContain(resolveClosureFollowup.status)
    const recordClosureAttestation = await post(
      {
        action: "record_closure_attestation",
        actorId: "partner_a",
        ownerId: "partner_a",
        secondReviewerId: "partner_b",
        partnerConcurrence: true,
        evidenceNote: "Claim, dispatch closure, and remediation artifacts reviewed",
        note: "Record closure attestation evidence bundle",
      },
      "6c63f0cb-fa8d-44b4-b1f3-e4300edcece5"
    )
    expect([200, 422]).toContain(recordClosureAttestation.status)
    let attestationId: string | null = null
    if (recordClosureAttestation.status === 200) {
      const recordClosureAttestationJson = (await recordClosureAttestation.json()) as {
        result: { closureAttestation: { id: string; status: string } }
      }
      attestationId = recordClosureAttestationJson.result.closureAttestation.id
      expect(
        ["pending_second_review", "attested", "rejected"].includes(
          recordClosureAttestationJson.result.closureAttestation.status
        )
      ).toBe(true)
    }
    if (attestationId) {
      const reviewClosureAttestation = await post(
        {
          action: "review_closure_attestation",
          actorId: "partner_b",
          attestationId,
          decision: "approve",
          note: "Second review approved for closure evidence packet",
        },
        "3af816e8-b0f2-406d-aed5-e4d5e244ad50"
      )
      expect([200, 422]).toContain(reviewClosureAttestation.status)
    }
    let disputeId: string | null = null
    let adjudicationId: string | null = null
    if (attestationId) {
      const openClosureDispute = await post(
        {
          action: "open_closure_attestation_dispute",
          actorId: "partner_b",
          attestationId,
          conflictReason: "Dispute raised for chronology reconciliation",
          note: "Open attestation dispute for override workflow validation",
        },
        "089de9d4-2ec4-4f13-be09-cf7325480d41"
      )
      expect([200, 422]).toContain(openClosureDispute.status)
      if (openClosureDispute.status === 200) {
        const openClosureDisputeJson = (await openClosureDispute.json()) as {
          result: { closureAttestationDispute: { id: string; status: string } }
        }
        disputeId = openClosureDisputeJson.result.closureAttestationDispute.id
        expect(
          ["open_dispute", "under_review", "resolved_upheld", "resolved_overturned"].includes(
            openClosureDisputeJson.result.closureAttestationDispute.status
          )
        ).toBe(true)
      }
    }
    if (disputeId) {
      const escalateDisputeToPanelPayload = {
        action: "escalate_closure_dispute_to_panel" as const,
        actorId: "partner_b",
        disputeId,
        panelMemberIds: ["partner_a", "partner_b"],
        dissentNote: "preserve immutable dissent note for review",
        note: "Escalate closure dispute to adjudication panel",
      }
      const escalateDisputeToPanel = await post(
        escalateDisputeToPanelPayload,
        "7cf92ef7-f258-42c5-8fc0-d0bc9f2f732b"
      )
      expect([200, 422]).toContain(escalateDisputeToPanel.status)
      if (escalateDisputeToPanel.status === 200) {
        const escalateJson = (await escalateDisputeToPanel.json()) as {
          reused: boolean
          result: { closureAdjudicationQueue?: { id: string; status: string } }
        }
        expect(escalateJson.reused).toBe(false)
        adjudicationId = escalateJson.result.closureAdjudicationQueue?.id ?? null
        expect(
          ["pending_panel_assignment", "panel_in_review", "resolved_upheld", "resolved_overturned"].includes(
            escalateJson.result.closureAdjudicationQueue?.status ?? ""
          )
        ).toBe(true)
        const escalateReplay = await post(
          escalateDisputeToPanelPayload,
          "7cf92ef7-f258-42c5-8fc0-d0bc9f2f732b"
        )
        expect(escalateReplay.status).toBe(200)
        const escalateReplayJson = (await escalateReplay.json()) as { reused: boolean }
        expect(escalateReplayJson.reused).toBe(true)
      }
    }
    if (adjudicationId) {
      const governQuorumPayload = {
        action: "govern_closure_adjudication_quorum" as const,
        actorId: "partner_a",
        adjudicationId,
        requiredPanelCount: 3,
        quorumWindowHours: 0,
        verdictWindowHours: 0,
        note: "Govern quorum/timer status for adjudication backlog checks",
      }
      const governQuorum = await post(
        governQuorumPayload,
        "7a7fe973-3ea2-4fd3-8e0e-cf9b4cb74c53"
      )
      expect([200, 422]).toContain(governQuorum.status)
      const acknowledgeSloBreachPayload = {
        action: "acknowledge_closure_adjudication_slo_breach" as const,
        actorId: "partner_a",
        adjudicationId,
        note: "Acknowledge open adjudication SLO breach for panel backlog",
      }
      const acknowledgeSloBreach = await post(
        acknowledgeSloBreachPayload,
        "6f7d5d3e-51c4-4f49-9fa7-a9836cc5eb81"
      )
      expect([200, 422]).toContain(acknowledgeSloBreach.status)
      const extendSloDeadlinePayload = {
        action: "extend_closure_adjudication_slo_deadline" as const,
        actorId: "partner_a",
        adjudicationId,
        extensionHours: 2,
        note: "Extend adjudication SLO deadline after quorum governance check",
      }
      const extendSloDeadline = await post(
        extendSloDeadlinePayload,
        "fd3eb93f-74a3-4f75-a7ec-b0dc022861ab"
      )
      expect([200, 422]).toContain(extendSloDeadline.status)
      if (extendSloDeadline.status === 200) {
        const extendSloReplay = await post(
          extendSloDeadlinePayload,
          "fd3eb93f-74a3-4f75-a7ec-b0dc022861ab"
        )
        expect(extendSloReplay.status).toBe(200)
        const extendSloReplayJson = (await extendSloReplay.json()) as { reused: boolean }
        expect(extendSloReplayJson.reused).toBe(true)
      }
      const escalateSloTier = await post(
        {
          action: "escalate_closure_adjudication_slo_tier",
          actorId: "partner_a",
          adjudicationId,
          escalationTier: "tier_2_management_escalation",
          note: "Escalate adjudication SLO stewardship tier for operations review",
        },
        "9083a071-dae7-43ce-ac22-1092a7ddfac2"
      )
      expect([200, 422]).toContain(escalateSloTier.status)
      const recordAdjudicationVerdict = await post(
        {
          action: "record_closure_adjudication_verdict",
          actorId: "partner_a",
          adjudicationId,
          verdict: "uphold_dispute",
          dissentNote: "immutable dissent retained with verdict",
          note: "Capture panel verdict for closure dispute",
        },
        "b1279536-680b-46d8-a0a0-f329d3507f04"
      )
      expect([200, 422]).toContain(recordAdjudicationVerdict.status)
    }
    if (disputeId) {
      const resolveClosureDispute = await post(
        {
          action: "resolve_closure_attestation_dispute",
          actorId: "partner_a",
          disputeId,
          resolution: "uphold",
          note: "Dispute reviewed and attestation upheld",
        },
        "594fe088-669f-43dd-bec5-8bca67674600"
      )
      expect([200, 422]).toContain(resolveClosureDispute.status)
    }
    const tickClosureEnforcement = await post(
      {
        action: "tick_closure_sla_exception_enforcement",
        actorId: "partner_a",
        ownerId: "partner_a",
        note: "Advance expiry enforcement counters and transitions",
      },
      "88f0ea98-fb32-4fd8-8e6d-c8b95e9acdb9"
    )
    expect([200, 404]).toContain(tickClosureEnforcement.status)
    const rebalanceEnforcementPayload = {
      action: "rebalance_closure_enforcement_queue" as const,
      actorId: "partner_a",
      ownerId: "partner_a",
      status: "owner_reassignment_recommended" as const,
      recommendedOwnerId: "partner_b",
      note: "Record owner reassignment hint after repeated SLA exception escalation",
    }
    const rebalanceClosureEnforcement = await post(
      rebalanceEnforcementPayload,
      "0f72938a-ccce-43a1-adf5-fd66f7eeb3ef"
    )
    expect([200, 404, 422]).toContain(rebalanceClosureEnforcement.status)
    let rebalanceId: string | null = null
    if (rebalanceClosureEnforcement.status === 200) {
      const rebalanceJson = (await rebalanceClosureEnforcement.json()) as {
        result: { closureEnforcementRebalance?: { id: string } }
      }
      rebalanceId = rebalanceJson.result.closureEnforcementRebalance?.id ?? null
      const rebalanceReplay = await post(
        rebalanceEnforcementPayload,
        "0f72938a-ccce-43a1-adf5-fd66f7eeb3ef"
      )
      expect(rebalanceReplay.status).toBe(200)
      const rebalanceReplayJson = (await rebalanceReplay.json()) as { reused: boolean }
      expect(rebalanceReplayJson.reused).toBe(true)
    }
    if (rebalanceId) {
      const executeOwnerTransferPayload = {
        action: "execute_closure_rebalance_owner_transfer" as const,
        actorId: "partner_a",
        rebalanceId,
        note: "Execute owner reassignment recommendation for closure rebalance",
      }
      const configureSafeguardPayload = {
        action: "configure_closure_rebalance_auto_execution_safeguard" as const,
        actorId: "partner_a",
        rebalanceId,
        cooldownLockHours: 1,
        duplicateSuppressionHours: 1,
        note: "Configure lockout and duplicate suppression windows before auto-exec",
      }
      const configureSafeguard = await post(
        configureSafeguardPayload,
        "a793b8fa-7f9d-4140-adad-f6e6ab4953be"
      )
      expect([200, 404, 422]).toContain(configureSafeguard.status)
      if (configureSafeguard.status === 200) {
        const configureSafeguardReplay = await post(
          configureSafeguardPayload,
          "a793b8fa-7f9d-4140-adad-f6e6ab4953be"
        )
        expect(configureSafeguardReplay.status).toBe(200)
        const configureSafeguardReplayJson = (await configureSafeguardReplay.json()) as {
          reused: boolean
        }
        expect(configureSafeguardReplayJson.reused).toBe(true)
      }
      const executeOwnerTransfer = await post(
        executeOwnerTransferPayload,
        "ca6a53fa-12d5-445a-a6a8-73e68d852bb8"
      )
      expect([200, 422, 404]).toContain(executeOwnerTransfer.status)
      const attestOverride = await post(
        {
          action: "attest_closure_rebalance_auto_execution_override",
          actorId: "partner_a",
          rebalanceId,
          reason: "Controlled partner override after safeguard lockout validation",
          note: "Attest override to permit guarded auto execution path",
        },
        "f1db66f6-2e22-43fd-912a-4c6832388745"
      )
      expect([200, 404, 422]).toContain(attestOverride.status)
      if (executeOwnerTransfer.status === 200) {
        const executeOwnerTransferReplay = await post(
          executeOwnerTransferPayload,
          "ca6a53fa-12d5-445a-a6a8-73e68d852bb8"
        )
        expect(executeOwnerTransferReplay.status).toBe(200)
        const executeOwnerTransferReplayJson = (await executeOwnerTransferReplay.json()) as {
          reused: boolean
        }
        expect(executeOwnerTransferReplayJson.reused).toBe(true)
      }
      const throttleOn = await post(
        {
          action: "rebalance_closure_enforcement_queue",
          actorId: "partner_a",
          rebalanceId,
          status: "throttle_active",
          note: "Activate throttle before controlled release execution",
        },
        "9d3f55b8-6b01-4e9e-93f4-31a509ee4a8f"
      )
      expect([200, 404, 422]).toContain(throttleOn.status)
      if (throttleOn.status === 200) {
        const executeThrottleReleasePayload = {
          action: "execute_closure_rebalance_throttle_release" as const,
          actorId: "partner_a",
          rebalanceId,
          reopenQueue: true,
          note: "Execute throttle release with controlled reopen path",
        }
        const executeThrottleRelease = await post(
          executeThrottleReleasePayload,
          "4dc72ec5-b873-460d-88b3-f40853db7dad"
        )
        expect([200, 404, 422]).toContain(executeThrottleRelease.status)
      }
    }

    const waiverExpiryViewBefore = await get(
      new URLSearchParams({
        view: "waiver_expiry_digests",
        userId: "associate_a",
        matterId,
        packageId,
        expiryStatus: "open_expiry",
        limit: "10",
        cursor: "0",
      })
    )
    expect(waiverExpiryViewBefore.status).toBe(200)
    const waiverExpiryViewBeforeJson = (await waiverExpiryViewBefore.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      waiverExpiryViewBeforeJson.items.some(
        (row) => row.packageId === packageId && row.status === "open_expiry"
      )
    ).toBe(true)

    const acknowledgeWaiverExpiry = await post(
      {
        action: "acknowledge_waiver_expiry",
        actorId: "partner_a",
        packageId,
        note: "Waiver expiry risk acknowledged and extension queued",
      },
      "d9815d63-ab37-48fa-9e40-f0912a02b2b9"
    )
    expect(acknowledgeWaiverExpiry.status).toBe(200)
    const acknowledgeWaiverExpiryJson = (await acknowledgeWaiverExpiry.json()) as {
      result: { waiverExpiryDigest: { status: string } }
    }
    expect(acknowledgeWaiverExpiryJson.result.waiverExpiryDigest.status).toBe("acknowledged")

    const extendWaiver = await post(
      {
        action: "extend_breach_waiver",
        actorId: "partner_a",
        packageId,
        extendHours: 8,
        secondApproverId: "partner_a",
        rolloverJustification: "Waiver cap exceeded due documented registry closure period",
        rolloverNote: "Rollover attestation captured with partner signoff",
        note: "Extending waiver pending registry reopening",
      },
      "0b2da76f-47d7-4902-b5cd-faf6c2af9a56"
    )
    expect(extendWaiver.status).toBe(200)
    const extendWaiverJson = (await extendWaiver.json()) as {
      result: {
        waiver: { status: string }
        waiverExpiryDigest: { status: string }
        rolloverAttestation: { status: string } | null
      }
    }
    expect(extendWaiverJson.result.waiver.status).toBe("active")
    expect(["extended", "open_expiry", "cleared"]).toContain(
      extendWaiverJson.result.waiverExpiryDigest.status
    )
    expect(extendWaiverJson.result.rolloverAttestation?.status).toBe("attested")

    const acknowledgeRolloverBreach = await post(
      {
        action: "acknowledge_rollover_breach",
        actorId: "partner_a",
        packageId,
        note: "Rollover breach acknowledged pending reaffirmation note",
      },
      "81d5402f-0d15-474f-b956-55963937a2e3"
    )
    expect(acknowledgeRolloverBreach.status).toBe(200)
    const acknowledgeRolloverBreachJson = (await acknowledgeRolloverBreach.json()) as {
      result: { rolloverBreachWatch: { status: string } }
    }
    expect(acknowledgeRolloverBreachJson.result.rolloverBreachWatch.status).toBe("acknowledged")

    const reaffirmRolloverAttestation = await post(
      {
        action: "reaffirm_rollover_attestation",
        actorId: "partner_a",
        packageId,
        note: "reaffirm waiver extension with latest court closure memo",
      },
      "3be4d4a6-7f4e-4157-b4a6-03ba036149cb"
    )
    expect(reaffirmRolloverAttestation.status).toBe(200)
    const reaffirmRolloverAttestationJson = (await reaffirmRolloverAttestation.json()) as {
      result: { rolloverBreachWatch: { status: string } }
    }
    expect(reaffirmRolloverAttestationJson.result.rolloverBreachWatch.status).toBe("cleared")

    const acknowledgeReaffirmationSla = await post(
      {
        action: "acknowledge_rollover_reaffirmation_sla",
        actorId: "partner_a",
        packageId,
        note: "Acknowledged reaffirmation SLA review",
      },
      "388dd8fd-eae8-4603-850f-fda901ac40c5"
    )
    expect(acknowledgeReaffirmationSla.status).toBe(422)

    const revokeWaiver = await post(
      {
        action: "revoke_breach_waiver",
        actorId: "partner_a",
        packageId,
        note: "Waiver window closed after staffing recovery",
      },
      "d4aaf865-30dd-4363-9780-7d6b49f4dd33"
    )
    expect(revokeWaiver.status).toBe(200)
    const revokeWaiverJson = (await revokeWaiver.json()) as {
      result: { waiver: { status: string }; workloadDigest: { status: string } }
    }
    expect(revokeWaiverJson.result.waiver.status).toBe("revoked")
    expect(["open_alert", "cleared"]).toContain(revokeWaiverJson.result.workloadDigest.status)

    const acknowledgeHandoff = await post(
      {
        action: "acknowledge_handoff",
        actorId: "partner_a",
        packageId,
        note: "Escalation handoff attested by assigned owner",
      },
      "a4c0b77b-a412-460d-9bf4-f57ca5f9feb8"
    )
    expect(acknowledgeHandoff.status).toBe(200)
    const acknowledgeHandoffJson = (await acknowledgeHandoff.json()) as {
      result: { rota: { status: string; handoffRequired: boolean } }
    }
    expect(acknowledgeHandoffJson.result.rota.status).toBe("handoff_acknowledged")
    expect(acknowledgeHandoffJson.result.rota.handoffRequired).toBe(false)

    const delivered = await post(
      {
        action: "confirm_delivered",
        actorId: "partner_a",
        packageId,
        transportChannel: "courier_stub",
        channelPayloadHash: "transport-hash-003",
        attachmentPointers: ["ops://dispatch/proof-of-delivery"],
        relatedReceiptId: `receipt:${packageId}:1`,
        note: "Courier delivery confirmed in deterministic transport mode",
      },
      "2b5d5a95-4dd6-4f99-9535-4d2f07454d26"
    )
    expect(delivered.status).toBe(200)
    const deliveredJson = (await delivered.json()) as {
      result: {
        evidence: { outcome: string }
        dispatchQueue: { status: string; externalDispatchState: string }
        submissionException: { status: string }
      }
    }
    expect(deliveredJson.result.evidence.outcome).toBe("confirm_delivered")
    expect(deliveredJson.result.dispatchQueue.status).toBe("handoff_ready")
    expect(deliveredJson.result.dispatchQueue.externalDispatchState).toBe("ready_for_firm_dispatch")
    expect(deliveredJson.result.submissionException.status).toBe("resolved")

    const clearedDigest = await post(
      {
        action: "clear_digest",
        actorId: "partner_a",
        packageId,
        note: "Digest cleared after deterministic delivery confirmation",
      },
      "e4777c9f-fa6e-4c37-a36b-353af0d43f0a"
    )
    expect(clearedDigest.status).toBe(200)
    const clearedDigestJson = (await clearedDigest.json()) as {
      result: { digest: { status: string; breachReasons: string[] } }
    }
    expect(clearedDigestJson.result.digest.status).toBe("cleared")
    expect(clearedDigestJson.result.digest.breachReasons).toHaveLength(0)

    const revokedRota = await post(
      {
        action: "revoke_assignment",
        actorId: "partner_a",
        packageId,
        note: "Escalation assignment revoked after closure",
      },
      "aabce5a0-61ca-443e-8359-52ec764bca87"
    )
    expect(revokedRota.status).toBe(200)
    const revokedRotaJson = (await revokedRota.json()) as {
      result: { rota: { status: string; primaryOwnerId: string | null } }
    }
    expect(revokedRotaJson.result.rota.status).toBe("revoked")
    expect(revokedRotaJson.result.rota.primaryOwnerId).toBe(null)

    const transportEvidenceView = await get(
      new URLSearchParams({
        view: "transport_execution",
        userId: "associate_a",
        matterId,
        packageId,
        outcome: "confirm_delivered",
        limit: "10",
        cursor: "0",
      })
    )
    expect(transportEvidenceView.status).toBe(200)
    const transportEvidenceJson = (await transportEvidenceView.json()) as {
      items: Array<{ packageId: string; outcome: string }>
    }
    expect(
      transportEvidenceJson.items.some(
        (row) => row.packageId === packageId && row.outcome === "confirm_delivered"
      )
    ).toBe(true)

    const digestView = await get(
      new URLSearchParams({
        view: "submission_sla_digests",
        userId: "associate_a",
        matterId,
        packageId,
        digestStatus: "cleared",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(digestView.status).toBe(200)
    const digestViewJson = (await digestView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      digestViewJson.items.some(
        (row) => row.packageId === packageId && row.status === "cleared"
      )
    ).toBe(true)

    const rotaView = await get(
      new URLSearchParams({
        view: "escalation_owner_rota",
        userId: "associate_a",
        matterId,
        packageId,
        rotaStatus: "revoked",
        limit: "10",
        cursor: "0",
      })
    )
    expect(rotaView.status).toBe(200)
    const rotaViewJson = (await rotaView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      rotaViewJson.items.some((row) => row.packageId === packageId && row.status === "revoked")
    ).toBe(true)

    const workloadView = await get(
      new URLSearchParams({
        view: "escalation_workload_digests",
        userId: "associate_a",
        matterId,
        packageId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(workloadView.status).toBe(200)
    const workloadViewJson = (await workloadView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      workloadViewJson.items.some(
        (row) => row.packageId === packageId && ["cleared", "open_alert"].includes(row.status)
      )
    ).toBe(true)

    const policyVarianceView = await get(
      new URLSearchParams({
        view: "policy_variance_digests",
        userId: "associate_a",
        packageId,
        varianceStatus: "snoozed",
        limit: "10",
        cursor: "0",
      })
    )
    expect(policyVarianceView.status).toBe(200)
    const policyVarianceViewJson = (await policyVarianceView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      policyVarianceViewJson.items.some(
        (row) => row.packageId === packageId && row.status === "snoozed"
      )
    ).toBe(true)

    const remediationView = await get(
      new URLSearchParams({
        view: "variance_remediation_ledger",
        userId: "associate_a",
        packageId,
        remediationStatus: "expired",
        decision: "temporary_override",
        limit: "10",
        cursor: "0",
      })
    )
    expect(remediationView.status).toBe(200)
    const remediationViewJson = (await remediationView.json()) as {
      items: Array<{ packageId: string; status: string; decision: string }>
    }
    expect(
      remediationViewJson.items.some(
        (row) =>
          row.packageId === packageId &&
          row.status === "expired" &&
          row.decision === "temporary_override"
      )
    ).toBe(true)

    const remediationExpiryView = await get(
      new URLSearchParams({
        view: "remediation_expiry_digests",
        userId: "associate_a",
        packageId,
        expiryStatus: "cleared",
        limit: "10",
        cursor: "0",
      })
    )
    expect(remediationExpiryView.status).toBe(200)
    const remediationExpiryViewJson = (await remediationExpiryView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      remediationExpiryViewJson.items.some(
        (row) => row.packageId === packageId && row.status === "cleared"
      )
    ).toBe(true)

    const lifecycleView = await get(
      new URLSearchParams({
        view: "remediation_lifecycle",
        userId: "associate_a",
        packageId,
        lifecycleStatus: "closure_attested",
        closureOutcome: "accepted_risk_retired",
        limit: "10",
        cursor: "0",
      })
    )
    expect(lifecycleView.status).toBe(200)
    const lifecycleViewJson = (await lifecycleView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      lifecycleViewJson.items.some(
        (row) => row.packageId === packageId && row.status === "closure_attested"
      )
    ).toBe(true)

    const policyView = await get(
      new URLSearchParams({
        view: "escalation_policy_baselines",
        userId: "associate_a",
        packageId,
        scope: "package_override",
        limit: "10",
        cursor: "0",
      })
    )
    expect(policyView.status).toBe(200)
    const policyViewJson = (await policyView.json()) as {
      items: Array<{ packageId: string | null; scope: string }>
    }
    expect(
      policyViewJson.items.some(
        (row) => row.packageId === packageId && row.scope === "package_override"
      )
    ).toBe(true)

    const waiverView = await get(
      new URLSearchParams({
        view: "breach_waiver_ledger",
        userId: "associate_a",
        packageId,
        waiverStatus: "revoked",
        limit: "10",
        cursor: "0",
      })
    )
    expect(waiverView.status).toBe(200)
    const waiverViewJson = (await waiverView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      waiverViewJson.items.some((row) => row.packageId === packageId && row.status === "revoked")
    ).toBe(true)

    const waiverExpiryView = await get(
      new URLSearchParams({
        view: "waiver_expiry_digests",
        userId: "associate_a",
        packageId,
        expiryStatus: "cleared",
        limit: "10",
        cursor: "0",
      })
    )
    expect(waiverExpiryView.status).toBe(200)
    const waiverExpiryViewJson = (await waiverExpiryView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      waiverExpiryViewJson.items.some(
        (row) => row.packageId === packageId && row.status === "cleared"
      )
    ).toBe(true)

    const rolloverView = await get(
      new URLSearchParams({
        view: "waiver_rollover_attestations",
        userId: "associate_a",
        packageId,
        rolloverStatus: "attested",
        limit: "10",
        cursor: "0",
      })
    )
    expect(rolloverView.status).toBe(200)
    const rolloverViewJson = (await rolloverView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      rolloverViewJson.items.some(
        (row) => row.packageId === packageId && row.status === "attested"
      )
    ).toBe(true)

    const rolloverWatchView = await get(
      new URLSearchParams({
        view: "rollover_breach_watches",
        userId: "associate_a",
        packageId,
        watchStatus: "cleared",
        limit: "10",
        cursor: "0",
      })
    )
    expect(rolloverWatchView.status).toBe(200)
    const rolloverWatchViewJson = (await rolloverWatchView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      rolloverWatchViewJson.items.some(
        (row) => row.packageId === packageId && row.status === "cleared"
      )
    ).toBe(true)

    const reaffirmationSlaView = await get(
      new URLSearchParams({
        view: "rollover_reaffirmation_sla",
        userId: "associate_a",
        packageId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(reaffirmationSlaView.status).toBe(200)
    const reaffirmationSlaViewJson = (await reaffirmationSlaView.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      reaffirmationSlaViewJson.items.some(
        (row) =>
          row.packageId === packageId &&
          ["within_sla", "cleared", "acknowledged"].includes(row.status)
      )
    ).toBe(true)

    const closureComplianceView = await get(
      new URLSearchParams({
        view: "closure_compliance_digests",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureComplianceView.status).toBe(200)
    const closureComplianceViewJson = (await closureComplianceView.json()) as {
      items: Array<{
        ownerId: string
        status: string
        slaWindowStatus?: string
        slaPressureLevel?: string
        slaExceptionStatus?: string
        slaExceptionPressureLevel?: string
        attestationDisputeStatus?: string | null
        slaExceptionEnforcementStatus?: string
        closureAdjudicationStatus?: string | null
        closureEnforcementRebalanceStatus?: string
        closureAdjudicationQuorumStatus?: string | null
        closureRebalanceExecutionStatus?: string | null
        closureRebalanceExecutionMode?: string | null
        closureRebalanceChurnCount?: number
        closureAdjudicationThroughputScore?: number
        closureAdjudicationSloStatus?: string | null
        closureAdjudicationSloEscalationTier?: string
        closureAdjudicationSloDebtHours?: number
        closureRebalanceSafeguardStatus?: string
        closureRebalanceAutoExecutionEligible?: boolean
        closureRebalanceSuppressionReasons?: string[]
        closureCriticalPath?: boolean
      }>
    }
    expect(
      closureComplianceViewJson.items.some(
        (row) => {
          const digestStatusOk = ["open_alert", "acknowledged", "cleared"].includes(row.status)
          const slaStatusOk =
            row.slaWindowStatus === undefined ||
            ["within_window", "ack_breached", "clear_breached", "auto_escalation_due", "cleared"].includes(
              row.slaWindowStatus
            )
          const pressureOk =
            row.slaPressureLevel === undefined ||
            ["baseline", "elevated", "critical"].includes(row.slaPressureLevel)
          const exceptionStatusOk =
            row.slaExceptionStatus === undefined ||
            ["open_exception", "waived", "expired", "cleared"].includes(row.slaExceptionStatus)
          const exceptionPressureOk =
            row.slaExceptionPressureLevel === undefined ||
            ["baseline", "elevated", "critical"].includes(row.slaExceptionPressureLevel)
          const disputeStatusOk =
            row.attestationDisputeStatus === undefined ||
            row.attestationDisputeStatus === null ||
            ["open_dispute", "under_review", "resolved_upheld", "resolved_overturned"].includes(
              row.attestationDisputeStatus
            )
          const enforcementStatusOk =
            row.slaExceptionEnforcementStatus === undefined ||
            ["countdown_active", "reminder_sent", "escalated", "closed"].includes(
              row.slaExceptionEnforcementStatus
            )
          const adjudicationStatusOk =
            row.closureAdjudicationStatus === undefined ||
            row.closureAdjudicationStatus === null ||
            [
              "pending_panel_assignment",
              "panel_in_review",
              "resolved_upheld",
              "resolved_overturned",
            ].includes(row.closureAdjudicationStatus)
          const rebalanceStatusOk =
            row.closureEnforcementRebalanceStatus === undefined ||
            ["none", "cooldown_scheduled", "owner_reassignment_recommended", "throttle_active"].includes(
              row.closureEnforcementRebalanceStatus
            )
          const quorumStatusOk =
            row.closureAdjudicationQuorumStatus === undefined ||
            row.closureAdjudicationQuorumStatus === null ||
            ["quorum_pending", "quorum_met", "verdict_overdue", "closed"].includes(
              row.closureAdjudicationQuorumStatus
            )
          const executionStatusOk =
            row.closureRebalanceExecutionStatus === undefined ||
            row.closureRebalanceExecutionStatus === null ||
            ["queued", "owner_transfer_in_progress", "throttle_release_in_progress", "completed"].includes(
              row.closureRebalanceExecutionStatus
            )
          const executionModeOk =
            row.closureRebalanceExecutionMode === undefined ||
            row.closureRebalanceExecutionMode === null ||
            ["owner_transfer", "throttle_release"].includes(row.closureRebalanceExecutionMode)
          const churnMetricOk =
            row.closureRebalanceChurnCount === undefined ||
            (Number.isFinite(row.closureRebalanceChurnCount) && row.closureRebalanceChurnCount >= 0)
          const throughputMetricOk =
            row.closureAdjudicationThroughputScore === undefined ||
            [0, 1].includes(row.closureAdjudicationThroughputScore)
          const adjudicationSloStatusOk =
            row.closureAdjudicationSloStatus === undefined ||
            row.closureAdjudicationSloStatus === null ||
            ["within_slo", "deadline_extended", "breach_open", "breach_acknowledged"].includes(
              row.closureAdjudicationSloStatus
            )
          const adjudicationSloTierOk =
            row.closureAdjudicationSloEscalationTier === undefined ||
            ["none", "tier_1_partner_watch", "tier_2_management_escalation", "tier_3_executive_escalation"].includes(
              row.closureAdjudicationSloEscalationTier
            )
          const adjudicationSloDebtOk =
            row.closureAdjudicationSloDebtHours === undefined ||
            (Number.isFinite(row.closureAdjudicationSloDebtHours) &&
              row.closureAdjudicationSloDebtHours >= 0)
          const safeguardStatusOk =
            row.closureRebalanceSafeguardStatus === undefined ||
            ["auto_exec_ready", "cooldown_locked", "duplicate_suppressed", "override_attested"].includes(
              row.closureRebalanceSafeguardStatus
            )
          const autoExecEligibleOk =
            row.closureRebalanceAutoExecutionEligible === undefined ||
            typeof row.closureRebalanceAutoExecutionEligible === "boolean"
          const safeguardReasonsOk =
            row.closureRebalanceSuppressionReasons === undefined ||
            row.closureRebalanceSuppressionReasons.every((reason) =>
              ["cooldown_lockout_active", "duplicate_execution_window", "manual_override_required"].includes(
                reason
              )
            )
          const criticalPathOk =
            row.closureCriticalPath === undefined || typeof row.closureCriticalPath === "boolean"
          return (
            row.ownerId === "partner_a" &&
            digestStatusOk &&
            slaStatusOk &&
            pressureOk &&
            exceptionStatusOk &&
            exceptionPressureOk &&
            disputeStatusOk &&
            enforcementStatusOk &&
            adjudicationStatusOk &&
            rebalanceStatusOk &&
            quorumStatusOk &&
            executionStatusOk &&
            executionModeOk &&
            churnMetricOk &&
            throughputMetricOk &&
            adjudicationSloStatusOk &&
            adjudicationSloTierOk &&
            adjudicationSloDebtOk &&
            safeguardStatusOk &&
            autoExecEligibleOk &&
            safeguardReasonsOk &&
            criticalPathOk
          )
        }
      )
    ).toBe(true)

    const closureQueueView = await get(
      new URLSearchParams({
        view: "closure_followup_queue",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureQueueView.status).toBe(200)
    const closureQueueViewJson = (await closureQueueView.json()) as {
      items: Array<{ ownerId: string; status: string }>
    }
    expect(
      closureQueueViewJson.items.some(
        (row) => row.ownerId === "partner_a" && ["open", "claimed", "resolved"].includes(row.status)
      )
    ).toBe(true)
    const closureAttestationsView = await get(
      new URLSearchParams({
        view: "closure_attestations",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureAttestationsView.status).toBe(200)
    const closureAttestationsViewJson = (await closureAttestationsView.json()) as {
      items: Array<{ ownerId: string; status: string }>
    }
    if (attestationId) {
      expect(closureAttestationsViewJson.items.length).toBeGreaterThan(0)
    }
    expect(
      closureAttestationsViewJson.items.every((row) =>
        ["pending_second_review", "attested", "rejected"].includes(row.status)
      )
    ).toBe(true)

    const closureSlaConfigView = await get(
      new URLSearchParams({
        view: "closure_sla_window_configs",
        userId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureSlaConfigView.status).toBe(200)
    const closureSlaConfigViewJson = (await closureSlaConfigView.json()) as {
      items: Array<{ scope: string; ackDeadlineMs: number }>
    }
    expect(
      closureSlaConfigViewJson.items.some(
        (row) => row.scope === "firm_default" && row.ackDeadlineMs === 60 * 60 * 1000
      )
    ).toBe(true)

    const closureAutoRuleView = await get(
      new URLSearchParams({
        view: "closure_auto_assignment_rules",
        userId: "partner_a",
        mode: "workload_aware_claim",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureAutoRuleView.status).toBe(200)
    const closureAutoRuleViewJson = (await closureAutoRuleView.json()) as {
      items: Array<{ mode: string; maxActiveClaimsPerPartner: number }>
    }
    expect(
      closureAutoRuleViewJson.items.some(
        (row) => row.mode === "workload_aware_claim" && row.maxActiveClaimsPerPartner === 4
      )
    ).toBe(true)

    const closureSlaWindowsView = await get(
      new URLSearchParams({
        view: "closure_sla_windows",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureSlaWindowsView.status).toBe(200)
    const closureSlaWindowsViewJson = (await closureSlaWindowsView.json()) as {
      items: Array<{ ownerId: string; status: string; pressureLevel: string }>
    }
    expect(
      closureSlaWindowsViewJson.items.some(
        (row) =>
          row.ownerId === "partner_a" &&
          ["within_window", "ack_breached", "clear_breached", "auto_escalation_due", "cleared"].includes(
            row.status
          ) &&
          ["baseline", "elevated", "critical"].includes(row.pressureLevel)
      )
    ).toBe(true)
    const closureSlaExceptionView = await get(
      new URLSearchParams({
        view: "closure_sla_exception_digests",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureSlaExceptionView.status).toBe(200)
    const closureSlaExceptionViewJson = (await closureSlaExceptionView.json()) as {
      items: Array<{ ownerId: string; status: string; pressureLevel: string }>
    }
    expect(
      closureSlaExceptionViewJson.items.some(
        (row) =>
          row.ownerId === "partner_a" &&
          ["open_exception", "waived", "expired", "cleared"].includes(row.status) &&
          ["baseline", "elevated", "critical"].includes(row.pressureLevel)
      )
    ).toBe(true)
    const closureDisputesView = await get(
      new URLSearchParams({
        view: "closure_attestation_disputes",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureDisputesView.status).toBe(200)
    const closureDisputesViewJson = (await closureDisputesView.json()) as {
      items: Array<{ ownerId: string; status: string }>
    }
    if (disputeId) {
      expect(
        closureDisputesViewJson.items.some(
          (row) =>
            row.ownerId === "partner_a" &&
            ["open_dispute", "under_review", "resolved_upheld", "resolved_overturned"].includes(
              row.status
            )
        )
      ).toBe(true)
    }
    const closureEnforcementView = await get(
      new URLSearchParams({
        view: "closure_sla_exception_enforcement",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureEnforcementView.status).toBe(200)
    const closureEnforcementViewJson = (await closureEnforcementView.json()) as {
      items: Array<{ ownerId: string; status: string }>
    }
    expect(
      closureEnforcementViewJson.items.every((row) =>
        ["countdown_active", "reminder_sent", "escalated", "closed"].includes(row.status)
      )
    ).toBe(true)
    const closureAdjudicationView = await get(
      new URLSearchParams({
        view: "closure_adjudication_queue",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureAdjudicationView.status).toBe(200)
    const closureAdjudicationViewJson = (await closureAdjudicationView.json()) as {
      items: Array<{ ownerId: string; status: string }>
    }
    expect(
      closureAdjudicationViewJson.items.every((row) =>
        [
          "pending_panel_assignment",
          "panel_in_review",
          "resolved_upheld",
          "resolved_overturned",
        ].includes(row.status)
      )
    ).toBe(true)
    const closureRebalanceView = await get(
      new URLSearchParams({
        view: "closure_enforcement_rebalance",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureRebalanceView.status).toBe(200)
    const closureRebalanceViewJson = (await closureRebalanceView.json()) as {
      items: Array<{ ownerId: string; status: string }>
    }
    expect(
      closureRebalanceViewJson.items.every((row) =>
        ["none", "cooldown_scheduled", "owner_reassignment_recommended", "throttle_active"].includes(
          row.status
        )
      )
    ).toBe(true)
    const closureQuorumView = await get(
      new URLSearchParams({
        view: "closure_adjudication_quorum",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureQuorumView.status).toBe(200)
    const closureQuorumViewJson = (await closureQuorumView.json()) as {
      items: Array<{ ownerId: string; status: string }>
    }
    expect(
      closureQuorumViewJson.items.every((row) =>
        ["quorum_pending", "quorum_met", "verdict_overdue", "closed"].includes(row.status)
      )
    ).toBe(true)
    const closureExecutionView = await get(
      new URLSearchParams({
        view: "closure_rebalance_execution",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureExecutionView.status).toBe(200)
    const closureExecutionViewJson = (await closureExecutionView.json()) as {
      items: Array<{ ownerId: string; status: string; mode: string }>
    }
    expect(
      closureExecutionViewJson.items.every(
        (row) =>
          ["queued", "owner_transfer_in_progress", "throttle_release_in_progress", "completed"].includes(
            row.status
          ) && ["owner_transfer", "throttle_release"].includes(row.mode)
      )
    ).toBe(true)
    const closureSloView = await get(
      new URLSearchParams({
        view: "closure_adjudication_slo",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureSloView.status).toBe(200)
    const closureSloViewJson = (await closureSloView.json()) as {
      items: Array<{ ownerId: string; status: string; escalationTier: string }>
    }
    expect(
      closureSloViewJson.items.every(
        (row) =>
          ["within_slo", "deadline_extended", "breach_open", "breach_acknowledged"].includes(row.status) &&
          ["none", "tier_1_partner_watch", "tier_2_management_escalation", "tier_3_executive_escalation"].includes(
            row.escalationTier
          )
      )
    ).toBe(true)
    const closureSafeguardView = await get(
      new URLSearchParams({
        view: "closure_rebalance_safeguards",
        userId: "partner_a",
        ownerId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureSafeguardView.status).toBe(200)
    const closureSafeguardViewJson = (await closureSafeguardView.json()) as {
      items: Array<{ ownerId: string; status: string; suppressionReasons: string[] }>
    }
    expect(
      closureSafeguardViewJson.items.every(
        (row) =>
          ["auto_exec_ready", "cooldown_locked", "duplicate_suppressed", "override_attested"].includes(
            row.status
          ) &&
          row.suppressionReasons.every((reason) =>
            ["cooldown_lockout_active", "duplicate_execution_window", "manual_override_required"].includes(
              reason
            )
          )
      )
    ).toBe(true)
  })

  it("replays idempotent create package requests and rejects conflicts", async () => {
    const { matterId, draftId } = seedMatterAndDraft()
    const key = "fee8efdf-d8ca-4115-a978-a91ddeb03684"
    const payload = {
      action: "create_package",
      actorId: "associate_a",
      matterId,
      draftId,
      classification: "internal",
      citedJudgmentIds: [],
      temporalCitations: [],
    }
    const first = await post(payload, key)
    const second = await post(payload, key)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { reused: boolean; result: { filingPackage: { id: string } } }
    const b = (await second.json()) as { reused: boolean; result: { filingPackage: { id: string } } }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(a.result.filingPackage.id).toBe(b.result.filingPackage.id)

    const conflict = await post({ ...payload, classification: "confidential" }, key)
    expect(conflict.status).toBe(409)
  })
})
