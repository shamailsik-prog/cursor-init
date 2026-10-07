/**
 * List pagination shared by every Next list route (spec audit U-11; L18 §4.3: "limit (default
 * 20, max 100)").
 *
 * FOLLOW-UP: L18 §4.3 asks for opaque or keyset cursors and `total` only when cheap. These
 * cursors are still numeric offsets into a fully built, sorted list (and routes still return
 * `total`); that is transitional until list reads move to keyset queries on the durable store.
 */
export const DEFAULT_PAGE_LIMIT = 20
export const MAX_PAGE_LIMIT = 100

export function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : DEFAULT_PAGE_LIMIT
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_LIMIT
  return Math.min(parsed, MAX_PAGE_LIMIT)
}

/** A numeric offset cursor (transitional, see above); invalid or negative reads as 0. */
export function parseCursor(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 0
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}
