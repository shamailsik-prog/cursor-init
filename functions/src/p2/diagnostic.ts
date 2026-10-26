import { FieldValue, type DocumentReference } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { abortableDelay } from "./abortable"
import { JOB_LEASE_MS } from "./constants"
import { JobError } from "./errors"
import type { JobContext, JobHandler, JobResult } from "./registry"

/**
 * `platform.diagnostic` (spec P3-17): an internal job type with no entry point but code, that
 * reaches every engine path. `succeed` increments `counters/<firmId>_jobdiag_<jobId>.count` in
 * the done transaction, so the number of committed effects is observable.
 */

export type DiagnosticPayload = {
  behaviour: "succeed" | "fail_times" | "throw_raw" | "permanent" | "hang"
  failTimes?: number
  marker?: string
}

const BEHAVIOURS: ReadonlySet<string> = new Set(["succeed", "fail_times", "throw_raw", "permanent", "hang"])
const KEYS: ReadonlySet<string> = new Set(["behaviour", "failTimes", "marker"])
const MAX_MARKER = 64

const invalid = () => new JobError("invalid_payload", { permanent: true })

export function diagnosticCounterRef(firmId: string, jobId: string): DocumentReference {
  return adminDb().collection("counters").doc(`${firmId}_jobdiag_${jobId}`)
}

function parse(payload: unknown): DiagnosticPayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw invalid()
  const raw = payload as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) throw invalid()
  const { behaviour, failTimes, marker } = raw
  if (typeof behaviour !== "string" || !BEHAVIOURS.has(behaviour)) throw invalid()
  const out: DiagnosticPayload = { behaviour: behaviour as DiagnosticPayload["behaviour"] }
  if (failTimes !== undefined) {
    if (typeof failTimes !== "number" || !Number.isInteger(failTimes) || failTimes < 1 || failTimes > 4) throw invalid()
    out.failTimes = failTimes
  } else if (behaviour === "fail_times") throw invalid()
  if (marker !== undefined) {
    if (typeof marker !== "string" || marker.length > MAX_MARKER) throw invalid()
    out.marker = marker
  }
  return out
}

function succeed(ctx: JobContext<DiagnosticPayload>): JobResult {
  const { firmId, id } = ctx.job
  return {
    apply: (tx) => {
      tx.set(
        diagnosticCounterRef(firmId, id),
        { firmId, kind: "jobdiag", jobId: id, classification: "internal", count: FieldValue.increment(1) },
        { merge: true }
      )
    },
  }
}

async function run(ctx: JobContext<DiagnosticPayload>): Promise<JobResult> {
  const { behaviour, failTimes = 0, marker = "" } = ctx.payload
  switch (behaviour) {
    case "succeed":
      return succeed(ctx)
    case "fail_times":
      if (ctx.job.totalAttempts <= failTimes) throw new JobError("diag_failure")
      return succeed(ctx)
    case "throw_raw":
      // The poison case: raw text that quotes the payload must never leave sanitizeError.
      throw new Error(`diagnostic raw failure ${marker}`)
    case "permanent":
      throw new JobError("diag_permanent", { permanent: true })
    case "hang":
      // Outlasts any handler budget; aborts when the worker records handler_timeout.
      await abortableDelay(JOB_LEASE_MS, ctx.signal)
      return {}
  }
}

export const diagnosticHandler: JobHandler<DiagnosticPayload> = {
  jobType: "platform.diagnostic",
  saga: false,
  errorCodes: {
    diag_failure: "Diagnostic failure (planned).",
    diag_permanent: "Diagnostic permanent failure (planned).",
  },
  parse,
  run,
}
