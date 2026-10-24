import { FieldPath, FieldValue, Timestamp, type DocumentData, type DocumentReference, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { isClassification, type Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { INTERNAL_ONLY, RUNTIME_DEFAULTS } from "../runtimeOptions"
import { errorCode } from "../log"
import { firmConfigRef, monthRef, pkrRateOf } from "./config"
import { MAX_OUTPUT_TOKENS, PROVIDER_ID } from "./costTable"
import { reconciledDecision } from "./decisionRecord"
import { NOTHING_STAGED, isRetryableCommitError, leaseMillis, logLearning, settledState, stage, type ClosedState, type StageResult, type UsageRecord } from "./gateway"
import { isMonthKey } from "./month"
import { opikConfig } from "./opik"
import { modelId } from "./transport"
import type { LedgerTaskType, P1Outcome } from "./types"

/**
 * The lease reconciler for P1 reservations (audit F07, F08), run every minute by `p1ReservationReconciler`, the
 * scheduling pattern of the P2 job sweeper (`jobSweeper`): a pinned timeout below the one-minute schedule and a
 * wall-clock budget that ends a run between reservations.
 *
 * Which records a run reads (re-audit R1-D2, R2-D2). Only lapsed records can be acted on, so a run asks for them
 * directly and live ones never take its place, however many there are or however their ids sort:
 *
 * - Pass C, the sweep, first: a slice of RECONCILE_SWEEP_SIZE records still `reserved`, in document-id order from a
 *   cursor kept in `platform/p1ReconcileCursor` (server-only), wrapping to the start after the last slice. It acts only
 *   on records whose `leaseUntil` no index can find: missing, or neither a Timestamp nor a number (the gateway always
 *   writes a Timestamp, so no live call owns such a record: it counts as lapsed, fail closed). Every open record is
 *   read within ceil(open / RECONCILE_SWEEP_SIZE) runs.
 * - Pass B: records whose lease is a number of milliseconds at or before the clock (a malformed record), oldest first.
 * - Pass A: records whose lease is a Timestamp at or before the clock, oldest first, up to RECONCILE_MAX_PAGES pages of
 *   RECONCILE_PAGE_SIZE. The query `state == "reserved" and leaseUntil <= now order by leaseUntil` uses the composite
 *   index (state, leaseUntil) in firestore.indexes.json; Pass B's query is the same with a number, on the same index
 *   (a Firestore range filter matches only values of its own type). The sweep's query is the state equality with the
 *   document-id order, which the single-field index serves.
 *
 * A record is tried at most once per run. The lease outlives the function timeout by 60 s (RESERVATION_LEASE_MS), so the
 * call that made a lapsed reservation is gone and can no longer settle it. For each one, in its own transaction that
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
 * A settled reservation also gets the call's decision record (audit F34, spec ruling R2), staged in the same transaction
 * from the reservation's `decisionSeed` and its provider attempt (`reconciledDecision` in decisionRecord.ts). A released
 * one does not: nothing was sent and no usage row is written, and the released reservation is its record.
 *
 * Either way, in the same transaction (Codex P2 on PR #40), the call's `committee_outputs` rows (found by their
 * `usageLogId`) take `accounting: "settled"`, and so does the answer stored for the request's Idempotency-Key (the
 * reservation's `idempotencyDoc`, when its stored answer carries this call's trace id), so a reader and a same-key
 * replay see the books completed. Both writes are idempotent: a row or answer already settled is left as it is.
 *
 * Failures (re-audit R1-D2, R2-D1). A failure that a later run may not meet (contention, ABORTED, UNAVAILABLE,
 * DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED and the rest of `isRetryableCommitError`) is logged `p1.reconcile_failed` with
 * `transient: true` and retried on the next run; it never counts toward quarantine, so a valid record is never
 * quarantined for contention on its firm's month total. Only a fault of the record itself counts: fields a settlement
 * can do without are defaulted (a missing `traceId` is recorded as null, a missing actor as `system`, an unreadable
 * classification as the strictest label), but a record whose firm, month or hold cannot be read cannot be settled
 * without guessing what to take off which month total (`reservation_malformed`), and any other failure that is not
 * retryable (an invalid write, an existing usage row) is the record's own. Each such run counts on the record
 * (`reconcileFailures`); at RECONCILE_MAX_FAILURES it is quarantined: `state: "reconcile_failed"`, logged
 * `p1.reconcile_quarantined` at error. A quarantined record keeps its hold and keeps its firm refused
 * `accounting_indeterminate` (fail closed) until an operator settles it (README runbook).
 *
 * The Gateway gives this code no per-request receipt to check a charge against; the attempt keeps the provider's
 * response id and request id for that (O-57: reconcile `costMicroUsd` against the Gateway's records at G-1).
 */

/** Pass A's page size, and the pages it may read in a run (at most 500 lapsed reservations a minute). */
export const RECONCILE_PAGE_SIZE = 100
export const RECONCILE_MAX_PAGES = 5
/** Records the sweep (Pass C) reads per run. */
export const RECONCILE_SWEEP_SIZE = 200
/** One run's wall-clock budget, checked before each page and each reservation, like the job sweeper's. */
export const RECONCILE_BUDGET_MS = 30_000
/** The reconciler function's timeout: below the one-minute schedule, so runs never overlap. */
export const RECONCILER_TIMEOUT_SECONDS = 45
/**
 * Runs in which a record's own fault was met, after which it is quarantined (re-audit R1-D2). Store faults that a
 * later run may not meet are never counted (re-audit R2-D1), so three counted runs mean the record itself is bad.
 */
export const RECONCILE_MAX_FAILURES = 3

if (!(RECONCILE_BUDGET_MS + 10_000 <= RECONCILER_TIMEOUT_SECONDS * 1000)) {
  throw new Error(`reconcile budget (${RECONCILE_BUDGET_MS} ms) must end at least 10 s before the reconciler timeout (${RECONCILER_TIMEOUT_SECONDS} s)`)
}

/** Where the sweep (Pass C) resumes: `{ after: <document id> }`, "" for the start. Server-only, like all of `platform/*`. */
export function reconcileCursorRef(): DocumentReference {
  return adminDb().collection("platform").doc("p1ReconcileCursor")
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
  taskType: LedgerTaskType
  model: string
  classification: Classification
  reservedInputTokens: number
  reservedOutputTokens: number
  attempt: Record<string, unknown> | null
  /** The `idempotency_keys` doc id of the request the call was made for, when it is a plain doc id. */
  idempotencyDoc: string | null
  /** FA-D3C-002: an embedding call's verified service caller and corpus operation id; null on every chat call. */
  caller: string | null
  corpusOperationId: string | null
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
    taskType: (nonEmpty(res.taskType) ? res.taskType : "committee") as LedgerTaskType,
    model: nonEmpty(res.model) ? res.model : "unknown",
    classification: isClassification(res.classification) ? res.classification : "privileged-restricted",
    reservedInputTokens: count(res.reservedInputTokens) ?? 0,
    reservedOutputTokens: count(res.reservedOutputTokens) ?? MAX_OUTPUT_TOKENS,
    // Any attempt, even an unreadable one, means the provider may have been called: it is settled, never released.
    attempt: attempt == null ? null : typeof attempt === "object" && !Array.isArray(attempt) ? (attempt as Record<string, unknown>) : {},
    idempotencyDoc: typeof res.idempotencyDoc === "string" && /^[A-Za-z0-9_-]{1,400}$/.test(res.idempotencyDoc) ? res.idempotencyDoc : null,
    caller: nonEmpty(res.caller) ? res.caller : null,
    corpusOperationId: nonEmpty(res.corpusOperationId) ? res.corpusOperationId : null,
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

/**
 * The model the provider reported, as the attempt recorded it (audit F17 review round, Codex P2 on PR #63): a model id
 * (`modelId`, as the transport and the receipt check it), else null. Fail-safe: an attempt recorded before F17 has no
 * field, and a malformed value (not a model id) is recorded as null; neither stops the settlement, which owes the charge.
 */
function reportedModel(attempt: Record<string, unknown>): string | null {
  return modelId(attempt.modelReported) ?? null
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

    // The call's stored output rows and its request's stored answer (Codex P2 on PR #40), read before anything is
    // staged, and marked settled after: only this firm's rows, and only an answer that carries this call's trace id.
    const outputs = await tx.get(db.collection("committee_outputs").where("usageLogId", "==", ref.id))
    const answerRef = p.idempotencyDoc === null ? null : db.collection("idempotency_keys").doc(p.idempotencyDoc)
    const answer = answerRef === null ? null : await tx.get(answerRef)
    const markSettled = () => {
      for (const row of outputs.docs) {
        if (row.get("firmId") === p.firmId && row.get("accounting") !== "settled") tx.update(row.ref, { accounting: "settled" })
      }
      if (
        answerRef !== null &&
        answer?.exists === true &&
        answer.get("firmId") === p.firmId &&
        answer.get("status") === "done" &&
        p.traceId !== null &&
        answer.get("response.body.traceId") === p.traceId &&
        answer.get("response.body.accounting") === "pending"
      ) {
        tx.update(answerRef, { "response.body.accounting": "settled" })
      }
    }

    if (p.attempt === null) {
      // Nothing was sent: release the hold, charge nothing.
      const now = FieldValue.serverTimestamp()
      tx.set(totalRef, { firmId: p.firmId, monthKey: p.monthKey, reservedMicroUsd: FieldValue.increment(-p.held), updatedAt: now }, { merge: true })
      tx.update(ref, { state: "released", actualMicroUsd: 0, settledAt: now, settledBy: "reconciler" })
      markSettled()
      return { state: "released" as const, staged: { ...NOTHING_STAGED, crossings: [] }, firmId: p.firmId, monthKey: p.monthKey }
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
      // Audit F17 review round (Codex P2 on PR #63): beside the configured model, as the call's own row would have it.
      modelReported: reportedModel(p.attempt),
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
      // FA-D3C-002 (Codex P2 on PR #118): an embedding call's caller and corpus operation, as its own row would carry them,
      // so the row still joins the corpus's F27 receipt. Added only when the reservation holds them: a chat call's row
      // is unchanged.
      ...(p.caller === null ? {} : { caller: p.caller }),
      ...(p.corpusOperationId === null ? {} : { corpusOperationId: p.corpusOperationId }),
    }
    const state = recorded ? settledState(true, recorded.result, recorded.costMicroUsd) : "settled"
    // Audit F34 (R2): the call never committed, so its decision record is written here, from the seed it left on the
    // reservation before dispatch and the attempt's ids and transport time; its trace export is left to the export
    // reconciler (`pending`, nothing tried), or `disabled` when tracing is off.
    const decision = reconciledDecision({ usageLogId: ref.id, traceId: p.traceId, seed: snap.get("decisionSeed"), attempt: p.attempt, record, nowMs, tracing: opikConfig().enabled })
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
      decision,
    })
    markSettled()
    return { state, staged, firmId: p.firmId, monthKey: p.monthKey }
  })
}

