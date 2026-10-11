import { randomBytes } from "node:crypto"

const MAX_TS = 0xffffffffffff

/** RFC 9562 UUIDv7: a 48-bit Unix millisecond timestamp, then version 7, 74 random bits and the 10 variant. */
export function uuidv7(nowMs: number = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_TS) throw new RangeError("uuidv7 timestamp out of range")
  const rand = randomBytes(10)
  rand[0] = (rand[0]! & 0x0f) | 0x70
  rand[2] = (rand[2]! & 0x3f) | 0x80
  const h = nowMs.toString(16).padStart(12, "0") + rand.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
