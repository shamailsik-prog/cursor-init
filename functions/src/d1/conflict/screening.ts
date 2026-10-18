import type { Transaction } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import { logFailure } from "../../log"
import { enqueueJob } from "../../p2/enqueue"
import { loadScreeningRegistry, type ScreeningLoad } from "./candidates"
import type { Subject } from "./match"
import { NameIndexUnavailable } from "./nameIndex"
import { NAME_REINDEX_JOB_TYPE, pktMinuteKey } from "./reindexJob"
import { registryStateOf, registryVersionRef, type RegistryState } from "../registryVersion"

/**
 * The screening registry for runConflictCheck and openMatter (audit F37; spec 2026-10-18-f37 ruling 5). When the
 * firm's name index cannot be trusted (missing, another schema, behind the registry, unreadable) the screen is
 * refused with 503 `screening_unavailable`: no check is written and no matter is opened. A reconciliation job is
 * enqueued for the firm (one per PKT minute, however many calls are refused), so the refusal clears itself once it
 * runs. Never a silent CLEAR, and never the old O(registry) read on the request path.
 */
export async function screeningRegistry(
  firmId: string,
  subjects: readonly Subject[],
  subjectEntityIds: readonly (string | undefined)[],
  now: Date
): Promise<ScreeningLoad> {
  try {
    return await loadScreeningRegistry(firmId, subjects, subjectEntityIds, now)
  } catch (err) {
    if (!(err instanceof NameIndexUnavailable)) throw err
    logger.warn("conflict.screening_unavailable", { firmId, reason: err.reason })
    await requestReindex(firmId, now.getTime())
    throw new HttpError(503, "screening_unavailable")
  }
}

/**
 * The run key of the firm's on-demand reindex for a PKT minute and the counter's confirmation count (`nameIndexEpoch`,
 * PR #89 review, Codex 4307586920). Every reconciliation run that confirms the index current moves the count in its
 * confirming transaction, so a key is never reused once its run has confirmed: a break (or a refusal) after that
 * reads the new count and gets a run of its own, while every break and refusal before it, in that minute, shares the
 * one pending run (a bulk import makes one run per minute, not one per row). The minute stays in the key so a run
 * that ended without confirming (dead-lettered) is replaced by the next minute's request.
 */
export const reindexRunKey = (period: string, epoch: number): string => `${NAME_REINDEX_JOB_TYPE}:stale:${period}:c${epoch}`

/**
 * Stages, in `tx`, the firm's on-demand `d1.conflict.reindex` run for the PKT minute of `nowMs` and the confirmation
 * count of `state` (the counter read in `tx`): created, or the pending one reused. Reads (the job doc) before it writes.
 */
export async function enqueueReindexTx(tx: Transaction, firmId: string, nowMs: number, state: RegistryState): Promise<void> {
  const period = pktMinuteKey(nowMs)
  const key = reindexRunKey(period, state.nameIndexEpoch)
  await enqueueJob(
    tx,
    {
      firmId,
      jobType: NAME_REINDEX_JOB_TYPE,
      classification: "internal",
      matterId: null,
      payload: { period },
      idempotencyKey: key,
      runKey: key,
      createdBy: "system",
    },
    { now: nowMs }
  )
}

/**
 * Enqueues the firm's on-demand reindex run (`enqueueReindexTx`) in its own transaction, after reading the counter: a
 * refused screen calls it, so every refusal is backed by a run that confirms after it. A failure is logged and
 * swallowed: the caller's refusal stands either way, and the next refused call or the daily run enqueues it again.
 */
export async function requestReindex(firmId: string, nowMs: number): Promise<void> {
  try {
    await adminDb().runTransaction(async (tx) => {
      const counter = await tx.get(registryVersionRef(firmId))
      await enqueueReindexTx(tx, firmId, nowMs, registryStateOf(counter.exists, counter.data()))
    })
  } catch (err) {
    logFailure("conflict reindex enqueue failed", err)
  }
}
