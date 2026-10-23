// FA-F13-003 (Codex review on #97): the backfill's audit trail is bounded. No audit row carries more than one batch of
// paths (a single run-wide row could pass Firestore's 1 MiB document limit), and each batch's planned paths are
// recorded BEFORE its writes, so a run that dies mid-way still leaves a record of what it was about to change.
import { describe, expect, it } from "vitest"
import {
  MATTER_BACKFILL_AUDIT_BATCH,
  applyMatterShapeBackfill,
  planMatterShapeBackfill,
  type ApplyRejection,
  type CompleteMatterResult,
  type MatterShapeBackfillStore,
} from "@/platform/persistence/matterShapeBackfill"

const legacyMatter = (i: number) => ({
  id: `m${String(i).padStart(5, "0")}`,
  data: { firmId: "firmA", clientId: "c1", title: "Suit", classification: "internal", status: "live" },
})

function memoryStore(opts: { failAt?: number; matterOutcome?: (id: string) => CompleteMatterResult | undefined } = {}) {
  const audit: Array<Record<string, unknown>> = []
  const events: string[] = []
  let writes = 0
  const store: MatterShapeBackfillStore = {
    async completeMatter(planned) {
      writes += 1
      if (opts.failAt !== undefined && writes === opts.failAt) throw new Error("instance died")
      const forced = opts.matterOutcome?.(planned.id)
      if (forced) return forced
      events.push(`write:matters/${planned.id}`)
      return { status: "written" }
    },
    async completeMember(planned) {
      writes += 1
      if (opts.failAt !== undefined && writes === opts.failAt) throw new Error("instance died")
      events.push(`write:matter_members/${planned.id}`)
      return { status: "written" }
    },
    async appendAudit(row) {
      if (audit.some((r) => r.id === row.id)) throw new Error(`audit row ${row.id} exists`)
      audit.push(row as unknown as Record<string, unknown>)
      events.push(`audit:${row.id}`)
    },
  }
  return { store, audit, events }
}

const pathsIn = (row: Record<string, unknown>) =>
  ["planned", "applied", "skipped", "rejected", "failed", "malformed", "orphans"].reduce(
    (n, k) => n + ((row[k] as unknown[] | undefined)?.length ?? 0),
    0
  )

describe("F13 FA-F13-003: bounded backfill audit rows", () => {
  it("a large run writes many bounded rows, never one row with every path", async () => {
    const n = MATTER_BACKFILL_AUDIT_BATCH * 2 + 7
    const malformed = Array.from({ length: MATTER_BACKFILL_AUDIT_BATCH + 3 }, (_, i) => ({ id: `bad${i}`, data: { firmId: "firmA" } }))
    const plan = planMatterShapeBackfill([...Array.from({ length: n }, (_, i) => legacyMatter(i)), ...malformed], [])
    const { store, audit } = memoryStore()
    await applyMatterShapeBackfill(store, plan, { runId: "r1", now: 1 })
    for (const row of audit) {
      expect(pathsIn(row), String(row.id)).toBeLessThanOrEqual(MATTER_BACKFILL_AUDIT_BATCH)
      expect(JSON.stringify(row).length, String(row.id)).toBeLessThan(200_000)
    }
    const applied = audit.flatMap((r) => (r.applied as string[] | undefined) ?? [])
    expect(new Set(applied).size).toBe(n)
    const listedMalformed = audit.flatMap((r) => (r.malformed as string[] | undefined) ?? [])
    expect(listedMalformed).toHaveLength(malformed.length)
    const summary = audit.find((r) => r.id === "aud_matter_shape_backfill_r1")
    expect(summary).toMatchObject({ appliedCount: n, skippedCount: 0, malformedCount: malformed.length })
    expect(pathsIn(summary!)).toBe(0)
  })

  it("each batch's planned paths are audited before its writes, so a run that dies mid-batch left a record", async () => {
    const plan = planMatterShapeBackfill(Array.from({ length: MATTER_BACKFILL_AUDIT_BATCH + 2 }, (_, i) => legacyMatter(i)), [])
    const { store, audit, events } = memoryStore({ failAt: MATTER_BACKFILL_AUDIT_BATCH + 1 })
    // FA-F13-033: the thrown write is recorded and the run finishes. The planned row is still written first.
    const res = await applyMatterShapeBackfill(store, plan, { runId: "r2", now: 1 })
    expect(res.failed).toEqual([{ path: "matters/m00200", message: "instance died" }])
    expect(res.applied).toContain("matters/m00201")
    const planned = audit.filter((r) => Array.isArray(r.planned))
    expect(planned).toHaveLength(2)
    expect(planned[1].planned).toEqual(plan.matters.slice(MATTER_BACKFILL_AUDIT_BATCH).map((u) => `matters/${u.id}`))
    // Every write comes after the planned row of its batch.
    const firstPlanned = events.indexOf(`audit:${planned[0].id}`)
    const firstWrite = events.findIndex((e) => e.startsWith("write:"))
    expect(firstPlanned).toBeGreaterThanOrEqual(0)
    expect(firstPlanned).toBeLessThan(firstWrite)
    // The first batch's outcome row was written before the second batch started.
    expect(audit.some((r) => Array.isArray(r.applied) && (r.applied as string[]).length === MATTER_BACKFILL_AUDIT_BATCH)).toBe(true)
  })
})

