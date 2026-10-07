// Review round 2, N6: the matter's case number is the source of the citation gate's own-case
// exemption; only a partner member records it, through the API, audited.
import { afterEach, describe, expect, it } from "vitest"
import { POST as MATTERS } from "@/app/api/d1/matters/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

afterEach(() => resetRuntimeStoreForTests())
let n = 0
const key = () => `d6d6d6d6-0000-4000-8000-${String(++n).padStart(12, "0")}`
const post = (body: unknown) =>
  MATTERS(new Request("http://127.0.0.1/api/d1/matters", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() }, body: JSON.stringify(body) }))

describe("record_case_number is partner-only and audited (review R2 N6)", () => {
  it("an associate member is refused; a partner member records it with an audit row", async () => {
    const store = getRuntimeStore()
    const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
    addMember(store, m.id, "partner_a", "firmA")
    addMember(store, m.id, "associate_a", "firmA")
    const byAssociate = await post({ action: "record_case_number", actorId: "associate_a", matterId: m.id, raw: "C.P. No. D-1234 of 2025", courtId: "SHC" })
    expect(byAssociate.status).toBe(403)
    expect(store.matters.get(m.id)?.caseNumber).toBeNull()
    const byPartner = await post({ action: "record_case_number", actorId: "partner_a", matterId: m.id, raw: "C.P. No. D-1234 of 2025", courtId: "SHC" })
    expect(byPartner.status).toBe(200)
    expect(store.matters.get(m.id)?.caseNumber).toBeTruthy()
    expect(store.audit.some((r) => r.action === "matter_record_case_number" && r.actorId === "partner_a")).toBe(true)
  })
})

describe("escalation-closure rows: partner who can access every referenced package (review R2 N6)", () => {
  it("closureRowVisible", async () => {
    const { closureRowVisible } = await import("@/services/d4-3/closureVisibility")
    const store = getRuntimeStore()
    const m1 = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "a", courtId: "SHC", classification: "internal" })
    const m2 = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "b", courtId: "SHC", classification: "internal" })
    addMember(store, m1.id, "partner_a", "firmA")
    addMember(store, m1.id, "associate_a", "firmA")
    const pk = new Map([
      ["pk1", { matterId: m1.id, classification: "internal" as const }],
      ["pk2", { matterId: m2.id, classification: "internal" as const }],
    ])
    const lookup = (id: string) => pk.get(id)
    const partner = store.users.get("partner_a")!
    const associate = store.users.get("associate_a")!
    expect(closureRowVisible(store, associate, ["pk1"], lookup)).toBe(false)
    expect(closureRowVisible(store, partner, ["pk1"], lookup)).toBe(true)
    expect(closureRowVisible(store, partner, ["pk1", "pk2"], lookup)).toBe(false)
    expect(closureRowVisible(store, partner, ["pk1", "missing"], lookup)).toBe(false)
    expect(closureRowVisible(store, partner, [], lookup)).toBe(true)
    expect(closureRowVisible(store, associate, [], lookup)).toBe(false)
    addMember(store, m2.id, "partner_a", "firmA")
    expect(closureRowVisible(store, partner, ["pk1", "pk2"], lookup)).toBe(true)
  })

  it("no filings view filters closure rows by 'some' package any more", async () => {
    const { readFileSync } = await import("node:fs")
    const route = readFileSync("app/api/d4/filings/route.ts", "utf8")
    expect(route).not.toMatch(/packageIds\.some\(/)
    expect((route.match(/closureRowVisible\(/g) ?? []).length).toBeGreaterThanOrEqual(23)
  })
})
