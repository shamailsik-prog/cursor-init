import { FieldPath, Timestamp, type DocumentData, type DocumentSnapshot, type Query, type Transaction } from "firebase-admin/firestore"
import { decide } from "@/platform/p5/permissionDecision"
import { adminDb } from "../admin"
import { decodeCursor, encodeCursor, parsePage, type Page } from "../d1/pagination"
import { HttpError } from "../http/errors"
import { logFailure } from "../log"
import type { Caller } from "../p5/auth"
import { isSafeDocId, type Data, type FirmOperation, type Session } from "../p5/common"
import { requirePermission } from "../p5/permission"
import { DISPATCH_GRACE_MS, JOB_ENGINE, JOB_STATUSES, MAX_MANUAL_RETRIES } from "./constants"
import { runtimeDeps } from "./dispatch"
import { jobsRef, stageJobUpdate, type JobActorNote, type JobRow } from "./enqueue"
import { legacyJobIdFromEngine, OCR_JOB_TYPE } from "./ocrJob"
import { handlerFor } from "./registry"
import { atMatterLabel, jobView, visibilityOf, type JobView, type MatterNow, type Visibility } from "./view"
import { appendLog } from "./worker"

/**
 * The job API (spec P3-10..P3-13): GET listJobs and getJob, POST retryFailedJob and cancelJob,
 * under /api/platform/jobs. Firm-bound, rate kind general, one CallAudit row per call. P2 is CORE:
 * no layer flag. A row the caller may not see is answered as missing (404 not_found) and is left
 * out of a list, so neither route is an existence oracle across firms, matters or clearances; the
 * state codes (409) are decided only after that gate. Views come from `jobView`: never the
 * payload, its hash, the idempotency key or the lease (P3-9, P3-11).
 *
 * Audit F14: every route judges a matter job as it stands now (`judge`): its matter and the
 * caller's membership are read on the call (in the transaction for retry and cancel), the job
 * takes its effective label (`atMatterLabel`: the stricter of its own and its matter's current
 * label), and a full view is also `job.read` on the matter decided by the shared table. A matter
 * raised above the caller's clearance after the job was enqueued therefore hides the job (404 /
 * left out of a list) and refuses retry and cancel; every view shows the effective label.
 */

const badQuery = () => new HttpError(400, "invalid_query")
const notFound = () => new HttpError(404, "not_found")

/** The shortest requeue or cancel note after trimming (as P2-35's decision notes). */
const MIN_NOTE = 20
/** The longest note (400 note_too_long): three requeues and a cancel stay far below the 1 MiB document limit. */
const MAX_NOTE = 2000
/** Rows read per listJobs scan; a page keeps scanning until it holds `limit` visible rows. */
const SCAN_BATCH = 100

/**
 * Test seams, set in a test and deleted after: a smaller listJobs scan batch, and a hook awaited between two scan
 * batches (after one is judged, before the next is read), where a test changes what the next batch is judged against.
 */
export const listJobsTestSeam: { scanBatch?: number; betweenBatches?: () => Promise<void> } = {}

const nowOf = (session: Session): number => session.now ?? Date.now()
const memberRef = (matterId: string, uid: string) => adminDb().collection("matter_members").doc(`${matterId}_${uid}`)
const matterRef = (matterId: string) => adminDb().collection("matters").doc(matterId)

/** The matter whose label and membership decide the row's visibility: a same-firm row's safe matterId, else none. */
function matterOf(caller: Caller, job: DocumentData | undefined): string | null {
  return job && job.firmId === caller.firmId && isSafeDocId(job.matterId) ? job.matterId : null
}

/** A matter snapshot as `judge` reads it: its firm and current label, or null when it does not exist. */
function matterNow(snap: DocumentSnapshot): MatterNow {
  const data = snap.data()
  return data ? { firmId: data.firmId, classification: data.classification } : null
}

type Judged = { visibility: "none" } | { visibility: "full" | "restricted"; row: DocumentData }
const HIDDEN: Judged = { visibility: "none" }

