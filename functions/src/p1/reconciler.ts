import { FieldPath, FieldValue, type DocumentData, type DocumentReference, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { isClassification, type Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { REGION } from "../health"
import { errorCode } from "../log"
import { firmConfigRef, monthRef, pkrRateOf } from "./config"
import { MAX_OUTPUT_TOKENS, PROVIDER_ID } from "./costTable"
import { leaseMillis, settledState, stage, type ClosedState, type StageResult, type UsageRecord } from "./gateway"
import { isMonthKey } from "./month"
import type { P1Outcome, TaskType } from "./types"

/**
 * The lease reconciler for P1 reservations (audit F07, F08), run every minute by `p1ReservationReconciler`, the
 * scheduling pattern of the P2 job sweeper (`jobSweeper`): a pinned timeout below the one-minute schedule and a
 * wall-clock budget that ends a run between reservations.
 *
 * It pages through every `ai_reservations` record still `reserved`, in document-id order with a cursor (re-audit
 * R1-D2), and acts on those whose lease has passed. The lease is read in code, not in the query, so a lease stored in
 * any shape is seen: a Timestamp or a number of milliseconds is compared with the clock, and anything else counts as
 * lapsed (the gateway always writes a Timestamp, so no live call owns such a record). Records that fail never stop the
 * run: the cursor moves past them. The lease outlives the function timeout by 60 s (RESERVATION_LEASE_MS), so the call
 * that made a lapsed reservation is gone and can no longer settle it. For each one, in its own transaction that
 * re-reads the reservation:
 *
 * - No provider attempt: nothing was sent. The reservation is released: its hold leaves the month's
 *   `reservedMicroUsd` and it takes `state: "released"`, `actualMicroUsd: 0`. No usage row is written.
 * - A provider attempt: the provider may have been called and billed. The reservation is settled the way the
 *   call's own commit would have settled it, through the same staging (`stage` in gateway.ts): the missing usage
 *   row, with outcome `reconciled`, the month total (`spentMicroUsd` up by the charge, `reservedMicroUsd` down by
 *   the hold, `calls.reconciled` up by one), any 70/90 alert, an audit row `ai.gateway.reconciled` (actor `system`)
 *   and the event `ai.call.reconciled`. The charge is the one the attempt recorded after the provider answered,
 *   when it did (`reconciledFrom: "recorded"`: the provider's reported usage, or the I1 charge); otherwise the
 *   reserved worst case, the input ceiling and the 4,096-token ceiling (`reconciledFrom: "worst_case"`,
 *   `tokensEstimated: true`).
 *
 * Malformed records (re-audit R1-D2). Fields a settlement can do without are defaulted: a missing `traceId` is
 * recorded as null, a missing actor as `system`, an unreadable classification as the strictest label. A record whose
 * firm, month or hold cannot be read cannot be settled without guessing what to take off which month total, so it
 * fails. Each failed run counts on the record (`reconcileFailures`); at RECONCILE_MAX_FAILURES it is quarantined:
 * `state: "reconcile_failed"`, logged `p1.reconcile_quarantined` at error. A quarantined record keeps its hold and
 * keeps its firm refused `accounting_indeterminate` (fail closed) until an operator settles it (README runbook).
 *
 * The Gateway gives this code no per-request receipt to check a charge against; the attempt keeps the provider's
 * response id and request id for that (O-57: reconcile `costMicroUsd` against the Gateway's records at G-1).
 */

/** Reservations per query page, and pages per run (at most 500 open reservations a minute). */
export const RECONCILE_PAGE_SIZE = 100
export const RECONCILE_MAX_PAGES = 5
/** One run's wall-clock budget, checked before each page and each reservation, like the job sweeper's. */
export const RECONCILE_BUDGET_MS = 30_000
/** The reconciler function's timeout: below the one-minute schedule, so runs never overlap. */
export const RECONCILER_TIMEOUT_SECONDS = 45
/**
 * Failed runs after which a reservation is quarantined (re-audit R1-D2). Three runs, a minute apart, rule out a
 * transient store fault (each run's own transaction already retries contention) without leaving a bad record in
 * every run's way for long.
 */
export const RECONCILE_MAX_FAILURES = 3

if (!(RECONCILE_BUDGET_MS + 10_000 <= RECONCILER_TIMEOUT_SECONDS * 1000)) {
  throw new Error(`reconcile budget (${RECONCILE_BUDGET_MS} ms) must end at least 10 s before the reconciler timeout (${RECONCILER_TIMEOUT_SECONDS} s)`)
}

export type ReconcileResult = { settled: string[]; released: string[]; quarantined: string[] }

/** A count, when it is a non-negative integer. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** A record that cannot be settled without guessing; logged by this fixed code, never its content. */
function malformed(): Error {
  return Object.assign(new Error("P1 reservation is malformed"), { code: "reservation_malformed" })
}

type Parsed = {
  firmId: string
  monthKey: string
  held: number
  traceId: string | null
  actorId: string
  matterId: string | null
  jobId: string | null
  taskType: TaskType
  model: string
  classification: Classification
  reservedInputTokens: number
  reservedOutputTokens: number
  attempt: Record<string, unknown> | null
}

/** What a settlement needs from a reservation. The firm, the month and the hold are required; everything else is defaulted. */
function parseReservation(res: DocumentData): Parsed {
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== ""
  const held = count(res.reservedMicroUsd)
  if (!nonEmpty(res.firmId) || !isMonthKey(res.monthKey) || held === null) throw malformed()
  const attempt = res.providerAttempt
  return {
    firmId: res.firmId,
    monthKey: res.monthKey,
    held,
    traceId: nonEmpty(res.traceId) ? res.traceId : null,
    actorId: nonEmpty(res.actorId) ? res.actorId : "system",
    matterId: nonEmpty(res.matterId) ? res.matterId : null,
    jobId: nonEmpty(res.jobId) ? res.jobId : null,
    taskType: (nonEmpty(res.taskType) ? res.taskType : "committee") as TaskType,
    model: nonEmpty(res.model) ? res.model : "unknown",
    classification: isClassification(res.classification) ? res.classification : "privileged-restricted",
    reservedInputTokens: count(res.reservedInputTokens) ?? 0,
    reservedOutputTokens: count(res.reservedOutputTokens) ?? MAX_OUTPUT_TOKENS,
    // Any attempt, even an unreadable one, means the provider may have been called: it is settled, never released.
    attempt: attempt == null ? null : typeof attempt === "object" && !Array.isArray(attempt) ? (attempt as Record<string, unknown>) : {},
  }
}

/** What the attempt recorded after the provider answered, when the record is complete; null otherwise. */
function recordedCharge(attempt: Record<string, unknown>): { result: P1Outcome; inputTokens: number; outputTokens: number; tokensEstimated: boolean; costMicroUsd: number } | null {
  if (attempt.outcome !== "returned") return null
  const inputTokens = count(attempt.inputTokens)
  const outputTokens = count(attempt.outputTokens)
  const costMicroUsd = count(attempt.costMicroUsd)
  const result = attempt.result
  if (inputTokens === null || outputTokens === null || costMicroUsd === null || typeof attempt.tokensEstimated !== "boolean") return null
  if (result !== "ok" && result !== "failed") return null
  return { result, inputTokens, outputTokens, tokensEstimated: attempt.tokensEstimated, costMicroUsd }
}

type Done = { state: ClosedState; staged: StageResult; firmId: string; monthKey: string }

/** Settles or releases one lapsed reservation; null when it is no longer reserved or its lease has not passed. */
async function reconcileOne(db: Firestore, ref: DocumentReference, nowMs: number): Promise<Done | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.get("state") !== "reserved") return null
    const lease = leaseMillis(snap.get("leaseUntil"))
    if (lease !== null && lease > nowMs) return null
    const p = parseReservation(snap.data()!)
    const totalRef = monthRef(p.firmId, p.monthKey)

    if (p.attempt === null) {
      // Nothing was sent: release the hold, charge nothing.
      const now = FieldValue.serverTimestamp()
      tx.set(totalRef, { firmId: p.firmId, monthKey: p.monthKey, reservedMicroUsd: FieldValue.increment(-p.held), updatedAt: now }, { merge: true })
      tx.update(ref, { state: "released", actualMicroUsd: 0, settledAt: now, settledBy: "reconciler" })
      return { state: "released" as const, staged: { crossings: [], exceeded: null }, firmId: p.firmId, monthKey: p.monthKey }
    }

    const recorded = recordedCharge(p.attempt)
    const configRef = firmConfigRef(p.firmId)
    const rate = pkrRateOf((await tx.get(configRef)).data())
    const charge = recorded ?? { inputTokens: p.reservedInputTokens, outputTokens: p.reservedOutputTokens, tokensEstimated: true, costMicroUsd: p.held }
    const record: UsageRecord = {
      firmId: p.firmId,
      actorId: p.actorId,
      matterId: p.matterId,
      jobId: p.jobId,
      taskType: p.taskType,
      provider: PROVIDER_ID,
      model: p.model,
      classification: p.classification,
      outcome: "reconciled",
      blockReason: null,
      inputTokens: charge.inputTokens,
      outputTokens: charge.outputTokens,
      tokensEstimated: charge.tokensEstimated,
      costMicroUsd: charge.costMicroUsd,
      fxPkrPerUsd: rate,
      costPkr: rate === null ? null : Math.round((charge.costMicroUsd * rate) / 10_000) / 100,
      monthKey: p.monthKey,
      // The reconciler cannot know whether the call's trace was exported.
      trace: { id: p.traceId, status: "unknown" },
      reconciledFrom: recorded ? "recorded" : "worst_case",
    }
    const state = recorded ? settledState(true, recorded.result, recorded.costMicroUsd) : "settled"
    const staged = await stage(db, tx, {
      usageRef: db.collection("ai_usage_logs").doc(ref.id),
      configRef,
      totalRef,
      record,
      traceId: p.traceId,
      failCommit: false,
      seam: {},
      reservation: { ref, state, mustBeLive: true },
      settledBy: "reconciler",
    })
    return { state, staged, firmId: p.firmId, monthKey: p.monthKey }
  })
}

