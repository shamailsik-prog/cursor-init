// FA-F13-018 (Codex P2 on #100): apply-time member rejections (matter deleted/malformed after planning) must not be
// counted as "completed since planning" skips; they carry an explicit reason in the audit trail.
import { describe, expect, it } from "vitest"
import { applyMatterShapeBackfill, planMatterShapeBackfill } from "@/platform/persistence/matterShapeBackfill"
import { adminMatterShapeBackfillStore } from "@/scripts/lib/matterShapeBackfillAdmin"

/** Already canonical at plan time so only the member is scheduled for apply (matter mutations are member-only). */
const completeMatter = (id: string) => ({
  id,
  data: {
    firmId: "firmA",
    clientId: "c1",
    title: "Suit",
    classification: "internal",
    status: "live",
    courtId: "LHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    stage: "pre_filing",
    matterNo: null,
    conflictCheckId: null,
    createdBy: null,
  },
})

const legacyMember = (matterId: string, userId: string) => ({
  id: `${matterId}_${userId}`,
  data: { firmId: "firmA", matterId, userId },
})

type Doc = { id: string; data: Record<string, unknown> }

function memoryAdminDb(initial: { matters: Doc[]; members: Doc[]; audit: Doc[] }) {
  const matters = new Map(initial.matters.map((d) => [d.id, { ...d.data }]))
  const members = new Map(initial.members.map((d) => [d.id, { ...d.data }]))
  const audit = new Map<string, Record<string, unknown>>()
  const ref = (col: string, id: string) => ({ col, id })
  const db = {
    collection(name: string) {
      return {
        async get() {
          const rows = name === "matters" ? matters : name === "matter_members" ? members : audit
          return {
            docs: [...rows.entries()].map(([id, data]) => ({ id, data: () => data })),
          }
        },
        doc(id: string) {
          if (name === "audit_log") {
            return {
              async create(row: Record<string, unknown>) {
                if (audit.has(id)) throw new Error(`audit ${id} exists`)
                audit.set(id, row)
              },
            }
          }
          return ref(name, id)
        },
      }
    },
    async runTransaction<T>(fn: (tx: {
      get(r: { col: string; id: string }): Promise<{ exists: boolean; data(): unknown }>
      update(r: { col: string; id: string }, data: Record<string, unknown>): void
    }) => Promise<T>): Promise<T> {
      const reads = new Map<string, Record<string, unknown> | null>()
      const writes = new Map<string, Record<string, unknown>>()
      const tx = {
        async get(r: { col: string; id: string }) {
          const key = `${r.col}/${r.id}`
          if (reads.has(key)) {
            const data = reads.get(key)
            return { exists: data != null, data: () => data }
          }
          const map = r.col === "matters" ? matters : members
          const data = map.get(r.id)
          reads.set(key, data ?? null)
          return { exists: data !== undefined, data: () => data }
        },
        update(r: { col: string; id: string }, patch: Record<string, unknown>) {
          const map = r.col === "matters" ? matters : members
          const cur = { ...(map.get(r.id) ?? {}), ...patch }
          writes.set(`${r.col}/${r.id}`, cur)
        },
      }
      const result = await fn(tx)
      for (const [key, data] of writes) {
        const [col, id] = key.split("/")
        const map = col === "matters" ? matters : members
        map.set(id, data)
      }
      return result
    },
  }
  return {
    db,
    matters,
    members,
    auditRows: () => [...audit.values()],
    findAudit: (id: string) => audit.get(id),
  }
}

describe("F13 FA-F13-018: apply-time member rejections", () => {
  it.each([
    ["the matter was deleted", (matters: Map<string, Record<string, unknown>>, matterId: string) => matters.delete(matterId), "matter_gone"],
    [
      "the matter became malformed",
      (matters: Map<string, Record<string, unknown>>, matterId: string) => matters.set(matterId, { firmId: "firmA", clientId: "c1" }),
      "matter_malformed",
    ],
  ])("records %s as rejected at apply, not as completed-since-planning skip", async (_label, mutate, reason) => {
    const matterId = "m00001"
    const userId = "u1"
    const mem = memoryAdminDb({
      matters: [{ id: matterId, data: { ...completeMatter(matterId).data } }],
      members: [{ id: `${matterId}_${userId}`, data: { ...legacyMember(matterId, userId).data } }],
      audit: [],
    })
    const plan = planMatterShapeBackfill([completeMatter(matterId)], [legacyMember(matterId, userId)])
    expect(plan.matters).toHaveLength(0)
    expect(plan.members).toHaveLength(1)

    mutate(mem.matters, matterId)
    const path = `matter_members/${matterId}_${userId}`
    const res = await applyMatterShapeBackfill(adminMatterShapeBackfillStore(mem.db as never, () => 1), plan, {
      runId: "rej",
      now: 1,
    })

    expect(res.skipped).not.toContain(path)
    expect(res.rejected).toEqual([{ path, reason }])

    const done = mem.findAudit("aud_matter_shape_backfill_rej_b0_done")
    expect(done?.rejected).toEqual([{ path, reason }])
    expect(done?.skipped).toEqual([])

    const summary = mem.findAudit("aud_matter_shape_backfill_rej")
    expect(summary).toMatchObject({ rejectedCount: 1, skippedCount: 0, appliedCount: 0 })
    expect(String(summary?.reason)).toContain("rejected at apply")
    expect(String(summary?.reason)).not.toMatch(/\b1 skipped \(completed since planning\)/)
  })
})