/**
 * What the caller may see of `job` now (audit F14), given its matter (`matter`, as read on this call; null when the
 * job names none, or names one that could not be read) and the caller's membership of it (`isMember`, read on this
 * call). The row is judged at its effective label (`atMatterLabel`), so a matter job whose matter is unreadable or
 * above the caller's clearance is `none`; a firm-level job keeps its rule (partner only, cleared for its label). A
 * matter job's full view is also `job.read` on its matter as the shared table decides it now (same firm, member,
 * cleared, role; R-2), so the P2 rule never grants more than the table. `row` carries the effective label, for the view.
 */
function judge(caller: Caller, job: DocumentData | undefined, matter: MatterNow, isMember: boolean): Judged {
  const row = atMatterLabel(job, matter)
  const visibility = visibilityOf(caller, row, isMember)
  if (visibility === "none" || !row) return HIDDEN
  if (visibility === "full" && row.matterId !== null && row.matterId !== undefined) {
    if (!matter || !decide(caller, "job.read", { firmId: matter.firmId as string, classification: matter.classification }, isMember).allow) return HIDDEN
  }
  return { visibility, row }
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

/**
 * Reads the job, its matter and the caller's membership of it in `tx`, so the decision is made again on what the
 * transaction commits against (a label raised or a member removed since the call began is judged, and a change while
 * it runs retries it; audit F14). Answers 404 for `none` and 403 not_member for `restricted`; returns the row at its
 * effective label.
 */
async function readVisibleTx(tx: Transaction, caller: Caller, jobId: string): Promise<JobRow> {
  const ref = jobsRef().doc(jobId)
  const job = (await tx.get(ref)).data()
  const matterId = matterOf(caller, job)
  const [matterSnap, memberSnap] = matterId === null ? [] : await tx.getAll(matterRef(matterId), memberRef(matterId, caller.uid))
  const judged = judge(caller, job, matterSnap ? matterNow(matterSnap) : null, memberSnap?.exists === true)
  if (judged.visibility === "none") throw notFound()
  if (judged.visibility === "restricted") throw new HttpError(403, "not_member")
  return judged.row as JobRow
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
 * `full` and `restricted` rows. Each batch reads the current label of every matter its rows name
 * and the caller's membership of each, for a matter list as for the firm queue (Copilot C5), so a
 * row is judged at its effective label and the membership as it stands when its batch is read
 * (audit F14): one above the caller's clearance, whose matter is unreadable, or whose matter the
 * caller has left since the call began, is hidden.
 * Rows the caller may not see (and rows that are not engine rows)
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
      const current = await mattersNow(caller, snap.docs.map((d) => d.data()))
      for (const d of snap.docs) {
        const job = d.data()
        const matterId = matterOf(caller, job)
        const judged = matterId === null ? judge(caller, job, null, false) : judge(caller, job, current.matters.get(matterId) ?? null, current.members.has(matterId))
        if (judged.visibility === "none" || !shown.has(judged.visibility) || !(job.createdAt instanceof Timestamp)) continue
        if (items.length === limit) {
          more = true
          break
        }
        items.push({ id: d.id, createdAt: job.createdAt, view: jobView(d.id, judged.row, judged.visibility, { logs: false }) })
      }
      if (more || snap.size < batch) break
      const last = snap.docs[snap.docs.length - 1]
      const lastAt: unknown = last.get("createdAt")
      // Only Timestamp-ordered rows can carry a page on; anything after them is not an engine row.
      if (!(lastAt instanceof Timestamp)) break
      after = { createdAt: lastAt, id: last.id }
      await listJobsTestSeam.betweenBatches?.()
    }

    await audit.allow()
    const last = items[items.length - 1]
    return {
      items: items.map((i) => i.view),
      nextCursor: more && last ? encodeCursor(`${last.createdAt.seconds}.${last.createdAt.nanoseconds}`, last.id) : null,
    }
  },
}

