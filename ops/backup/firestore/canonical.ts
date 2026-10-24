import { createHash } from "node:crypto"
import type { DocumentReference, GeoPoint, Timestamp } from "firebase-admin/firestore"

const SEP = 0x1e

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v)
}

function encodeNumber(n: number): string {
  if (Number.isNaN(n)) return "n:NaN"
  if (n === Infinity) return "n:+Inf"
  if (n === -Infinity) return "n:-Inf"
  if (Object.is(n, -0)) return "n:-0"
  if (Number.isInteger(n)) return `i:${n}`
  return `d:${n}`
}

/** Typed canonical encoding (spec R10). */
export function canonicalEncode(value: unknown): Buffer {
  const parts: string[] = []
  const walk = (v: unknown): void => {
    if (v === null) parts.push("null")
    else if (typeof v === "boolean") parts.push(v ? "true" : "false")
    else if (typeof v === "number") parts.push(encodeNumber(v))
    else if (typeof v === "string") parts.push(`s:${v}`)
    else if (Buffer.isBuffer(v)) parts.push(`b:${v.toString("base64")}`)
    else if (v && typeof v === "object" && "toMillis" in (v as Timestamp) && typeof (v as Timestamp).toMillis === "function") {
      const ts = v as Timestamp
      parts.push(`ts:${ts.seconds}:${ts.nanoseconds}`)
    } else if (v && typeof v === "object" && "_latitude" in (v as GeoPoint)) {
      const g = v as GeoPoint
      parts.push(`geo:${g.latitude}:${g.longitude}`)
    } else if (v && typeof v === "object" && "path" in (v as DocumentReference)) {
      parts.push(`ref:${(v as DocumentReference).path}`)
    } else if (v && typeof v === "object" && "toArray" in (v as { toArray: () => number[] })) {
      const arr = (v as { toArray: () => number[] }).toArray()
      parts.push(`vec:[${arr.join(",")}]`)
    } else if (Array.isArray(v)) {
      parts.push("[")
      for (const item of v) walk(item)
      parts.push("]")
    } else if (isPlainObject(v)) {
      parts.push("{")
      for (const key of Object.keys(v).sort()) {
        parts.push(`k:${key}`)
        walk(v[key])
      }
      parts.push("}")
    } else parts.push(`x:${String(v)}`)
  }
  walk(value)
  return Buffer.from(parts.join("\n"), "utf8")
}

export function docHash(path: string, data: Record<string, unknown>): Buffer {
  return createHash("sha256")
    .update(path)
    .update(Buffer.from([SEP]))
    .update(canonicalEncode(data))
    .digest()
}

export function collectionPattern(path: string): string {
  const parts = path.split("/")
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) out.push("*")
    else out.push(parts[i])
  }
  return out.join("/")
}
