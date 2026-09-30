// Review round 1, finding 5: the body a partner approves, the body the gate checked and the
// body later filed could diverge (direct draft edits; stale in-memory copy at approval).
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { POST as FILINGS } from "@/app/api/d4/filings/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { composeDraft } from "@/services/d4-1/drafts"
import { seedJudgment, seedTreatment } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

afterEach(() => resetRuntimeStoreForTests())
let n = 0
const key = () => `f5f5f5f5-0000-4000-8000-${String(++n).padStart(12, "0")}`
const post = (body: unknown) =>
  FILINGS(
    new Request("http://127.0.0.1/api/d4/filings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify(body),
    })
  )
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

async function packageFor(body: string) {
  const store = getRuntimeStore()
  const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
  addMember(store, m.id, "partner_a", "firmA")
  addMember(store, m.id, "associate_a", "firmA")
  const draft = composeDraft(store, {
    actorId: "associate_a", matterId: m.id, templateId: getDocumentTypes()[0]!.id, title: "d", body,
    classification: "internal",
    preflight: { actorId: "associate_a", matterId: m.id, classification: "internal", citedJudgmentIds: [], temporalCitations: [] },
  })
  const res = await post({ action: "create_package", actorId: "associate_a", matterId: m.id, draftId: draft.id, classification: "internal" })
  expect(res.status).toBe(200)
  const pkg = ((await res.json()) as { result: { filingPackage: { id: string; draftBodySha256: string } } }).result.filingPackage
  return { store, matterId: m.id, draftId: draft.id, pkg }
}

describe("filing package pins the draft body", () => {
  it("records sha256 of the body at creation and locks the draft", async () => {
    const { store, draftId, pkg } = await packageFor("Clean pleading.")
    expect(pkg.draftBodySha256).toBe(sha("Clean pleading."))
    expect(store.drafts.get(draftId)?.locked).toBe(true)
  })

  it("an out-of-band body edit after creation makes approval 409 draft_changed (and the edit is not approved)", async () => {
    const { store, draftId, pkg } = await packageFor("Clean pleading.")
    seedJudgment(store, "j-old", "Old", "single", "2019 SCMR 1234")
    seedJudgment(store, "j-new", "New", "larger", "2021 SCMR 1")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")
    const draft = store.drafts.get(draftId)
    if (!draft) throw new Error("draft missing")
    store.drafts.set(draftId, { ...draft, body: "Relying on 2019 SCMR 1234." })
    const res = await post({ action: "decide_package", actorId: "partner_a", packageId: pkg.id, decision: "approve", reason: "ok" })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe("draft_changed")
    expect(store.filingPackages.get(pkg.id)?.status).toBe("pending_partner_approval")
    // An override does not bypass the integrity check either.
    const over = await post({ action: "decide_package", actorId: "partner_a", packageId: pkg.id, decision: "approve", reason: "ok", partnerOverride: { reason: "x" } })
    expect(over.status).toBe(409)
  })

  it("approval with the unchanged body succeeds; rejection unlocks the draft", async () => {
    const first = await packageFor("Clean pleading.")
    const ok = await post({ action: "decide_package", actorId: "partner_a", packageId: first.pkg.id, decision: "approve", reason: "ok" })
    expect(ok.status).toBe(200)
    expect(first.store.drafts.get(first.draftId)?.locked).toBe(true)
    resetRuntimeStoreForTests()
    const second = await packageFor("Another pleading.")
    const rejected = await post({ action: "decide_package", actorId: "partner_a", packageId: second.pkg.id, decision: "reject", reason: "redo" })
    expect(rejected.status).toBe(200)
    expect(second.store.drafts.get(second.draftId)?.locked).toBe(false)
  })
})
