/**
 * Central redaction for logs, metrics and spans (Q15a).
 *
 * Builds on three existing rules instead of a second mask:
 * - F34: a trace may carry ids, codes and counts, never client or matter text
 *   (`functions/src/p1/opik.ts`, `TRACE_TEXT_MAX_RANK`).
 * - `functions/src/log.ts`: an error contributes its code, never its message.
 * - F15: `detectionView` / `foldName` (`platform/p1/piiText.ts`) fold Unicode
 *   digits, invisibles and look-alike letters before a value is judged.
 *
 * Keys are an allowlist. A key that is not on it is dropped, including after
 * case, separator and confusable folding. A value that is kept must be an
 * operational token, a small number, or a boolean. Anything else is replaced
 * with `REDACTED` or omitted, so the original is not serialised.
 */

import { detectionView, foldName } from "@/platform/p1/piiText"

export const REDACTED = "[redacted]"

/** Canonical field names a signal may carry. Lookup is on `normalizeFieldKey`. */
export const OBSERVABILITY_FIELDS = [
  "signal",
  "level",
  "severity",
  "event",
  "code",
  "reason",
  "outcome",
  "status",
  "service",
  "module",
  "operation",
  "classification",
  "firmId",
  "matterId",
  "documentId",
  "jobId",
  "operationId",
  "traceId",
  "spanId",
  "parentSpanId",
  "requestId",
  "usageLogId",
  "actorId",
  "durationMs",
  "count",
  "attempt",
  "value",
  "unit",
  "metric",
  "statusCode",
  "ok",
  "errorName",
  "errorCode",
] as const

export type ObservabilityField = (typeof OBSERVABILITY_FIELDS)[number]

const CANONICAL = new Map<string, ObservabilityField>(
  OBSERVABILITY_FIELDS.map((field) => [normalizeFieldKey(field), field]),
)

const NUMERIC = new Set<ObservabilityField>(["durationMs", "count", "attempt", "value", "statusCode"])

/**
 * A value is kept only when it proves it is safe for that field.
 *
 * Non-id strings must be one case of snake case (`not_minimised`, `OVERRIDE_FORBIDDEN`),
 * at most 19 characters unless an underscore lets a repo code run to 40, with at most
 * six digits and no secret prefix. Id fields must be a UUID or a single-case opaque id,
 * and a digit window on the folded text refuses an embedded CNIC, mobile (including
 * `0092`), or landline. `errorName` is a PascalCase class name copied only off a real
 * Error, never off a caller field.
 */
const ERROR_NAME = /^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPAQUE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const LOWER_SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/
const CNIC_WINDOW = /\d{5}\D{0,2}\d{7}\D{0,2}\d/
const MOBILE_WINDOW = /(?:\+|00)?92\D{0,2}3\d{2}\D{0,2}\d{7}|0?3\d{2}\D{0,2}\d{3}\D{0,2}\d{4}/
const LANDLINE_WINDOW = /0\d{2,3}\D{0,2}\d{7,8}/
const SECRET_PREFIXES = [
  "aiza",
  "akia",
  "asia",
  "github_pat_",
  "whsec_",
  "sk-",
  "sk_live_",
  "rk_live_",
  "eyj",
  "basic_",
  "ghp_",
  "gho_",
  "glpat-",
  "xoxb-",
  "xoxp-",
]

function folded(raw: string): string {
  return detectionView(raw).text.toLowerCase()
}

function digitRun(raw: string): boolean {
  return /\d{10,}/.test(folded(raw))
}

function digitCount(raw: string): number {
  return folded(raw).replace(/\D/g, "").length
}

function hasSecretPrefix(raw: string): boolean {
  const text = folded(raw)
  return SECRET_PREFIXES.some((prefix) => text.startsWith(prefix))
}

function hasDigitWindow(raw: string): boolean {
  const text = folded(raw)
  return CNIC_WINDOW.test(text) || MOBILE_WINDOW.test(text) || LANDLINE_WINDOW.test(text)
}

