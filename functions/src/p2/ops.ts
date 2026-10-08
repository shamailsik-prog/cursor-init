import { FieldPath, Timestamp, type DocumentData, type Query, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { decodeCursor, encodeCursor, parsePage, type Page } from "../d1/pagination"
import { HttpError } from "../http/errors"
import { logFailure } from "../log"
import type { Caller } from "../p5/auth"
import { isSafeDocId, type Data, type FirmOperation, type Session } from "../p5/common"
import { requirePermission } from "../p5/permission"
import { JOB_STATUSES, MAX_MANUAL_RETRIES } from "./constants"
import { runtimeDeps } from "./dispatch"
import { jobsRef, type JobActorNote, type JobRow } from "./enqueue"
import { handlerFor } from "./registry"
import { jobView, visibilityOf, type JobView, type Visibility } from "./view"
import { appendLog } from "./worker"

/**
 * The job API (spec P3-10..P3-13): GET listJobs and getJob, POST retryFailedJob and cancelJob,
 * under /api/platform/jobs. Firm-bound, rate kind general, one CallAudit row per call. P2 is CORE:
 * no layer flag. A row the caller may not see is answered as missing (404 not_found) and is left
 * out of a list, so neither route is an existence oracle across firms, matters or clearances; the
 * state codes (409) are decided only after that gate. Views come from `jobView`: never the
 * payload, its hash, the idempotency key or the lease (P3-9, P3-11).
 */

const badQuery = () => new HttpError(400, "invalid_query")
const notFound = () => new HttpError(404, "not_found")

/** The shortest requeue or cancel note after trimming (as P2-35's decision notes). */
const MIN_NOTE = 20
/** The longest note (400 note_too_long): three requeues and a cancel stay far below the 1 MiB document limit. */
const MAX_NOTE = 2000
/** Rows read per listJobs scan; a page keeps scanning until it holds `limit` visible rows. */
const SCAN_BATCH = 100

/** Test seam: a smaller listJobs scan batch, set in a test and deleted after. */
export const listJobsTestSeam: { scanBatch?: number } = {}

const nowOf = (session: Session): number => session.now ?? Date.now()
const memberRef = (matterId: string, uid: string) => adminDb().collection("matter_members").doc(`${matterId}_${uid}`)

/** The matter whose membership decides the row's visibility: a same-firm row's safe matterId, else none. */
function matterOf(caller: Caller, job: DocumentData | undefined): string | null {
  return job && job.firmId === caller.firmId && isSafeDocId(job.matterId) ? job.matterId : null
}

function parseJobId(value: unknown): string {
  if (!isSafeDocId(value)) throw badQuery()
  return value
}

/** The POST body of retryFailedJob and cancelJob: a safe `jobId` and a string note of 20 to 2000 characters after trimming. */
function parseBody(data: Data): { jobId: string; note: string } {
  const jobId = parseJobId(data.jobId)
  if (typeof data.note !== "string") throw badQuery()
  const note = data.note.trim()
  if (note.length > MAX_NOTE) throw new HttpError(400, "note_too_long")
  if (note.length < MIN_NOTE) throw new HttpError(400, "note_too_short")
  return { jobId, note }
}

/** Reads the job and the caller's membership of its matter in `tx`; answers 404 for `none` and 403 not_member for `restricted`. */
async function readVisibleTx(tx: Transaction, caller: Caller, jobId: string): Promise<JobRow> {
  const ref = jobsRef().doc(jobId)
  const job = (await tx.get(ref)).data()
  const matterId = matterOf(caller, job)
  const isMember = matterId !== null && (await tx.get(memberRef(matterId, caller.uid))).exists
  const visibility = visibilityOf(caller, job, isMember)
  if (visibility === "none") throw notFound()
  if (visibility === "restricted") throw new HttpError(403, "not_member")
  return job as JobRow
}

type ListQuery = { matterId?: string; status?: string; jobType?: string }

/** listJobs filters: each absent, or `matterId` and `jobType` safe ids and `status` one of the six; else 400 invalid_query. */
function parseListQuery(data: Data): ListQuery {
  const q: ListQuery = {}
  if (data.matterId !== undefined) {
    if (!isSafeDocId(data.matterId)) throw badQuery()
    q.matterId = data.matterId
  }
  if (data.status !== undefined) {
    if (typeof data.status !== "string" || !(JOB_STATUSES as readonly string[]).includes(data.status)) throw badQuery()
    q.status = data.status
  }
  if (data.jobType !== undefined) {
    if (!isSafeDocId(data.jobType)) throw badQuery()
    q.jobType = data.jobType
  }
  return q
}

/** The cursor's position: the last scanned row's `createdAt` ("<seconds>.<nanos>") and id. */
function parseAfter(cursor: string | null): { createdAt: Timestamp; id: string } | null {
  if (cursor === null) return null
  const { sortKey, id } = decodeCursor(cursor)
  const parts = sortKey.split(".")
  const [seconds, nanos] = parts.map(Number)
  if (parts.length !== 2 || !Number.isInteger(seconds) || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9 || !isSafeDocId(id)) {
    throw new HttpError(400, "invalid_cursor")
  }
  try {
    return { createdAt: new Timestamp(seconds, nanos), id }
  } catch {
    // Seconds outside the Timestamp range.
    throw new HttpError(400, "invalid_cursor")
  }
}

/**
 * listJobs(?matterId&status&jobType&limit&cursor) → { items, nextCursor }, newest first
 * (`createdAt` desc, then id desc). With `matterId`: `job.read` on that matter (403 cross_firm /
 * not_member / clearance), its `full` rows only. Without: the firm queue (`job.queue`, partner),
 * `full` and `restricted` rows. Rows the caller may not see (and rows that are not engine rows)
 * are skipped: the scan continues in batches until the page holds `limit` visible rows, as
 * listClients does. `nextCursor` names the last *visible* row, and only when a further visible
 * row exists, so a hidden row is never encoded in a cursor and never signals another page (no
 * existence oracle, P3-11).
 */
export const listJobsOp: FirmOperation<Page<JobView>> = {
  auth: "firm",
  kind: "general",
  action: "job.read",
  target: "jobs",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const filters = parseListQuery(data)
    const { limit, cursor } = parsePage(data)
    let after = parseAfter(cursor)
    if (filters.matterId !== undefined) {
      audit.target = `matters/${filters.matterId}`
      await requirePermission(caller, "job.read", filters.matterId)
    } else {
      await requirePermission(caller, "job.queue")
    }

    let base: Query = jobsRef().where("firmId", "==", caller.firmId)
    if (filters.matterId !== undefined) base = base.where("matterId", "==", filters.matterId)
    if (filters.status !== undefined) base = base.where("status", "==", filters.status)
    if (filters.jobType !== undefined) base = base.where("jobType", "==", filters.jobType)
    base = base.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc")
    const shown: ReadonlySet<Visibility> = new Set(filters.matterId !== undefined ? ["full"] : ["full", "restricted"])
    const batch = listJobsTestSeam.scanBatch ?? SCAN_BATCH

    const items: Array<{ id: string; createdAt: Timestamp; view: JobView }> = []
    let more = false
    for (;;) {
      const snap = await (after ? base.startAfter(after.createdAt, after.id) : base).limit(batch).get()
      const members = await membershipsOf(caller, filters.matterId, snap.docs.map((d) => d.data()))
      for (const d of snap.docs) {
        const job = d.data()
        const matterId = matterOf(caller, job)
        const visibility = visibilityOf(caller, job, matterId !== null && members.has(matterId))
        if (visibility === "none" || !shown.has(visibility) || !(job.createdAt instanceof Timestamp)) continue
        if (items.length === limit) {
          more = true
          break
        }
        items.push({ id: d.id, createdAt: job.createdAt, view: jobView(d.id, job, visibility, { logs: false }) })
      }
      if (more || snap.size < batch) break
      const last = snap.docs[snap.docs.length - 1]
      const lastAt: unknown = last.get("createdAt")
      // Only Timestamp-ordered rows can carry a page on; anything after them is not an engine row.
      if (!(lastAt instanceof Timestamp)) break
      after = { createdAt: lastAt, id: last.id }
    }

    await audit.allow()
    const last = items[items.length - 1]
    return {
      items: items.map((i) => i.view),
      nextCursor: more && last ? encodeCursor(`${last.createdAt.seconds}.${last.createdAt.nanoseconds}`, last.id) : null,
    }
  },
}

