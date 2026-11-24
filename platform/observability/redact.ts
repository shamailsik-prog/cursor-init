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
 * operational token, a small number, a boolean, or a minted id. Anything else
 * is replaced with `REDACTED` or omitted, so the original is not serialised.
 *
 * An id field keeps a value only when the object is the same one this module
 * put in its private registry (`mintUuid`, `mintFirestoreId`, `mintUlid`,
 * `mintHyphenatedId`, `mintMatterSerial`, `mintDatedId`). Emit copies the
 * registry text after checking it again. A spread, an assign, a mutation, a
 * forged symbol, a Proxy or a getter is not that object, so it is redacted.
 * A string is not kept because it looks like a UUID, a Firestore auto-id, or
 * any other id shape.
 */

import { randomBytes, randomUUID } from "node:crypto"
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
 * six digits, no secret prefix and no credential segment. A closed set of repo codes
 * is kept by exact membership when that shape would refuse them (`malformed_token`,
 * `pwd_reset`). An id string is never kept. `errorName` is a closed set of
 * built-in classes and this repo's error classes, copied only off a real Error.
 */
const KNOWN_ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "AssertionError",
  "SystemError",
])
/**
 * Closed error-class enum. The attached audit list, plus the four exported
 * TypeScript classes that list missed (`P1TransportError` and the embedding
 * and deadline classes). A personal name ending in Error is not in the set.
 */
const REPO_ERROR_NAMES = new Set([
  "APIConnectionError",
  "ApiError",
  "AuditAppendConflictError",
  "AuthError",
  "AuthorityUnavailableError",
  "BatchError",
  "CallerFirmRequiredError",
  "CitationError",
  "CommittedEffectError",
  "CommitteeScopeError",
  "ConfigurationError",
  "ContractError",
  "CorpusUnavailableError",
  "CourtOpsAckIdError",
  "CourtOpsAckRefusedError",
  "CourtOpsItemNotFoundError",
  "CursorError",
  "DeployContractError",
  "DocumentMalformedError",
  "DocumentObjectAlreadyExistsError",
  "DocumentObjectConfigurationError",
  "DocumentObjectStoreError",
  "DraftChangedError",
  "DraftCharsetError",
  "DraftSizeError",
  "DraftTemplateAnalyticsIdError",
  "DraftTemplateAnalyticsRefusedError",
  "EnvelopeError",
  "ExplodingRowError",
  "FeatureDisabledError",
  "FirmScopedCursorError",
  "FirmScopedUpdateError",
  "FollowUpResolveRefusedError",
  "HarvesterContractError",
  "HttpError",
  "IdempotencyError",
  "IdempotencyFenceError",
  "InsecureDevAuthContextError",
  "JobError",
  "LeaseLostError",
  "ManifestError",
  "MatterClosedError",
  "MatterShapeError",
  "MembershipAssignmentError",
  "OcrAdmissionError",
  "OcrTimeoutError",
  "PDFDownloadError",
  "PDFExtractionError",
  "PackageAlreadyDecidedError",
  "PeriodRangeError",
  "PersistenceConfigurationError",
  "PgTargetNotCleanError",
  "ProviderKeyInRuntimeError",
  "PublicError",
  "PublicationError",
  "QueryTextError",
  "RateLimitedError",
  "ReconcileError",
  "RetentionConfigError",
  "ScheduledRunsFailedError",
  "SearchIndexMalformedError",
  "SectionHistoryInconsistentError",
  "ServiceAuthError",
  "SurfaceError",
  "TokenRejectedError",
  "ToolContractError",
  "UnregisteredJobTypeError",
  "_RecordSpecificError",
  "P1EmbeddingRequestError",
  "P1EmbeddingTransportError",
  "P1PreCallDeadlineError",
  "P1TransportError",
])
/**
 * Repo codes the snake-case grammar refuses because a segment is `token`,
 * `authorization` or `pwd`. Membership is exact, so `token_hunter2` stays out.
 * `tokenizer_failed` and `secretary_absent` are pinned here as well.
 */
