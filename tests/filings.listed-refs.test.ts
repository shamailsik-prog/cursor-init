// Review round 1, finding 8: ids listed at package creation (not in the body) were not
// re-checked at approval.
import { afterEach, describe, expect, it } from "vitest"
import { POST as FILINGS } from "@/app/api/d4/filings/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { composeDraft } from "@/services/d4-1/drafts"
import { seedJudgment, seedTreatment } from "@/services/d4-2/draftingIntelligence"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"
import { getDocumentTypes } from "@/lib/foundation-data"

afterEach(() => resetRuntimeStoreForTests())
let n = 0
const key = () => `b8b8b8b8-0000-4000-8000-${String(++n).padStart(12, "0")}`
const post = (body: unknown) =>
  FILINGS(new Request("http://127.0.0.1/api/d4/filings", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() }, body: JSON.stringify(body) }))

describe("listed judgment ids are pinned on the package and re-checked at approval", () => {
  it("an id listed at creation and overruled later blocks approval", async () => {
    const store = getRuntimeStore()
    const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
    addMember(store, m.id, "partner_a", "firmA")
    addMember(store, m.id, "associate_a", "firmA")
    seedJudgment(store, "j-listed", "Listed only", "single")
    const draft = composeDraft(store, {
      actorId: "associate_a", matterId: m.id, templateId: getDocumentTypes()[0]!.id, title: "d", body: "Clean body.",
      classification: "internal",
      preflight: { actorId: "associate_a", matterId: m.id, classification: "internal", citedJudgmentIds: [], temporalCitations: [] },
    })
    const created = await post({ action: "create_package", actorId: "associate_a", matterId: m.id, draftId: draft.id, classification: "internal", citedJudgmentIds: ["j-listed", " j-listed "] })
    expect(created.status).toBe(200)
    const pkg = ((await created.json()) as { result: { filingPackage: { id: string; citedRefs: string[] } } }).result.filingPackage
    expect(pkg.citedRefs).toEqual(["j-listed"])

    seedJudgment(store, "j-larger", "Larger", "larger")
    seedTreatment(store, "j-larger", "j-listed", "overruled", "larger")
    const blocked = await post({ action: "decide_package", actorId: "partner_a", packageId: pkg.id, decision: "approve", reason: "ok" })
    expect(blocked.status).toBe(422)
    const overridden = await post({ action: "decide_package", actorId: "partner_a", packageId: pkg.id, decision: "approve", reason: "ok", partnerOverride: { reason: "Distinguished" } })
    expect(overridden.status).toBe(200)
    const row = store.audit.filter((r) => r.action === "citation_gate_override").at(-1)
    expect(row?.overriddenAuthorities).toEqual(["j-listed:OVERRULED"])
  })

  it("the matter's own case number in the body passes creation and approval alike", async () => {
    const store = getRuntimeStore()
    const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
    addMember(store, m.id, "partner_a", "firmA")
    addMember(store, m.id, "associate_a", "firmA")
    recordCaseNumber(store, m.id, "C.P. No. D-1234 of 2025", "SHC")
    const body = "In C.P. No. D-1234 of 2025 the petitioner submits as follows."
    const draft = composeDraft(store, {
      actorId: "associate_a", matterId: m.id, templateId: getDocumentTypes()[0]!.id, title: "d", body,
      classification: "internal",
      preflight: { actorId: "associate_a", matterId: m.id, classification: "internal", citedJudgmentIds: [], temporalCitations: [] },
    })
    const created = await post({ action: "create_package", actorId: "associate_a", matterId: m.id, draftId: draft.id, classification: "internal" })
    expect(created.status).toBe(200)
    const pkg = ((await created.json()) as { result: { filingPackage: { id: string } } }).result.filingPackage
    const approved = await post({ action: "decide_package", actorId: "partner_a", packageId: pkg.id, decision: "approve", reason: "ok" })
    expect(approved.status).toBe(200)
  })
})
