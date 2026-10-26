import { JobError } from "./errors"

/** The error handlers should treat as a budget overrun when `signal` aborts. */
export function handlerTimeoutFromSignal(signal: AbortSignal): JobError {
  const reason = signal.reason
  if (reason instanceof JobError && reason.code === "handler_timeout") return reason
  return new JobError("handler_timeout")
}

/**
 * Resolves after `ms` or rejects when `signal` aborts (typically the worker's handler budget).
 * The timer is unref'd so a stray delay never holds the process open.
 */
export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw handlerTimeoutFromSignal(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(handlerTimeoutFromSignal(signal))
    }
    signal.addEventListener("abort", onAbort)
  })
}
