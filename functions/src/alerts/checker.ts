import { FieldPath, Timestamp, type DocumentReference, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminDb } from "../admin"
import { errorCode } from "../log"
import { JOB_ENGINE } from "../p2/constants"
import { JOB_WAIT_ALERT_MS, RESERVATION_UNRESOLVED_ALERT_MS, SAGA_AGE_ALERT_MS, type AlertSpec } from "./model"
import { raiseAlertBestEffort } from "./raise"
import { queueAgeSpec, reservationUnresolvedSpec, sagaAgeSpec } from "./specs"

/**
 * The checker (audit F43, spec R8, R10), run every five minutes by `alertChecker`. It derives the conditions that have
 * no single transaction of their own from the rows' durable state and raises one alert per firm and subject (each in
 * its own transaction; a raise that fails is logged `ops_alert.raise_failed` and derived again on a later run):
 *
 * - `jobs`: engine jobs `queued` or `failed` and due `JOB_WAIT_ALERT_MS` ago or more, and `running` jobs whose lease
 *   expired that long ago (the sweeper has not recovered them) → `job.queue_age` per firm and job type.
 * - `sagas`: `merge_events` whose un-merge has been `in_progress` for `SAGA_AGE_ALERT_MS` or more → `saga.age` per firm.
 * - `reservations`: P1 reservations still `reserved` `RESERVATION_UNRESOLVED_ALERT_MS` or more past their lease, and
 *   every quarantined one (`reconcile_failed`) → `ai.reservation_unresolved` per firm.
 *
 * Paging (PR #120 review, Codex P2). Each of the five queries is ordered (by its time field, then the document id; the
 * quarantined query by the id alone) and read in pages of `CHECK_PAGE_SIZE`, at most `CHECK_MAX_PAGES` pages per run,
 * starting after the cursor the previous run left in the checker-state document `platform/opsAlertChecker`
 * (server-only, like all of `platform/*`). A short page means the query reached its end: the cursor is cleared, so the
 * next run starts again from the oldest row (the wrap). So during a persistent backlog every row is read within
 * ceil(backlog / window) runs, and an incident behind another (another firm's among them) is reported, instead of the
 * same first rows coming back every run. An alert's counts (`waiting`, `inProgress`, `unresolved`) are of the rows this
 * run read. The cursor is saved after each query; a run that fails or overlaps another costs at most a window re-read.
 *
 * Each pass is caught on its own (`ops_alert.pass_failed`), so a query that fails (an index still building) stops only
 * its own pass.
 */

export const CHECK_PASSES = ["jobs", "sagas", "reservations"] as const
export type CheckPass = (typeof CHECK_PASSES)[number]
/** Rows per page, and pages per query per run: a window of at most 500 rows per query per run. */
export const CHECK_PAGE_SIZE = 100
export const CHECK_MAX_PAGES = 5
/** One run's wall-clock budget, inside the function's 60 s timeout. */
export const CHECKER_BUDGET_MS = 40_000

/** The checker's queries, each with its own cursor. */
export const CHECK_QUERIES = ["jobsWaiting", "jobsRunning", "sagas", "reservationsHeld", "reservationsQuarantined"] as const
export type CheckQuery = (typeof CHECK_QUERIES)[number]

/** Where a query resumes: the last row read (its time field's value, null for an id-ordered query, and its id). */
export type CheckCursor = { at: Timestamp | null; id: string }

/** The checker-state document: one cursor per query (absent or null: start from the oldest row). */
export function checkerStateRef(): DocumentReference {
  return adminDb().collection("platform").doc("opsAlertChecker")
}

const millisOf = (t: unknown): number | null => (t instanceof Timestamp ? t.toMillis() : typeof t === "number" && Number.isFinite(t) ? t : null)
const at = (ms: number) => Timestamp.fromMillis(ms)

function isCursor(v: unknown): v is CheckCursor {
  if (v === null || typeof v !== "object") return false
  const c = v as Record<string, unknown>
  return typeof c.id === "string" && c.id !== "" && (c.at === null || c.at instanceof Timestamp)
}

