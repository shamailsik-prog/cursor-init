import { JobError } from "../../p2/errors"
import type { JobContext, JobHandler, JobResult } from "../../p2/registry"
import { reconcileNameIndex, ReconcileError } from "./nameIndex"

/**
 * `d1.conflict.reindex` (audit F37; spec 2026-10-18-f37 ruling 7): the firm's name index reconciliation, off
 * the request path. Runs daily per firm (a scheduled run, `NAME_REINDEX_SPEC`), on demand when a screen finds
 * the index unavailable or a registry trigger breaks it (`screening.ts`, `registryTriggers.ts`, keyed per PKT minute), and as
 * the deploy backfill
 * (`jobs:backfill d1.conflict.reindex <day> <day>`). The work is `reconcileNameIndex`: derived from Firestore state
 * (append-only, or a reset and rebuild of a damaged index), so it is idempotent under at-least-once delivery and
 * needs no fenced step. No failure is permanent: a damaged index is rebuilt, and writes racing the run retry it.
 */

export const NAME_REINDEX_JOB_TYPE = "d1.conflict.reindex"
/** Daily at 02:35 PKT, after the 02:15 auto-confirm run. */
export const NAME_REINDEX_SPEC = { jobType: NAME_REINDEX_JOB_TYPE, cron: "35 2 * * *", period: "day" } as const

type Payload = { period: string }

const errorCodes = {
  reconcile_contended: "Registry writes that do not maintain the name index kept racing the reconciliation.",
} as const

const invalid = () => new JobError("invalid_payload", { permanent: true })

/** `{ period }`: a PKT day key (scheduled and backfill runs), or a PKT hour or minute key (an on-demand run). */
function parse(payload: unknown): Payload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw invalid()
  const raw = payload as Record<string, unknown>
  if (Object.keys(raw).length !== 1 || typeof raw.period !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}(:\d{2})?)?$/.test(raw.period)) throw invalid()
  return { period: raw.period }
}

async function run(ctx: JobContext<Payload>): Promise<JobResult> {
  try {
    await reconcileNameIndex(ctx.job.firmId)
  } catch (err) {
    if (err instanceof ReconcileError) throw new JobError(err.code, { permanent: false })
    throw err
  }
  return {}
}

export const nameReindexHandler: JobHandler<Payload> = {
  jobType: NAME_REINDEX_JOB_TYPE,
  saga: false,
  errorCodes,
  parse,
  run,
}

const PKT_OFFSET_MS = 5 * 3_600_000
const pad = (n: number, w = 2) => String(n).padStart(w, "0")

/** The PKT (UTC+5, no DST) hour key `YYYY-MM-DDTHH` of `nowMs`, as p2/scheduled.ts formats an hour period. */
export function pktHourKey(nowMs: number): string {
  const d = new Date(nowMs + PKT_OFFSET_MS)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}`
}

/** The PKT minute key `YYYY-MM-DDTHH:MM` of `nowMs`: the period of an on-demand reindex run. */
export function pktMinuteKey(nowMs: number): string {
  const d = new Date(nowMs + PKT_OFFSET_MS)
  return `${pktHourKey(nowMs)}:${pad(d.getUTCMinutes())}`
}
