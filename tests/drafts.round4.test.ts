// Review round 4: R4-2 (the draft title is charset-checked and gated) and R4-4 (package creation
// and approval hash and analyse the normalised body, normalising a raw client-SDK body at read time).
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { POST as FILINGS } from "@/app/api/d4/filings/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { seedJudgment, seedTreatment } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

afterEach(() => resetRuntimeStoreForTests())
let n = 0
const key = () => `d4d4d4d4-0000-4000-8000-${String(++n).padStart(12, "0")}`
const post = (route: typeof DRAFTS, url: string, body: unknown) =>
  route(new Request(`http://127.0.0.1${url}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() }, body: JSON.stringify(body) }))
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

function setup() {
  const store = getRuntimeStore()
  const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
  for (const u of ["partner_a", "associate_a"]) addMember(store, m.id, u, "firmA")
  seedJudgment(store, "j-old", "Old", "single", "2019 SCMR 1234")
  seedJudgment(store, "j-new", "New", "larger", "2021 SCMR 1")
  seedTreatment(store, "j-new", "j-old", "overruled", "larger")
  return { store, matterId: m.id }
}
const compose = (matterId: string, body: string, title = "x") =>
  post(DRAFTS, "/api/d4/drafts", { action: "compose", actorId: "associate_a", matterId, templateId: getDocumentTypes()[0]!.id, title, body, classification: "internal" })
const createPackage = (matterId: string, draftId: string) =>
  post(FILINGS, "/api/d4/filings", { action: "create_package", actorId: "associate_a", matterId, draftId, classification: "internal" })
const approve = (packageId: string) =>
  post(FILINGS, "/api/d4/filings", { action: "decide_package", actorId: "partner_a", packageId, decision: "approve", reason: "ok" })
async function composed(matterId: string, body = "Relying on the Constitution.", title = "Petition") {
  const res = await compose(matterId, body, title)
  expect(res.status).toBe(200)
  return ((await res.json()) as { result: { draft: { id: string } } }).result.draft.id
}
async function packaged(matterId: string, draftId: string) {
  const res = await createPackage(matterId, draftId)
  expect(res.status).toBe(200)
  return ((await res.json()) as { result: { filingPackage: { id: string; draftBodySha256: string } } }).result.filingPackage
}

describe("R4-2: the draft title is charset-checked and gated like the body", () => {
  it("compose: an overruled citation in the title is 422 even with a clean body", async () => {
    const { store, matterId } = setup()
    const res = await compose(matterId, "Relying on the Constitution.", "Writ Petition relying on 2019 SCMR 1234")
    expect(res.status).toBe(422)
    expect([...store.drafts.values()]).toHaveLength(0)
  })
  it("compose: a title with an RLO is 422 unsupported_characters", async () => {
    const { matterId } = setup()
    const res = await compose(matterId, "Relying on the Constitution.", "Petition ‮4321 RMCS 9102‬")
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe("unsupported_characters")
  })
  it("compose stores the normalised title", async () => {
    const { store, matterId } = setup()
    const id = await composed(matterId, "Clean.", "Petition ۱۲ – draft")
    expect(store.drafts.get(id)?.title).toBe("Petition 12 - draft")
  })
  it("preflight gates the title", async () => {
    const { matterId } = setup()
    const res = await post(DRAFTS, "/api/d4/drafts", { action: "preflight", actorId: "associate_a", matterId, classification: "internal", title: "Relying on 2019 SCMR 1234", body: "Clean." })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { result: { result: { ok: boolean } } }).result.result.ok).toBe(false)
  })
  it("package creation and approval gate a title changed after compose (client-SDK title edits are allowed on locked drafts)", async () => {
    const { store, matterId } = setup()
    const draftId = await composed(matterId)
    const draft = store.drafts.get(draftId)!
    store.drafts.set(draftId, { ...draft, title: "Relying on 2019 SCMR 1234" })
    expect((await createPackage(matterId, draftId)).status).toBe(422)
    store.drafts.set(draftId, draft)
    const pkg = await packaged(matterId, draftId)
    store.drafts.set(draftId, { ...store.drafts.get(draftId)!, title: "Relying on 2019 SCMR 1234" })
    expect((await approve(pkg.id)).status).toBe(422)
    store.drafts.set(draftId, { ...store.drafts.get(draftId)!, title: "Petition ‮x" })
    const refused = await approve(pkg.id)
    expect(refused.status).toBe(422)
    expect(((await refused.json()) as { code: string }).code).toBe("unsupported_characters")
    store.drafts.set(draftId, { ...store.drafts.get(draftId)!, title: "Petition" })
    expect((await approve(pkg.id)).status).toBe(200)
  })
})
