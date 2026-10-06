// Review round 3, N13: attempts were counted per concurrent flush (one burst of 5 failing
// requests dead-lettered an owed row in ~5 ms), concurrent flushes re-sent the same row, and a
// dead-letter survived only as a console line with identifiers.
import { afterEach, describe, expect, it, vi } from "vitest"
import { GET as FILINGS_GET } from "@/app/api/d4/filings/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import {
  AUDIT_RETRY_BACKOFF_BASE_MS,
  MAX_FLUSH_ATTEMPTS,
  isAuditRowDeadLettered,
  isAuditRowPersisted,
} from "@/platform/audit/requestAudit"
import { flushRequestAudit, setRequestAuditSinkForTests } from "@/platform/persistence/requestAuditFlush"
import type { AuditEntry } from "@/platform/spine/store"

afterEach(() => {
  setRequestAuditSinkForTests(null)
  resetRuntimeStoreForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function seed() {
  const store = getRuntimeStore()
  const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
  addMember(store, m.id, "partner_a", "firmA")
  return store
}
const get = () => FILINGS_GET(new Request("http://127.0.0.1/api/d4/filings?userId=partner_a&view=packages"))
const owedRow = (target: string): AuditEntry =>
  ({ action: "background_thing", actorId: "partner_a", target, classification: "confidential", reason: "full reason text", overriddenAuthorities: ["2019 SCMR 1234:OVERRULED"] }) as AuditEntry

describe("audit retry: in-flight set, backoff windows, durable dead-letter", () => {
  it("a burst of 5 concurrent requests against a failing store is one attempt for an owed row, never a dead-letter", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const store = seed()
    const owed = owedRow("x")
    store.audit.push(owed)
    let sentOwed = 0
    setRequestAuditSinkForTests(async (rows) => {
      sentOwed += rows.filter((r) => r === owed).length
      await new Promise((r) => setTimeout(r, 5))
      throw new Error("down")
    })
    const res = await Promise.all(Array.from({ length: 5 }, get))
    // these GETs write no audit rows of their own; an older owed row failing never fails a request
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
    expect(sentOwed).toBe(1)
    expect(isAuditRowDeadLettered(owed)).toBe(false)
    expect(store.audit.retryQueue).toContain(owed)
  })

  it("with a working sink, concurrent flushes send an owed row exactly once", async () => {
    const store = seed()
    const owed = owedRow("y")
    store.audit.push(owed)
    let sentOwed = 0
    setRequestAuditSinkForTests(async (rows) => {
      sentOwed += rows.filter((r) => r === owed).length
      await new Promise((r) => setTimeout(r, 5))
    })
    await Promise.all(Array.from({ length: 3 }, get))
    expect(sentOwed).toBe(1)
    expect(isAuditRowPersisted(owed)).toBe(true)
  })

  it("a failed row is not retried before its backoff window; attempts count per window", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-06T00:00:00Z"))
    const store = seed()
    const owed = owedRow("z")
    store.audit.push(owed)
    let sends = 0
    setRequestAuditSinkForTests(async (rows) => {
      if (rows.includes(owed)) sends += 1
      throw new Error("down")
    })
    await flushRequestAudit([]).catch(() => {})
    expect(sends).toBe(1)
    for (let i = 0; i < 10; i += 1) await flushRequestAudit([]).catch(() => {})
    expect(sends).toBe(1) // still inside the first backoff window
    vi.setSystemTime(Date.now() + AUDIT_RETRY_BACKOFF_BASE_MS)
    await flushRequestAudit([]).catch(() => {})
    expect(sends).toBe(2)
    expect(isAuditRowDeadLettered(owed)).toBe(false)
  })

  it("after MAX_FLUSH_ATTEMPTS windows the full row goes to the durable audit_dead_letter repository and is logged", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-06T00:00:00Z"))
    const store = seed()
    const owed = owedRow("poison")
    store.audit.push(owed)
    setRequestAuditSinkForTests(async (rows) => {
      if (rows.includes(owed)) throw new Error("conflict")
    })
    for (let i = 0; i < MAX_FLUSH_ATTEMPTS; i += 1) {
      await flushRequestAudit([]).catch(() => {})
      vi.setSystemTime(Date.now() + 60 * 60 * 1000)
    }
    expect(isAuditRowDeadLettered(owed)).toBe(true)
    await flushRequestAudit([]).catch(() => {})
    expect(store.auditDeadLetters).toHaveLength(1)
    expect(store.auditDeadLetters[0]).toMatchObject({
      row: { action: "background_thing", reason: "full reason text", classification: "confidential", overriddenAuthorities: ["2019 SCMR 1234:OVERRULED"] },
    })
    expect(store.auditDeadLetters[0]?.reason).toMatch(/attempts/)
    expect(errors.mock.calls.some((c) => String(c[0]).includes("dead-letter"))).toBe(true)
  })
})
