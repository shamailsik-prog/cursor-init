import { createHash, randomUUID } from "node:crypto"
import { Timestamp, type CollectionReference, type Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { HttpError } from "../http/errors"
import { canonicalJson } from "../http/idempotency"
import { isKnownClassification } from "../p5/classification"
import { isSafeDocId, type Session } from "../p5/common"
import { stageJobAudit } from "./audit"
import { JOB_ENGINE, JOB_SCHEMA_VERSION, MAX_ATTEMPTS, MAX_PAYLOAD_BYTES, MAX_REFS, type JobStatus } from "./constants"
import { handlerFor } from "./registry"

/**
 * Transactional enqueue (spec P3-2, P3-4): a job is created inside its cause's own Firestore
 * transaction, so it exists if and only if that transaction committed. The doc id is derived
 * from (firmId, jobType, idempotencyKey), so a repeated key reuses the row.
 */

export { canonicalJson }

export type JobLogEvent = "enqueued" | "claimed" | "reclaimed" | "done" | "failed" | "dead_lettered" | "requeued" | "cancelled"
export type JobLogEntry = { at: Timestamp; event: JobLogEvent; attempt: number; code?: string }
export type JobActorNote = { by: string; role: string; at: Timestamp; note: string }

export type JobRow = {
  engine: "p2"
  schemaVersion: 1
  firmId: string
  jobType: string
  classification: Classification
  matterId: string | null
  payload: Record<string, unknown>
  payloadHash: string
  inputRefs: string[]
  outputRefs: string[]
  idempotencyKey: string
  runKey: string | null
  status: JobStatus
  attempts: number
  totalAttempts: number
  maxAttempts: 4
  manualRetries: number
  nextAttemptAt: Timestamp | null
  lease: { owner: string; expiresAt: Timestamp } | null
  dispatchSeq: number
  dispatchedAt: Timestamp
  traceId: string
  lastError: { code: string; message: string } | null
  logs: JobLogEntry[]
  createdBy: string
  requeues: JobActorNote[]
  cancellation: JobActorNote | null
  /** Fenced steps committed by this job (`runFenced`), keyed by step id; absent until the first. Never in a view. */
  fencedSteps?: Record<string, FencedStepRecord>
  createdAt: Timestamp
  updatedAt: Timestamp
  startedAt: Timestamp | null
  finishedAt: Timestamp | null
}

export type FencedStepRecord = { at: Timestamp; attempt: number }

export type JobSpec = {
  firmId: string
  jobType: string
  classification: Classification
  matterId: string | null
  payload: Record<string, unknown>
  inputRefs?: string[]
  idempotencyKey: string
  runKey?: string | null
  createdBy: string
}

export type EnqueueResult = { jobId: string; reused: boolean }

const MAX_KEY_LENGTH = 512

export function jobsRef(): CollectionReference {
  return adminDb().collection("jobs")
}

/** `"j"` + the first 40 hex characters of SHA-256(firmId NUL jobType NUL idempotencyKey). */
export function jobIdFor(firmId: string, jobType: string, idempotencyKey: string): string {
  return "j" + createHash("sha256").update(`${firmId}\0${jobType}\0${idempotencyKey}`).digest("hex").slice(0, 40)
}

/** The key of a job caused by an HTTP call: the request's Idempotency-Key plus a suffix (P3-4). */
export function jobKey(session: Session, suffix: string): string {
  if (typeof session.idempotencyKey !== "string" || session.idempotencyKey === "") throw new Error("jobKey: no idempotency key")
  return `${session.idempotencyKey}:${suffix}`
}

const invalid = (field: string) => new Error(`enqueue: invalid ${field}`)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Firestore refuses a document nested deeper than this (the payload object itself is level 1; probed in the emulator). */
const MAX_PAYLOAD_DEPTH = 20

/** A field name Firestore refuses: empty, or of the form `__x__`. */
function isRefusedKey(key: string): boolean {
  return key === "" || (key.length >= 4 && key.startsWith("__") && key.endsWith("__"))
}

/**
 * A plain JSON value that Firestore accepts as a stored field: string, finite number, boolean,
 * null, array or plain object, recursively (no cycles). It refuses the shapes Firestore itself
 * rejects at commit, so they fail as `enqueue: invalid payload` rather than an SDK error: an
 * empty-string key, a `__x__` key, an array directly inside an array, and nesting deeper than 20.
 */
function isJsonValue(value: unknown, ancestors: Set<object>, depth = 0, parentIsArray = false): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (parentIsArray || depth + 1 > MAX_PAYLOAD_DEPTH) return false
    if (Object.getPrototypeOf(value) !== Array.prototype || ancestors.has(value)) return false
    ancestors.add(value)
    const ok = value.every((v) => isJsonValue(v, ancestors, depth + 1, true))
    ancestors.delete(value)
    return ok
  }
  if (isPlainObject(value)) {
    if (depth + 1 > MAX_PAYLOAD_DEPTH || ancestors.has(value)) return false
    ancestors.add(value)
    const ok = Object.entries(value).every(([k, v]) => !isRefusedKey(k) && isJsonValue(v, ancestors, depth + 1, false))
    ancestors.delete(value)
    return ok
  }
  return false
}

/** A document path `collection/id` with safe ids (inputRefs, outputRefs). */
export function isSafeRef(ref: unknown): boolean {
  if (typeof ref !== "string") return false
  const parts = ref.split("/")
  return parts.length === 2 && isSafeDocId(parts[0]) && isSafeDocId(parts[1])
}

