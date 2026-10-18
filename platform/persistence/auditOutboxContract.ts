/**
 * Audit F11: the audit-outbox contract shared by the Next process (which stages entries in each effect's own commit,
 * platform/persistence/auditOutbox.ts) and the Cloud Functions reconciler (which publishes what a dead request left,
 * functions/src/p5/auditOutbox.ts). Pure: no SDK import, no I/O, so both stacks bundle it.
 *
 * An entry (`audit_outbox/<requestId>_<seq>`, server-only) is staged with one effect write of a request. It carries the
 * request's audit rows collected before that write and not yet staged, the paths the write touched, and who, which
 * firm, which route and action, which F10 operation. Spec: docs/superpowers/specs/2026-10-18-f11-atomic-request-audit-design.md.
 */
import { isClassification } from "@/platform/p1/types"

export const AUDIT_OUTBOX_COLLECTION = "audit_outbox"
export const AUDIT_LOG_COLLECTION = "audit_log"
export const AUDIT_DEAD_LETTER_COLLECTION = "audit_dead_letter"

/**
 * Collections whose writes are not effects (spec §2.2): the audit log, its dead letter, the outbox itself and F10's
 * operation record and effect marker. A write to them stages nothing. The same list as F10's UNFENCED_COLLECTIONS.
 */
export const NOT_EFFECT_COLLECTIONS: readonly string[] = [
  AUDIT_LOG_COLLECTION,
  AUDIT_DEAD_LETTER_COLLECTION,
  AUDIT_OUTBOX_COLLECTION,
  "idempotency_keys",
  "idempotency_effects",
]

/** A live request is never published: an entry is reconciled only once it is this old (ruling 5: twice F10's lease). */
export const AUDIT_OUTBOX_GRACE_MS = 10 * 60_000
/** The backlog alert fires while the oldest entry is at least this old (ruling 5). */
export const AUDIT_OUTBOX_ALERT_AGE_MS = 20 * 60_000
/** Rows staged in one entry, and their serialised size (ruling 14: a document holds 1 MiB). */
export const AUDIT_OUTBOX_MAX_ROWS = 200
export const AUDIT_OUTBOX_MAX_ROW_BYTES = 512 * 1024
/** Reconciler runs that met a non-retryable failure of the entry before it is dead-lettered whole (ruling 7). */
export const AUDIT_OUTBOX_MAX_ATTEMPTS = 3

export const RECOVERED_AUDIT_ACTION = "request_effect_recovered"
export const RECOVERED_AUDIT_REASON = "audit_unconfirmed"
export const RECOVERED_AUDIT_ID_PREFIX = "aud_outbox_"
/** The pseudo path of an effect that is not a Firestore write (a provider dispatch). */
export const EXTERNAL_EFFECT_PREFIX = "external:"

/** True when a write to `path` is an effect (its first segment is not one of NOT_EFFECT_COLLECTIONS). */
export function isEffectPath(path: string): boolean {
  return !NOT_EFFECT_COLLECTIONS.includes(path.split("/")[0] ?? "")
}

/** The stored entry, as the Next process writes it. */
export type AuditOutboxEntry = {
  v: 1
  surface: "next"
  firmId: string | null
  actorId: string | null
  route: string
  requestAction: string | null
  operationId: string | null
  requestId: string
  seq: number
  effectPaths: string[]
  rows: Record<string, unknown>[]
  stagedAt: Date
  attempts: number
}

/** An entry as the reconciler reads it back. */
export type ParsedOutboxEntry = {
  firmId: string
  actorId: string | null
  route: string | null
  requestAction: string | null
  operationId: string | null
  requestId: string | null
  effectPaths: string[]
  rows: unknown[]
  stagedAtMs: number
  attempts: number
}

export type OutboxEntryCheck = { ok: true; entry: ParsedOutboxEntry } | { ok: false; reason: "entry_malformed" | "entry_no_firm" }

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== ""
const optionalString = (v: unknown): string | null => (nonEmptyString(v) ? v : null)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Milliseconds of a stored time (an SDK Timestamp, a Date or a number); NaN when unreadable. */
export function millisOf(value: unknown): number {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (isRecord(value) && typeof value.toMillis === "function") return (value.toMillis as () => number)()
  return Number.NaN
}