/** The matters (of `rows`) the caller is a member of. A matter list is already gated on membership of its matter. */
async function membershipsOf(caller: Caller, listedMatter: string | undefined, rows: DocumentData[]): Promise<Set<string>> {
  if (listedMatter !== undefined) return new Set([listedMatter])
  const matterIds = [...new Set(rows.map((r) => matterOf(caller, r)).filter((m): m is string => m !== null))]
  const members = new Set<string>()
  if (matterIds.length === 0) return members
  const snaps = await adminDb().getAll(...matterIds.map((m) => memberRef(m, caller.uid)))
  snaps.forEach((snap, i) => {
    if (snap.exists) members.add(matterIds[i])
  })
  return members
}

/** getJob(?jobId) → the job's view with its logs (`job.read`); a row the caller may not see is 404 not_found. */
export const getJobOp: FirmOperation<JobView> = {
  auth: "firm",
  kind: "general",
  action: "job.read",
  target: "jobs",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const jobId = parseJobId(data.jobId)
    audit.target = `jobs/${jobId}`
    await requirePermission(caller, "job.read")
    const job = (await jobsRef().doc(jobId).get()).data()
    const matterId = matterOf(caller, job)
    const isMember = matterId !== null && (await memberRef(matterId, caller.uid).get()).exists
    const visibility = visibilityOf(caller, job, isMember)
    if (visibility === "none" || !job) throw notFound()
    await audit.allow()
    return jobView(jobId, job, visibility, { logs: true })
  },
}