const CLOSED_CODES: ReadonlySet<string> = new Set([
  "malformed_token",
  "missing_token",
  "invalid_token",
  "token_expired",
  "token_revoked",
  "AUTHORIZATION_FAILED",
  "pwd_reset",
  "tokenizer_failed",
  "secretary_absent",
])
const LOWER_SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/
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
  "ghs_",
  "ghu_",
  "npm_",
  "sk_test_",
  "rk_test_",
  "pk_live_",
  "pk_test_",
]
// A hyphen is already outside the snake-case grammar, and an id string is never
// kept, so a hyphenated prefix cannot decide a keep. Live prefixes remain:
// they still match at the start, one character in, or after "_" or "-".
// `sk_live` matches only when that token itself starts: at the beginning, or
// after "_" or "-". A hit inside task_live, risk_live, disk_live or ask_live
// is not a token start. `AKIA` / `ASIA` / `AIZA` still match one character in.
// Two or more alphanumeric characters in front of those prefixes is not a hit.
const REFUSED_SEGMENTS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "bearer",
  "authorization",
  "credential",
]

function folded(raw: string): string {
  return detectionView(raw).text.toLowerCase()
}

function digitCount(raw: string): number {
  return folded(raw).replace(/\D/g, "").length
}

function boundaryPrefix(text: string, prefix: string): boolean {
  let from = 0
  while (from < text.length) {
    const at = text.indexOf(prefix, from)
    if (at < 0) return false
    const prev = at === 0 ? "" : text[at - 1]
    if (at === 0 || at === 1 || prev === "_" || prev === "-") return true
    from = at + 1
  }
  return false
}

/** `sk_live` at a token start when the next character is not alphanumeric. */
function skLiveHit(text: string): boolean {
  const prefix = "sk_live"
  let from = 0
  while (from < text.length) {
    const at = text.indexOf(prefix, from)
    if (at < 0) return false
    const prev = at === 0 ? "" : text[at - 1]
    const next = text[at + prefix.length]
    const tokenStart = at === 0 || prev === "_" || prev === "-"
    if (tokenStart && (next === undefined || !/[a-z0-9]/.test(next))) return true
    from = at + 1
  }
  return false
}

function hasSecretPrefix(raw: string): boolean {
  const text = folded(raw)
  if (skLiveHit(text)) return true
  return SECRET_PREFIXES.some((prefix) => boundaryPrefix(text, prefix))
}

function hasRefusedSegment(raw: string): boolean {
  const text = folded(raw)
  return REFUSED_SEGMENTS.some((word) => new RegExp(`(?:^|[_-])${word}(?:$|[_-])`).test(text))
}

function provenErrorName(raw: string): boolean {
  return KNOWN_ERROR_NAMES.has(raw) || REPO_ERROR_NAMES.has(raw)
}

function provenSafeNonId(raw: string): boolean {
  if (CLOSED_CODES.has(raw)) return true
  if (hasSecretPrefix(raw)) return false
  if (hasRefusedSegment(raw)) return false
  if (!LOWER_SNAKE.test(raw) && !UPPER_SNAKE.test(raw)) return false
  if (digitCount(raw) > 6) return false
  const max = raw.includes("_") ? 40 : 19
  if (raw.length > max) return false
  return true
}

function redactString(field: ObservabilityField, raw: string): string {
  if (field === "errorName") return provenErrorName(raw) ? raw : REDACTED
  if (field.endsWith("Id")) return REDACTED
  return provenSafeNonId(raw) ? raw : REDACTED
}

const mintedBrand: unique symbol = Symbol("legal-os.observability.minted-id")

/** An id this module generated. A caller-built object with a `text` field is not one. */
export type MintedId = {
  readonly text: string
  readonly [mintedBrand]: true
}

const mintedRegistry = new WeakMap<object, string>()

function acceptableMintedText(text: string): boolean {
  return text.length > 0 && text.length <= 64 && !hasSecretPrefix(text) && !hasRefusedSegment(text)
}

/** Registry text only. A copy is a different object and is not in the map. */
function mintedTextOk(record: { text: string }): boolean {
  return record.text.length > 0 && record.text.length <= 64 && acceptableMintedText(record.text) && digitCount(record.text) <= 32
}

function stamp(text: string): MintedId | undefined {
  const record = { text }
  if (!mintedTextOk(record)) return undefined
  const minted: MintedId = Object.freeze({ text: record.text, [mintedBrand]: true as const })
  mintedRegistry.set(minted, record.text)
  return minted
}

function emittedMintedText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const stored = mintedRegistry.get(value)
  if (stored === undefined) return undefined
  const record = { text: stored }
  if (!mintedTextOk(record)) return undefined
  return record.text
}

const FIRESTORE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function firestoreToken(): string {
  let text = ""
  while (text.length < 20) {
    const bytes = randomBytes(40)
    for (const byte of bytes) {
      if (byte >= 248) continue
      text += FIRESTORE_ALPHABET[byte % 62]!
      if (text.length === 20) return text
    }
  }
  return text
}