/**
 * The matters `rows` name, as they stand now (audit F14): each one's current label (`matters`) and the ones the caller
 * is a member of (`members`), read together in one `getAll` for every scan batch. A matter list reads its matter and
 * the caller's membership again on each batch too (Copilot C5): the gate at the start of the call is not carried over,
 * so a member removed while the scan runs sees no row from a later batch.
 */
async function mattersNow(caller: Caller, rows: DocumentData[]): Promise<{ matters: Map<string, MatterNow>; members: Set<string> }> {
  const matters = new Map<string, MatterNow>()
  const members = new Set<string>()
  const matterIds = [...new Set(rows.map((r) => matterOf(caller, r)).filter((m): m is string => m !== null))]
  if (matterIds.length === 0) return { matters, members }
  const snaps = await adminDb().getAll(...matterIds.flatMap((m) => [matterRef(m), memberRef(m, caller.uid)]))
  matterIds.forEach((m, i) => {
    matters.set(m, matterNow(snaps[2 * i]))
    if (snaps[2 * i + 1].exists) members.add(m)
  })
  return { matters, members }
}

/**
 * getJob(?jobId) → the job's view with its logs (`job.read`); a row the caller may not see is 404 not_found. The job's
 * matter and the caller's membership are read on the call and the row is judged at its effective label (audit F14).
 */
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
    const [matterSnap, memberSnap] = matterId === null ? [] : await adminDb().getAll(matterRef(matterId), memberRef(matterId, caller.uid))
    const judged = judge(caller, job, matterSnap ? matterNow(matterSnap) : null, memberSnap?.exists === true)
    if (judged.visibility === "none") throw notFound()
    await audit.allow()
    return jobView(jobId, judged.row, judged.visibility, { logs: true })
  },
}

/**
 * retryFailedJob({ jobId, note }) → the job's view (P3-12). `job.retry` (partner, associate); a
 * saga type, or one no longer registered, needs a partner. Only a dead-lettered job with fewer
 * than 3 manual retries is requeued: `queued`, `attempts` 0, `manualRetries + 1`, due now, with a
 * new dispatch seq, `sweepAt` one dispatch grace on and `redispatches` 0 (P3-34, P3-35);
 * `lastError` is kept until the next attempt ends. Dispatched after commit; a dispatch failure is
 * logged and left to the sweeper.
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
        // The sweeper may re-dispatch once the grace has passed, with a fresh backoff (P3-34, P3-35).
        sweepAt: Timestamp.fromMillis(now + DISPATCH_GRACE_MS),
        redispatches: 0,
        updatedAt: at,
        finishedAt: null,
        requeues: [...(Array.isArray(job.requeues) ? job.requeues : []), requeue],
        logs: appendLog(job, "requeued", 0, now),
      }
      await audit.stage(tx, "allow", "ok")
      stageJobUpdate(tx, jobsRef().doc(jobId), update)
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
        sweepAt: null,
        finishedAt: at,
        updatedAt: at,
        logs: appendLog(job, "cancelled", typeof job.attempts === "number" ? job.attempts : 0, now),
      }
      await audit.stage(tx, "allow", "ok")
      stageJobUpdate(tx, jobsRef().doc(jobId), update)
      const legacyId = job.jobType === OCR_JOB_TYPE ? legacyJobIdFromEngine(job) : undefined
      if (legacyId !== undefined) {
        const legacyRef = jobsRef().doc(legacyId)
        const legacySnap = await tx.get(legacyRef)
        const legacy = legacySnap.data()
        if (
          legacySnap.exists &&
          legacy?.firmId === caller.firmId &&
          legacy.engine !== JOB_ENGINE &&
          legacy.ocrStatus !== "done"
        ) {
          tx.update(legacyRef, { ocrStatus: "failed", ocrFailureCode: "cancelled" })
        }
      }
      return jobView(jobId, { ...job, ...update }, "full", { logs: true })
    })
    audit.committed()
    return view
  },
}
