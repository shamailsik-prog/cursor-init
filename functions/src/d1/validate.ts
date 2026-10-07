import { HttpError } from "../http/errors"
import { normaliseCnic, normaliseNtn, normalisePhone, normaliseSecp } from "./conflict/normalise"

/** Shared input parsers for the D1 operations. Every refusal is 400 `invalid_subjects`. */

export type Keys = { cnic?: string; ntn?: string; secp?: string; phone?: string }

const invalid = () => new HttpError(400, "invalid_subjects")

/** A party name: a string of 1-200 characters after trimming. Returns the trimmed name. */
export function parseName(value: unknown): string {
  if (typeof value !== "string") throw invalid()
  const name = value.trim()
  if (name.length < 1 || name.length > 200) throw invalid()
  return name
}

/** An identifier field: absent, null or blank means not supplied; a non-string or an unnormalisable value is refused. */
function parseKey(value: unknown, normalise: (raw: string) => string | null): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw invalid()
  if (value.trim() === "") return undefined
  const normalised = normalise(value)
  if (normalised === null) throw invalid()
  return normalised
}

/** The identifiers in `data` (`cnic`, `ntn`, `secp`, `phone`), normalised. Only supplied keys appear in the result. */
export function parseKeys(data: Record<string, unknown>): Keys {
  const keys: Keys = {}
  const cnic = parseKey(data.cnic, normaliseCnic)
  const ntn = parseKey(data.ntn, normaliseNtn)
  const secp = parseKey(data.secp, normaliseSecp)
  const phone = parseKey(data.phone, normalisePhone)
  if (cnic !== undefined) keys.cnic = cnic
  if (ntn !== undefined) keys.ntn = ntn
  if (secp !== undefined) keys.secp = secp
  if (phone !== undefined) keys.phone = phone
  return keys
}
