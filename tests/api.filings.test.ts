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