type Scan = { docs: QueryDocumentSnapshot[]; next: CheckCursor | null }

/**
 * Reads up to `CHECK_MAX_PAGES` pages of `base` ordered by `field` (null: by document id alone) and the id, starting
 * after `cursor`. Returns the rows and the cursor to save: the last row read, or null once a page came back short (the
 * end of the query: the next run wraps to the start). Stops early, keeping the cursor, when the run's budget is spent.
 */
async function scan(base: Query, field: string | null, cursor: CheckCursor | null, spent: () => boolean): Promise<Scan> {
  const ordered = field === null ? base.orderBy(FieldPath.documentId()) : base.orderBy(field).orderBy(FieldPath.documentId())
  const docs: QueryDocumentSnapshot[] = []
  let after = cursor
  for (let page = 0; page < CHECK_MAX_PAGES; page++) {
    if (spent()) break
    let q = ordered.limit(CHECK_PAGE_SIZE)
    if (after !== null) q = field === null ? q.startAfter(after.id) : q.startAfter(after.at, after.id)
    const snap = await q.get()
    docs.push(...snap.docs)
    if (snap.size < CHECK_PAGE_SIZE) return { docs, next: null }
    const last = snap.docs[snap.size - 1]
    after = { at: field === null ? null : (last.get(field) as Timestamp), id: last.id }
  }
  return { docs, next: after }
}

/** One run's cursors: read once at the start, each saved as soon as its query is done. */
type Cursors = { get(q: CheckQuery): CheckCursor | null; save(q: CheckQuery, next: CheckCursor | null): Promise<void> }

async function loadCursors(): Promise<Cursors> {
  const stored = ((await checkerStateRef().get()).get("cursors") ?? {}) as Record<string, unknown>
  return {
    get: (q) => (isCursor(stored[q]) ? stored[q] : null),
    save: async (q, next) => {
      await checkerStateRef().set({ cursors: { [q]: next }, updatedAt: Timestamp.now() }, { merge: true })
    },
  }
}

/** Scans query `name` from its cursor and saves where it stopped. */
async function scanFrom(name: CheckQuery, base: Query, field: string | null, cursors: Cursors, spent: () => boolean): Promise<QueryDocumentSnapshot[]> {
  const { docs, next } = await scan(base, field, cursors.get(name), spent)
  await cursors.save(name, next)
  return docs
}

type Group = { firmId: string; key: string; count: number; extra: number; oldestMs: number; oldestId: string }

/** Adds a row to its firm-and-key group, keeping the oldest. */
function tally(groups: Map<string, Group>, firmId: string, key: string, ms: number, id: string, extra = 0): void {
  const k = `${firmId}\0${key}`
  const g = groups.get(k)
  if (!g) {
    groups.set(k, { firmId, key, count: 1, extra, oldestMs: ms, oldestId: id })
    return
  }
  g.count += 1
  g.extra += extra
  if (ms < g.oldestMs) {
    g.oldestMs = ms
    g.oldestId = id
  }
}

const isFirm = (v: unknown): v is string => typeof v === "string" && v !== "" && !v.includes("/") && v.length <= 128

type PassContext = { nowMs: number; cursors: Cursors; spent: () => boolean }

async function jobsPass({ nowMs, cursors, spent }: PassContext): Promise<AlertSpec[]> {
  const cutoff = at(nowMs - JOB_WAIT_ALERT_MS)
  const jobs = adminDb().collection("jobs")
  const waiting = await scanFrom("jobsWaiting", jobs.where("status", "in", ["queued", "failed"]).where("nextAttemptAt", "<=", cutoff), "nextAttemptAt", cursors, spent)
  const running = await scanFrom("jobsRunning", jobs.where("status", "==", "running").where("sweepAt", "<=", cutoff), "sweepAt", cursors, spent)
  const groups = new Map<string, Group>()
  const add = (d: QueryDocumentSnapshot, field: string) => {
    const row = d.data()
    const ms = millisOf(row[field])
    if (row.engine !== JOB_ENGINE || !isFirm(row.firmId) || typeof row.jobType !== "string" || ms === null) return
    tally(groups, row.firmId, row.jobType, ms, d.id)
  }
  for (const d of waiting) add(d, "nextAttemptAt")
  for (const d of running) add(d, "sweepAt")
  return [...groups.values()].map((g) => queueAgeSpec(g.firmId, g.key, g.count, nowMs - g.oldestMs, g.oldestId))
}

