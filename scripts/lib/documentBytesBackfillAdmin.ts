/**
 * FA-F13-029: the Admin SDK side of the document bytes backfill (platform/persistence/documentBytesBackfill.ts).
 * It lives with the operator scripts, not under platform/: the Next server never imports it.
 */
import { documentRecordRefusal } from "@/platform/d1/documentRecord"
import type { DocumentBytesBackfillStore, DocumentBytesStampResult } from "@/platform/persistence/documentBytesBackfill"

export type AdminLike = {
  collection(name: string): {
    get(): Promise<{ docs: Array<{ id: string; data(): unknown }> }>
    doc(id: string): unknown
  }
  runTransaction<T>(fn: (tx: {
    get(ref: unknown): Promise<{ exists: boolean; data(): unknown }>
    update(ref: unknown, data: Record<string, unknown>): unknown
  }) => Promise<T>): Promise<T>
}

export async function readDocumentRows(db: AdminLike): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const snap = await db.collection("documents").get()
  return snap.docs.map((doc) => ({ id: doc.id, data: (doc.data() ?? {}) as Record<string, unknown> }))
}

/** Writes `objectBytesStatus: "missing"` only when the stored row is still readable and the field is absent. */
export function adminDocumentBytesBackfillStore(db: AdminLike): DocumentBytesBackfillStore {
  return {
    async stamp(id: string): Promise<DocumentBytesStampResult> {
      const ref = db.collection("documents").doc(id)
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        if (!snap.exists) return { status: "rejected", reason: "gone" }
        const data = (snap.data() ?? {}) as Record<string, unknown>
        if (documentRecordRefusal(id, data)) return { status: "rejected", reason: "malformed" }
        if (data.objectBytesStatus !== undefined) return { status: "skipped" }
        tx.update(ref, { objectBytesStatus: "missing" })
        return { status: "written" }
      })
    },
  }
}
