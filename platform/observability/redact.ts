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

/** Operational tokens only: no spaces, no '@', no '='; long enough for a UUID, short of a document. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/

const SENSITIVE = [
  /[^\s@]+@[^\s@]+\.[^\s@]{2,}/,
  /\b\d{5}[-.\s]+\d{7}[-.\s]+\d\b/,
  /\b\d{13}\b/,
  /\b(?:\+?92|0092|0)3\d{2}[\s.-]*\d{7}\b/,
  /\b03\d{9}\b/,
  /\bpk\d{2}[a-z0-9]{10,}\b/i,
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/,
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9]/,
  /\bAKIA[0-9A-Z]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd|secret|token|apikey|api key|authorization|cookie)\b\s*[:=]/i,
  /\bbearer\s+\S{6,}/i,
  /\b(?:cnic|nic|phone|email|address)\b/i,
  /\b(?:house|street|road|mohalla|mohallah|colony|sector)\b/i,
]

/** Fold a field name the way F15 folds a party name, then drop separators. */
export function normalizeFieldKey(key: string): string {
  return foldName(key).replace(/[^a-z0-9]/g, "")
}

function sensitive(value: string): boolean {
  const folded = detectionView(value).text
  return SENSITIVE.some((re) => re.test(folded) || re.test(value))
}

function redactString(raw: string): string {
  if (!TOKEN.test(raw) || sensitive(raw)) return REDACTED
  return raw
}

function redactNumber(n: number, field: ObservabilityField): number | undefined {
  if (!Number.isFinite(n)) return undefined
  // A metric may be fractional. Eleven or more integer digits is an identifier, not a measurement.
  if (field === "value") {
    if (Number.isInteger(n) && String(Math.abs(n)).length >= 11) return undefined
    if (Math.abs(n) > 1_000_000_000_000) return undefined
    return n
  }
  if (!Number.isInteger(n)) return undefined
  if (field === "statusCode") return n >= 0 && n <= 599 ? n : undefined
  if (field === "attempt") return n >= 0 && n <= 100 ? n : undefined
  if (field === "count") return n >= 0 && n <= 1_000_000_000 ? n : undefined
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
  const out: Record<string, unknown> = {}
  const safeName = redactString(name)
  if (safeName !== REDACTED) out.errorName = safeName
  if ("code" in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 16) out.errorCode = code
    else if (typeof code === "string") {
      const safe = redactString(code)
      if (safe !== REDACTED) out.errorCode = safe
    }
  }
  return out
}

function redactArray(values: readonly unknown[], depth: number, seen: WeakSet<object>): unknown[] {
  return values.map((item) => {
    const next = redactValue(item, depth + 1, seen)
    return next === undefined ? REDACTED : next
  })
}

function redactObject(value: object, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  if (isErrorLike(value)) return redactError(value)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const canonical = CANONICAL.get(normalizeFieldKey(key))
    if (canonical === undefined) continue
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
      out[canonical] = redactString(child)
      continue
    }
    if (Array.isArray(child)) {
      out[canonical] = redactArray(child, depth, seen)
      continue
    }
    if (typeof child === "object" && child !== null) {
      const nested = redactValue(child, depth + 1, seen)
      if (nested !== undefined) out[canonical] = nested
    }
  }
  return out
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 8) return REDACTED
  if (value === null || value === undefined) return undefined
  if (typeof value === "string") return redactString(value)
  if (typeof value === "number") return undefined
  if (typeof value === "boolean") return value
  if (typeof value !== "object") return REDACTED
  if (seen.has(value)) return REDACTED
  seen.add(value)
  try {
    if (Array.isArray(value)) return redactArray(value, depth, seen)
    return redactObject(value, depth, seen)
  } finally {
    seen.delete(value)
  }
}

/** Return a value that is safe to serialise onto a log line, a metric or a span. */
export function redactForObservability(input: unknown): unknown {
  return redactValue(input, 0, new WeakSet())
}
