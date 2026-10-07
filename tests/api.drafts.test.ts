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

function secondTemplateId(): string {
  const second = getDocumentTypes()[1]
  if (!second) throw new Error("second document type seed missing")
  return second.id
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

  it("tracks template search analytics for actor-scoped template discovery", async () => {
    const query = templateId()
    const first = await get(
      new URLSearchParams({
        view: "templates",
        actorId: "associate_a",
        q: query,
        limit: "10",
        cursor: "0",
      })
    )
    expect(first.status).toBe(200)
    const one = (await first.json()) as {
      items: Array<{ id: string; analytics: { templateSearchCount: number } }>
    }
    expect(one.items).toHaveLength(1)
    expect(one.items[0]?.id).toBe(query)
    expect(one.items[0]?.analytics.templateSearchCount).toBe(1)

    const second = await get(
      new URLSearchParams({
        view: "templates",
        actorId: "associate_a",
        q: query,
        limit: "10",
        cursor: "0",
      })
    )
    expect(second.status).toBe(200)
    const two = (await second.json()) as {
      items: Array<{ id: string; analytics: { templateSearchCount: number } }>
    }
    expect(two.items[0]?.id).toBe(query)
    expect(two.items[0]?.analytics.templateSearchCount).toBe(2)
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

  it("rejects an associate naming a partner in partnerOverride (403), keeping the OVERRULED block", async () => {
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

    const spoofed = await post(
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
    expect(spoofed.status).toBe(403)
    expect([...store.drafts.values()]).toHaveLength(0)
    expect(store.audit.some((row) => row.action === "citation_gate_override")).toBe(false)

    const associateSelf = await post(
      {
        action: "preflight",
        actorId: "associate_a",
        matterId,
        classification: "internal",
        citedJudgmentIds: ["j-old"],
        partnerOverride: { reason: "I am not a partner" },
      },
      "5a0f3e38-0d33-4a0e-9d7c-4b1f0a6b9e11"
    )
    expect(associateSelf.status).toBe(403)
  })

  it("lets the partner override the OVERRULED block for themselves with a reason, and audits the reason", async () => {
    const matterId = seedMatter("internal")
    const store = getRuntimeStore()
    seedJudgment(store, "j-old", "Old authority", "single")
    seedJudgment(store, "j-new", "Larger bench", "larger")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")

    const missingReason = await post(
      {
        action: "compose",
        actorId: "partner_a",
        matterId,
        templateId: templateId(),
        title: "Partner draft",
        body: "Body",
        classification: "internal",
        citedJudgmentIds: ["j-old"],
        partnerOverride: { partnerId: "partner_a", reason: "   " },
      },
      "0c5d3a55-6a57-4d59-a0f4-1f2e6b8d7c01"
    )
    expect(missingReason.status).toBe(400)

    const naming = await post(
      {
        action: "compose",
        actorId: "partner_a",
        matterId,
        templateId: templateId(),
        title: "Partner draft",
        body: "Body",
        classification: "internal",
        citedJudgmentIds: ["j-old"],
        partnerOverride: { partnerId: "partner_b", reason: "Other firm partner" },
      },
      "6e7b1a9c-2f44-4c1e-8d0b-3a5c9e7f1d02"
    )
    expect(naming.status).toBe(403)

    const allowed = await post(
      {
        action: "compose",
        actorId: "partner_a",
        matterId,
        templateId: templateId(),
        title: "Partner draft",
        body: "Body",
        classification: "internal",
        citedJudgmentIds: ["j-old"],
        temporalCitations: [],
        partnerOverride: {
          reason: "Distinguished on facts and client instruction",
        },
      },
      "9d2c4b1a-7e6f-4a3b-8c5d-0e1f2a3b4c03"
    )
    expect(allowed.status).toBe(200)
    const ok = (await allowed.json()) as {
      result: { draft: { id: string; templateId: string } }
    }
    expect(ok.result.draft.id).toBeTruthy()
    expect(ok.result.draft.templateId).toBe(templateId())
    const overrides = store.audit.filter((row) => row.action === "citation_gate_override")
    expect(overrides).toHaveLength(1)
    expect(overrides[0]).toMatchObject({
      actorId: "partner_a",
      target: matterId,
      reason: "Distinguished on facts and client instruction",
    })
  })

  it("extracts citations from the draft body: an overruled authority blocks even when the caller omits it", async () => {
    const matterId = seedMatter("internal")
    const store = getRuntimeStore()
    seedJudgment(store, "j-old", "Old authority", "single", "PLD 2010 Lahore 5")
    seedJudgment(store, "j-new", "Larger bench", "larger", "PLD 2020 SC 1")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")

    const res = await post(
      {
        action: "compose",
        actorId: "associate_a",
        matterId,
        templateId: templateId(),
        title: "Relies on overruled case",
        body: "The petitioner relies on PLD 2010 Lah. 5 for the proposition.",
        classification: "internal",
        citedJudgmentIds: [],
      },
      "3b9e1c7d-2a4f-4e6b-9c8d-1f0a2b3c4d06"
    )
    expect(res.status).toBe(422)
    const json = (await res.json()) as {
      preflight: { citationStatus: string; citations: Array<{ ref: string; status: string }> }
    }
    expect(json.preflight.citationStatus).toBe("OVERRULED")
    expect(json.preflight.citations).toEqual([
      { ref: "PLD 2010 Lahore 5", judgmentId: "j-old", status: "OVERRULED" },
    ])
  })

  it("blocks an unknown authority as UNVERIFIED (E-22) and lets the calling partner override with a reason", async () => {
    const matterId = seedMatter("internal")
    const store = getRuntimeStore()
    seedJudgment(store, "j-good", "Good law", "division", "2019 SCMR 1234")

    const verified = await post(
      {
        action: "preflight",
        actorId: "associate_a",
        matterId,
        classification: "internal",
        body: "See 2019 SCMR 1234.",
      },
      "4c0f2d8e-3b5a-4f7c-8d9e-2a1b3c4d5e07"
    )
    expect(verified.status).toBe(200)
    const v = (await verified.json()) as { result: { result: { ok: boolean; citationStatus: string } } }
    expect(v.result.result).toMatchObject({ ok: true, citationStatus: "OK" })

    const unknown = await post(
      {
        action: "compose",
        actorId: "associate_a",
        matterId,
        templateId: templateId(),
        title: "Cites unknown authority",
        body: "See 2019 SCMR 1234 and 2001 YLR 999.",
        classification: "internal",
      },
      "5d1a3e9f-4c6b-4a8d-9e0f-3b2c4d5e6f08"
    )
    expect(unknown.status).toBe(422)
    const u = (await unknown.json()) as { preflight: { citationStatus: string } }
    expect(u.preflight.citationStatus).toBe("UNVERIFIED")

    const overridden = await post(
      {
        action: "compose",
        actorId: "partner_a",
        matterId,
        templateId: templateId(),
        title: "Cites unknown authority",
        body: "See 2019 SCMR 1234 and 2001 YLR 999.",
        classification: "internal",
        partnerOverride: { reason: "Reported copy checked against the printed volume" },
      },
      "6e2b4f0a-5d7c-4b9e-8f1a-4c3d5e6f7a09"
    )
    expect(overridden.status).toBe(200)
    expect(store.audit.filter((row) => row.action === "citation_gate_override")).toHaveLength(1)
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
    expect(conflict.status).toBe(422) // idempotency_key_reused (final audit F4: functions semantics)
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

  it("orders draft discovery by persisted template compose analytics", async () => {
    const matterId = seedMatter("internal")
    const primaryTemplate = templateId()
    const secondaryTemplate = secondTemplateId()
    await post(
      {
        action: "compose",
        actorId: "associate_a",
        matterId,
        templateId: primaryTemplate,
        title: "Draft Primary A",
        body: "Body",
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
      "fbbf9be9-a051-43d6-9f3d-df4f0d0b68bf"
    )
    await post(
      {
        action: "compose",
        actorId: "associate_a",
        matterId,
        templateId: secondaryTemplate,
        title: "Draft Secondary",
        body: "Body",
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
      "e8aa0905-b58a-4f99-8382-0a0aa4fd846d"
    )
    await post(
      {
        action: "compose",
        actorId: "associate_a",
        matterId,
        templateId: primaryTemplate,
        title: "Draft Primary B",
        body: "Body",
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
      "7a9aa75b-c412-4a4d-8eab-5caad3a5f992"
    )

    const ranked = await get(
      new URLSearchParams({
        view: "drafts",
        userId: "associate_a",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(ranked.status).toBe(200)
    const rankedJson = (await ranked.json()) as { items: Array<{ templateId: string }> }
    expect(rankedJson.items[0]?.templateId).toBe(primaryTemplate)
  })
})