/** A UUID from `randomUUID`. The string form alone is not an id. */
export function mintUuid(): MintedId {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const text = randomUUID()
    const minted = stamp(text)
    if (minted !== undefined) return minted
  }
  throw new Error("observability uuid mint failed closed")
}

/** A 20-character Firestore auto-id. The string form alone is not an id. */
export function mintFirestoreId(): MintedId {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const text = firestoreToken()
    const minted = stamp(text)
    if (minted !== undefined) return minted
  }
  throw new Error("observability firestore id mint failed closed")
}

function encodeUlidTime(timeMs: number): string {
  let out = ""
  let n = timeMs
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[n % 32]! + out
    n = Math.floor(n / 32)
  }
  return out
}

function encodeUlidRandom(bytes: Buffer): string {
  let out = ""
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD[(acc >> bits) & 31]!
    }
  }
  return out
}

/** A ULID. `timeMs` is the 48-bit timestamp; randomness comes from this process. */
export function mintUlid(timeMs = Date.now()): MintedId | undefined {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs >= 2 ** 48) return undefined
  const time = encodeUlidTime(timeMs)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const random = encodeUlidRandom(randomBytes(10))
    if (random.length !== 16) continue
    const text = time + random
    const minted = stamp(text)
    if (minted !== undefined) return minted
  }
  return undefined
}

/**
 * `trace-abc` or `job-123`. The suffix is a 1–3 letter opcode or a digit serial.
 * A name (`muhammad`) or a mixed token (`hunter2`) is refused. Length stays on
 * the charset check, so this pattern is not also a length cap.
 */
export function mintHyphenatedId(prefix: "trace" | "job", suffix: string): MintedId | undefined {
  if (prefix !== "trace" && prefix !== "job") return undefined
  if (!/^[a-z0-9]{1,8}$/.test(suffix)) return undefined
  if ((suffix.match(/\d/g) ?? []).length > 3) return undefined
  if (suffix.length <= 8 && !/^(?:[a-z]{1,3}|\d+)$/.test(suffix)) return undefined
  const text = `${prefix}-${suffix}`
  if (!acceptableMintedText(text)) return undefined
  return stamp(text)
}

/** `MATTER_2026_000123`. Year 2000–2099, serial 0–999999. */
export function mintMatterSerial(year: number, serial: number): MintedId | undefined {
  if (!Number.isInteger(year) || year < 2000 || year > 2099) return undefined
  if (!Number.isInteger(serial) || serial < 0 || serial > 999_999) return undefined
  const text = `MATTER_${year}_${String(serial).padStart(6, "0")}`
  if (!acceptableMintedText(text)) return undefined
  return stamp(text)
}

function isCalendarDay(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const dim = days[month - 1]
  return dim !== undefined && day <= dim
}

/** `mat_2026_11_15_001`. Month 1–12, a real calendar day, serial 0–999. */
export function mintDatedId(year: number, month: number, day: number, serial: number): MintedId | undefined {
  if (!Number.isInteger(year) || year < 2000 || year > 2099) return undefined
  if (!Number.isInteger(month) || month < 1 || month > 12) return undefined
  if (!Number.isInteger(day) || day < 1 || day > 31) return undefined
  if (!Number.isInteger(serial) || serial < 0 || serial > 999) return undefined
  if (day >= 1 && day <= 31 && !isCalendarDay(year, month, day)) return undefined
  const text = `mat_${year}_${String(month).padStart(2, "0")}_${String(day).padStart(2, "0")}_${String(serial).padStart(3, "0")}`
  if (!acceptableMintedText(text)) return undefined
  return stamp(text)
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
    if (canonical.endsWith("Id")) {
      const mintedText = emittedMintedText(child)
      if (mintedText !== undefined) out[canonical] = mintedText
      else if (typeof child === "string" || (child !== null && typeof child === "object")) out[canonical] = REDACTED
      continue
    }
    if (canonical === "ok") {
      if (typeof child === "boolean") out.ok = child
      continue
    }
    if (typeof child === "bigint") continue
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
  if (typeof value === "bigint") return REDACTED
  if (typeof value === "number" || typeof value === "boolean") return REDACTED
  if (typeof value !== "object") return REDACTED
  if (Array.isArray(value)) return REDACTED
  return redactObject(value)
}

/** Return a value that is safe to serialise onto a log line, a metric or a span. */
export function redactForObservability(input: unknown): unknown {
  return redactValue(input)
}
