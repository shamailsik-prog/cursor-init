import { FUNCTION_TIMEOUT_SECONDS } from "../health"
import { HttpError } from "../http/errors"

/**
 * How long a contention round loop (openMatter, registerClient) may go on starting rounds, on the real
 * clock from the start of the call (final review). Once it has passed, no new round starts and the call
 * answers 409 registry_contended, written and audited exactly as after its last round. Ten rounds, each
 * up to ten transaction attempts with the SDK's backoff, can outlast the api function's 120 s timeout,
 * which would end the call in a timeout instead of that 409. The round in flight at the deadline still
 * runs to its end.
 */
export const CONTENTION_DEADLINE_MS = 90_000

if (!(CONTENTION_DEADLINE_MS < FUNCTION_TIMEOUT_SECONDS * 1000)) {
  throw new Error(`contention deadline (${CONTENTION_DEADLINE_MS} ms) must be less than the function timeout (${FUNCTION_TIMEOUT_SECONDS} s)`)
}

/** Test seam only (the emulator suites set it; production code never does): replaces `Date.now` as the deadline's clock. */
export const contentionTestSeam: { wallClock?: () => number } = {}

/** Starts a call's contention deadline: the returned check answers true once `CONTENTION_DEADLINE_MS` of real time has passed. */
export function contentionDeadline(): () => boolean {
  const clock = contentionTestSeam.wallClock ?? Date.now
  const started = clock()
  return () => clock() - started >= CONTENTION_DEADLINE_MS
}

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
