import type { Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { diagnosticHandler } from "./diagnostic"

/**
 * The job handler contract and the production registry (spec P3-6, P3-17). A handler parses its
 * payload (a bad one throws a permanent `invalid_payload`), then `run` returns the Firestore
 * writes to stage with `done` (`apply`, no reads) and its output refs. Handlers must be
 * idempotent: delivery is at least once.
 */

export type JobContext<P> = {
  job: {
    id: string
    firmId: string
    jobType: string
    classification: Classification
    matterId: string | null
    attempt: number
    totalAttempts: number
    traceId: string
  }
  payload: P
  now(): number
  /** Runs a transaction that first re-reads the job and checks the claim's fence (Task 3). */
  runFenced<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>
}

export type JobResult = { apply?: (tx: Transaction) => void; outputRefs?: string[] }

export type JobHandler<P = unknown> = {
  jobType: string
  /** A saga step: retry needs a partner, cancel is refused (P3-12, P3-13). */
  saga: boolean
  /** The handler's own error codes and their fixed messages (P3-9). */
  errorCodes: Readonly<Record<string, string>>
  parse(payload: unknown): P
  run(ctx: JobContext<P>): Promise<JobResult>
}

/** Production job types. 3a registers only the diagnostic type (P3-1, P3-17). */
export const JOB_HANDLERS: ReadonlyMap<string, JobHandler> = new Map<string, JobHandler>([
  [diagnosticHandler.jobType, diagnosticHandler as JobHandler],
])

/** Test-only registrations (e.g. a saga-flagged type). Never set in production code. */
export const jobTestSeam: { handlers: Map<string, JobHandler> } = { handlers: new Map() }

/** The handler for `jobType`: the production registry first, then the test seam. */
export function handlerFor(jobType: string): JobHandler | undefined {
  return JOB_HANDLERS.get(jobType) ?? jobTestSeam.handlers.get(jobType)
}
