import { afterEach, describe, expect, it, vi } from "vitest"
import { GET, POST } from "@/app/api/d4/filings/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { composeDraft } from "@/services/d4-1/drafts"
import { getDocumentTypes } from "@/lib/foundation-data"

afterEach(() => {
  vi.restoreAllMocks()
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/d4/filings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    })
  )
}

function get(params: Record<string, string>) {
  return GET(
    new Request(`http://127.0.0.1/api/d4/filings?${new URLSearchParams(params).toString()}`)
  )
}

async function seedApprovedPackage(): Promise<string> {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Side-effect-free GET matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  const template = getDocumentTypes()[0]
  if (!template) throw new Error("missing template seed")
  const draft = composeDraft(store, {
    actorId: "associate_a",
    matterId: matter.id,
    templateId: template.id,
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
  const created = await post(
    {
      action: "create_package",
      actorId: "associate_a",
      matterId: matter.id,
      draftId: draft.id,
      classification: "internal",
      citedJudgmentIds: [],
      temporalCitations: [],
    },
    crypto.randomUUID()
  )
  expect(created.status).toBe(200)
  const packageId = ((await created.json()) as { result: { filingPackage: { id: string } } })
    .result.filingPackage.id
  const approved = await post(
    {
      action: "decide_package",
      actorId: "partner_a",
      packageId,
      decision: "approve",
      reason: "Ready for filing",
    },
    crypto.randomUUID()
  )
  expect(approved.status).toBe(200)
  return packageId
}

describe("GET /api/d4/filings is side-effect free", () => {
  it("POST create/decide persists the packet artifact and dispatch queue row", async () => {
    const packageId = await seedApprovedPackage()
    const store = getRuntimeStore()
    expect([...store.filingPacketArtifacts.values()].some((r) => r.packageId === packageId)).toBe(
      true
    )
    expect([...store.filingDispatchQueue.values()].some((r) => r.packageId === packageId)).toBe(
      true
    )
  })

  it("derives missing packet artifacts / dispatch rows for the response without writing them", async () => {
    const packageId = await seedApprovedPackage()
    const store = getRuntimeStore()
    // Simulate a legacy package whose derived rows were never materialised.
    store.filingPacketArtifacts.clear()
    store.filingDispatchQueue.clear()

    const list = await get({ userId: "associate_a", limit: "10", cursor: "0" })
    expect(list.status).toBe(200)
    const listJson = (await list.json()) as {
      items: Array<{ id: string; packetArtifact: { readiness: string } | null }>
    }
    expect(
      listJson.items.some((row) => row.id === packageId && row.packetArtifact?.readiness === "ready")
    ).toBe(true)

    const dispatch = await get({
      view: "dispatch",
      userId: "associate_a",
      limit: "10",
      cursor: "0",
    })
    expect(dispatch.status).toBe(200)
    const dispatchJson = (await dispatch.json()) as {
      items: Array<{ packageId: string; status: string }>
    }
    expect(
      dispatchJson.items.some((row) => row.packageId === packageId && row.status === "queued")
    ).toBe(true)

    expect(store.filingPacketArtifacts.size).toBe(0)
    expect(store.filingDispatchQueue.size).toBe(0)
  })

  it("derives the same rows on every GET (timestamps anchored to the package, not the clock)", async () => {
    const packageId = await seedApprovedPackage()
    const store = getRuntimeStore()
    const createdAt = [...store.filingPackages.values()].find((row) => row.id === packageId)
      ?.createdAt
    store.filingPacketArtifacts.clear()
    store.filingDispatchQueue.clear()

    let clock = 5_000_000_000_000
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 60_000))
    const read = async () => {
      const list = (await (await get({ userId: "associate_a", limit: "10", cursor: "0" })).json()) as {
        items: Array<{ id: string; packetArtifact: unknown }>
      }
      const dispatch = (await (
        await get({ view: "dispatch", userId: "associate_a", limit: "10", cursor: "0" })
      ).json()) as { items: Array<{ packageId: string; updatedAt: number }> }
      return {
        artifact: list.items.find((row) => row.id === packageId)?.packetArtifact,
        queue: dispatch.items.find((row) => row.packageId === packageId),
      }
    }
    const first = await read()
    const second = await read()
    expect(first.artifact).toBeDefined()
    expect(first.queue).toBeDefined()
    expect(second).toEqual(first)
    expect(first.queue?.updatedAt).toBe(createdAt)
  })
})
