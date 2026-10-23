import { FieldPath, Timestamp, type DocumentData, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminDb } from "../admin"
import { logFailure } from "../log"
import { DISPATCH_GRACE_MS, JOB_ENGINE, MAX_MANUAL_RETRIES, SWEEP_BUDGET_MS, SWEEP_LIMIT, SWEEP_MAX_PAGES } from "./constants"
import type { JobDeps } from "./dispatch"
import { jobIdFor, jobsRef, stageJobUpdate, type JobActorNote, type JobRow } from "./enqueue"
import { isSafeDocId } from "../p5/common"
import { acceptLegacyOcrJob } from "./ocrDrain"
import { backfillLegacyOcrStatusForSweep } from "./legacyOcrStatusBackfill"
import { isCompleteLegacyOcrJob, OCR_JOB_TYPE, recordLegacyOcr } from "./ocrJob"
import { appendLog } from "./worker"

/**
 * Legacy OCR sweep (FA-F04-007). `onJobCreated` drains a well-formed `ocr` row only when that row
 * is created. This sweep, once a minute, picks up the rows that trigger missed:
 * an older row that was never handed to the worker, and a row whose engine job has exhausted its
 * retries (dead-lettered) while the legacy row is still not terminal.
 *
 * A dead-lettered engine job is requeued the way a manual retry is: `queued`, attempts 0, and
 * `manualRetries` increased, up to `MAX_MANUAL_RETRIES`. At that cap the legacy row is recorded
 * failed and the engine job stays dead-lettered, so a poison job is not requeued forever.
 * Rows already `done` or `failed` are left alone. One row's error is logged and the page continues;
 * the first error is rethrown after the page so the next minute retries it.
 */

export type LegacyOcrSweepResult = {
  examined: number
  drained: number
  requeued: number
  closed: number
}

const NOTE = "OCR sweep picked up a job whose retries were exhausted"
const TERMINAL_OCR_STATUSES = ["done", "failed"]
const LEGACY_INCOMPLETE_CODE = "invalid_job"
const LEGACY_CANCELLED_CODE = "cancelled"

async function closeLegacyRow(jobId: string, firmId: string, code: string): Promise<void> {
  await recordLegacyOcr(jobId, firmId, { ocrStatus: "failed", ocrFailureCode: code })
}

type LegacyOcrQuery = () => Query

/** Legacy OCR rows the sweep can still act on (FA-F04-010). Terminal rows are excluded so the window advances. */
function legacyQuery(): Query {
  return jobsRef()
    .where("jobType", "==", "ocr")
    .where("ocrStatus", "not-in", TERMINAL_OCR_STATUSES)
    .orderBy("ocrStatus")
    .orderBy(FieldPath.documentId())
    .limit(SWEEP_LIMIT)
}

async function reviveOrClose(legacyId: string, firmId: string, engineId: string, deps: JobDeps): Promise<"requeued" | "closed" | "skipped"> {
  const engineRef = jobsRef().doc(engineId)
  const decision = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(engineRef)
    const current = snap.exists ? (snap.data() as JobRow) : undefined
    if (!current || current.engine !== JOB_ENGINE || current.status !== "dead_lettered") return { kind: "skipped" as const }
    const manual = typeof current.manualRetries === "number" ? current.manualRetries : 0
    if (!(manual < MAX_MANUAL_RETRIES)) {
      const code = current.lastError?.code
      return { kind: "capped" as const, code: typeof code === "string" && code.length > 0 ? code : "ocr_failed" }
    }
    const now = deps.clock()
    const at = Timestamp.fromMillis(now)
    const nextSeq = current.dispatchSeq + 1
    const note: JobActorNote = { by: "system", role: "system", at, note: NOTE }
    stageJobUpdate(tx, engineRef, {
      status: "queued",
      attempts: 0,
      manualRetries: manual + 1,
      nextAttemptAt: at,
      dispatchSeq: nextSeq,
      dispatchedAt: at,
      sweepAt: Timestamp.fromMillis(now + DISPATCH_GRACE_MS),
      redispatches: 0,
      updatedAt: at,
      finishedAt: null,
      requeues: [...(Array.isArray(current.requeues) ? current.requeues : []), note],
      logs: appendLog(current, "requeued", 0, now),
    })
    return { kind: "requeued" as const, seq: nextSeq }
  })
  if (decision.kind === "capped") {
    await recordLegacyOcr(legacyId, firmId, { ocrStatus: "failed", ocrFailureCode: decision.code })
    return "closed"
  }
  if (decision.kind === "skipped") return "skipped"
  await deps.dispatcher.dispatch({ jobId: engineId, seq: decision.seq })
  return "requeued"
}

