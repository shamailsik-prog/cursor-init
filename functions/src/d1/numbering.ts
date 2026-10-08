import { FieldValue, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { HttpError } from "../http/errors"

/**
 * Firm numbering: client codes `{clientPrefix}-{YYYY}-{NNNN}` and matter numbers
 * `{matterPrefix}/{YYYY}/{NNNN}`. The year is the Asia/Karachi year; NNNN is
 * zero-padded to 4 digits (larger numbers print in full). Counters live in
 * `counters/{firmId}_{kind}_{YYYY}` and are advanced inside the caller's transaction.
 */

export type NumberKind = "client" | "matter"

const KARACHI = "Asia/Karachi"

/** The Asia/Karachi calendar parts of `now`. */
function karachiParts(now: Date): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KARACHI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return { year: part("year"), month: part("month"), day: part("day") }
}

export function karachiYear(now: Date): number {
  return Number(karachiParts(now).year)
}

/** "YYYYMMDD" in Asia/Karachi. */
export function karachiDay(now: Date): string {
  const { year, month, day } = karachiParts(now)
  return `${year}${month}${day}`
}

const pad = (n: number) => String(n).padStart(4, "0")

export function formatClientCode(prefix: string, year: number, n: number): string {
  return `${prefix}-${year}-${pad(n)}`
}

export function formatMatterNo(prefix: string, year: number, n: number): string {
  return `${prefix}/${year}/${pad(n)}`
}

/**
 * Allocates the next number (from 1) of `kind` for the firm in the current Karachi year.
 * Reads then writes the counter in `tx`, so concurrent allocations serialise; call it
 * after the transaction's other reads (Firestore requires reads before writes). An existing
 * counter whose `next` is not an integer ≥ 1 → HttpError(500, "counter_corrupt").
 */
export async function allocateNumber(tx: Transaction, firmId: string, kind: NumberKind, now: Date): Promise<number> {
  const year = karachiYear(now)
  const ref = adminDb().collection("counters").doc(`${firmId}_${kind}_${year}`)
  const data = (await tx.get(ref)).data()
  const valid = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1
  // A counter that exists but cannot be read fails closed: resetting it would reissue numbers.
  if (data !== undefined && !valid(data.next)) throw new HttpError(500, "counter_corrupt")
  const n = data === undefined ? 1 : (data.next as number)
  if (data) tx.update(ref, { next: n + 1 })
  else {
    tx.create(ref, {
      firmId,
      kind,
      year,
      next: n + 1,
      classification: "internal",
      createdAt: FieldValue.serverTimestamp(),
    })
  }
  return n
}

export const PREFIX_PATTERN = /^[A-Z]{2,6}$/

/** The firm's configured prefixes; 409 numbering_not_configured until a partner sets both. */
export async function readPrefixes(tx: Transaction, firmId: string): Promise<{ clientPrefix: string; matterPrefix: string }> {
  const firm = (await tx.get(adminDb().collection("firms").doc(firmId))).data()
  const { clientPrefix, matterPrefix } = firm ?? {}
  if (
    typeof clientPrefix !== "string" ||
    typeof matterPrefix !== "string" ||
    !PREFIX_PATTERN.test(clientPrefix) ||
    !PREFIX_PATTERN.test(matterPrefix)
  ) {
    throw new HttpError(409, "numbering_not_configured")
  }
  return { clientPrefix, matterPrefix }
}
