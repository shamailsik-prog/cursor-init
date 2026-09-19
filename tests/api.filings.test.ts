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
