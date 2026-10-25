/**
 * Audit F42: the matter tombstone, shared by both API stacks. Pure: no Firestore, Next.js or firebase imports.
 *
 * An approved deletion writes `matter_tombstones/{matterId}` (functions/src/retention/ops.ts). From that commit on,
 * every read through either stack refuses the matter: the shared P5 table denies `matter-deleted`
 * (platform/p5/permissionDecision.ts), the Cloud Functions permission check reads the tombstone with the matter
 * (functions/src/p5/permission.ts), and the Next Firestore repository drops every row of the matter
 * (platform/persistence/firestoreSpineRepositories.ts, firmScopedList.ts). The tombstone holds ids, the label, counts,
 * codes and timestamps only, never content (spec R14), and survives the purge of the matter row.
 */

export const MATTER_TOMBSTONES = "matter_tombstones"

/** A stored tombstone counts only for its own firm, and only when it names the matter it is filed under. */
export function isTombstoneFor(data: unknown, firmId: string, matterId: string): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false
  const row = data as { firmId?: unknown; matterId?: unknown }
  return typeof firmId === "string" && firmId !== "" && row.firmId === firmId && row.matterId === matterId
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== ""

/**
 * The matter a stored row belongs to, for the tombstone filter: the document id of a `matters` row; otherwise the
 * row's `matterId`, else its `linkedMatterId` (a search-index row). Null for a firm-level row (no matter).
 */
export function matterKeyOfRow(collection: string, id: string, row: unknown): string | null {
  if (collection === "matters") return nonEmpty(id) ? id : null
  if (typeof row !== "object" || row === null) return null
  const r = row as { matterId?: unknown; linkedMatterId?: unknown }
  if (nonEmpty(r.matterId)) return r.matterId
  if (nonEmpty(r.linkedMatterId)) return r.linkedMatterId
  return null
}
