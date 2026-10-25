import { createHash } from "node:crypto"
import { Timestamp, type DocumentData, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { MATTER_TOMBSTONES_COLLECTION, ackDocId, acksRef, requestsRef, type AckOutcome } from "./model"

/**
 * Audit F42: per-store acknowledgements and the request's completion (spec R7). A store's acknowledgement is
 * `deletion_acks/{requestId}_{storeKey}` (`acknowledged: true`) plus `acked[storeKey]` on the request, written in one
 * transaction. The transaction that records the last expected store finishes the request and stamps the tombstone.
 * A store already acknowledged keeps its first acknowledgement. Details carry codes, numbers and ISO times only.
 */

export type AckDetail = Record<string, string | number | boolean | null>

export type AckInput = {
  key: string
  storeId: string
  outcome: AckOutcome
  count: number | null
  idsSha256: string | null
  detail: AckDetail
}

/** SHA-256 of `parts` joined by NUL: the id hash an acknowledgement carries, never the ids' content. */
export function sha256(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex")
}

/** Whether every expected store has an acknowledgement in `acked` (and there is at least one expected store). */
export function isComplete(expected: readonly unknown[], acked: Record<string, unknown> | undefined): boolean {
  if (!Array.isArray(expected) || expected.length === 0 || !acked) return false
  return expected.every((key) => typeof key === "string" && Object.hasOwn(acked, key) && typeof acked[key] === "string")
}

export const requestRefOf = (requestId: string): DocumentReference => requestsRef().doc(requestId)
export const ackRefOf = (requestId: string, key: string): DocumentReference => acksRef().doc(ackDocId(requestId, key))

/**
 * Stages the acknowledgements in `tx`. Reads first (the request and each acknowledgement document), then writes, so
 * call it before any write of the transaction. Returns whether this transaction finished the request.
 */
export async function stageAcks(
  tx: Transaction,
  requestId: string,
  acks: readonly AckInput[],
  ctx: { jobId: string; nowMs: number }
): Promise<{ finished: boolean; written: number }> {
  if (acks.length === 0) return { finished: false, written: 0 }
  const reqRef = requestRefOf(requestId)
  const refs = acks.map((a) => ackRefOf(requestId, a.key))
  const [reqSnap, ...ackSnaps] = await tx.getAll(reqRef, ...refs)
  const req = reqSnap.data()
  if (!req) throw new Error("retention: request missing")
  const acked: Record<string, string> = { ...((req.acked as Record<string, string> | undefined) ?? {}) }
  const at = Timestamp.fromMillis(ctx.nowMs)
  const patch: Record<string, unknown> = {}
  let written = 0
  acks.forEach((a, i) => {
    const prior = ackSnaps[i].data()
    // The first acknowledgement of a store stands (a replay or a duplicate job never rewrites it).
    if (prior?.acknowledged === true || Object.hasOwn(acked, a.key)) return
    tx.set(refs[i], {
      firmId: req.firmId,
      requestId,
      matterId: req.matterId,
      storeId: a.storeId,
      storeKey: a.key,
      acknowledged: true,
      outcome: a.outcome,
      count: a.count,
      idsSha256: a.idsSha256,
      detail: a.detail,
      jobId: ctx.jobId,
      at,
    }, { merge: true })
    acked[a.key] = a.outcome
    patch[`acked.${a.key}`] = a.outcome
    written += 1
  })
  const finished = req.status === "in_progress" && isComplete(req.expected as unknown[], acked)
  if (finished) {
    patch.status = "completed"
    patch.completedAt = at
    tx.set(adminDb().collection(MATTER_TOMBSTONES_COLLECTION).doc(req.matterId as string), { purgeCompletedAt: at }, { merge: true })
  }
  if (Object.keys(patch).length > 0) {
    patch.updatedAt = at
    tx.update(reqRef, patch)
  }
  return { finished, written }
}

/** The request as stored, or null. */
export async function readRequest(requestId: string): Promise<DocumentData | null> {
  return (await requestRefOf(requestId).get()).data() ?? null
}
