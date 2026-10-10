import { HttpError } from "../http/errors"

/**
 * gRPC INVALID_ARGUMENT (3) texts that mean "this transaction is gone", not a bad request: the
 * emulator's closed transaction, and the expired transaction the Admin SDK itself retries
 * (its isRetryableTransactionError matches /transaction has expired/).
 */
const DEAD_TRANSACTION =
  /Transaction is invalid or closed|transaction has expired/i

/**
 * A Firestore transaction that gave up under lock contention after its maxAttempts. In openMatter and
 * registerClient it wrote nothing, so it is a moved round, not a 500 (PR #9 CI). Either gRPC ABORTED (code 10), or gRPC
 * INVALID_ARGUMENT (code 3) for a dead transaction: under load a transactional read waits out the
 * emulator's 2s lock timeout (10 ABORTED), gax's stream retry re-sends it on the transaction that abort
 * closed, and the "3 INVALID_ARGUMENT: Transaction is invalid or closed." that comes back is not
 * retried by the SDK runner. Any other INVALID_ARGUMENT is a bug and stays a 500.
 */
export function isContentionAbort(err: unknown): boolean {
  if (!(err instanceof Error) || err instanceof HttpError) return false
  const code = (err as { code?: unknown }).code
  if (
    code === 10 ||
    (typeof code === "string" && code.toLowerCase() === "aborted")
  )
    return true
  return code === 3 && DEAD_TRANSACTION.test(err.message)
}
