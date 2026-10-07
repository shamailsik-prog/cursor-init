// Review round 1, finding 7: a preflight dry run wrote an override row (so preflight + compose
// wrote two), and the row did not say which authorities were overridden.
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { POST as FILINGS } from "@/app/api/d4/filings/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { seedJudgment, seedTreatment } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

afterEach(() => resetRuntimeStoreForTests())
let n = 0
const key = () => `a7a7a7a7-0000-4000-8000-${String(++n).padStart(12, "0")}`
const post = (route: typeof DRAFTS, url: string, body: unknown) =>
  route(
    new Request(`http://127.0.0.1${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify(body),
    })
  )

function setup() {
  const store = getRuntimeStore()
  const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "confidential" })
  for (const u of ["partner_a", "associate_a"]) addMember(store, m.id, u, "firmA")
  seedJudgment(store, "j-old", "Old", "single", "2019 SCMR 1234")
  seedJudgment(store, "j-new", "New", "larger", "2021 SCMR 1")
  seedTreatment(store, "j-new", "j-old", "overruled", "larger")
  return { store, matterId: m.id }
}
const overrides = (store: ReturnType<typeof getRuntimeStore>) =>
  store.audit.filter((row) => row.action === "citation_gate_override")

describe("citation override audit rows", () => {
  it("preflight writes none; compose writes exactly one naming the authorities, at the matter's classification", async () => {
    const { store, matterId } = setup()
    const base = {
      actorId: "partner_a", matterId, classification: "privileged",
      body: "Relying on 2019 SCMR 1234 and 2001 YLR 999.",
      partnerOverride: { reason: "Distinguished" },
    }
    const pre = await post(DRAFTS, "/api/d4/drafts", { action: "preflight", ...base })
    expect(pre.status).toBe(200)
    expect(overrides(store)).toHaveLength(0)
    const composed = await post(DRAFTS, "/api/d4/drafts", {
      action: "compose", templateId: getDocumentTypes()[0]!.id, title: "x", ...base,
    })
    expect(composed.status).toBe(200)
    const rows = overrides(store)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actorId: "partner_a",
      target: matterId,
      classification: "confidential",
      reason: "Distinguished",
      overriddenAuthorities: ["2019 SCMR 1234:OVERRULED", "2001 YLR 999:UNVERIFIED"],
    })
  })

  it("approval override row names the authorities it cleared", async () => {
    const { store, matterId } = setup()
    seedJudgment(store, "j-x", "X", "single", "2018 CLC 789")
    const composed = await post(DRAFTS, "/api/d4/drafts", {
      action: "compose", actorId: "associate_a", matterId, templateId: getDocumentTypes()[0]!.id,
      title: "x", body: "Relying on 2018 CLC 789.", classification: "confidential",
    })
    const draftId = ((await composed.json()) as { result: { draft: { id: string } } }).result.draft.id
    const created = await post(FILINGS, "/api/d4/filings", { action: "create_package", actorId: "associate_a", matterId, draftId, classification: "confidential" })
    const pkg = ((await created.json()) as { result: { filingPackage: { id: string } } }).result.filingPackage.id
    seedTreatment(store, "j-new", "j-x", "overruled", "larger")
    const approved = await post(FILINGS, "/api/d4/filings", {
      action: "decide_package", actorId: "partner_a", packageId: pkg, decision: "approve", reason: "ok",
      partnerOverride: { reason: "Still good law on this point" },
    })
    expect(approved.status).toBe(200)
    const rows = overrides(store)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ overriddenAuthorities: ["2018 CLC 789:OVERRULED"], classification: "confidential" })
  })
})
