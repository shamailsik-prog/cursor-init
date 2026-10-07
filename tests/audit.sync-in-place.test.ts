// Review round 2, N2: GET /api/p5/tenancy?view=audit replaced store.audit with a plain Array,
// silently disabling per-request audit persistence (and the bound) for the whole process.
import { afterEach, describe, expect, it } from "vitest"
import { GET as FILINGS_GET } from "@/app/api/d4/filings/route"
import { GET as TENANCY_GET } from "@/app/api/p5/tenancy/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { AuditLog } from "@/platform/audit/requestAudit"
import { setRequestAuditSinkForTests } from "@/platform/persistence/requestAuditFlush"
import type { AuditEntry } from "@/platform/spine/store"

afterEach(() => {
  setRequestAuditSinkForTests(null)
  resetRuntimeStoreForTests()
})

function seed() {
  const store = getRuntimeStore()
  const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
  addMember(store, m.id, "partner_a", "firmA")
  store.filingPackages.set("pkg1", {
    id: "pkg1", firmId: "firmA", matterId: m.id, draftId: "d", classification: "internal", citationStatus: "OK",
    temporalAllOk: true, status: "approved", createdBy: "partner_a", createdAt: 1, approvedBy: "partner_a", approvalReason: "r",
  } as never)
  return store
}

describe("the tenancy audit view syncs the log in place", () => {
  it("store.audit stays the same AuditLog and later requests still persist their rows", async () => {
    const store = seed()
    const log = store.audit
    const flushed: AuditEntry[] = []
    setRequestAuditSinkForTests(async (rows) => {
      flushed.push(...rows)
    })
    const view = await TENANCY_GET(new Request("http://127.0.0.1/api/p5/tenancy?view=audit&actorId=partner_a&firmId=firmA"))
    expect(view.status).toBe(200)
    expect(getRuntimeStore().audit).toBe(log)
    expect(getRuntimeStore().audit).toBeInstanceOf(AuditLog)
    const before = flushed.length
    const appendedBefore = getRuntimeStore().audit.length
    const res = await FILINGS_GET(new Request("http://127.0.0.1/api/d4/filings?userId=partner_a&view=packages"))
    expect(res.status).toBe(200)
    const appended = getRuntimeStore().audit.length - appendedBefore
    expect(appended).toBeGreaterThan(0)
    expect(flushed.length - before).toBe(appended)
  })

  it("a sync never drops this firm's local rows that are not persisted yet", async () => {
    const store = seed()
    const pending: AuditEntry = { action: "pending_row", actorId: "partner_a", target: "t", classification: "internal", firmId: "firmA" }
    store.audit.push(pending)
    const { syncFirmAudit } = await import("@/platform/persistence/auditSync")
    const { getRuntimeRepositories } = await import("@/platform/persistence/runtimeRepositories")
    await syncFirmAudit(store, await getRuntimeRepositories(store), "firmA")
    expect(store.audit).toContain(pending)
  })
})
