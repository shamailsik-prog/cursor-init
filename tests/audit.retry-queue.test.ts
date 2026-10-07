// Review round 2, N4: one unpersisted row pinned the bounded log forever, and rows of a failed
// flush were never retried.
import { afterEach, describe, expect, it, vi } from "vitest"
import { GET as FILINGS_GET } from "@/app/api/d4/filings/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import {
  AUDIT_RETRY_BACKOFF_BASE_MS,
  AUDIT_RETRY_BACKOFF_MAX_MS,
  AuditLog,
  MAX_FLUSH_ATTEMPTS,
  isAuditRowDeadLettered,
  isAuditRowPersisted,
  markAuditRowPersisted,
} from "@/platform/audit/requestAudit"
import { flushRequestAudit, setRequestAuditSinkForTests } from "@/platform/persistence/requestAuditFlush"
import type { AuditEntry } from "@/platform/spine/store"

afterEach(() => {
  setRequestAuditSinkForTests(null)
  resetRuntimeStoreForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const row = (target: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  action: "x", actorId: "partner_a", target, classification: "internal", firmId: "firmA", ...extra,
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

describe("bounded audit log with a retry queue", () => {
  it("an unpersisted row no longer pins the log: trimming skips past it", () => {
    const log = new AuditLog(5, 10)
    const stuck = row("stuck")
    log.push(stuck) // outside any request: queued for retry, not persisted
    for (let i = 0; i < 50; i += 1) {
      const r = row(String(i))
      markAuditRowPersisted(r)
      log.push(r)
    }
    expect(log.length).toBeLessThanOrEqual(5 + 1)
    expect(log).toContain(stuck)
    expect(log.retryQueue).toContain(stuck)
  })

  it("rows of a failed flush are retried by the next request's flush", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    seed()
    setRequestAuditSinkForTests(async () => {
      throw new Error("audit store down")
    })
    const failed = await FILINGS_GET(new Request("http://127.0.0.1/api/d4/filings?userId=partner_a&view=packages"))
    expect(failed.status).toBe(503)
    const owed = [...getRuntimeStore().audit.retryQueue]
    expect(owed.length).toBeGreaterThan(0)
    // R3 N13: a failed row waits out its backoff window before the next attempt
    vi.setSystemTime(Date.now() + AUDIT_RETRY_BACKOFF_BASE_MS)
    const flushed: AuditEntry[] = []
    setRequestAuditSinkForTests(async (rows) => {
      flushed.push(...rows)
    })
    const ok = await FILINGS_GET(new Request("http://127.0.0.1/api/d4/filings?userId=partner_a&view=packages"))
    expect(ok.status).toBe(200)
    for (const r of owed) {
      expect(flushed).toContain(r)
      expect(isAuditRowPersisted(r)).toBe(true)
    }
    expect(getRuntimeStore().audit.retryQueue).toHaveLength(0)
  })

  it("a row that keeps failing is dead-lettered (logged) after MAX_FLUSH_ATTEMPTS and stops pinning", async () => {
    const store = getRuntimeStore()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const poison = row("poison")
    store.audit.push(poison)
    setRequestAuditSinkForTests(async (rows) => {
      if (rows.includes(poison)) throw new Error("conflict")
    })
    vi.useFakeTimers({ toFake: ["Date"] })
    for (let i = 0; i < MAX_FLUSH_ATTEMPTS; i += 1) {
      await flushRequestAudit([]).catch(() => {})
      vi.setSystemTime(Date.now() + AUDIT_RETRY_BACKOFF_MAX_MS) // one attempt per backoff window (R3 N13)
    }
    expect(isAuditRowDeadLettered(poison)).toBe(true)
    expect(store.audit.retryQueue).not.toContain(poison)
    expect(errors.mock.calls.some((c) => String(c[0]).includes("dead-letter"))).toBe(true)
  })

  it("the retry queue is capped: overflow is dead-lettered and logged, the log stays bounded", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const log = new AuditLog(5, 3)
    const rows = Array.from({ length: 10 }, (_, i) => row(`q${i}`))
    for (const r of rows) log.push(r)
    expect(log.retryQueue).toHaveLength(3)
    expect(rows.slice(0, 7).every((r) => isAuditRowDeadLettered(r))).toBe(true)
    expect(log.length).toBeLessThanOrEqual(5 + 3)
    expect(errors).toHaveBeenCalled()
  })
})