describe("F13 FA-F13-019: a planned matter gone or malformed at apply is rejected, not skipped", () => {
  it("rejects with the store's reason and counts it as rejected in the batch and summary rows", async () => {
    const plan = planMatterShapeBackfill([legacyMatter(0), legacyMatter(1), legacyMatter(2)], [])
    const reasons: Record<string, CompleteMatterResult> = {
      m00000: { status: "rejected", reason: "matter_gone" },
      m00001: { status: "rejected", reason: "matter_malformed" },
    }
    const { store, audit } = memoryStore({ matterOutcome: (id) => reasons[id] })
    const res = await applyMatterShapeBackfill(store, plan, { runId: "r19", now: 1 })
    expect(res.skipped).toEqual([])
    expect(res.applied).toEqual(["matters/m00002"])
    expect(res.rejected).toEqual([
      { path: "matters/m00000", reason: "matter_gone" },
      { path: "matters/m00001", reason: "matter_malformed" },
    ])
    const done = audit.find((r) => r.id === "aud_matter_shape_backfill_r19_b0_done")!
    expect(done.skipped).toEqual([])
    expect(done.rejected).toEqual(res.rejected)
    const summary = audit.find((r) => r.id === "aud_matter_shape_backfill_r19")!
    expect(summary).toMatchObject({ appliedCount: 1, skippedCount: 0, rejectedCount: 2 })
  })
})

describe("F13 FA-F13-033: one failed write does not abort the backfill audit", () => {
  const failedOf = (res: { applied: string[]; skipped: string[]; rejected: ApplyRejection[] }) =>
    (res as { failed?: { path: string; message: string }[] }).failed

  it("records the failed matter, writes the later row in the batch, and still writes the summary", async () => {
    const malformed = [{ id: "bad0", data: { firmId: "firmA" } }]
    const plan = planMatterShapeBackfill([legacyMatter(0), legacyMatter(1), ...malformed], [])
    const { store, audit } = memoryStore({ failAt: 1 })
    const res = await applyMatterShapeBackfill(store, plan, { runId: "r23", now: 1 })
    expect(failedOf(res)).toEqual([{ path: "matters/m00000", message: "instance died" }])
    expect(res.applied).toEqual(["matters/m00001"])
    expect(res.skipped).toEqual([])
    expect(res.rejected).toEqual([])
    const done = audit.find((r) => r.id === "aud_matter_shape_backfill_r23_b0_done")!
    expect(done.failed).toEqual([{ path: "matters/m00000", message: "instance died" }])
    expect(done.applied).toEqual(["matters/m00001"])
    expect(done.skipped).toEqual([])
    expect(String(done.reason)).toContain("1 failed")
    const summary = audit.find((r) => r.id === "aud_matter_shape_backfill_r23")!
    expect(summary).toMatchObject({ appliedCount: 1, skippedCount: 0, rejectedCount: 0, failedCount: 1, malformedCount: 1 })
    expect(summary.failed).toBeUndefined()
    expect(pathsIn(summary)).toBe(0)
    expect(String(summary.reason)).toContain("1 failed")
    expect(audit.some((r) => r.id === "aud_matter_shape_backfill_r23_malformed_0")).toBe(true)
  })

  it("records a failed member write and still completes the next member", async () => {
    const matter = {
      id: "mcomplete",
      data: {
        firmId: "firmA", clientId: "c1", title: "Suit", classification: "internal", status: "live",
        stage: "pre_filing", caseNumberStatus: "pending", matterNo: null, courtId: null, caseNumber: null,
        conflictCheckId: null, createdBy: null,
      },
    }
    const member = (userId: string) => ({ id: `mcomplete_${userId}`, data: { firmId: "firmA", matterId: "mcomplete", userId } })
    const plan = planMatterShapeBackfill([matter], [member("u0"), member("u1")])
    expect(plan.matters).toEqual([])
    expect(plan.members.map((row) => row.id)).toEqual(["mcomplete_u0", "mcomplete_u1"])
    const { store, audit } = memoryStore({ failAt: 1 })
    const res = await applyMatterShapeBackfill(store, plan, { runId: "r23m", now: 1 })
    expect(failedOf(res)).toEqual([{ path: "matter_members/mcomplete_u0", message: "instance died" }])
    expect(res.applied).toEqual(["matter_members/mcomplete_u1"])
    expect(res.skipped).toEqual([])
    expect(res.rejected).toEqual([])
    const summary = audit.find((r) => r.id === "aud_matter_shape_backfill_r23m")!
    expect(summary).toMatchObject({ appliedCount: 1, failedCount: 1 })
    expect(pathsIn(summary)).toBe(0)
  })

  it("records a non-Error throw by its string, not by rethrowing", async () => {
    const plan = planMatterShapeBackfill([legacyMatter(0), legacyMatter(1)], [])
    const { store } = memoryStore()
    store.completeMatter = async (planned) => {
      if (planned.id === "m00000") throw "disk full"
      return { status: "written" }
    }
    const res = await applyMatterShapeBackfill(store, plan, { runId: "r23s", now: 1 })
    expect(failedOf(res)).toEqual([{ path: "matters/m00000", message: "disk full" }])
    expect(res.applied).toEqual(["matters/m00001"])
  })

  it("an audit write that throws still rejects, and no matter write runs after it", async () => {
    const plan = planMatterShapeBackfill([legacyMatter(0), legacyMatter(1)], [])
    const { store, events } = memoryStore()
    store.appendAudit = async () => {
      throw new Error("audit down")
    }
    await expect(applyMatterShapeBackfill(store, plan, { runId: "raud", now: 1 })).rejects.toThrow("audit down")
    expect(events.some((event) => event.startsWith("write:"))).toBe(false)
  })
})
