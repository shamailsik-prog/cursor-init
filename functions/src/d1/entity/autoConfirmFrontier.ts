import { FieldPath, Timestamp, type DocumentData, type DocumentReference, type Query } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { isSafeDocId } from "../../p5/common"

/**
 * The auto-confirm job's frontier (audit F38; spec `docs/superpowers/specs/2026-10-18-f38-auto-confirm-progress-design.md`,
 * R1): a per-firm cursor over the aged candidate rows in `(createdAt, linkId)` order that only moves forward.
 * Rows age in `createdAt` order, so every row that ages is ahead of the cursor and is reached once, whatever sits
 * behind it. The cursor is `counters/{firmId}_autoconfirm.cursor`, the last scanned row the job has handled; each
 * step writes it in its own transaction (a checkpoint).
 *
 * The scan is the review queue's query (`firmId`, `state == "candidate"`, `disputed == false`, `createdAt <=
 * now - 30 d`) ordered by `createdAt` then document id, served by the existing composite index.
 */

/** Frontier rows one run reads (the meaning `AUTO_CONFIRM_ROW_LIMIT` had for the old fixed window). */
export const AUTO_CONFIRM_ROW_LIMIT = 2000
/** Rows per frontier query page. */
export const AUTO_CONFIRM_PAGE_ROWS = 500

/** A position in the scan's order: the row's `createdAt` and its link id (the tie-break). */
export type Cursor = { createdAt: Timestamp; linkId: string }

/** A pair the frontier has read and not yet handled. */
export type FrontierPair = { a: string; b: string; pairId: string }

/** The firm's progress doc: the frontier cursor, the last run and the backlog state (server-only, like every counter). */
export const autoConfirmProgressRef = (firmId: string): DocumentReference => adminDb().collection("counters").doc(`${firmId}_autoconfirm`)

/** The stored cursor; null when there is none or it is malformed (the scan then starts at the oldest aged row). */
export function cursorOf(data: DocumentData | undefined, firmId: string): Cursor | null {
  if (data === undefined || data.firmId !== firmId) return null
  const c: unknown = data.cursor
  if (c === null || typeof c !== "object") return null
  const { createdAt, linkId } = c as Record<string, unknown>
  return createdAt instanceof Timestamp && isSafeDocId(linkId) ? { createdAt, linkId } : null
}

/**
 * One run's walk along the frontier. Pages are read on demand, at most `AUTO_CONFIRM_ROW_LIMIT` rows a run. Pairs
 * queue in the order their first row appears; a row whose ids cannot name a pair (unsafe, or both the same) is
 * passed over and counted. `cursorAfter(n)` is where the cursor may go once the next `n` queued pairs are handled:
 * the row before the first pair still waiting, or the last row read when none waits. Every row before it belongs
 * to a handled pair or was passed over; a later row of a handled pair is read again later, which is harmless.
 */
export class FrontierScan {
  private readonly rows: Cursor[] = []
  private readonly pairs: Array<FrontierPair & { first: number }> = []
  private readonly seen = new Set<string>()
  private next = 0
  private read = 0
  private exhausted = false
  /** Rows passed over because their ids cannot name a pair. */
  skippedRows = 0

  constructor(
    private readonly firmId: string,
    private readonly cutoff: Timestamp,
    private readonly start: Cursor | null
  ) {}

  private query(after: Cursor | null, limit: number): Query {
    let q = adminDb()
      .collection("entity_links")
      .where("firmId", "==", this.firmId)
      .where("state", "==", "candidate")
      .where("disputed", "==", false)
      .where("createdAt", "<=", this.cutoff)
      .orderBy("createdAt")
      .orderBy(FieldPath.documentId())
      .limit(limit)
    if (after !== null) q = q.startAfter(after.createdAt, after.linkId)
    return q
  }

  private async page(): Promise<void> {
    const want = Math.min(AUTO_CONFIRM_PAGE_ROWS, AUTO_CONFIRM_ROW_LIMIT - this.read)
    const snap = await this.query(this.rows.at(-1) ?? this.start, want).get()
    this.read += snap.size
    if (snap.size < want) this.exhausted = true
    for (const doc of snap.docs) {
      // The range filter matches Timestamp values only, so createdAt is one.
      const index = this.rows.push({ createdAt: doc.get("createdAt") as Timestamp, linkId: doc.id }) - 1
      const leftId: unknown = doc.get("leftId")
      const rightId: unknown = doc.get("rightId")
      if (!isSafeDocId(leftId) || !isSafeDocId(rightId) || leftId === rightId) {
        this.skippedRows += 1
        continue
      }
      const pairId = `${leftId}_${rightId}`
      if (this.seen.has(pairId)) continue
      this.seen.add(pairId)
      this.pairs.push({ a: leftId, b: rightId, pairId, first: index })
    }
  }

  /** Reads pages until `n` pairs wait, the scan reaches the end or the run's row budget is spent. */
  async fill(n: number): Promise<void> {
    while (this.pending() < n && !this.exhausted && this.read < AUTO_CONFIRM_ROW_LIMIT) await this.page()
  }

  pending(): number {
    return this.pairs.length - this.next
  }

  /** The next `n` waiting pairs (fewer when fewer wait). */
  peek(n: number): FrontierPair[] {
    return this.pairs.slice(this.next, this.next + n).map(({ a, b, pairId }) => ({ a, b, pairId }))
  }

  /** Marks the next `n` waiting pairs handled. */
  advance(n: number): void {
    this.next += n
  }

  /** The cursor once the next `n` waiting pairs are handled (the start cursor when no row is behind them). */
  cursorAfter(n: number): Cursor | null {
    const k = this.next + n
    const index = k < this.pairs.length ? this.pairs[k].first - 1 : this.rows.length - 1
    return index >= 0 ? this.rows[index] : this.start
  }

  /** The `createdAt` of the first row not yet handled, reading one row past the budget if needed; null when the frontier is drained. */
  async nextUnhandled(): Promise<Timestamp | null> {
    if (this.pending() > 0) return this.rows[this.pairs[this.next].first].createdAt
    if (this.exhausted) return null
    const snap = await this.query(this.cursorAfter(0), 1).get()
    return snap.empty ? null : (snap.docs[0].get("createdAt") as Timestamp)
  }
}
