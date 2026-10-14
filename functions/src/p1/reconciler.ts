import { FieldValue, Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { onSchedule } from "firebase-functions/v2/scheduler"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { REGION } from "../health"
import { errorCode } from "../log"
import { firmConfigRef, monthRef, pkrRateOf, reservedOf } from "./config"
import { MAX_OUTPUT_TOKENS, PROVIDER_ID } from "./costTable"
import { settledState, stage, type Crossing, type UsageRecord } from "./gateway"
import type { P1Outcome, TaskType } from "./types"

/**
 * The lease reconciler for P1 reservations (audit F07, F08), run every minute by `p1ReservationReconciler`, the
 * scheduling pattern of the P2 job sweeper (`jobSweeper`): a pinned timeout below the one-minute schedule and a
 * wall-clock budget that ends a run between reservations.
 *
 * It reads `ai_reservations` still `reserved` whose `leaseUntil` has passed. The lease outlives the function
 * timeout by 60 s (RESERVATION_LEASE_MS), so the call that made such a reservation is gone and can no longer
 * settle it. For each one, in its own transaction that re-reads the reservation:
 *
 * - No provider attempt: nothing was sent. The reservation is released: its hold leaves the month's
 *   `reservedMicroUsd` and it takes `state: "released"`, `actualMicroUsd: 0`. No usage row is written.
 * - A provider attempt: the provider may have been called and billed. The reservation is settled the way the
 *   call's own commit would have settled it, through the same staging (`stage` in gateway.ts): the missing usage
 *   row, with outcome `reconciled`, the month total (`spentMicroUsd` up by the charge, `reservedMicroUsd` down by
 *   the hold, `calls.reconciled` up by one), any 70/90 alert, an audit row `ai.gateway.reconciled` (actor `system`)
 *   and the event `ai.call.reconciled`. The charge is the one the attempt recorded after the provider answered,
 *   when it did (`reconciledFrom: "recorded"`: the provider's reported usage, or the I1 charge); otherwise the
 *   reserved worst case, the estimated input and the 4,096-token ceiling (`reconciledFrom: "worst_case"`,
 *   `tokensEstimated: true`).
 *
 * The Gateway gives this code no per-request receipt to check a charge against, so no charge is matched with the
 * provider's own bill here; that is the open item O-57 (reconcile `costMicroUsd` against the Gateway's spend
 * report at G-1).
 */

/** Reservations per query page, and pages per run (at most 500 reservations a minute). */
export const RECONCILE_PAGE_SIZE = 100
export const RECONCILE_MAX_PAGES = 5
/** One run's wall-clock budget, checked before each page and each reservation, like the job sweeper's. */
export const RECONCILE_BUDGET_MS = 30_000
/** The reconciler function's timeout: below the one-minute schedule, so runs never overlap. */
export const RECONCILER_TIMEOUT_SECONDS = 45

if (!(RECONCILE_BUDGET_MS + 10_000 <= RECONCILER_TIMEOUT_SECONDS * 1000)) {
  throw new Error(`reconcile budget (${RECONCILE_BUDGET_MS} ms) must end at least 10 s before the reconciler timeout (${RECONCILER_TIMEOUT_SECONDS} s)`)
}

export type ReconcileResult = { settled: string[]; released: string[] }

/** A count the attempt recorded, when it is a non-negative integer. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
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

/** Settles or releases one lapsed reservation; null when it is no longer reserved or its lease has not passed. */
async function reconcileOne(db: Firestore, ref: DocumentReference, nowMs: number): Promise<{ state: "settled" | "released"; crossings: Crossing[]; firmId: string; monthKey: string } | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.get("state") !== "reserved") return null
    const lease = snap.get("leaseUntil")
    if (!(lease instanceof Timestamp) || lease.toMillis() > nowMs) return null
    const res = snap.data()!
    const firmId = res.firmId as string
    const monthKey = res.monthKey as string
    const totalRef = monthRef(firmId, monthKey)
    const attempt = res.providerAttempt as Record<string, unknown> | undefined

    if (attempt == null) {
      // Nothing was sent: release the hold, charge nothing.
      const now = FieldValue.serverTimestamp()
      tx.set(totalRef, { firmId, monthKey, reservedMicroUsd: FieldValue.increment(-reservedOf(res)), updatedAt: now }, { merge: true })
      tx.update(ref, { state: "released", actualMicroUsd: 0, settledAt: now, settledBy: "reconciler" })
      return { state: "released" as const, crossings: [], firmId, monthKey }
    }

    const recorded = recordedCharge(attempt)
    const configRef = firmConfigRef(firmId)
    const rate = pkrRateOf((await tx.get(configRef)).data())
    const charge = recorded ?? {
      result: "failed" as const,
      inputTokens: count(res.reservedInputTokens) ?? 0,
      outputTokens: count(res.reservedOutputTokens) ?? MAX_OUTPUT_TOKENS,
      tokensEstimated: true,
      costMicroUsd: reservedOf(res),
    }
    const record: UsageRecord = {
      firmId,
      actorId: res.actorId as string,
      matterId: (res.matterId as string | null) ?? null,
      jobId: (res.jobId as string | null) ?? null,
      taskType: res.taskType as TaskType,
      provider: PROVIDER_ID,
      model: res.model as string,
      classification: res.classification as Classification,
      outcome: "reconciled",
      blockReason: null,
      inputTokens: charge.inputTokens,
      outputTokens: charge.outputTokens,
      tokensEstimated: charge.tokensEstimated,
      costMicroUsd: charge.costMicroUsd,
      fxPkrPerUsd: rate,
      costPkr: rate === null ? null : Math.round((charge.costMicroUsd * rate) / 10_000) / 100,
      monthKey,
      // The reconciler cannot know whether the call's trace was exported.
      trace: { id: res.traceId as string, status: "unknown" },
      reconciledFrom: recorded ? "recorded" : "worst_case",
    }
    const state = recorded ? settledState(true, recorded.result, recorded.costMicroUsd) : "settled"
    const crossings = await stage(db, tx, {
      usageRef: db.collection("ai_usage_logs").doc(ref.id),
      configRef,
      totalRef,
      record,
      traceId: res.traceId as string,
      failCommit: false,
      seam: {},
      reservation: { ref, state, mustBeLive: true },
      settledBy: "reconciler",
    })
    return { state, crossings, firmId, monthKey }
  })
}

