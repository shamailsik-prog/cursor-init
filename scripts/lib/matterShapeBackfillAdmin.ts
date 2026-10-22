/**
 * FA-F13-003: the Admin SDK side of the matter / member backfill (platform/persistence/matterShapeBackfill.ts).
 * It lives with the operator scripts, not under platform/: the Next server never imports it, and the Next Firestore
 * static guards (F01 no full-collection scans, F10 fenced writes) cover the server's own code.
 */
import {
  SERVER_TIMESTAMP,
  stillMissing,
  type BackfillRow,
  type MatterShapeBackfillStore,
} from "@/platform/persistence/matterShapeBackfill"

export type AdminLike = {
  collection(name: string): { get(): Promise<{ docs: Array<{ id: string; data(): unknown }> }>; doc(id: string): unknown }
  runTransaction<T>(fn: (tx: {
    get(ref: unknown): Promise<{ exists: boolean; data(): unknown }>
    update(ref: unknown, data: Record<string, unknown>): unknown
  }) => Promise<T>): Promise<T>
}

/** The Admin SDK store (the script and the emulator tests). `serverTimestamp` is FieldValue.serverTimestamp. */
export function adminMatterShapeBackfillStore(db: AdminLike, serverTimestamp: () => unknown): MatterShapeBackfillStore {
  return {
    async addMissingFields(collection, id, patch) {
      const ref = db.collection(collection).doc(id)
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        if (!snap.exists) return false
        const missing = stillMissing((snap.data() ?? {}) as Record<string, unknown>, patch)
        if (!Object.keys(missing).length) return false
        const write: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(missing)) write[k] = v === SERVER_TIMESTAMP ? serverTimestamp() : v
        tx.update(ref, write)
        return true
      })
    },
    async appendAudit(row) {
      // create(): an audit row is never overwritten.
      await (db.collection("audit_log").doc(row.id) as { create(d: unknown): Promise<unknown> }).create(row)
    },
  }
}

/** Reads both collections whole (a one-off run; Admin SDK). */
export async function readMatterShapeRows(db: AdminLike): Promise<{ matters: BackfillRow[]; members: BackfillRow[] }> {
  const rows = async (name: string) =>
    (await db.collection(name).get()).docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> }))
  return { matters: await rows("matters"), members: await rows("matter_members") }
}
