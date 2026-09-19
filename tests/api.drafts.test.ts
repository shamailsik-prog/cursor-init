import { afterEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/d4/drafts/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import {
  seedJudgment,
  seedSection,
  seedTreatment,
} from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/d4/drafts", {
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
  return GET(new Request(`http://127.0.0.1/api/d4/drafts?${params.toString()}`))
}

function seedMatter(classification: "internal" | "confidential" | "privileged" = "internal") {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Drafting matter",
    courtId: "SHC",
    classification,
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  addMember(store, matter.id, "clerk_a", "firmA")
  return matter.id
}

function templateId(): string {
  const first = getDocumentTypes()[0]
  if (!first) throw new Error("document types seed missing")
  return first.id
}

describe("POST/GET /api/d4/drafts", () => {
  it("lists id-keyed templates with pagination", async () => {
    const firstPage = await get(
      new URLSearchParams({
        view: "templates",
        limit: "2",
        cursor: "0",
      })
    )
    expect(firstPage.status).toBe(200)
    const one = (await firstPage.json()) as {
      view: string
      items: Array<{ id: string; name: string }>
      nextCursor: string | null
    }
    expect(one.view).toBe("templates")
    expect(one.items.length).toBeGreaterThan(0)
    expect(one.items[0]?.id).toBeTruthy()
    if (one.nextCursor) {
      const secondPage = await get(
        new URLSearchParams({
          view: "templates",
          limit: "2",
          cursor: one.nextCursor,
        })
      )
      expect(secondPage.status).toBe(200)
    }
  })

  it("blocks preflight when citation is overruled without partner override", async () => {
    const matterId = seedMatter("internal")
    const store = getRuntimeStore()
    seedJudgment(store, "j-old", "Old authority", "single")
    seedJudgment(store, "j-new", "Larger bench", "larger")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")

    const res = await post(
      {
        action: "preflight",
        actorId: "associate_a",
        matterId,
        classification: "internal",
        citedJudgmentIds: ["j-old"],
        temporalCitations: [],
      },
      "2f6bdd6a-90f9-4ee2-b454-86dbff16ff52"
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      result: { result: { ok: boolean; citationStatus: string } }
    }
    expect(json.result.result.ok).toBe(false)
    expect(json.result.result.citationStatus).toBe("OVERRULED")
  })

  it("requires partner override reason for overruled citations and allows compose when provided", async () => {
    const matterId = seedMatter("internal")
    const store = getRuntimeStore()
    seedJudgment(store, "j-old", "Old authority", "single")
    seedJudgment(store, "j-new", "Larger bench", "larger")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")

    const blocked = await post(
      {
        action: "compose",
        actorId: "associate_a",
        matterId,
        templateId: templateId(),
        title: "Draft without override",
        body: "Body",
        classification: "internal",
        citedJudgmentIds: ["j-old"],
        temporalCitations: [],
      },
      "f95a3b51-2802-49b8-941c-e4f271225d48"
    )
    expect(blocked.status).toBe(422)

    const allowed = await post(
      {
        action: "compose",
        actorId: "associate_a",
        matterId,
        templateId: templateId(),
        title: "Draft with override",
        body: "Body",
        classification: "internal",
        citedJudgmentIds: ["j-old"],
        temporalCitations: [],
        partnerOverride: {
          partnerId: "partner_a",
          reason: "Distinguished on facts and client instruction",
        },
      },
      "2de03efa-37e4-471a-9667-3a79f443a873"
    )
    expect(allowed.status).toBe(200)
    const ok = (await allowed.json()) as {
      result: { draft: { id: string; templateId: string } }
    }
    expect(ok.result.draft.id).toBeTruthy()
    expect(ok.result.draft.templateId).toBe(templateId())
  })

  it("blocks compose when temporal preflight mismatches statute text", async () => {
    const matterId = seedMatter("internal")
    const store = getRuntimeStore()
    seedSection(store, "ppc_302", [
      {
        versionNo: 1,
        effectiveFrom: "1860-10-06",
        effectiveTo: null,
        text: "Correct historical text",
      },
    ])

    const res = await post(
      {
        action: "compose",
        actorId: "associate_a",
        matterId,
        templateId: templateId(),
        title: "Temporal mismatch draft",
        body: "Body",
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [
          {
            sectionId: "ppc_302",
            offenceDate: "2015-01-01",
            usedText: "Wrong text",
          },
        ],
      },
      "f984d8f4-8ba2-4b15-af11-ececa7c728f2"
    )
    expect(res.status).toBe(422)
    const json = (await res.json()) as {
      preflight?: { temporal?: Array<{ status: string }> }
    }
    void json
  })

  it("replays idempotent compose and rejects key conflicts", async () => {
    const matterId = seedMatter("internal")
    const key = "95b7752f-eb62-40e0-9b5f-bbeadf857744"
    const payload = {
      action: "compose",
      actorId: "associate_a",
      matterId,
      templateId: templateId(),
      title: "Idempotent draft",
      body: "Body",
      classification: "internal",
      citedJudgmentIds: [],
      temporalCitations: [],
    }
    const first = await post(payload, key)
    const second = await post(payload, key)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { reused: boolean; result: { draft: { id: string } } }
    const b = (await second.json()) as { reused: boolean; result: { draft: { id: string } } }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(a.result.draft.id).toBe(b.result.draft.id)

    const conflict = await post({ ...payload, title: "Different body" }, key)
    expect(conflict.status).toBe(409)
  })

  it("lists composed drafts with pagination and matter scoping", async () => {
    const matterId = seedMatter("internal")
    await post(
      {
        action: "compose",
        actorId: "associate_a",
        matterId,
        templateId: templateId(),
        title: "Draft A",
        body: "Body A",
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
      "1f4cc0cc-b4c0-474f-86bd-f0e32ec3f9c1"
    )
    await post(
      {
        action: "compose",
        actorId: "associate_a",
        matterId,
        templateId: templateId(),
        title: "Draft B",
        body: "Body B",
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
      "5609cb31-9df1-429b-9193-f713ee05320b"
    )

    const pageOne = await get(
      new URLSearchParams({
        view: "drafts",
        userId: "associate_a",
        matterId,
        limit: "1",
        cursor: "0",
      })
    )
    expect(pageOne.status).toBe(200)
    const one = (await pageOne.json()) as {
      items: Array<{ id: string }>
      total: number
      nextCursor: string | null
    }
    expect(one.total).toBe(2)
    expect(one.items).toHaveLength(1)
    expect(one.nextCursor).toBe("1")

    const pageTwo = await get(
      new URLSearchParams({
        view: "drafts",
        userId: "associate_a",
        matterId,
        limit: "1",
        cursor: one.nextCursor ?? "1",
      })
    )
    const two = (await pageTwo.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(two.items).toHaveLength(1)
    expect(two.nextCursor).toBeNull()
  })
})
