import { FieldPath, Timestamp, type DocumentReference, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminDb } from "../admin"
import { errorCode } from "../log"
import { JOB_ENGINE } from "../p2/constants"
import { JOB_WAIT_ALERT_MS, RESERVATION_UNRESOLVED_ALERT_MS, SAGA_AGE_ALERT_MS, opsAlertsRef, type AlertCondition, type AlertRow, type AlertSpec } from "./model"
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
 * Paging (PR #120 review, Codex P2; re-audit FA-F43-R1-004, spec R20). Each of the five queries is ordered by its time
 * field, then the document id (the quarantined reservations by `quarantinedAt`, which the reconciler stamps when it
 * quarantines, so a new quarantine sorts after the cursor instead of at a random place), and read in pages of
 * `CHECK_PAGE_SIZE`, at most `CHECK_MAX_PAGES` pages per run, starting after the cursor the previous run left in the
 * checker-state document `platform/opsAlertChecker` (server-only, like all of `platform/*`). A short page means the
 * query reached its end: the cursor is cleared, so the next run starts again from the oldest row (the wrap). A run whose
 * budget runs out mid-query keeps its cursor. The bound (spec R20): in runs that read a full window W = 500 rows per
 * query, a row present when the query's cycle begins is read within ceil(N/W) runs, and one that enters behind the
 * cursor within 2·ceil(N/W) − 1; when the budget ends runs instead, every pass still starts first at least once in
 * three runs (the rotation below) and reads at least one page of 100 then: 3·(2·ceil(N/100) − 1) runs. An alert's
 * counts (`waiting`, `inProgress`, `unresolved`) are of the rows this run read.
 *
 * Rotation (spec R20): the pass that starts a run rotates (`nextPass` in the checker-state document, saved at the start
 * of each run), so a pass the budget would leave unread behind a slow one still runs first in its turn. A pass's raises
 * may use `CHECK_RAISE_GRACE_MS` past the scan budget, so the groups it read are raised even when its scan used the
 * budget (their rows are behind the saved cursor and would otherwise wait for the wrap).
 *
 * Clearing (spec R22, re-audit FA-F43-R1-006): when a pass read every one of its queries completely in this run (from
 * no cursor to the end), each `open` alert of its condition whose firm and subject it did not observe is cleared: it
 * gets `clearedAt` and loses its deadline, so the escalator skips it. A run that read only part of a query clears
 * nothing. Observed again, the alert is counted and resumes (`stageAlert`).
 *
 * Each pass is caught on its own (`ops_alert.pass_failed`), so a query that fails (an index still building) stops only
 * its own pass.
 */

export const CHECK_PASSES = ["jobs", "sagas", "reservations"] as const
export type CheckPass = (typeof CHECK_PASSES)[number]
/** Rows per page, and pages per query per run: a window of at most 500 rows per query per run. */
export const CHECK_PAGE_SIZE = 100
export const CHECK_MAX_PAGES = 5
/** One run's wall-clock budget for its scans, inside the function's 60 s timeout. */
export const CHECKER_BUDGET_MS = 40_000
/** How far past the scan budget a pass may still raise (and clear) what it read (the sweeper's stall raises do the same). */
export const CHECK_RAISE_GRACE_MS = 5_000
/** Open alerts of one condition examined for clearing per pass, per page. */
const CLEAR_PAGE_SIZE = 100
const CLEAR_MAX_PAGES = 5

/** The checker's queries, each with its own cursor. */
export const CHECK_QUERIES = ["jobsWaiting", "jobsRunning", "sagas", "reservationsHeld", "reservationsQuarantined"] as const
export type CheckQuery = (typeof CHECK_QUERIES)[number]

/** Where a query resumes: the last row read (its time field's value and its id). */
export type CheckCursor = { at: Timestamp; id: string }

/** The checker-state document: one cursor per query (absent or null: start from the oldest row), and `nextPass`. */
export function checkerStateRef(): DocumentReference {
  return adminDb().collection("platform").doc("opsAlertChecker")
}

const millisOf = (t: unknown): number | null => (t instanceof Timestamp ? t.toMillis() : typeof t === "number" && Number.isFinite(t) ? t : null)
const at = (ms: number) => Timestamp.fromMillis(ms)

/** A stored cursor; one without a Timestamp (the id-only cursor of the quarantined query before R20) is ignored. */
function isCursor(v: unknown): v is CheckCursor {
  if (v === null || typeof v !== "object") return false
  const c = v as Record<string, unknown>
  return typeof c.id === "string" && c.id !== "" && c.at instanceof Timestamp
}

/** One query's rows this run, the cursor to save, and whether the run read the whole query (from its start to its end). */
type Scan = { docs: QueryDocumentSnapshot[]; next: CheckCursor | null; complete: boolean }

/**
 * Reads up to `CHECK_MAX_PAGES` pages of `base` ordered by `field` and the id, starting after `cursor`. Returns the
 * rows and the cursor to save: the last row read, or null once a page came back short (the end of the query: the next
 * run wraps to the start). Stops early, keeping the cursor, when the run's budget is spent.
 */
async function scan(base: Query, field: string, cursor: CheckCursor | null, spent: () => boolean): Promise<Scan> {
  const ordered = base.orderBy(field).orderBy(FieldPath.documentId())
  const docs: QueryDocumentSnapshot[] = []
  let after = cursor
  for (let page = 0; page < CHECK_MAX_PAGES; page++) {
    if (spent()) break
    let q = ordered.limit(CHECK_PAGE_SIZE)
    if (after !== null) q = q.startAfter(after.at, after.id)
    const snap = await q.get()
    docs.push(...snap.docs)
    if (snap.size < CHECK_PAGE_SIZE) return { docs, next: null, complete: cursor === null }
    const last = snap.docs[snap.size - 1]
    after = { at: last.get(field) as Timestamp, id: last.id }
  }
  return { docs, next: after, complete: false }
}

/** One run's checker state: the cursors (read once at the start, each saved as soon as its query is done). */
type Cursors = { get(q: CheckQuery): CheckCursor | null; save(q: CheckQuery, next: CheckCursor | null): Promise<void> }
type CheckerState = { cursors: Cursors; nextPass: CheckPass }

async function loadState(): Promise<CheckerState> {
  const snap = await checkerStateRef().get()
  const stored = (snap.get("cursors") ?? {}) as Record<string, unknown>
  const next: unknown = snap.get("nextPass")
  return {
    cursors: {
      get: (q) => (isCursor(stored[q]) ? stored[q] : null),
      save: async (q, cursor) => {
        await checkerStateRef().set({ cursors: { [q]: cursor }, updatedAt: Timestamp.now() }, { merge: true })
      },
    },
    nextPass: (CHECK_PASSES as readonly unknown[]).includes(next) ? (next as CheckPass) : CHECK_PASSES[0],
  }
}

/** Scans query `name` from its cursor and saves where it stopped. */
async function scanFrom(name: CheckQuery, base: Query, field: string, cursors: Cursors, spent: () => boolean): Promise<Scan> {
  const result = await scan(base, field, cursors.get(name), spent)
  await cursors.save(name, result.next)
  return result
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
/** What a pass derived: its condition, the alerts to raise, and whether it read all of its queries completely. */
type PassResult = { condition: AlertCondition; specs: AlertSpec[]; complete: boolean }

async function jobsPass({ nowMs, cursors, spent }: PassContext): Promise<PassResult> {
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
  for (const d of waiting.docs) add(d, "nextAttemptAt")
  for (const d of running.docs) add(d, "sweepAt")
  return {
    condition: "job.queue_age",
    specs: [...groups.values()].map((g) => queueAgeSpec(g.firmId, g.key, g.count, nowMs - g.oldestMs, g.oldestId)),
    complete: waiting.complete && running.complete,
  }
}

async function sagasPass({ nowMs, cursors, spent }: PassContext): Promise<PassResult> {
  const base = adminDb().collection("merge_events").where("unmerge.status", "==", "in_progress").where("unmerge.startedAt", "<=", at(nowMs - SAGA_AGE_ALERT_MS))
  const sagas = await scanFrom("sagas", base, "unmerge.startedAt", cursors, spent)
  const groups = new Map<string, Group>()
  for (const d of sagas.docs) {
    const firmId: unknown = d.get("firmId")
    const ms = millisOf(d.get("unmerge.startedAt"))
    if (isFirm(firmId) && ms !== null) tally(groups, firmId, "entity.unmerge", ms, d.id)
  }
  return { condition: "saga.age", specs: [...groups.values()].map((g) => sagaAgeSpec(g.firmId, g.count, nowMs - g.oldestMs, g.oldestId)), complete: sagas.complete }
}

async function reservationsPass({ nowMs, cursors, spent }: PassContext): Promise<PassResult> {
  const reservations = adminDb().collection("ai_reservations")
  const held = await scanFrom("reservationsHeld", reservations.where("state", "==", "reserved").where("leaseUntil", "<=", at(nowMs - RESERVATION_UNRESOLVED_ALERT_MS)), "leaseUntil", cursors, spent)
  const quarantined = await scanFrom("reservationsQuarantined", reservations.where("state", "==", "reconcile_failed"), "quarantinedAt", cursors, spent)
  const groups = new Map<string, Group>()
  for (const [docs, isQuarantined] of [[held.docs, 0], [quarantined.docs, 1]] as const) {
    for (const d of docs) {
      const firmId: unknown = d.get("firmId")
      if (!isFirm(firmId)) continue
      tally(groups, firmId, "reservations", millisOf(d.get("leaseUntil")) ?? nowMs, d.id, isQuarantined)
    }
  }
  return {
    condition: "ai.reservation_unresolved",
    specs: [...groups.values()].map((g) => reservationUnresolvedSpec(g.firmId, g.count, g.extra, nowMs - g.oldestMs, g.oldestId)),
    complete: held.complete && quarantined.complete,
  }
}

const PASSES: Readonly<Record<CheckPass, (c: PassContext) => Promise<PassResult>>> = { jobs: jobsPass, sagas: sagasPass, reservations: reservationsPass }

/**
 * Spec R22: clears every open, uncleared alert of `condition` whose firm and subject are not in `observed` (a pass
 * that read its whole query this run): `clearedAt` set, deadline removed, in a transaction that re-reads it and leaves
 * it alone if it changed or was raised at or after `nowMs`. Returns the ids cleared.
 */
async function clearUnobserved(condition: AlertCondition, observed: ReadonlySet<string>, nowMs: number, inTime: () => boolean): Promise<string[]> {
  const cleared: string[] = []
  const base = opsAlertsRef().where("condition", "==", condition).where("state", "==", "open").where("clearedAt", "==", null).orderBy(FieldPath.documentId())
  let after: string | null = null
  for (let page = 0; page < CLEAR_MAX_PAGES && inTime(); page++) {
    const snap = await (after === null ? base : base.startAfter(after)).limit(CLEAR_PAGE_SIZE).get()
    for (const doc of snap.docs) {
      if (!inTime()) return cleared
      if (observed.has(`${doc.get("firmId")}\0${doc.get("subjectKey")}`)) continue
      const done = await adminDb().runTransaction(async (tx) => {
        const row = (await tx.get(doc.ref)).data() as AlertRow | undefined
        if (!row || row.state !== "open" || row.clearedAt instanceof Timestamp) return false
        if ((millisOf(row.lastSeenAt) ?? Number.NEGATIVE_INFINITY) >= nowMs) return false
        tx.update(doc.ref, { clearedAt: at(nowMs), escalateAt: null, updatedAt: at(nowMs) })
        return true
      })
      if (done) cleared.push(doc.id)
    }
    if (snap.size < CLEAR_PAGE_SIZE) break
    after = snap.docs[snap.size - 1].id
  }
  return cleared
}

export type CheckerOptions = { now?: () => number; passes?: readonly CheckPass[]; wallClock?: () => number }

/**
 * One checker run at `now()`: each pass (from its cursors, starting at the rotated pass), then one raise per group,
 * then clearing. Returns the alert ids raised or counted, and those cleared.
 */
export async function runAlertChecker(opts: CheckerOptions = {}): Promise<{ raised: string[]; cleared: string[] }> {
  const now = opts.now ?? Date.now
  const wall = opts.wallClock ?? Date.now
  const started = wall()
  const spent = () => wall() - started >= CHECKER_BUDGET_MS
  const inGrace = () => wall() - started < CHECKER_BUDGET_MS + CHECK_RAISE_GRACE_MS
  const out = { raised: [] as string[], cleared: [] as string[] }
  let state: CheckerState
  try {
    state = await loadState()
  } catch (err) {
    logger.error("ops_alert.pass_failed", { pass: "cursors", code: errorCode(err), event: "ops_alert.pass_failed" })
    return out
  }
  const requested = opts.passes ?? CHECK_PASSES
  const start = CHECK_PASSES.indexOf(state.nextPass)
  const order = [...CHECK_PASSES.slice(start), ...CHECK_PASSES.slice(0, start)].filter((p) => requested.includes(p))
  if (order.length > 0) {
    try {
      // Saved first, so a run that dies still hands the start to the next pass.
      await checkerStateRef().set({ nextPass: CHECK_PASSES[(CHECK_PASSES.indexOf(order[0]) + 1) % CHECK_PASSES.length] }, { merge: true })
    } catch (err) {
      logger.error("ops_alert.pass_failed", { pass: "rotation", code: errorCode(err), event: "ops_alert.pass_failed" })
    }
  }
  for (const pass of order) {
    if (spent()) break
    let result: PassResult
    const nowMs = now()
    try {
      result = await PASSES[pass]({ nowMs, cursors: state.cursors, spent })
    } catch (err) {
      logger.error("ops_alert.pass_failed", { pass, code: errorCode(err), event: "ops_alert.pass_failed" })
      continue
    }
    for (const spec of result.specs) {
      if (!inGrace()) break
      const id = await raiseAlertBestEffort(spec, nowMs)
      if (id !== null) out.raised.push(id)
    }
    if (!result.complete) continue
    try {
      out.cleared.push(...(await clearUnobserved(result.condition, new Set(result.specs.map((s) => `${s.firmId}\0${s.subjectKey}`)), nowMs, inGrace)))
    } catch (err) {
      logger.error("ops_alert.pass_failed", { pass: `${pass}.clear`, code: errorCode(err), event: "ops_alert.pass_failed" })
    }
  }
  return out
}
