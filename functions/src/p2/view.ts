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
 * Who sees `job`: `none` if it is missing, not an engine row, in another firm, has an unknown
 * label or is above the caller's clearance. A firm-level job (`matterId == null`) is `full` for a
 * partner and `none` otherwise. A matter job is `full` for a member partner, associate or clerk,
 * `restricted` for a non-member partner, and `none` otherwise.
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
 * The API view of job `id`. `restricted`: `matterId` is "restricted" and `inputRefs`,
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
