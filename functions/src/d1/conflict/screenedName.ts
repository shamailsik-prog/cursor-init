import type { DocumentData } from "firebase-admin/firestore"

/**
 * The screened name of a client or matter party row, and the stamp the writers in functions/src put on a row whose
 * screened name they staged in the conflict name index (audit F37 re-audit FA-D1C-002, FA-D1C-005). Pure and free of
 * imports from functions/src, so the test-time registry recorder can use it without loading the product graph.
 */

/** A row's screened name: what the name tier can hit, and for which firm. */
export type ScreenedKey = { firmId: string; name: string }

export const sameKey = (a: ScreenedKey | null, b: ScreenedKey | null): boolean => a !== null && b !== null && a.firmId === b.firmId && a.name === b.name

/** A client's `canonicalName` or an opposing party's `name`, with the row's firm; null when the row has none the screen can hit. */
export function screenedKeyOf(collection: string, data: DocumentData | undefined): ScreenedKey | null {
  if (data === undefined || typeof data.firmId !== "string") return null
  if (collection === "clients") return typeof data.canonicalName === "string" ? { firmId: data.firmId, name: data.canonicalName } : null
  if (collection === "matter_parties") return data.role === "opposing" && typeof data.name === "string" ? { firmId: data.firmId, name: data.name } : null
  return null
}

/** A stamp: the screened name a writer staged, and the index generation (`nameIndexGen`) it staged it in. */
export type NameStamp = ScreenedKey & { gen: number }

/**
 * The stamp a writer in functions/src puts on a row whose screened name it staged in the index, in the same transaction
 * that read `gen` (the counter's `nameIndexGen`).
 */
export const nameIndexStamp = (firmId: string, name: string, gen: number) => ({ nameIndexed: { firmId, name, gen } })

/** The row's stamp, when it is well formed (a stamp without a generation is not). */
export function stampOf(data: DocumentData | undefined): NameStamp | null {
  const s: unknown = data?.nameIndexed
  if (s === null || typeof s !== "object") return null
  const { firmId, name, gen } = s as Record<string, unknown>
  return typeof firmId === "string" && typeof name === "string" && typeof gen === "number" && Number.isInteger(gen) && gen >= 0 ? { firmId, name, gen } : null
}