/** Counts a failed run on a still-reserved record; at RECONCILE_MAX_FAILURES it quarantines it. Its hold is kept either way. */
async function recordFailure(db: Firestore, ref: DocumentReference, err: unknown): Promise<"counted" | "quarantined" | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.get("state") !== "reserved") return null
    const failures = (count(snap.get("reconcileFailures")) ?? 0) + 1
    const code = errorCode(err)
    if (failures < RECONCILE_MAX_FAILURES) {
      tx.update(ref, { reconcileFailures: failures, lastReconcileError: code })
      return "counted" as const
    }
    tx.update(ref, { state: "reconcile_failed", reconcileFailures: failures, lastReconcileError: code, quarantinedAt: FieldValue.serverTimestamp() })
    return "quarantined" as const
  })
}

/**
 * One reconciler run: pages through the open reservations with a cursor until a short page, RECONCILE_MAX_PAGES or
 * the budget. `now` is the clock the leases are compared with (the tests drive it). A reservation that fails is
 * logged by code, counted, and quarantined at its RECONCILE_MAX_FAILURES-th failed run; the run moves on past it.
 */
export async function reconcileReservations(opts: { now?: () => number } = {}): Promise<ReconcileResult> {
  const now = opts.now ?? Date.now
  const db = adminDb()
  const started = Date.now()
  const spent = () => Date.now() - started >= RECONCILE_BUDGET_MS
  const result: ReconcileResult = { settled: [], released: [], quarantined: [] }
  let cursor: QueryDocumentSnapshot | undefined
  for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
    if (spent()) {
      logger.warn("p1.reconcile_budget_spent", { settled: result.settled.length, released: result.released.length })
      break
    }
    const nowMs = Math.floor(now())
    let query = db.collection("ai_reservations").where("state", "==", "reserved").orderBy(FieldPath.documentId()).limit(RECONCILE_PAGE_SIZE)
    if (cursor) query = query.startAfter(cursor)
    const open = await query.get()
    for (const doc of open.docs) {
      if (spent()) break
      const lease = leaseMillis(doc.get("leaseUntil"))
      if (lease !== null && lease > nowMs) continue // a live call can still settle it
      try {
        const done = await reconcileOne(db, doc.ref, nowMs)
        if (done === null) continue
        result[done.state].push(doc.id)
        if (done.state === "released") logger.info("p1.reservation_released", { firmId: done.firmId, usageLogId: doc.id })
        else logger.warn("p1.reservation_reconciled", { firmId: done.firmId, usageLogId: doc.id })
        for (const c of done.staged.crossings) logger.warn("p1.budget_threshold", { firmId: done.firmId, monthKey: done.monthKey, ...c })
        if (done.staged.exceeded !== null) logger.error("p1.reservation_exceeded", { firmId: done.firmId, usageLogId: doc.id, monthKey: done.monthKey, ...done.staged.exceeded })
      } catch (err) {
        const firmId = typeof doc.get("firmId") === "string" ? (doc.get("firmId") as string) : null
        logger.error("p1.reconcile_failed", { firmId, usageLogId: doc.id, code: errorCode(err) })
        try {
          if ((await recordFailure(db, doc.ref, err)) === "quarantined") {
            result.quarantined.push(doc.id)
            logger.error("p1.reconcile_quarantined", { firmId, usageLogId: doc.id, failures: RECONCILE_MAX_FAILURES, code: errorCode(err) })
          }
        } catch (countErr) {
          logger.error("p1.reconcile_failure_uncounted", { firmId, usageLogId: doc.id, code: errorCode(countErr) })
        }
      }
    }
    if (spent() || open.size < RECONCILE_PAGE_SIZE) break
    cursor = open.docs[open.docs.length - 1]
  }
  return result
}

/** The scheduled reconciler (F07, F08): every minute, like the job sweeper. No caller, no tenant input. */
export const p1ReservationReconciler = onSchedule({ schedule: "every 1 minutes", region: REGION, timeoutSeconds: RECONCILER_TIMEOUT_SECONDS }, async () => {
  await reconcileReservations()
})
