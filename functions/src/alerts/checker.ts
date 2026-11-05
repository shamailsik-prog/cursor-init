import { FieldPath, Timestamp, type DocumentReference, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { errorCode, logRegisteredError } from "../log"
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
 * Paging (PR #120 review, Codex P2; FA-F43-R1-004). Each of the five queries is ordered by its time field, then the
 * document id, and read in pages of `CHECK_PAGE_SIZE`, at most `CHECK_MAX_PAGES` pages per run, starting after the
 * cursor the previous run left in `platform/opsAlertChecker` (server-only, like all of `platform/*`). Quarantined
 * reservations order by `leaseUntil` (the durable time the gateway writes and quarantine keeps; no new field), not by
 * document id. A row with no `leaseUntil` is outside that index; `createdAt` is the documented creation time and is not
 * a second query. A short page means the query reached its end: the cursor is cleared, so the next run starts again
 * from the oldest row (the wrap). An id-only cursor (`at: null`) cannot resume a time order and is ignored once.
 *
 * Passes rotate (`passIndex` on the same document): run N starts at `CHECK_PASSES[N mod 3]`. A jobs pass that spends
 * `CHECKER_BUDGET_MS` therefore cannot skip sagas and reservations on every run. When the budget covers all three
 * passes, a backlog row is still read within ceil(N / 500) runs. That figure alone overstated a budget that fits only
 * the leading pass: rotation then reads a row within 3·ceil(N / 500) runs. For two passes the leading pass's last
 * window is the 2·ceil(N / 500)−1 run; it is not a bound for the pass that was last. Counts are of the rows this run
 * read. The cursor is saved after each query; a run that fails or overlaps another costs at most a window re-read.
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

/** One page row, as the test seam returns it. Production never sets the seam. */
export type CheckerPageRow = { id: string; data: Record<string, unknown> }

/** In-memory checker state used only when `readPage` is set (no Firestore). */
export type CheckerMemoryState = {
  cursors: Partial<Record<CheckQuery, CheckCursor | null>>
  passIndex: number
}

/**
 * Test hook, unset in production. `readPage` replaces each Firestore page (the checker still applies the page size,
 * the cursor and the budget). `memory` holds the cursors and the pass-rotation index for that hook.
 */
export const checkerTestSeam: {
  readPage?: (name: CheckQuery, field: string | null, cursor: CheckCursor | null) => Promise<CheckerPageRow[]>
  memory?: CheckerMemoryState
} = {}

/** Where a query resumes: the last row read (its time field's value, null for an id-ordered query, and its id). */
export type CheckCursor = { at: Timestamp | null; id: string }

/** The checker-state document: one cursor per query, and `passIndex` (absent or null cursor: start from the oldest row). */
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

function rowSnap(row: CheckerPageRow): QueryDocumentSnapshot {
  return {
    id: row.id,
    data: () => row.data,
    get: (field: string) => row.data[field],
  } as unknown as QueryDocumentSnapshot
}

/**
 * One page. A time-ordered query cannot resume from an id-only cursor (`at: null`, the shape saved when the query was
 * ordered by document id): that cursor is ignored and the page starts at the oldest row.
 */
async function readOrderedPage(name: CheckQuery, base: Query | null, field: string | null, after: CheckCursor | null): Promise<QueryDocumentSnapshot[]> {
  const usable = after !== null && (field === null || after.at !== null) ? after : null
  if (checkerTestSeam.readPage) {
    const rows = await checkerTestSeam.readPage(name, field, usable)
    return rows.slice(0, CHECK_PAGE_SIZE).map(rowSnap)
  }
  if (base === null) throw new Error("checker scan missing query")
  const ordered = field === null ? base.orderBy(FieldPath.documentId()) : base.orderBy(field).orderBy(FieldPath.documentId())
  let q = ordered.limit(CHECK_PAGE_SIZE)
  if (usable !== null) q = field === null ? q.startAfter(usable.id) : q.startAfter(usable.at as Timestamp, usable.id)
  return (await q.get()).docs
}

/**
 * Reads up to `CHECK_MAX_PAGES` pages of `base` ordered by `field` (null: by document id alone) and the id, starting
 * after `cursor`. Returns the rows and the cursor to save: the last row read, or null once a page came back short (the
 * end of the query: the next run wraps to the start). Stops early, keeping the cursor, when the run's budget is spent.
 */
async function scan(name: CheckQuery, base: Query | null, field: string | null, cursor: CheckCursor | null, spent: () => boolean): Promise<Scan> {
  const docs: QueryDocumentSnapshot[] = []
  let after = cursor
  for (let page = 0; page < CHECK_MAX_PAGES; page++) {
    if (spent()) break
    const pageDocs = await readOrderedPage(name, base, field, after)
    docs.push(...pageDocs)
    if (pageDocs.length < CHECK_PAGE_SIZE) return { docs, next: null }
    const last = pageDocs[pageDocs.length - 1]!
    after = { at: field === null ? null : (last.get(field) as Timestamp), id: last.id }
  }
  return { docs, next: after }
}

/** One run's cursors: read once at the start, each saved as soon as its query is done. `passIndex` rotates the next run. */
type Cursors = {
  passIndex: number
  get(q: CheckQuery): CheckCursor | null
  save(q: CheckQuery, next: CheckCursor | null): Promise<void>
  advancePass(): Promise<void>
}

function memoryCursors(mem: CheckerMemoryState): Cursors {
  return {
    passIndex: mem.passIndex,
    get: (q) => (isCursor(mem.cursors[q]) ? (mem.cursors[q] as CheckCursor) : null),
    save: async (q, next) => {
      mem.cursors[q] = next
    },
    advancePass: async () => {
      mem.passIndex += 1
    },
  }
}

async function loadCursors(): Promise<Cursors> {
  if (checkerTestSeam.readPage) return memoryCursors((checkerTestSeam.memory ??= { cursors: {}, passIndex: 0 }))
  const snap = await checkerStateRef().get()
  const stored = (snap.get("cursors") ?? {}) as Record<string, unknown>
  const rawIndex = snap.get("passIndex")
  const passIndex = typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : 0
  return {
    passIndex,
    get: (q) => (isCursor(stored[q]) ? stored[q] : null),
    save: async (q, next) => {
      await checkerStateRef().set({ cursors: { [q]: next }, updatedAt: Timestamp.now() }, { merge: true })
    },
    advancePass: async () => {
      await checkerStateRef().set({ passIndex: passIndex + 1, updatedAt: Timestamp.now() }, { merge: true })
    },
  }
}

/** Scans query `name` from its cursor and saves where it stopped. `base` is null when the test seam is serving pages. */
async function scanFrom(name: CheckQuery, base: Query | null, field: string | null, cursors: Cursors, spent: () => boolean): Promise<QueryDocumentSnapshot[]> {
  const { docs, next } = await scan(name, base, field, cursors.get(name), spent)
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

/** `start` selects which pass leads. The rest follow in `CHECK_PASSES` order, wrapping. */
function rotatedPasses(start: number, passes: readonly CheckPass[]): readonly CheckPass[] {
  const n = passes.length
  if (n === 0) return passes
  const i = ((Math.trunc(start) % n) + n) % n
  return [...passes.slice(i), ...passes.slice(0, i)]
}

type PassContext = { nowMs: number; cursors: Cursors; spent: () => boolean }

/** Firestore base, or null while `checkerTestSeam.readPage` is serving pages (the seam must not open a client). */
function live<T>(build: () => T): T | null {
  return checkerTestSeam.readPage ? null : build()
}

async function jobsPass({ nowMs, cursors, spent }: PassContext): Promise<AlertSpec[]> {
  const cutoff = at(nowMs - JOB_WAIT_ALERT_MS)
  const jobs = live(() => adminDb().collection("jobs"))
  const waiting = await scanFrom("jobsWaiting", jobs?.where("status", "in", ["queued", "failed"]).where("nextAttemptAt", "<=", cutoff) ?? null, "nextAttemptAt", cursors, spent)
  const running = await scanFrom("jobsRunning", jobs?.where("status", "==", "running").where("sweepAt", "<=", cutoff) ?? null, "sweepAt", cursors, spent)
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
  const base = live(() => adminDb().collection("merge_events").where("unmerge.status", "==", "in_progress").where("unmerge.startedAt", "<=", at(nowMs - SAGA_AGE_ALERT_MS)))
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
  const reservations = live(() => adminDb().collection("ai_reservations"))
  const held = await scanFrom("reservationsHeld", reservations?.where("state", "==", "reserved").where("leaseUntil", "<=", at(nowMs - RESERVATION_UNRESOLVED_ALERT_MS)) ?? null, "leaseUntil", cursors, spent)
  // Oldest lease first. `leaseUntil` is already on the row (gateway write, kept when quarantined). `createdAt` is the
  // documented creation time for a row that never received a lease; it is not a second page order (FA-F43-R1-004).
  const quarantined = await scanFrom("reservationsQuarantined", reservations?.where("state", "==", "reconcile_failed") ?? null, "leaseUntil", cursors, spent)
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

/**
 * One checker run at `now()`: each pass (from its cursors), then one raise per group. Returns the alert ids raised or
 * counted. The scheduled run rotates which pass leads (`passIndex`). A caller that names `passes` keeps that order and
 * does not move the index (the paging tests pin one pass).
 */
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
    logRegisteredError("ops_alert.pass_failed", { pass: "cursors", code: errorCode(err) })
    return { raised }
  }
  const rotate = opts.passes === undefined
  const ordered = opts.passes ?? rotatedPasses(cursors.passIndex, CHECK_PASSES)
  for (const pass of ordered) {
    if (spent()) break
    let specs: AlertSpec[]
    const nowMs = now()
    try {
      specs = await PASSES[pass]({ nowMs, cursors, spent })
    } catch (err) {
      logRegisteredError("ops_alert.pass_failed", { pass, code: errorCode(err) })
      continue
    }
    for (const spec of specs) {
      if (spent()) break
      const id = await raiseAlertBestEffort(spec, nowMs)
      if (id !== null) raised.push(id)
    }
  }
  if (rotate) {
    try {
      await cursors.advancePass()
    } catch (err) {
      logRegisteredError("ops_alert.pass_failed", { pass: "rotation", code: errorCode(err) })
    }
  }
  return { raised }
}
