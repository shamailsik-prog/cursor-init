import { createHash } from "node:crypto"
import { FieldValue, type DocumentData, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { JobError } from "../../p2/errors"
import type { JobContext, JobHandler, JobResult } from "../../p2/registry"
import { isSafeDocId } from "../../p5/common"

/**
 * `d1.entity.candidateSignal` (audit F36): the production fan-out consumer for `entity.candidate`.
 * It reads the event the fan-out job names, validates the pair payload, and records a firm-level
 * signal counter partners can inspect in ops (`counters/{firmId}_entity_candidate_signal`).
 * The review queue itself still reads `entity_links`; this job is the durable downstream automation
 * path the P2 event bus was built for.
 */

export const ENTITY_CANDIDATE_SIGNAL_JOB_TYPE = "d1.entity.candidateSignal"

type Payload = { eventId: string }

const invalid = () => new JobError("invalid_payload", { permanent: true })

function parse(payload: unknown): Payload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw invalid()
  const keys = Object.keys(payload)
  const { eventId } = payload as Record<string, unknown>
  if (keys.length !== 1 || typeof eventId !== "string" || eventId === "") throw invalid()
  return { eventId }
}

function pairKeyFromPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null
  const ids = (payload as Record<string, unknown>).entityIds
  if (!Array.isArray(ids) || ids.length !== 2 || !ids.every((id) => typeof id === "string" && isSafeDocId(id))) return null
  return [...ids].sort().join("_")
}

function signalCounterRef(firmId: string) {
  return adminDb().collection("counters").doc(`${firmId}_entity_candidate_signal`)
}

async function run(ctx: JobContext<Payload>): Promise<JobResult> {
  const snap = await adminDb().collection("events").doc(ctx.payload.eventId).get()
  if (!snap.exists) throw new JobError("event_missing", { permanent: true })
  const event = snap.data() as DocumentData
  if (event.firmId !== ctx.job.firmId) throw new JobError("event_firm_mismatch", { permanent: true })
  if (event.name !== "entity.candidate") throw new JobError("event_name_mismatch", { permanent: true })
  const pairKey = pairKeyFromPayload(event.payload)
  if (pairKey === null) throw new JobError("event_payload_invalid", { permanent: true })

  const stepId = `signal-${createHash("sha256").update(ctx.payload.eventId, "utf8").digest("hex").slice(0, 32)}`
  await ctx.runFenced(stepId, async (tx: Transaction) => {
    tx.set(
      signalCounterRef(ctx.job.firmId),
      {
        lastEventId: ctx.payload.eventId,
        lastPairKey: pairKey,
        lastSignaledAt: FieldValue.serverTimestamp(),
        signalCount: FieldValue.increment(1),
      },
      { merge: true }
    )
  })
  return {}
}

const errorCodes = {
  event_missing: "The named event row does not exist.",
  event_firm_mismatch: "The event belongs to another firm.",
  event_name_mismatch: "The event is not an entity.candidate event.",
  event_payload_invalid: "The event payload does not name a candidate pair.",
} as const

export const entityCandidateSignalHandler: JobHandler<Payload> = {
  jobType: ENTITY_CANDIDATE_SIGNAL_JOB_TYPE,
  saga: false,
  errorCodes,
  parse,
  run,
}