type Validated = { spec: JobSpec; jobId: string; payloadHash: string; inputRefs: string[]; runKey: string | null }

/** Validates a spec; a failure is a programming error naming the field only, never its value. */
function validate(spec: JobSpec): Validated {
  if (typeof spec.jobType !== "string" || handlerFor(spec.jobType) === undefined) throw invalid("jobType")
  if (!isSafeDocId(spec.firmId)) throw invalid("firmId")
  if (!isKnownClassification(spec.classification)) throw invalid("classification")
  if (spec.matterId !== null && !isSafeDocId(spec.matterId)) throw invalid("matterId")
  if (!isPlainObject(spec.payload) || !isJsonValue(spec.payload, new Set())) throw invalid("payload")
  const canonical = canonicalJson(spec.payload)
  if (Buffer.byteLength(canonical) > MAX_PAYLOAD_BYTES) throw invalid("payload")
  const inputRefs = spec.inputRefs ?? []
  if (!Array.isArray(inputRefs) || inputRefs.length > MAX_REFS || !inputRefs.every(isSafeRef)) throw invalid("inputRefs")
  const key = spec.idempotencyKey
  if (typeof key !== "string" || key.length < 1 || key.length > MAX_KEY_LENGTH) throw invalid("idempotencyKey")
  const runKey = spec.runKey ?? null
  if (runKey !== null && (typeof runKey !== "string" || runKey.length < 1 || runKey.length > MAX_KEY_LENGTH)) throw invalid("runKey")
  if (spec.createdBy !== "system" && !isSafeDocId(spec.createdBy)) throw invalid("createdBy")
  return {
    spec,
    jobId: jobIdFor(spec.firmId, spec.jobType, key),
    payloadHash: createHash("sha256").update(canonical).digest("hex"),
    inputRefs: [...inputRefs],
    runKey,
  }
}

type Identity = { payloadHash: unknown; classification: unknown; matterId: unknown }

/** The same key may be reused only for the same payload, label and matter (P3-4). */
function assertSameJob(existing: Identity, v: Validated): void {
  if (existing.payloadHash !== v.payloadHash || existing.classification !== v.spec.classification || existing.matterId !== v.spec.matterId) {
    throw new HttpError(409, "job_key_conflict")
  }
}

function newRow(v: Validated, now: number): JobRow {
  const at = Timestamp.fromMillis(now)
  const { spec } = v
  return {
    engine: JOB_ENGINE,
    schemaVersion: JOB_SCHEMA_VERSION,
    firmId: spec.firmId,
    jobType: spec.jobType,
    classification: spec.classification,
    matterId: spec.matterId,
    payload: spec.payload,
    payloadHash: v.payloadHash,
    inputRefs: v.inputRefs,
    outputRefs: [],
    idempotencyKey: spec.idempotencyKey,
    runKey: v.runKey,
    status: "queued",
    attempts: 0,
    totalAttempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    manualRetries: 0,
    nextAttemptAt: at,
    lease: null,
    dispatchSeq: 0,
    dispatchedAt: at,
    traceId: randomUUID(),
    lastError: null,
    logs: [{ at, event: "enqueued", attempt: 0 }],
    createdBy: spec.createdBy,
    requeues: [],
    cancellation: null,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    finishedAt: null,
  }
}

/**
 * Enqueues `specs` in the caller's transaction `tx`, timed from `opts.now`. Call it after the
 * transaction's last read: it reads every target, then creates the missing rows (and, for a
 * system-created job, its `job.enqueue` audit row). Call it once per transaction, with every
 * spec in one array: the Firestore SDK refuses a read after a write, so a second call that
 * follows a call that created a row fails with the SDK's read-after-write error and the
 * transaction writes nothing. The module cannot raise its own error for this, because
 * `runTransaction` re-runs its callback with the same `Transaction` object on a retry, so a
 * per-transaction "already called" mark would reject the retry of a correct caller. A row with the same key and the same
 * payload, label and matter is reused with no write; any difference is 409 `job_key_conflict`.
 */
export async function enqueueJobs(tx: Transaction, specs: readonly JobSpec[], opts: { now: number }): Promise<EnqueueResult[]> {
  const validated = specs.map(validate)
  if (validated.length === 0) return []
  const uniqueIds = [...new Set(validated.map((v) => v.jobId))]
  const snaps = await tx.getAll(...uniqueIds.map((id) => jobsRef().doc(id)))
  const known = new Map<string, Identity>()
  snaps.forEach((snap, i) => {
    if (snap.exists) known.set(uniqueIds[i], snap.data() as Identity)
  })
  const results: EnqueueResult[] = []
  for (const v of validated) {
    const existing = known.get(v.jobId)
    if (existing) {
      assertSameJob(existing, v)
      results.push({ jobId: v.jobId, reused: true })
      continue
    }
    const row = newRow(v, opts.now)
    tx.create(jobsRef().doc(v.jobId), row)
    if (row.createdBy === "system") await stageJobAudit(tx, { id: v.jobId, ...row }, "job.enqueue", "ok")
    known.set(v.jobId, row)
    results.push({ jobId: v.jobId, reused: false })
  }
  return results
}

/** `enqueueJobs` for one spec. */
export async function enqueueJob(tx: Transaction, spec: JobSpec, opts: { now: number }): Promise<EnqueueResult> {
  const [result] = await enqueueJobs(tx, [spec], opts)
  return result
}
