import { randomUUID } from "node:crypto"
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Firestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { isClassification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { errorCode } from "../log"
import { INTERNAL_ONLY, RUNTIME_DEFAULTS } from "../runtimeOptions"
import { DECISIONS_COLLECTION, HASH_WITHHELD_NO_OUTPUT_ROW, exportFields, nextExport, seedHashScrub, type ExportStep } from "./decisionRecord"
import { OPIK_TIMEOUT_MS, exportTrace, opikConfig, type OpikConfig, type TraceRecord } from "./opik"
import type { UsageOutcome } from "./types"

/**
 * The trace export reconciler (audit F34; spec docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md,
 * ruling R11), run every 5 minutes by `p1TraceExportReconciler`.
 *
 * A call whose Opik export failed leaves its decision record `export.state: "pending"` with `nextAttemptAt`, never a log
 * line only. A run reads the records that are due (`export.state == "pending" and export.nextAttemptAt <= now`, oldest
 * first, the composite index in firestore.indexes.json), at most TRACE_EXPORT_PAGE_SIZE, under a wall-clock budget, and
 * for each:
 *
 * 1. claims it in a transaction that re-reads it and sets a lease (`export.leaseUntil`, `export.leaseToken`), only while
 *    it is still pending, due and not leased by another run;
 * 2. posts a trace rebuilt from the record alone (`traceRecordOf`): ids, hashes and metrics, never text, whatever its
 *    classification, under the same trace id;
 * 3. records the outcome in a second transaction that writes only while the record still carries this run's lease token
 *    (the fence: a run that lost its lease writes nothing, `p1.trace_export_fence_lost`). The outcome follows the state
 *    machine in decisionRecord.ts (`nextExport`): `exported`; or the attempt is counted and the record rescheduled (5, 10,
 *    20, 40 minutes); or, at the fifth attempt, `failed` with `abandonedAt`, logged `p1.trace_export_abandoned` at ERROR.
 *    Tracing turned off counts as a failed attempt (`export_disabled`), so such a record also ends `failed`, never pending
 *    for ever.
 *
 * A store failure on one record is logged by its code (`p1.trace_export_retry_failed`) and the record stays as it was, to
 * be tried on a later run; a failure of the query itself is logged at ERROR (`p1.trace_export_reconcile_failed`).
 *
 * Round 2 (FA-F34-R2-003, spec R37): each run also withholds the prompt hash of every record above rank 1 that is past its
 * `prompt.hashWithholdAtMs` with no output row (`withholdUnpublishedPromptHashes`). PR #132 review, Codex P2 (thread
 * 4369851306; spec R43): it runs first, within HASH_WITHHOLD_BUDGET_MS of the run's budget, because it needs no network and
 * an Opik backlog that spends the export loop's budget must never starve it; the export loop takes the rest.
 */

/** The schedule, as the deploy manifest records it. */
export const TRACE_EXPORT_SCHEDULE = "every 5 minutes"
/** Records a run reads. */
export const TRACE_EXPORT_PAGE_SIZE = 100
/** One run's wall-clock budget, checked before each record. */
export const TRACE_EXPORT_BUDGET_MS = 30_000
/** The reconciler function's timeout: below the five-minute schedule, so runs never overlap. */
export const TRACE_EXPORT_RECONCILER_TIMEOUT_SECONDS = 45
/** A claim's lease: longer than one export (OPIK_TIMEOUT_MS) and its two transactions, so a live run never loses it. */
export const TRACE_EXPORT_LEASE_MS = 60_000
/**
 * The share of TRACE_EXPORT_BUDGET_MS the withholding pass may use, first in each run (spec R43). One page of at most
 * TRACE_EXPORT_PAGE_SIZE Firestore transactions, no network; the export loop's deadline is the run's, so the whole run
 * stays within TRACE_EXPORT_BUDGET_MS plus one export.
 */
export const HASH_WITHHOLD_BUDGET_MS = 10_000

if (!(HASH_WITHHOLD_BUDGET_MS > 0 && HASH_WITHHOLD_BUDGET_MS < TRACE_EXPORT_BUDGET_MS)) {
  throw new Error(`the withholding share (${HASH_WITHHOLD_BUDGET_MS} ms) must be part of the run's budget (${TRACE_EXPORT_BUDGET_MS} ms)`)
}

if (!(TRACE_EXPORT_BUDGET_MS + OPIK_TIMEOUT_MS + 10_000 <= TRACE_EXPORT_RECONCILER_TIMEOUT_SECONDS * 1000)) {
  throw new Error(`trace export budget (${TRACE_EXPORT_BUDGET_MS} ms) plus one export must end 10 s before the reconciler timeout`)
}
if (!(TRACE_EXPORT_LEASE_MS >= OPIK_TIMEOUT_MS + 10_000)) {
  throw new Error(`trace export lease (${TRACE_EXPORT_LEASE_MS} ms) must outlast one export and its transactions`)
}

/**
 * Test seam only; inert when `NODE_ENV` is "production". `afterClaim` runs after a record is claimed and before it is
 * exported, so a test can take the lease from under the run (the fence).
 */
export const traceExportTestSeam: { afterClaim?: (usageLogId: string) => Promise<void> } = {}

function seam(): typeof traceExportTestSeam {
  return process.env.NODE_ENV === "production" ? {} : traceExportTestSeam
}

export type TraceExportResult = { exported: string[]; rescheduled: string[]; abandoned: string[]; skipped: string[] }

const OUTCOMES: ReadonlySet<string> = new Set<UsageOutcome>(["ok", "failed", "blocked", "reconciled"])
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)
const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0)
const strOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null)

