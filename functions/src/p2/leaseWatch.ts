import type { DocumentReference } from "firebase-admin/firestore"
import { JOB_LEASE_WATCH_POLL_MS } from "./constants"
import type { JobRow } from "./enqueue"
import { LeaseLostError } from "./errors"

/** Whether this claim's fence still holds (same check as the finish commit). */
export function leaseFenceHolds(row: JobRow | undefined, owner: string): boolean {
  return row?.status === "running" && row.lease?.owner === owner
}

/**
 * While a handler runs, polls the job row and calls `onLost` when the claim's lease fence no longer
 * holds (reclaim, lease overwrite, or status change). The first check runs immediately; then every
 * `pollMs` until `stop()` is called.
 */
export function startLeaseFenceWatch(
  ref: DocumentReference,
  owner: string,
  onLost: (err: LeaseLostError) => void,
  readRow: (ref: DocumentReference) => Promise<JobRow | undefined>,
  pollMs: number = JOB_LEASE_WATCH_POLL_MS
): () => void {
  let stopped = false
  let lost = false
  const check = async (): Promise<void> => {
    if (stopped || lost) return
    try {
      const row = await readRow(ref)
      if (!leaseFenceHolds(row, owner)) {
        lost = true
        onLost(new LeaseLostError())
      }
    } catch {
      // A read failure is retryable; the next poll or the budget/lease recovery path will decide.
    }
  }
  void check()
  const timer = setInterval(() => void check(), pollMs)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/** Production read used by the worker. */
export async function readJobRowForLeaseWatch(ref: DocumentReference): Promise<JobRow | undefined> {
  const snap = await ref.get()
  return snap.exists ? (snap.data() as JobRow) : undefined
}
