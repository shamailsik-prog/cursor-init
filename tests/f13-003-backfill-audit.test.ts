// FA-F13-003 (Codex review on #97): the backfill's audit trail is bounded. No audit row carries more than one batch of
// paths (a single run-wide row could pass Firestore's 1 MiB document limit), and each batch's planned paths are
// recorded BEFORE its writes, so a run that dies mid-way still leaves a record of what it was about to change.
import { describe, expect, it } from "vitest"
import {
  MATTER_BACKFILL_AUDIT_BATCH,
  applyMatterShapeBackfill,
  planMatterShapeBackfill,
  type MatterShapeBackfillStore,
} from "@/platform/persistence/matterShapeBackfill"

const legacyMatter = (i: number) => ({
  id: `m${String(i).padStart(5, "0")}`,
  data: { firmId: "firmA", clientId: "c1", title: "Suit", classification: "internal", status: "live" },
})

function memoryStore(opts: { failAt?: number } = {}) {
  const audit: Array<Record<string, unknown>> = []
  const events: string[] = []
  let writes = 0
  const store: MatterShapeBackfillStore = {
    async addMissingFields(collection, id) {
      writes += 1
      if (opts.failAt !== undefined && writes === opts.failAt) throw new Error("instance died")
      events.push(`write:${collection}/${id}`)
      return true
    },
    async completeMember(planned) {
      writes += 1
      if (opts.failAt !== undefined && writes === opts.failAt) throw new Error("instance died")
      events.push(`write:matter_members/${planned.id}`)
      return true
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
  ["planned", "applied", "skipped", "malformed", "orphans"].reduce((n, k) => n + ((row[k] as unknown[] | undefined)?.length ?? 0), 0)

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
    await expect(applyMatterShapeBackfill(store, plan, { runId: "r2", now: 1 })).rejects.toThrow("instance died")
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