/** Reads a stored entry, or says why it cannot be published (spec ruling 7, ruling 15). */
export function parseOutboxEntry(data: unknown): OutboxEntryCheck {
  if (!isRecord(data)) return { ok: false, reason: "entry_malformed" }
  const stagedAtMs = millisOf(data.stagedAt)
  const paths = data.effectPaths
  if (
    !Array.isArray(data.rows) ||
    !Array.isArray(paths) ||
    paths.length === 0 ||
    !paths.every(nonEmptyString) ||
    !Number.isFinite(stagedAtMs)
  ) {
    return { ok: false, reason: "entry_malformed" }
  }
  if (!nonEmptyString(data.firmId)) return { ok: false, reason: "entry_no_firm" }
  const attempts = typeof data.attempts === "number" && Number.isSafeInteger(data.attempts) && data.attempts >= 0 ? data.attempts : 0
  return {
    ok: true,
    entry: {
      firmId: data.firmId,
      actorId: optionalString(data.actorId),
      route: optionalString(data.route),
      requestAction: optionalString(data.requestAction),
      operationId: optionalString(data.operationId),
      requestId: optionalString(data.requestId),
      effectPaths: [...paths],
      rows: data.rows,
      stagedAtMs,
      attempts,
    },
  }
}

/** A Firestore document id the audit log can take (the ids Next gives rows are `aud_<uuid>`). */
const SAFE_ROW_ID = /^[A-Za-z0-9_-]{1,200}$/

export type StagedRowCheck =
  | { ok: true; row: Record<string, unknown> & { id: string } }
  | { ok: false; reason: "row_malformed" | "cross_firm_row" }

/**
 * Whether a staged row can be published into `firmId`'s audit log as it is: a normalised Next audit row (id, action,
 * actorId, target, classification label, time) of that firm. A row of another firm is never published (spec §2.7).
 */
export function checkStagedRow(row: unknown, firmId: string): StagedRowCheck {
  if (!isRecord(row)) return { ok: false, reason: "row_malformed" }
  if (
    typeof row.id !== "string" ||
    !SAFE_ROW_ID.test(row.id) ||
    !nonEmptyString(row.action) ||
    !nonEmptyString(row.actorId) ||
    !nonEmptyString(row.target) ||
    !isClassification(row.classification) ||
    typeof row.at !== "number" ||
    !Number.isFinite(row.at) ||
    !nonEmptyString(row.firmId)
  ) {
    return { ok: false, reason: "row_malformed" }
  }
  if (row.firmId !== firmId) return { ok: false, reason: "cross_firm_row" }
  return { ok: true, row: row as Record<string, unknown> & { id: string } }
}

export function recoveredAuditRowId(entryId: string): string {
  return `${RECOVERED_AUDIT_ID_PREFIX}${entryId}`
}

/** What the recovered row is built from: a parsed entry, or what can be read of a malformed one. */
export type RecoveredRowSource = {
  firmId: string | null
  actorId: string | null
  route: string | null
  requestAction: string | null
  operationId: string | null
  requestId: string | null
  effectPaths: readonly string[]
  rows: readonly unknown[]
  stagedAtMs?: number
  stagedAt?: unknown
}

/**
 * The row the reconciler publishes for an entry whose request never confirmed its audit (spec ruling 2): written by the
 * system (`actorId: "system"`, as P3-18 and `ai.gateway.reconciled`) about the request's own action (`onBehalfOf`),
 * naming the documents the effect wrote and the F10 operation. `privileged-restricted` fails closed: the paths can name
 * a privileged matter's documents.
 */
export function recoveredAuditRow(entryId: string, entry: RecoveredRowSource, recoveredAtMs: number): Record<string, unknown> {
  const stagedAtMs = entry.stagedAtMs ?? millisOf(entry.stagedAt)
  const stagedRowIds = (Array.isArray(entry.rows) ? entry.rows : [])
    .map((row) => (isRecord(row) && typeof row.id === "string" ? row.id : null))
    .filter((id): id is string => id !== null)
  return {
    id: recoveredAuditRowId(entryId),
    firmId: entry.firmId,
    action: RECOVERED_AUDIT_ACTION,
    actorId: "system",
    onBehalfOf: entry.actorId ?? "unknown",
    target: entry.effectPaths[0] ?? `${AUDIT_OUTBOX_COLLECTION}/${entryId}`,
    classification: "privileged-restricted",
    reason: RECOVERED_AUDIT_REASON,
    at: Number.isFinite(stagedAtMs) ? stagedAtMs : recoveredAtMs,
    recoveredAt: recoveredAtMs,
    route: entry.route ?? null,
    requestAction: entry.requestAction ?? null,
    operationId: entry.operationId ?? null,
    requestId: entry.requestId ?? null,
    effectPaths: [...entry.effectPaths],
    stagedRowIds,
  }
}

/**
 * A stored dead letter (spec §2.5). `firmId` is the firm that owns the letter: the row's for a letter the Next process
 * writes, the entry's (the request's) for one the reconciler writes. Letters stored before F11 carry only `row.firmId`.
 */
export type StoredDeadLetter = {
  row: unknown
  reason: string
  deadLetteredAt: number
  firmId?: string
  source?: "audit_outbox"
  outboxId?: string
}

/** A JSON copy: drops `undefined` (Firestore refuses it) and every non-JSON value. */
export function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
