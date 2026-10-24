import { Timestamp, type QueryDocumentSnapshot } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminDb } from "../admin"
import { errorCode } from "../log"
import { JOB_ENGINE } from "../p2/constants"
import { JOB_WAIT_ALERT_MS, RESERVATION_UNRESOLVED_ALERT_MS, SAGA_AGE_ALERT_MS, type AlertSpec } from "./model"
import { raiseAlertBestEffort } from "./raise"
import { queueAgeSpec, reservationUnresolvedSpec, sagaAgeSpec } from "./specs"

/**
 * The checker (audit F43, spec R8, R10), run every five minutes by `alertChecker`. It derives the conditions that have
 * no single transaction of their own from the rows' durable state, oldest first, at most `CHECK_LIMIT` rows per query,
 * and raises one alert per firm and subject (each in its own transaction; a raise that fails is logged
 * `ops_alert.raise_failed` and derived again on the next run):
 *
 * - `jobs`: engine jobs `queued` or `failed` and due `JOB_WAIT_ALERT_MS` ago or more, and `running` jobs whose lease
 *   expired that long ago (the sweeper has not recovered them) → `job.queue_age` per firm and job type.
 * - `sagas`: `merge_events` whose un-merge has been `in_progress` for `SAGA_AGE_ALERT_MS` or more → `saga.age` per firm.
 * - `reservations`: P1 reservations still `reserved` `RESERVATION_UNRESOLVED_ALERT_MS` or more past their lease, and
 *   every quarantined one (`reconcile_failed`) → `ai.reservation_unresolved` per firm.
 *
 * Each pass is caught on its own (`ops_alert.pass_failed`), so a query that fails (an index still building) stops only
 * its own pass.
 */

export const CHECK_PASSES = ["jobs", "sagas", "reservations"] as const
export type CheckPass = (typeof CHECK_PASSES)[number]
/** Rows read per query. */
export const CHECK_LIMIT = 500
/** One run's wall-clock budget, inside the function's 60 s timeout. */
export const CHECKER_BUDGET_MS = 40_000

const millisOf = (t: unknown): number | null => (t instanceof Timestamp ? t.toMillis() : typeof t === "number" && Number.isFinite(t) ? t : null)
const at = (ms: number) => Timestamp.fromMillis(ms)

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

async function jobsPass(nowMs: number): Promise<AlertSpec[]> {
  const cutoff = at(nowMs - JOB_WAIT_ALERT_MS)
  const jobs = adminDb().collection("jobs")
  const [waiting, running] = await Promise.all([
    jobs.where("status", "in", ["queued", "failed"]).where("nextAttemptAt", "<=", cutoff).orderBy("nextAttemptAt").limit(CHECK_LIMIT).get(),
    jobs.where("status", "==", "running").where("sweepAt", "<=", cutoff).orderBy("sweepAt").limit(CHECK_LIMIT).get(),
  ])
  const groups = new Map<string, Group>()
  const add = (d: QueryDocumentSnapshot, field: string) => {
    const row = d.data()
    const ms = millisOf(row[field])
    if (row.engine !== JOB_ENGINE || !isFirm(row.firmId) || typeof row.jobType !== "string" || ms === null) return
    tally(groups, row.firmId, row.jobType, ms, d.id)
  }
  for (const d of waiting.docs) add(d, "nextAttemptAt")
  for (const d of running.docs) add(d, "sweepAt")
  return [...groups.values()].map((g) => queueAgeSpec(g.firmId, g.key, g.count, nowMs - g.oldestMs, g.oldestId))
}

async function sagasPass(nowMs: number): Promise<AlertSpec[]> {
  const snap = await adminDb()
    .collection("merge_events")
    .where("unmerge.status", "==", "in_progress")
    .where("unmerge.startedAt", "<=", at(nowMs - SAGA_AGE_ALERT_MS))
    .orderBy("unmerge.startedAt")
    .limit(CHECK_LIMIT)
    .get()
  const groups = new Map<string, Group>()
  for (const d of snap.docs) {
    const firmId: unknown = d.get("firmId")
    const ms = millisOf(d.get("unmerge.startedAt"))
    if (isFirm(firmId) && ms !== null) tally(groups, firmId, "entity.unmerge", ms, d.id)
  }
  return [...groups.values()].map((g) => sagaAgeSpec(g.firmId, g.count, nowMs - g.oldestMs, g.oldestId))
}

async function reservationsPass(nowMs: number): Promise<AlertSpec[]> {
  const reservations = adminDb().collection("ai_reservations")
  const [held, quarantined] = await Promise.all([
    reservations.where("state", "==", "reserved").where("leaseUntil", "<=", at(nowMs - RESERVATION_UNRESOLVED_ALERT_MS)).orderBy("leaseUntil").limit(CHECK_LIMIT).get(),
    reservations.where("state", "==", "reconcile_failed").limit(CHECK_LIMIT).get(),
  ])
  const groups = new Map<string, Group>()
  for (const [docs, isQuarantined] of [[held.docs, 0], [quarantined.docs, 1]] as const) {
    for (const d of docs) {
      const firmId: unknown = d.get("firmId")
      if (!isFirm(firmId)) continue
      tally(groups, firmId, "reservations", millisOf(d.get("leaseUntil")) ?? nowMs, d.id, isQuarantined)
    }
  }
  return [...groups.values()].map((g) => reservationUnresolvedSpec(g.firmId, g.count, g.extra, nowMs - g.oldestMs, g.oldestId))
}

const PASSES: Readonly<Record<CheckPass, (nowMs: number) => Promise<AlertSpec[]>>> = { jobs: jobsPass, sagas: sagasPass, reservations: reservationsPass }

export type CheckerOptions = { now?: () => number; passes?: readonly CheckPass[]; wallClock?: () => number }

/** One checker run at `now()`: each pass, then one raise per group. Returns the alert ids raised or counted. */
export async function runAlertChecker(opts: CheckerOptions = {}): Promise<{ raised: string[] }> {
  const now = opts.now ?? Date.now
  const wall = opts.wallClock ?? Date.now
  const started = wall()
  const spent = () => wall() - started >= CHECKER_BUDGET_MS
  const raised: string[] = []
  for (const pass of opts.passes ?? CHECK_PASSES) {
    if (spent()) break
    let specs: AlertSpec[]
    const nowMs = now()
    try {
      specs = await PASSES[pass](nowMs)
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
