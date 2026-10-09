import { Timestamp, type DocumentData } from "firebase-admin/firestore"

/**
 * L17.2 entity link state at read time (spec P2-26, P2-29; L17.2 #15, L18 §7.1). Pure: the stored
 * `entity_links` row and the clock decide the effective state; nothing is written.
 */

/** Entity link auto-confirm window (P2-5, L18 §7.1). */
export const LINK_AUTO_CONFIRM_MS = 30 * 24 * 60 * 60 * 1000

/** The score of a deterministic key match (CNIC, NTN, SECP, phone), recorded on merge events and `entity.*` events. */
export const DETERMINISTIC_KEY_SCORE = 0.99

export type EffectiveLinkState = "candidate" | "auto_confirmed" | "disputed" | "confirmed" | "rejected" | "unmerging"

const millisOf = (value: unknown): number | null => (value instanceof Timestamp ? value.toMillis() : null)

/**
 * The effective state of one link row. With L17_2_ENABLED off every row reads as a candidate
 * (P2-18, strictest). `confirmed` and `rejected` are stored decisions; a candidate with
 * `disputed: true` is disputed; an undisputed candidate (`disputed === false`) created at least
 * 30 days ago is auto-confirmed. Anything else (unknown state, `disputed` not a boolean, no
 * Timestamp `createdAt`) reads as a candidate: fail toward review.
 */
export function effectiveLinkState(row: DocumentData, nowMs: number, l17_2Enabled: boolean): EffectiveLinkState {
  if (!l17_2Enabled) return "candidate"
  // P3-26: while the un-merge saga runs the pair is unresolved identity, whatever the stored state.
  if (isUnmergeInProgress(row)) return "unmerging"
  if (row.state === "confirmed") return "confirmed"
  if (row.state === "rejected") return "rejected"
  if (row.state !== "candidate") return "candidate"
  if (row.disputed === true) return "disputed"
  if (row.disputed !== false) return "candidate"
  const created = millisOf(row.createdAt)
  return created !== null && created <= nowMs - LINK_AUTO_CONFIRM_MS ? "auto_confirmed" : "candidate"
}

/** True while an un-merge saga holds the row (`unmerge.status === "in_progress"`, spec P3-26). */
export function isUnmergeInProgress(row: DocumentData): boolean {
  const unmerge: unknown = row.unmerge
  return typeof unmerge === "object" && unmerge !== null && (unmerge as { status?: unknown }).status === "in_progress"
}

/** Only confirmed and auto-confirmed links are evidence of identity (L17.2 #15). */
export const isConfirmedState = (s: EffectiveLinkState): boolean => s === "confirmed" || s === "auto_confirmed"

/** When an undisputed candidate auto-confirms (createdAt + 30 d); null for any other row. */
export function autoConfirmAt(row: DocumentData): Date | null {
  if (row.state !== "candidate" || row.disputed !== false) return null
  const created = millisOf(row.createdAt)
  return created === null ? null : new Date(created + LINK_AUTO_CONFIRM_MS)
}

/** The pair a link row belongs to (one row per key; leftId < rightId as written). */
export const pairIdOf = (row: DocumentData): string => `${row.leftId}_${row.rightId}`