/**
 * retryFailedJob({ jobId, note }) → the job's view (P3-12). `job.retry` (partner, associate); a
 * saga type, or one no longer registered, needs a partner. Only a dead-lettered job with fewer
 * than 3 manual retries is requeued: `queued`, `attempts` 0, `manualRetries + 1`, due now, with a
 * new dispatch seq; `lastError` is kept until the next attempt ends. Dispatched after commit; a
 * dispatch failure is logged and left to the sweeper.
 */
export const retryFailedJobOp: FirmOperation<JobView> = {
  auth: "firm",
  kind: "general",
  action: "job.retry",
  target: "jobs",
  run: async (session, data, audit) => {
    const { caller } = session
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "job.retry")
    const { jobId, note } = parseBody(data)
    audit.target = `jobs/${jobId}`
    const now = nowOf(session)

    const { view, seq } = await adminDb().runTransaction(async (tx) => {
      const job = await readVisibleTx(tx, caller, jobId)
      const handler = handlerFor(job.jobType)
      if ((handler === undefined || handler.saga) && caller.role !== "partner") throw new HttpError(403, "role_not_permitted")
      if (job.status !== "dead_lettered") throw new HttpError(409, "job_not_dead_lettered")
      if (!(job.manualRetries < MAX_MANUAL_RETRIES)) throw new HttpError(409, "retry_limit_reached")

      const at = Timestamp.fromMillis(now)
      const requeue: JobActorNote = { by: caller.uid, role: caller.role, at, note }
      const update = {
        status: "queued" as const,
        attempts: 0,
        manualRetries: job.manualRetries + 1,
        nextAttemptAt: at,
        dispatchSeq: job.dispatchSeq + 1,
        dispatchedAt: at,
        updatedAt: at,
        finishedAt: null,
        requeues: [...(Array.isArray(job.requeues) ? job.requeues : []), requeue],
        logs: appendLog(job, "requeued", 0, now),
      }
      await audit.stage(tx, "allow", "ok")
      tx.update(jobsRef().doc(jobId), update)
      return { view: jobView(jobId, { ...job, ...update }, "full", { logs: true }), seq: update.dispatchSeq }
    })
    audit.committed()
    try {
      await runtimeDeps().dispatcher.dispatch({ jobId, seq })
    } catch (err) {
      logFailure("job dispatch failed", err)
    }
    return view
  },
}

const CANCELLABLE: ReadonlySet<string> = new Set(["queued", "failed", "dead_lettered"])

/**
 * cancelJob({ jobId, note }) → the job's view (P3-13). `job.cancel` (partner). A saga or
 * unregistered type is never cancelled (409 job_not_cancellable); a running job is 409
 * job_running (cooperative cancel is O-31); done or cancelled is 409 job_finished. A task that
 * arrives later finds `cancelled` and is dropped; a cancel and a claim serialise on the job doc.
 */
export const cancelJobOp: FirmOperation<JobView> = {
  auth: "firm",
  kind: "general",
  action: "job.cancel",
  target: "jobs",
  run: async (session, data, audit) => {
    const { caller } = session
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "job.cancel")
    const { jobId, note } = parseBody(data)
    audit.target = `jobs/${jobId}`
    const now = nowOf(session)

    const view = await adminDb().runTransaction(async (tx) => {
      const job = await readVisibleTx(tx, caller, jobId)
      const handler = handlerFor(job.jobType)
      if (handler === undefined || handler.saga) throw new HttpError(409, "job_not_cancellable")
      if (job.status === "running") throw new HttpError(409, "job_running")
      if (!CANCELLABLE.has(job.status)) throw new HttpError(409, "job_finished")

      const at = Timestamp.fromMillis(now)
      const cancellation: JobActorNote = { by: caller.uid, role: caller.role, at, note }
      const update = {
        status: "cancelled" as const,
        cancellation,
        lease: null,
        nextAttemptAt: null,
        finishedAt: at,
        updatedAt: at,
        logs: appendLog(job, "cancelled", typeof job.attempts === "number" ? job.attempts : 0, now),
      }
      await audit.stage(tx, "allow", "ok")
      tx.update(jobsRef().doc(jobId), update)
      return jobView(jobId, { ...job, ...update }, "full", { logs: true })
    })
    audit.committed()
    return view
  },
}