/**
 * One reconciler run: pages through lapsed reservations (oldest lease first) until a short page, a page that acted
 * on nothing, RECONCILE_MAX_PAGES or the budget. `now` is the clock the leases are compared with (the tests drive it).
 * A reservation that fails is logged by code and left for the next run.
 */
export async function reconcileReservations(opts: { now?: () => number } = {}): Promise<ReconcileResult> {
  const now = opts.now ?? Date.now
  const db = adminDb()
  const started = Date.now()
  const spent = () => Date.now() - started >= RECONCILE_BUDGET_MS
  const result: ReconcileResult = { settled: [], released: [] }
  for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
    if (spent()) {
      logger.warn("p1.reconcile_budget_spent", { settled: result.settled.length, released: result.released.length })
      break
    }
    const nowMs = Math.floor(now())
    const due = await db
      .collection("ai_reservations")
      .where("state", "==", "reserved")
      .where("leaseUntil", "<=", Timestamp.fromMillis(nowMs))
      .orderBy("leaseUntil")
      .limit(RECONCILE_PAGE_SIZE)
      .get()
    let acted = 0
    for (const doc of due.docs) {
      if (spent()) break
      try {
        const done = await reconcileOne(db, doc.ref, nowMs)
        if (done === null) continue
        acted += 1
        result[done.state].push(doc.id)
        if (done.state === "released") logger.info("p1.reservation_released", { firmId: done.firmId, usageLogId: doc.id })
        else logger.warn("p1.reservation_reconciled", { firmId: done.firmId, usageLogId: doc.id })
        for (const c of done.crossings) logger.warn("p1.budget_threshold", { firmId: done.firmId, monthKey: done.monthKey, ...c })
      } catch (err) {
        logger.error("p1.reconcile_failed", { usageLogId: doc.id, code: errorCode(err) })
      }
    }
    if (due.size < RECONCILE_PAGE_SIZE || acted === 0) break
  }
  return result
}

/** The scheduled reconciler (F07, F08): every minute, like the job sweeper. No caller, no tenant input. */
export const p1ReservationReconciler = onSchedule({ schedule: "every 1 minutes", region: REGION, timeoutSeconds: RECONCILER_TIMEOUT_SECONDS }, async () => {
  await reconcileReservations()
})
