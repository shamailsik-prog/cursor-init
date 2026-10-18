import { logger } from "firebase-functions"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import { logFailure } from "../../log"
import { enqueueJob } from "../../p2/enqueue"
import { loadScreeningRegistry, type ScreeningLoad } from "./candidates"
import type { Subject } from "./match"
import { NameIndexUnavailable } from "./nameIndex"
import { NAME_REINDEX_JOB_TYPE, pktHourKey } from "./reindexJob"

/**
 * The screening registry for runConflictCheck and openMatter (audit F37; spec 2026-10-18-f37 ruling 5). When the
 * firm's name index cannot be trusted (missing, another schema, behind the registry, unreadable) the screen is
 * refused with 503 `screening_unavailable`: no check is written and no matter is opened. A reconciliation job is
 * enqueued for the firm (one per PKT hour, however many calls are refused), so the refusal clears itself once it
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
 * Enqueues the firm's on-demand `d1.conflict.reindex` run for the current PKT hour (a system job, in its own
 * transaction). A failure is logged and swallowed: the caller's refusal stands either way, and the daily run
 * or the next refused call enqueues it again.
 */
export async function requestReindex(firmId: string, nowMs: number): Promise<void> {
  const period = pktHourKey(nowMs)
  const key = `${NAME_REINDEX_JOB_TYPE}:stale:${period}`
  try {
    await adminDb().runTransaction((tx) =>
      enqueueJob(
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
    )
  } catch (err) {
    logFailure("conflict reindex enqueue failed", err)
  }
}
