import { HttpError } from "../http/errors"
import type { Data } from "../p5/common"

/** Cursor pagination (L18 §4.3) for the list GET routes: `?limit=&cursor=`. */

export type Page<T> = { items: T[]; nextCursor: string | null }

export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

/** `limit` is an integer in 1..100 (default 20); `cursor` is passed through opaque (decode it with decodeCursor). */
export function parsePage(data: Data): { limit: number; cursor: string | null } {
  let limit = DEFAULT_LIMIT
  if (data.limit !== undefined) {
    const raw = data.limit
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new HttpError(400, "invalid_limit")
    limit = Number(raw)
    if (limit < 1 || limit > MAX_LIMIT) throw new HttpError(400, "invalid_limit")
  }
  const cursor = typeof data.cursor === "string" && data.cursor !== "" ? data.cursor : null
  return { limit, cursor }
}

/** An opaque cursor: base64url JSON of the last item's sort key and id. */
export function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(JSON.stringify({ sortKey, id }), "utf8").toString("base64url")
}

export function decodeCursor(c: string): { sortKey: string; id: string } {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(c)) throw new Error("charset")
    const parsed: unknown = JSON.parse(Buffer.from(c, "base64url").toString("utf8"))
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { sortKey, id } = parsed as Record<string, unknown>
      if (typeof sortKey === "string" && typeof id === "string") return { sortKey, id }
    }
  } catch {
    /* falls through to the 400 below */
  }
  throw new HttpError(400, "invalid_cursor")
}