/** Epoch milliseconds of a stored Timestamp; null for anything else. */
function millis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null
}

/**
 * The trace of a decision record, rebuilt from the record alone (R10, R11): its ids, its prompt hash and template, the
 * model, the outcome and the cost. The record holds no text, so `maskedBody` and `maskedResponse` are null and no text
 * rides along at any rank. Null when the record lacks what a trace needs (a trace id, a firm, a classification label).
 */
export function traceRecordOf(usageLogId: string, d: DocumentData): TraceRecord | null {
  if (typeof d.traceId !== "string" || typeof d.firmId !== "string" || !isClassification(d.classification)) return null
  const model = d.model !== null && typeof d.model === "object" ? (d.model as Record<string, unknown>) : {}
  const prompt = d.prompt !== null && typeof d.prompt === "object" ? (d.prompt as Record<string, unknown>) : {}
  const cost = d.cost !== null && typeof d.cost === "object" ? (d.cost as Record<string, unknown>) : {}
  const endMs = num(d.endedAtMs) ?? num(d.startedAtMs) ?? 0
  const startMs = Math.min(num(d.startedAtMs) ?? endMs, endMs)
  return {
    traceId: d.traceId,
    startMs,
    endMs,
    taskType: typeof d.taskType === "string" ? d.taskType : "committee",
    classification: d.classification,
    outcome: typeof d.outcome === "string" && OUTCOMES.has(d.outcome) ? (d.outcome as UsageOutcome) : "reconciled",
    blockReason: strOrNull(d.blockReason),
    model: typeof model.configured === "string" ? model.configured : "unknown",
    provider: typeof model.provider === "string" ? model.provider : "unknown",
    inputTokens: count(cost.inputTokens),
    outputTokens: count(cost.outputTokens),
    costMicroUsd: count(cost.costMicroUsd),
    firmId: d.firmId,
    matterId: strOrNull(d.matterId),
    usageLogId,
    maskedBody: null,
    system: null,
    maskedResponse: null,
    promptHash: strOrNull(prompt.hash),
    promptTemplateId: strOrNull(prompt.templateId),
    promptTemplateVersion: strOrNull(prompt.templateVersion),
    modelReported: strOrNull(model.reported),
  }
}

/** Claims one due record (step 1): its data, or null when it is no longer pending, not yet due, or leased by another run. */
async function claim(db: Firestore, ref: DocumentReference, nowMs: number, token: string): Promise<DocumentData | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.get("export.state") !== "pending") return null
    const due = millis(snap.get("export.nextAttemptAt"))
    if (due === null || due > nowMs) return null
    const lease = millis(snap.get("export.leaseUntil"))
    if (lease !== null && lease > nowMs) return null
    tx.update(ref, { "export.leaseUntil": Timestamp.fromMillis(nowMs + TRACE_EXPORT_LEASE_MS), "export.leaseToken": token })
    return snap.data()!
  })
}