async function pickUp(jobId: string, data: DocumentData, deps: JobDeps): Promise<"drained" | "requeued" | "closed" | "skipped"> {
  if (!isCompleteLegacyOcrJob(data)) {
    const firmId = data.firmId
    if (data.jobType === "ocr" && data.engine !== JOB_ENGINE && typeof firmId === "string" && isSafeDocId(firmId)) {
      await closeLegacyRow(jobId, firmId, LEGACY_INCOMPLETE_CODE)
      return "closed"
    }
    return "skipped"
  }
  if (data.ocrStatus === "done" || data.ocrStatus === "failed") return "skipped"
  const firmId = data.firmId as string
  const engineId = jobIdFor(firmId, OCR_JOB_TYPE, jobId)
  const engine = await jobsRef().doc(engineId).get()
  if (engine.exists && engine.get("engine") === JOB_ENGINE) {
    const status = engine.get("status")
    if (status === "cancelled") {
      await closeLegacyRow(jobId, firmId, LEGACY_CANCELLED_CODE)
      return "closed"
    }
    // Queued, failed and running engine rows belong to the engine sweeper. Only a dead letter,
    // which that sweeper will not run again, is picked up here.
    if (status !== "dead_lettered") return "skipped"
    return reviveOrClose(jobId, firmId, engineId, deps)
  }
  await acceptLegacyOcrJob(jobId, data, deps)
  return "drained"
}

async function sweepLegacyPages(
  query: LegacyOcrQuery,
  deps: JobDeps,
  out: LegacyOcrSweepResult,
  started: number,
  failures: unknown[]
): Promise<void> {
  const spent = () => Date.now() - started >= SWEEP_BUDGET_MS
  let after: QueryDocumentSnapshot | undefined
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    if (spent()) {
      logger.warn("ocr.sweep_budget_spent", { examined: out.examined, drained: out.drained, requeued: out.requeued })
      return
    }
    const snap = await (after === undefined ? query() : query().startAfter(after)).get()
    for (const doc of snap.docs) {
      if (spent()) break
      out.examined += 1
      try {
        const action = await pickUp(doc.id, doc.data(), deps)
        if (action === "drained") out.drained += 1
        else if (action === "requeued") out.requeued += 1
        else if (action === "closed") out.closed += 1
      } catch (err) {
        logFailure("ocr legacy sweep row failed", err)
        failures.push(err)
      }
    }
    if (snap.size < SWEEP_LIMIT) break
    after = snap.docs[snap.docs.length - 1]
  }
}

/** Drains legacy OCR rows the create trigger did not finish. Safe to run again: enqueue and requeue are capped. */
export async function sweepLegacyOcr(deps: JobDeps): Promise<LegacyOcrSweepResult> {
  const out: LegacyOcrSweepResult = { examined: 0, drained: 0, requeued: 0, closed: 0 }
  const started = Date.now()
  const failures: unknown[] = []
  await backfillLegacyOcrStatusForSweep(SWEEP_LIMIT)
  await sweepLegacyPages(legacyQuery, deps, out, started, failures)
  if (failures.length > 0) throw failures[0]
  return out
}