/** Counts a run that met the record's own fault; at RECONCILE_MAX_FAILURES it quarantines it. Its hold is kept either way. */
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
 * One reconciler run: the sweep (Pass C), then the lapsed numeric leases (Pass B), then the lapsed Timestamp leases
 * (Pass A), each until its records run out or the budget is spent. `now` is the clock the leases are compared with (the
 * tests drive it). A record is tried at most once per run; one that fails is logged by code, and only a fault of the
 * record itself is counted and, at its RECONCILE_MAX_FAILURES-th counted run, quarantined.
 */
export async function reconcileReservations(opts: { now?: () => number } = {}): Promise<ReconcileResult> {
  const now = opts.now ?? Date.now
  const db = adminDb()
  const started = Date.now()
  const spent = () => Date.now() - started >= RECONCILE_BUDGET_MS
  const result: ReconcileResult = { settled: [], released: [], quarantined: [] }
  const tried = new Set<string>()
  const reserved = () => db.collection("ai_reservations").where("state", "==", "reserved")

  const handle = async (doc: QueryDocumentSnapshot, nowMs: number): Promise<void> => {
    if (tried.has(doc.id)) return
    tried.add(doc.id)
    try {
      const done = await reconcileOne(db, doc.ref, nowMs)
      if (done === null) return
      result[done.state].push(doc.id)
      if (done.state === "released") logger.info("p1.reservation_released", { firmId: done.firmId, usageLogId: doc.id })
      else logger.warn("p1.reservation_reconciled", { firmId: done.firmId, usageLogId: doc.id })
      for (const c of done.staged.crossings) logger.warn("p1.budget_threshold", { firmId: done.firmId, monthKey: done.monthKey, ...c })
      if (done.staged.exceeded !== null) logger.error("p1.reservation_exceeded", { firmId: done.firmId, usageLogId: doc.id, monthKey: done.monthKey, ...done.staged.exceeded })
      logLearning(doc.id, done.firmId, done.staged)
    } catch (err) {
      const firmId = typeof doc.get("firmId") === "string" ? (doc.get("firmId") as string) : null
      // A store fault a later run may not meet is retried then, and never counted (re-audit R2-D1).
      const transient = isRetryableCommitError(err)
      logger.error("p1.reconcile_failed", { firmId, usageLogId: doc.id, code: errorCode(err), transient })
      if (transient) return
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

  // A pass whose query or cursor fails is logged by code and the run goes on to the next pass.
  const pass = async (name: "sweep" | "numeric" | "timestamp", body: () => Promise<void>): Promise<void> => {
    try {
      await body()
    } catch (err) {
      logger.error("p1.reconcile_pass_failed", { pass: name, code: errorCode(err) })
    }
  }

  // Pass C, the sweep: a slice from the persisted cursor; it acts only on leases no index can find.
  await pass("sweep", async () => {
    if (spent()) return
    const nowMs = Math.floor(now())
    const after = (await reconcileCursorRef().get()).get("after")
    let sweep = reserved().orderBy(FieldPath.documentId()).limit(RECONCILE_SWEEP_SIZE)
    if (typeof after === "string" && after !== "") sweep = sweep.startAfter(after)
    const slice = await sweep.get()
    for (const doc of slice.docs) {
      if (spent()) break
      if (leaseMillis(doc.get("leaseUntil")) === null) await handle(doc, nowMs)
    }
    const next = slice.size < RECONCILE_SWEEP_SIZE ? "" : slice.docs[slice.docs.length - 1]!.id
    await reconcileCursorRef().set({ after: next, updatedAt: FieldValue.serverTimestamp() })
  })

  // Pass B, then Pass A: lapsed leases of each indexable type, oldest first.
  const passes = [
    { name: "numeric" as const, bound: (ms: number): number | Timestamp => ms },
    { name: "timestamp" as const, bound: (ms: number): number | Timestamp => Timestamp.fromMillis(ms) },
  ]
  for (const { name, bound } of passes) {
    await pass(name, async () => {
      let page: QueryDocumentSnapshot | undefined
      for (let n = 0; n < RECONCILE_MAX_PAGES; n++) {
        if (spent()) return
        const nowMs = Math.floor(now())
        let query = reserved().where("leaseUntil", "<=", bound(nowMs)).orderBy("leaseUntil").limit(RECONCILE_PAGE_SIZE)
        if (page) query = query.startAfter(page)
        const lapsed = await query.get()
        for (const doc of lapsed.docs) {
          if (spent()) return
          await handle(doc, nowMs)
        }
        if (lapsed.size < RECONCILE_PAGE_SIZE) return
        page = lapsed.docs[lapsed.docs.length - 1]
      }
    })
  }
  if (spent()) logger.warn("p1.reconcile_budget_spent", { settled: result.settled.length, released: result.released.length })
  return result
}

/** The scheduled reconciler (F07, F08): every minute, like the job sweeper. No caller, no tenant input. */
export const p1ReservationReconciler = onSchedule(
  {
    ...RUNTIME_DEFAULTS,
    schedule: "every 1 minutes",
    maxInstances: 1,
    timeoutSeconds: RECONCILER_TIMEOUT_SECONDS,
    ingressSettings: INTERNAL_ONLY,
  },
  async () => {
    await reconcileReservations()
  }
)