/** Records one attempt's outcome (step 3), only while the record still carries `token`; null when the fence refused it. */
async function finish(db: Firestore, ref: DocumentReference, token: string, outcome: "exported" | "failed" | "disabled", nowMs: number): Promise<ExportStep | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.get("export.state") !== "pending" || snap.get("export.leaseToken") !== token) return null
    const step = nextExport({ attempts: snap.get("export.attempts") }, outcome, nowMs)
    tx.update(ref, { export: exportFields(step) })
    return step
  })
}

/**
 * One run (see the module comment). `now` is the clock due times and leases are compared with (the tests drive it).
 * `budgetEndsAt` (epoch ms, wall clock): the scheduled run's deadline, shared with the withholding pass before it (R43);
 * alone, a run has TRACE_EXPORT_BUDGET_MS from its start.
 */
export async function reconcileTraceExports(opts: { now?: () => number; config?: OpikConfig; budgetEndsAt?: number } = {}): Promise<TraceExportResult> {
  const now = opts.now ?? Date.now
  const cfg = opts.config ?? opikConfig()
  const db = adminDb()
  const budgetEndsAt = opts.budgetEndsAt ?? Date.now() + TRACE_EXPORT_BUDGET_MS
  const spent = () => Date.now() >= budgetEndsAt
  const result: TraceExportResult = { exported: [], rescheduled: [], abandoned: [], skipped: [] }

  let due: DocumentReference[]
  try {
    const snap = await db
      .collection(DECISIONS_COLLECTION)
      .where("export.state", "==", "pending")
      .where("export.nextAttemptAt", "<=", Timestamp.fromMillis(Math.floor(now())))
      .orderBy("export.nextAttemptAt")
      .limit(TRACE_EXPORT_PAGE_SIZE)
      .get()
    due = snap.docs.map((d) => d.ref)
  } catch (err) {
    logger.error("p1.trace_export_reconcile_failed", { code: errorCode(err) })
    return result
  }

  for (const ref of due) {
    if (spent()) {
      logger.warn("p1.trace_export_budget_spent", { exported: result.exported.length, rescheduled: result.rescheduled.length })
      break
    }
    try {
      const token = randomUUID()
      const data = await claim(db, ref, Math.floor(now()), token)
      if (data === null) {
        result.skipped.push(ref.id)
        continue
      }
      await seam().afterClaim?.(ref.id)
      const record = traceRecordOf(ref.id, data)
      const outcome = record === null ? "failed" : await exportTrace(record, cfg)
      const step = await finish(db, ref, token, outcome, Math.floor(now()))
      if (step === null) {
        logger.warn("p1.trace_export_fence_lost", { usageLogId: ref.id })
        result.skipped.push(ref.id)
        continue
      }
      if (step.state === "exported") result.exported.push(ref.id)
      else if (step.state === "failed") {
        result.abandoned.push(ref.id)
        logger.error("p1.trace_export_abandoned", { firmId: data.firmId ?? null, usageLogId: ref.id, traceId: data.traceId ?? null, attempts: step.attempts, code: step.lastCode })
      } else result.rescheduled.push(ref.id)
    } catch (err) {
      // The record keeps its state and its due time; a later run tries it again once any lease this run set has lapsed.
      logger.warn("p1.trace_export_retry_failed", { usageLogId: ref.id, code: errorCode(err) })
    }
  }
  return result
}

export type HashWithholdResult = { withheld: string[]; cleared: string[]; skipped: string[] }

/**
 * Audit F34 round 2 (FA-F34-R2-003, spec ruling R37): the records due (`prompt.hashWithholdAtMs <= now`, oldest first, one
 * single-field range, at most TRACE_EXPORT_PAGE_SIZE) are re-read in a transaction each. A record whose output was
 * published (its `output.outputId`, or a `committee_outputs` row with its usage id) only loses the time: the masked body is
 * stored beside its hash. Any other has `prompt.hash` set to null and `prompt.hashWithheld: "no_output_row"`: past the
 * idempotency marker's TTL nothing stores the body any more, and nothing will publish it, so the bare SHA-256 would be the
 * only trace of a short body and a dictionary oracle. The template id, version and pin stay, and the reservation's decision
 * seed loses its copy of the hash in the same transaction (R42). `budgetEndsAt` (epoch ms, wall clock): the end of this
 * pass's share of the scheduled run, which runs it before the export loop (R43). A failed query is logged under the
 * reconciler's `p1.trace_export_reconcile_failed` (ERROR, `step: "prompt_hash_withhold"`); a failed record is
 * `p1.prompt_hash_withhold_retry_failed` (WARN) and stays due for a later run.
 */