function hasMixedCase(raw: string): boolean {
  return /[a-z]/.test(raw) && /[A-Z]/.test(raw)
}

function provenSafeNonId(raw: string): boolean {
  if (hasSecretPrefix(raw)) return false
  if (!LOWER_SNAKE.test(raw) && !UPPER_SNAKE.test(raw)) return false
  if (digitCount(raw) > 6) return false
  const max = raw.includes("_") ? 40 : 19
  if (raw.length > max) return false
  return true
}

function provenSafeId(raw: string): boolean {
  if (UUID.test(raw)) return true
  if (hasSecretPrefix(raw)) return false
  if (hasMixedCase(raw)) return false
  if (!OPAQUE_ID.test(raw)) return false
  if (digitRun(raw)) return false
  if (hasDigitWindow(raw)) return false
  return true
}

function redactString(field: ObservabilityField, raw: string): string {
  if (field === "errorName") return ERROR_NAME.test(raw) ? raw : REDACTED
  if (field.endsWith("Id")) return provenSafeId(raw) ? raw : REDACTED
  return provenSafeNonId(raw) ? raw : REDACTED
}

/** Fold a field name the way F15 folds a party name, then drop separators. */
export function normalizeFieldKey(key: string): string {
  return foldName(key).replace(/[^a-z0-9]/g, "")
}

function redactMetric(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined
  const text = String(n)
  if (/[eE]/.test(text)) return undefined
  if (Math.abs(n) > 1_000_000) return undefined
  const fraction = text.split(".")[1]
  if (fraction !== undefined && fraction.length > 3) return undefined
  return n
}

function redactNumber(n: number, field: ObservabilityField): number | undefined {
  if (field === "value") return redactMetric(n)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (/\d{10,}/.test(String(Math.abs(n)))) return undefined
  if (field === "statusCode") return n >= 0 && n <= 599 ? n : undefined
  if (field === "attempt") return n >= 0 && n <= 100 ? n : undefined
  if (field === "count") return n >= 0 ? n : undefined
  if (field === "durationMs") return n >= 0 && n <= 86_400_000 ? n : undefined
  return undefined
}

function isErrorLike(value: object): boolean {
  // Only a real Error. A plain object that happens to have `message` and `stack`
  // keys keeps its allowlisted fields; those two keys are not allowlisted, so the
  // text is still dropped.
  return value instanceof Error
}

/**
 * An error contributes its class name and, when it is a short code, its `code`.
 * The message, the stack and any other property are not copied (`functions/src/log.ts`).
 */
function redactError(err: object): Record<string, unknown> {
  const name = "name" in err && typeof err.name === "string" ? err.name : "Error"
  const out: Record<string, unknown> = { errorName: redactString("errorName", name) }
  if ("code" in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 16) out.errorCode = code
    else if (typeof code === "string" && provenSafeNonId(code)) out.errorCode = code
  }
  return out
}

function redactObject(value: object): Record<string, unknown> {
  if (isErrorLike(value)) return redactError(value)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const canonical = CANONICAL.get(normalizeFieldKey(key))
    if (canonical === undefined || canonical === "errorName" || canonical === "errorCode") continue
    if (canonical === "ok") {
      if (typeof child === "boolean") out.ok = child
      continue
    }
    if (NUMERIC.has(canonical)) {
      if (typeof child === "number") {
        const n = redactNumber(child, canonical)
        if (n !== undefined) out[canonical] = n
      }
      continue
    }
    if (typeof child === "string") {
      out[canonical] = redactString(canonical, child)
      continue
    }
    if (child !== null && typeof child === "object") out[canonical] = REDACTED
  }
  return out
}

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined
  if (typeof value === "string") return provenSafeNonId(value) ? value : REDACTED
  if (typeof value === "number" || typeof value === "boolean") return REDACTED
  if (typeof value !== "object") return REDACTED
  if (Array.isArray(value)) return REDACTED
  return redactObject(value)
}

/** Return a value that is safe to serialise onto a log line, a metric or a span. */
export function redactForObservability(input: unknown): unknown {
  return redactValue(input)
}
