// Review round 4, R4-6: a dead-letter is persisted at the moment it is dead-lettered (the
// in-memory list is only a cache of unwritten letters), and a re-queue keeps the oldest first.
import { afterEach, describe, expect, it, vi } from "vitest"
import { AuditLog, type AuditDeadLetter } from "@/platform/audit/requestAudit"
import { flushRequestAudit } from "@/platform/persistence/requestAuditFlush"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import type { AuditEntry } from "@/platform/spine/store"

afterEach(() => {
  resetRuntimeStoreForTests()
  vi.restoreAllMocks()
})
const row = (target: string): AuditEntry =>
  ({ action: "x", actorId: "partner_a", target, classification: "internal", firmId: "firmA", reason: "full" }) as AuditEntry

describe("R4-6: dead-letters are durable immediately", () => {
  it("dead-lettering writes the full row to the audit_dead_letter repository without waiting for a flush", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const store = getRuntimeStore()
    const r = row("now")
    store.audit.deadLetter(r, "failed 5 persist attempts: x")
    await store.audit.settleDeadLetterWrites()
    expect(store.auditDeadLetters).toHaveLength(1)
    expect(store.auditDeadLetters[0]).toMatchObject({ row: { target: "now", reason: "full" }, reason: "failed 5 persist attempts: x" })
    expect(store.audit.takeDeadLetters()).toEqual([]) // nothing left in the cache
  })

  it("a failed immediate write stays cached and the next flush writes it exactly once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const store = getRuntimeStore()
    const writes: AuditDeadLetter[] = []
    let fail = true
    store.audit.setDeadLetterWriter(async (letter) => {
      if (fail) throw new Error("store down")
      writes.push(letter)
    })
    store.audit.deadLetter(row("later"), "r")
    await store.audit.settleDeadLetterWrites()
    expect(writes).toHaveLength(0)
    fail = false
    await flushRequestAudit([])
    await flushRequestAudit([])
    expect(writes.map((l) => l.row.target)).toEqual(["later"])
  })
})

describe("R4-6: re-queued dead-letters keep the oldest first", () => {
  it("requeue puts the older letters in front and, over capacity, drops (logs) the oldest", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const log = new AuditLog(10, 2)
    log.setDeadLetterWriter(null)
    log.deadLetter(row("c"), "r")
    const letter = (target: string, at: number): AuditDeadLetter => ({ row: row(target), reason: "r", deadLetteredAt: at })
    log.requeueDeadLetters([letter("a", 1), letter("b", 2)])
    const taken = log.takeDeadLetters()
    expect(taken.map((l) => l.row.target)).toEqual(["b", "c"])
    expect(errors.mock.calls.some((c) => String(c[0]).includes("could not be stored durably") && String(c[1]).includes('"a"'))).toBe(true)
  })
})

describe("review round 4 audit4 probe: concurrency and a flaky dead-letter store", () => {
  it("6 backoff windows x 8 concurrent requests: each owed row is dead-lettered once, with one stored copy", async () => {
    const { GET: FILINGS_GET } = await import("@/app/api/d4/filings/route")
    const { addMember, createMatter } = await import("@/services/d1-2/matters")
    const { setRequestAuditSinkForTests } = await import("@/platform/persistence/requestAuditFlush")
    const { getRuntimeRepositories } = await import("@/platform/persistence/runtimeRepositories")
    const { isAuditRowDeadLettered, MAX_FLUSH_ATTEMPTS } = await import("@/platform/audit/requestAudit")
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      let now = Date.parse("2026-10-06T00:00:00Z")
      vi.setSystemTime(now)
      const store = getRuntimeStore()
      const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
      addMember(store, m.id, "partner_a", "firmA")
      const owed = Array.from({ length: 3 }, (_, i) => ({ action: "bg" + i, actorId: "partner_a", target: "x", classification: "internal" }) as AuditEntry)
      for (const r of owed) store.audit.push(r)
      let sinkCalls = 0
      setRequestAuditSinkForTests(async () => {
        sinkCalls += 1
        await new Promise((r) => setTimeout(r, 2))
        throw new Error("down")
      })
      const repos = await getRuntimeRepositories(store)
      const original = repos.auditDeadLetter.append.bind(repos.auditDeadLetter)
      let dlCalls = 0
      repos.auditDeadLetter.append = async (letter) => {
        dlCalls += 1
        await new Promise((r) => setTimeout(r, 3))
        if (dlCalls === 2) {
          await original(letter)
          throw new Error("timeout after commit")
        }
        return original(letter)
      }
      const get = () => FILINGS_GET(new Request("http://127.0.0.1/api/d4/filings?userId=partner_a&view=packages"))
      for (let w = 0; w < 6; w += 1) {
        await Promise.all(Array.from({ length: 8 }, get))
        now += 6 * 60_000
        vi.setSystemTime(now)
      }
      expect(sinkCalls).toBe(MAX_FLUSH_ATTEMPTS)
      expect(owed.every(isAuditRowDeadLettered)).toBe(true)
      setRequestAuditSinkForTests(async () => {})
      await Promise.all(Array.from({ length: 6 }, get))
      await store.audit.settleDeadLetterWrites()
      expect(owed.map((r) => store.auditDeadLetters.filter((l) => l.row === r).length)).toEqual([1, 1, 1])
      setRequestAuditSinkForTests(null)
    } finally {
      vi.useRealTimers()
    }
  })
})