export async function withholdUnpublishedPromptHashes(opts: { now?: () => number; budgetEndsAt?: number } = {}): Promise<HashWithholdResult> {
  const now = opts.now ?? Date.now
  const budgetEndsAt = opts.budgetEndsAt ?? Date.now() + TRACE_EXPORT_BUDGET_MS
  const db = adminDb()
  const result: HashWithholdResult = { withheld: [], cleared: [], skipped: [] }
  let due: DocumentReference[]
  try {
    const snap = await db
      .collection(DECISIONS_COLLECTION)
      .where("prompt.hashWithholdAtMs", "<=", Math.floor(now()))
      .orderBy("prompt.hashWithholdAtMs")
      .limit(TRACE_EXPORT_PAGE_SIZE)
      .get()
    due = snap.docs.map((d) => d.ref)
  } catch (err) {
    // The reconciler's own ERROR event (no new alert line: the manifest and alerts.tf already carry this one).
    logger.error("p1.trace_export_reconcile_failed", { step: "prompt_hash_withhold", code: errorCode(err) })
    return result
  }
  for (const ref of due) {
    if (Date.now() >= budgetEndsAt) {
      logger.warn("p1.prompt_hash_withhold_budget_spent", { withheld: result.withheld.length, cleared: result.cleared.length })
      break
    }
    try {
      const step = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        const at = snap.get("prompt.hashWithholdAtMs")
        if (!snap.exists || typeof at !== "number" || at > Math.floor(now())) return "skipped" as const
        const rows = await tx.get(db.collection("committee_outputs").where("usageLogId", "==", ref.id).limit(1))
        // PR #132 review, Codex P1 (spec R42): the reservation (same id) keeps the call's decision seed, which held a copy
        // of the hash; it is cleared in this transaction too. A settlement already cleared it on every reservation settled
        // since R42 (`in_record`); this covers the ones settled before.
        const reservationRef = db.collection("ai_reservations").doc(ref.id)
        const reservation = await tx.get(reservationRef)
        if (typeof snap.get("output.outputId") === "string" || !rows.empty) {
          tx.update(ref, { "prompt.hashWithholdAtMs": FieldValue.delete() })
          return "cleared" as const
        }
        tx.update(ref, { "prompt.hash": null, "prompt.hashWithheld": HASH_WITHHELD_NO_OUTPUT_ROW, "prompt.hashWithholdAtMs": FieldValue.delete() })
        const scrub = reservation.exists ? seedHashScrub(reservation.get("decisionSeed.prompt"), HASH_WITHHELD_NO_OUTPUT_ROW) : {}
        if (Object.keys(scrub).length > 0) tx.update(reservationRef, scrub)
        return "withheld" as const
      })
      result[step].push(ref.id)
    } catch (err) {
      logger.warn("p1.prompt_hash_withhold_retry_failed", { usageLogId: ref.id, code: errorCode(err) })
    }
  }
  return result
}

/** The scheduled export reconciler (F34, R11): every 5 minutes, one instance. No caller, no tenant input. */
export const p1TraceExportReconciler = onSchedule(
  {
    ...RUNTIME_DEFAULTS,
    schedule: TRACE_EXPORT_SCHEDULE,
    maxInstances: 1,
    timeoutSeconds: TRACE_EXPORT_RECONCILER_TIMEOUT_SECONDS,
    ingressSettings: INTERNAL_ONLY,
  },
  async () => {
    const started = Date.now()
    // PR #132 review, Codex P2 (spec R43): withholding first, within its share, so an Opik backlog that spends the export
    // loop's budget cannot starve it; the export loop then has the run's remaining budget.
    await withholdUnpublishedPromptHashes({ budgetEndsAt: started + HASH_WITHHOLD_BUDGET_MS })
    await reconcileTraceExports({ budgetEndsAt: started + TRACE_EXPORT_BUDGET_MS })
  }
)
