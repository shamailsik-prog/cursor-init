// Review round 1, finding 4: checkPermission rows on GET paths were never persisted, the
// in-memory log grew without bound, and index-based write-through could cross-pick rows.
import { afterEach, describe, expect, it } from "vitest"
import { GET as FILINGS_GET } from "@/app/api/d4/filings/route"
import { withSession } from "@/platform/http/withSession"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import {
  AuditLog,
  currentRequestAuditRows,
  isAuditRowPersisted,
  markAuditRowPersisted,
  runWithRequestAudit,
} from "@/platform/audit/requestAudit"
import { setRequestAuditSinkForTests } from "@/platform/persistence/requestAuditFlush"
import type { AuditEntry } from "@/platform/spine/store"

afterEach(() => {
  setRequestAuditSinkForTests(null)
  resetRuntimeStoreForTests()
})

function seedPackages() {
  const store = getRuntimeStore()
  const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
  addMember(store, m.id, "partner_a", "firmA")
  addMember(store, m.id, "associate_a", "firmA")
  store.filingPackages.set("pkg1", {
    id: "pkg1", firmId: "firmA", matterId: m.id, draftId: "d", classification: "internal", citationStatus: "OK",
    temporalAllOk: true, status: "approved", createdBy: "partner_a", createdAt: 1, approvedBy: "partner_a", approvalReason: "r",
  } as never)
  return { store, matterId: m.id }
}

describe("request audit rows are persisted before the response (GET and POST)", () => {
  it("filings GET views persist every permission_check row they create", async () => {
    const { store } = seedPackages()
    const flushed: AuditEntry[] = []
    setRequestAuditSinkForTests(async (rows) => {
      flushed.push(...rows)
    })
    const before = store.audit.length
    for (const view of ["dispatch", "packages", "artifacts", "annexures"]) {
      const res = await FILINGS_GET(new Request(`http://127.0.0.1/api/d4/filings?userId=partner_a&view=${view}`))
      expect(res.status).toBe(200)
    }
    const created = store.audit.slice(before).filter((row) => row.action === "permission_check")
    expect(created.length).toBeGreaterThan(0)
    expect(flushed.filter((row) => row.action === "permission_check")).toEqual(created)
    expect(created.every((row) => isAuditRowPersisted(row))).toBe(true)
  })

  it("without a test sink the rows go through the audit repository (memory mode) and are marked persisted", async () => {
    const { store } = seedPackages()
    const before = store.audit.length
    const res = await FILINGS_GET(new Request("http://127.0.0.1/api/d4/filings?userId=partner_a"))
    expect(res.status).toBe(200)
    const rows = store.audit.slice(before)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => isAuditRowPersisted(row) && typeof row.id === "string")).toBe(true)
  })

  it("concurrent requests never pick up each other's rows", async () => {
    seedPackages()
    const batches: AuditEntry[][] = []
    setRequestAuditSinkForTests(async (rows) => {
      batches.push([...rows])
    })
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        FILINGS_GET(
          new Request(`http://127.0.0.1/api/d4/filings?userId=${i % 2 === 0 ? "partner_a" : "associate_a"}`)
        )
      )
    )
    expect(batches.length).toBe(6)
    for (const batch of batches) {
      expect(new Set(batch.map((row) => row.actorId)).size).toBe(1)
    }
    const all = batches.flat()
    expect(new Set(all).size).toBe(all.length)
  })

  it("the collector is per async context, by object", async () => {
    const log = new AuditLog()
    const row = (actorId: string): AuditEntry => ({ action: "x", actorId, target: "t", classification: "internal" })
    const tick = () => new Promise((r) => setTimeout(r, 1))
    const [a, b] = await Promise.all([
      runWithRequestAudit(async () => {
        log.push(row("a1"))
        await tick()
        log.push(row("a2"))
        return currentRequestAuditRows().map((r) => r.actorId)
      }),
      runWithRequestAudit(async () => {
        await tick()
        log.push(row("b1"))
        return currentRequestAuditRows().map((r) => r.actorId)
      }),
    ])
    expect(a.rows.map((r) => r.actorId)).toEqual(["a1", "a2"])
    expect(b.rows.map((r) => r.actorId)).toEqual(["b1"])
    expect(log).toHaveLength(3)
  })

  it("a failed audit write answers 503 AUDIT_UNAVAILABLE for GET and POST", async () => {
    const { matterId } = seedPackages()
    setRequestAuditSinkForTests(async () => {
      throw new Error("audit store down")
    })
    const get = await FILINGS_GET(new Request("http://127.0.0.1/api/d4/filings?userId=partner_a"))
    expect(get.status).toBe(503)
    expect(((await get.json()) as { code: string }).code).toBe("AUDIT_UNAVAILABLE")
    // A POST whose handler created audit rows it did not persist itself.
    const post = await withSession(
      new Request("http://127.0.0.1/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "partner_a", matterId }),
      }),
      async () => {
        getRuntimeStore().audit.push({ action: "test_write", actorId: "partner_a", target: matterId, classification: "internal" })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
    )
    expect(post.status).toBe(503)
    expect(((await post.json()) as { code: string }).code).toBe("AUDIT_UNAVAILABLE")
  })
})

describe("the spine audit log is bounded", () => {
  const row = (i: number): AuditEntry => ({ action: `a${i}`, actorId: "u", target: "t", classification: "internal" })

  it("evicts the oldest rows beyond capacity, but only once they are persisted", () => {
    const log = new AuditLog(5)
    const rows = Array.from({ length: 8 }, (_, i) => row(i))
    for (const r of rows.slice(0, 8)) log.push(r)
    // nothing persisted yet: nothing evicted
    expect(log).toHaveLength(8)
    for (const r of rows.slice(0, 3)) markAuditRowPersisted(r)
    log.push(row(8))
    expect(log).toHaveLength(6) // three persisted evicted; unpersisted a3.. kept even above cap
    expect(log[0]?.action).toBe("a3")
    for (const r of [...log]) markAuditRowPersisted(r)
    log.push(row(9))
    expect(log).toHaveLength(5)
    expect(log.at(-1)?.action).toBe("a9")
  })

  it("array helpers still return plain arrays", () => {
    const log = new AuditLog(5)
    log.push(row(1))
    expect(Array.isArray(log.filter(() => true))).toBe(true)
    expect(log.filter(() => true)).not.toBeInstanceOf(AuditLog)
  })
})
