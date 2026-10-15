import type { DocumentData } from "firebase-admin/firestore"
import type { Caller } from "../p5/auth"
import { isKnownClassification, rankOf } from "../p5/classification"
import { JOB_ENGINE, MAX_MANUAL_RETRIES } from "./constants"
import { handlerFor } from "./registry"

/**
 * Job row visibility and the API's job view (spec P3-11). Pure.
 *
 * A view never carries `payload`, `payloadHash`, `idempotencyKey` or `lease`: a payload value can
 * be read only by whoever could read its source, and job rows are read more widely (P3-9). Error
 * text in `lastError` is already sanitised (`sanitizeError`); only its code and fixed message are copied.
 */

export type Visibility = "none" | "restricted" | "full"

const MATTER_STAFF: ReadonlySet<string> = new Set(["partner", "associate", "clerk"])

/**
 * A job's matter as the job routes read it on this call (audit F14): its firm and its current label. `null` when the
 * job names a matter that could not be read (missing, or an id the routes do not read).
 */
export type MatterNow = { firmId: unknown; classification: unknown } | null

/**
 * The job row as its visibility and its view judge it now (audit F14). A matter job takes its effective label: the
 * stricter of the label it was enqueued with and its matter's current label, so a matter raised after the job was
 * enqueued binds the job too (labels never fall, L17.3 #20). A matter job whose matter is missing, in another firm,
 * or carries an unknown label, or whose own label is unknown, is `undefined`: no one sees it (fail closed). A
 * firm-level job (`matterId` null or absent) is returned unchanged. The stored row is never rewritten: its label is
 * part of the job's enqueue identity (P3-4).
 */
export function atMatterLabel(job: DocumentData | undefined, matter: MatterNow): DocumentData | undefined {
  if (!job) return undefined
  if (job.matterId === null || job.matterId === undefined) return job
  if (!matter || matter.firmId !== job.firmId) return undefined
  if (!isKnownClassification(job.classification) || !isKnownClassification(matter.classification)) return undefined
  if (rankOf(matter.classification) <= rankOf(job.classification)) return job
  return { ...job, classification: matter.classification }
}

/**
 * Who sees `job` (the row as `atMatterLabel` returns it, so a matter job's label is its effective one): `none` if it
 * is missing, not an engine row, in another firm, has an unknown label or is above the caller's clearance. A
 * firm-level job (`matterId == null`) is `full` for a partner and `none` otherwise. A matter job is `full` for a member
 * partner, associate or clerk, `restricted` for a non-member partner, and `none` otherwise.
 */
export function visibilityOf(caller: Caller, job: DocumentData | undefined, isMember: boolean): Visibility {
  if (!job || job.engine !== JOB_ENGINE || job.firmId !== caller.firmId) return "none"
  if (!isKnownClassification(job.classification) || !isKnownClassification(caller.clearanceLevel)) return "none"
  if (rankOf(caller.clearanceLevel) < rankOf(job.classification)) return "none"
  if (job.matterId === null || job.matterId === undefined) return caller.role === "partner" ? "full" : "none"
  if (isMember && MATTER_STAFF.has(caller.role)) return "full"
  return caller.role === "partner" ? "restricted" : "none"
}

export type JobLogView = { at: string | null; event: string; attempt: number; code?: string }

export type JobView = {
  jobId: string
  jobType: string
  status: string
  matterId: string | null
  classification: string
  attempts: number
  maxAttempts: number
  totalAttempts: number
  manualRetries: number
  maxManualRetries: number
  nextAttemptAt: string | null
  createdAt: string | null
  updatedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  createdBy: string
  traceId: string
  runKey: string | null
  lastError: { code: string; message: string } | null
  retryable: boolean
  cancellable: boolean
  inputRefs?: string[]
  outputRefs?: string[]
  logs?: JobLogView[]
}

const CANCELLABLE: ReadonlySet<string> = new Set(["queued", "failed", "dead_lettered"])

/** A Firestore Timestamp (or anything with `toMillis`) as an ISO string; anything else is null. */
function iso(value: unknown): string | null {
  if (value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return new Date((value as { toMillis(): number }).toMillis()).toISOString()
  }
  return null
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0)
const str = (value: unknown): string => (typeof value === "string" ? value : "")
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [])

function lastErrorOf(value: unknown): { code: string; message: string } | null {
  if (!value || typeof value !== "object") return null
  const { code, message } = value as Record<string, unknown>
  return { code: str(code), message: str(message) }
}

function logsOf(value: unknown): JobLogView[] {
  if (!Array.isArray(value)) return []
  return value.map((entry: Record<string, unknown>) => {
    const log: JobLogView = { at: iso(entry?.at), event: str(entry?.event), attempt: num(entry?.attempt) }
    if (typeof entry?.code === "string") log.code = entry.code
    return log
  })
}

/**
 * The API view of job `id` (the row as `atMatterLabel` returns it, so `classification` is the effective label). `restricted`: `matterId` is "restricted" and `inputRefs`,
 * `outputRefs` and `logs` are left out. `full` adds the refs, and the logs when `opts.logs`
 * (getJob only). `retryable` and `cancellable` say what retryFailedJob and cancelJob would allow
 * by state and type (the caller's role is still checked there).
 */
export function jobView(id: string, job: DocumentData, visibility: "full" | "restricted", opts: { logs: boolean }): JobView {
  const status = str(job.status)
  const manualRetries = num(job.manualRetries)
  const handler = handlerFor(str(job.jobType))
  const view: JobView = {
    jobId: id,
    jobType: str(job.jobType),
    status,
    matterId: visibility === "restricted" ? "restricted" : typeof job.matterId === "string" ? job.matterId : null,
    classification: str(job.classification),
    attempts: num(job.attempts),
    maxAttempts: num(job.maxAttempts),
    totalAttempts: num(job.totalAttempts),
    manualRetries,
    maxManualRetries: MAX_MANUAL_RETRIES,
    nextAttemptAt: iso(job.nextAttemptAt),
    createdAt: iso(job.createdAt),
    updatedAt: iso(job.updatedAt),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
    createdBy: str(job.createdBy),
    traceId: str(job.traceId),
    runKey: typeof job.runKey === "string" ? job.runKey : null,
    lastError: lastErrorOf(job.lastError),
    retryable: status === "dead_lettered" && manualRetries < MAX_MANUAL_RETRIES,
    cancellable: CANCELLABLE.has(status) && handler?.saga === false,
  }
  if (visibility === "full") {
    view.inputRefs = strings(job.inputRefs)
    view.outputRefs = strings(job.outputRefs)
    if (opts.logs) view.logs = logsOf(job.logs)
  }
  return view
}
