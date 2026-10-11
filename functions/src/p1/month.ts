/** PKT (Asia/Karachi, UTC+5, no DST) month keys by fixed-offset arithmetic, so the host's timezone is irrelevant (P3-64). */

const PKT_OFFSET_MS = 5 * 3_600_000

/** `YYYY-MM` of the PKT calendar month holding `nowMs`; throws `RangeError` for a time no date can hold (NaN, infinite, out of range). */
export function monthKeyPkt(nowMs: number): string {
  const d = new Date(nowMs + PKT_OFFSET_MS)
  if (Number.isNaN(d.getTime())) throw new RangeError("monthKeyPkt time out of range")
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

/** True for `YYYY-MM` with a month from 01 to 12 and nothing else around it. */
export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)
}