async function sagasPass({ nowMs, cursors, spent }: PassContext): Promise<AlertSpec[]> {
  const base = adminDb().collection("merge_events").where("unmerge.status", "==", "in_progress").where("unmerge.startedAt", "<=", at(nowMs - SAGA_AGE_ALERT_MS))
  const docs = await scanFrom("sagas", base, "unmerge.startedAt", cursors, spent)
  const groups = new Map<string, Group>()
  for (const d of docs) {
    const firmId: unknown = d.get("firmId")
    const ms = millisOf(d.get("unmerge.startedAt"))
    if (isFirm(firmId) && ms !== null) tally(groups, firmId, "entity.unmerge", ms, d.id)
  }
  return [...groups.values()].map((g) => sagaAgeSpec(g.firmId, g.count, nowMs - g.oldestMs, g.oldestId))
}

async function reservationsPass({ nowMs, cursors, spent }: PassContext): Promise<AlertSpec[]> {
  const reservations = adminDb().collection("ai_reservations")
  const held = await scanFrom("reservationsHeld", reservations.where("state", "==", "reserved").where("leaseUntil", "<=", at(nowMs - RESERVATION_UNRESOLVED_ALERT_MS)), "leaseUntil", cursors, spent)
  const quarantined = await scanFrom("reservationsQuarantined", reservations.where("state", "==", "reconcile_failed"), null, cursors, spent)
  const groups = new Map<string, Group>()
  for (const [docs, isQuarantined] of [[held, 0], [quarantined, 1]] as const) {
    for (const d of docs) {
      const firmId: unknown = d.get("firmId")
      if (!isFirm(firmId)) continue
      tally(groups, firmId, "reservations", millisOf(d.get("leaseUntil")) ?? nowMs, d.id, isQuarantined)
    }
  }
  return [...groups.values()].map((g) => reservationUnresolvedSpec(g.firmId, g.count, g.extra, nowMs - g.oldestMs, g.oldestId))
}

const PASSES: Readonly<Record<CheckPass, (c: PassContext) => Promise<AlertSpec[]>>> = { jobs: jobsPass, sagas: sagasPass, reservations: reservationsPass }

export type CheckerOptions = { now?: () => number; passes?: readonly CheckPass[]; wallClock?: () => number }

/** One checker run at `now()`: each pass (from its cursors), then one raise per group. Returns the alert ids raised or counted. */
export async function runAlertChecker(opts: CheckerOptions = {}): Promise<{ raised: string[] }> {
  const now = opts.now ?? Date.now
  const wall = opts.wallClock ?? Date.now
  const started = wall()
  const spent = () => wall() - started >= CHECKER_BUDGET_MS
  const raised: string[] = []
  let cursors: Cursors
  try {
    cursors = await loadCursors()
  } catch (err) {
    logger.error("ops_alert.pass_failed", { pass: "cursors", code: errorCode(err) })
    return { raised }
  }
  for (const pass of opts.passes ?? CHECK_PASSES) {
    if (spent()) break
    let specs: AlertSpec[]
    const nowMs = now()
    try {
      specs = await PASSES[pass]({ nowMs, cursors, spent })
    } catch (err) {
      logger.error("ops_alert.pass_failed", { pass, code: errorCode(err) })
      continue
    }
    for (const spec of specs) {
      if (spent()) break
      const id = await raiseAlertBestEffort(spec, nowMs)
      if (id !== null) raised.push(id)
    }
  }
  return { raised }
}
