import type { DocumentReference as AdminDocumentReference, Firestore as AdminFirestore } from "firebase-admin/firestore"
import { MATTER_TOMBSTONES, isTombstoneFor, matterKeyOfRow } from "@/platform/retention/tombstone"
import { doc, firestoreSdkOf, type Firestore } from "@/platform/persistence/firestoreDbModular"

/**
 * Audit F42: the Next repository's tombstone filter. A firm-scoped read (`getById`, every firm-scoped list page) drops
 * a row whose matter (the row id for `matters`, else `matterId`, else `linkedMatterId`) has a tombstone of the same
 * firm, from the moment the deletion is approved, so every Next route (lists, documents, drafts, reports, the matter
 * and membership syncs the caches use) stops serving it at once.
 *
 * Tombstones are server-only (firestore.rules), so only an Admin SDK handle reads them: that is the production Next
 * persistence (platform/persistence/adminFirestore.ts). A client-SDK handle is governed by the rules instead, where the
 * approval's revocation of every membership of the matter refuses the membership-gated reads at once.
 */

const canRead = (db: Firestore): boolean => firestoreSdkOf(db) === "admin"

/** The distinct matter ids, of `ids`, that are tombstoned for `firmId` (one batched read). */
export async function tombstonedAmong(db: Firestore, firmId: string, ids: readonly string[]): Promise<ReadonlySet<string>> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id !== "" && !id.includes("/")))]
  if (!canRead(db) || unique.length === 0) return new Set()
  // One batched read of the tombstones (document reads only; FA-F01-001: no collection scan outside firestoreDbModular).
  const refs = unique.map((id) => doc(db, MATTER_TOMBSTONES, id)) as unknown as AdminDocumentReference[]
  const snaps = await (db as unknown as AdminFirestore).getAll(...refs)
  return new Set(snaps.filter((s) => isTombstoneFor(s.data(), firmId, s.id)).map((s) => s.id))
}

/** Whether one stored row of `collection` belongs to a matter tombstoned for `firmId`. */
export async function rowIsTombstoned(db: Firestore, collection: string, id: string, row: unknown, firmId: string): Promise<boolean> {
  const matterId = matterKeyOfRow(collection, id, row)
  if (matterId === null) return false
  return (await tombstonedAmong(db, firmId, [matterId])).has(matterId)
}

/** `rows` without those whose matter is tombstoned for `firmId`. */
export async function dropTombstonedRows<T extends { id?: string }>(db: Firestore, collection: string, firmId: string, rows: T[]): Promise<T[]> {
  const keys = rows.map((row) => matterKeyOfRow(collection, row.id ?? "", row))
  if (keys.every((key) => key === null)) return rows
  const dead = await tombstonedAmong(db, firmId, keys.filter((key): key is string => key !== null))
  if (dead.size === 0) return rows
  return rows.filter((_row, i) => keys[i] === null || !dead.has(keys[i] as string))
}
