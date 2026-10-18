import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { AUDIT_OUTBOX_ALERT_AGE_MS, AUDIT_OUTBOX_GRACE_MS } from "@/platform/persistence/auditOutboxContract"
import { adminDb } from "../src/admin"
import { BACKLOG_STATE_COLLECTION, BACKLOG_STATE_DOC, reconcileAuditOutbox, type ReconcileLog } from "../src/p5/auditOutbox"
import { EMULATORS } from "./emu"

/**
 * Audit F11: the audit-outbox reconciler on the Functions package's own firebase-admin (the one the deployed
 * `auditOutboxReconciler` runs on). The Next-side e2e drives it with the root package's SDK; this file proves the same
 * transactions, queries and aggregation on this one. Entries are written in the shape the Next process stages
 * (platform/persistence/auditOutbox.ts); firms are ids only (no `firms` documents), and every document is deleted.
 */

type Lines = Array<{ level: string; message: string }>
function recording(): ReconcileLog & { lines: Lines } {
  const lines: Lines = []
  return {
    lines,
    info: (message) => void lines.push({ level: "info", message }),
    warn: (message) => void lines.push({ level: "warn", message }),
    error: (message) => void lines.push({ level: "error", message }),
  }
}

const firms: string[] = []
const entries: string[] = []

function row(firmId: string, over: Record<string, unknown> = {}) {
  return { id: `aud_${randomUUID()}`, firmId, action: "f11_fn_row", actorId: "u-f11", target: "f11_probe/x", classification: "internal", at: 1, ...over }
}

async function stage(firmId: string, rows: unknown[], ageMs: number): Promise<string> {
  const id = `${randomUUID()}_0`
  entries.push(id)
  await adminDb()
    .collection("audit_outbox")
    .doc(id)
    .set({
      v: 1,
      surface: "next",
      firmId,
      actorId: "u-f11",
      route: "POST /api/f11-fn",
      requestAction: "probe",
      operationId: "op-f11",
      requestId: id.slice(0, -2),
      seq: 0,
      effectPaths: [`f11_probe/${id}`],
      rows,
      stagedAt: new Date(Date.now() - ageMs),
      attempts: 0,
    })
  return id
}

async function byFirm(collection: string, firmId: string) {
  return (await adminDb().collection(collection).where("firmId", "==", firmId).get()).docs
}

// A hang bound, not a speed budget: the first test also pays the process's first Admin connection; on a loaded machine
// it took 20 s in all (the racing runs 3.6 s of it), beyond the suite's 15 s default.
describe.skipIf(!EMULATORS)("F11 audit-outbox reconciler (Functions firebase-admin)", { timeout: 120_000 }, () => {
  afterEach(async () => {
    const db = adminDb()
    for (const firmId of firms.splice(0)) {
      for (const c of ["audit_log", "audit_dead_letter", "audit_outbox"]) for (const d of await byFirm(c, firmId)) await d.ref.delete()
    }
    for (const id of entries.splice(0)) await db.collection("audit_outbox").doc(id).delete()
    await db.collection(BACKLOG_STATE_COLLECTION).doc(BACKLOG_STATE_DOC).delete()
  })

  it("publishes once (runs racing), dead-letters the poisoned row under the entry's firm, and deletes the entry", async () => {
    const firmId = `f11fn-${randomUUID().slice(0, 8)}`
    firms.push(firmId)
    const good = row(firmId)
    const entryId = await stage(firmId, [good, row(firmId, { action: "" })], AUDIT_OUTBOX_GRACE_MS + 60_000)
    const both = await Promise.all([reconcileAuditOutbox({ db: adminDb(), log: recording() }), reconcileAuditOutbox({ db: adminDb(), log: recording() })])
    // Exactly one of the racing runs published it; the other found it gone.
    expect(both.map((r) => r.published.includes(entryId)).sort()).toEqual([false, true])
    expect((await reconcileAuditOutbox({ db: adminDb(), log: recording() })).published).not.toContain(entryId)
    expect((await byFirm("audit_log", firmId)).map((d) => d.id).sort()).toEqual([good.id, `aud_outbox_${entryId}`].sort())
    expect((await byFirm("audit_dead_letter", firmId)).map((d) => d.get("reason"))).toEqual(["row_malformed"])
    expect((await adminDb().collection("audit_outbox").doc(entryId).get()).exists).toBe(false)
  })

  it("the backlog alert fires while a stale entry cannot be published (a retryable store fault, uncounted) and clears once it is", async () => {
    const firmId = `f11fn-${randomUUID().slice(0, 8)}`
    firms.push(firmId)
    const entryId = await stage(firmId, [row(firmId)], AUDIT_OUTBOX_ALERT_AGE_MS + 60_000)
    const real = adminDb()
    // The database, except that every transaction fails with UNAVAILABLE (retryable: never counted on the entry).
    const down = new Proxy(real, {
      get(target, prop) {
        if (prop === "runTransaction") return async () => Promise.reject(Object.assign(new Error("unavailable"), { code: 14 }))
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })
    const firing = recording()
    const fired = await reconcileAuditOutbox({ db: down, log: firing })
    expect([fired.deferred, fired.backlog.firing, fired.backlog.transition]).toEqual([[entryId], true, "fired"])
    expect(firing.lines.some((l) => l.level === "error" && l.message === "audit.outbox_backlog_stale")).toBe(true)
    expect((await real.collection("audit_outbox").doc(entryId).get()).get("attempts")).toBe(0)

    const clearing = recording()
    const cleared = await reconcileAuditOutbox({ db: real, log: clearing })
    expect([cleared.published, cleared.backlog.firing, cleared.backlog.transition, cleared.backlog.oldestAgeMs]).toEqual([[entryId], false, "cleared", null])
    expect(clearing.lines.some((l) => l.level === "info" && l.message === "audit.outbox_backlog_cleared")).toBe(true)
  })
})
