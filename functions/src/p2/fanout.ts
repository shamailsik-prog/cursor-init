import { createHash } from "node:crypto"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { HttpError } from "../http/errors"
import { isKnownClassification } from "../p5/classification"
import { isFirestoreDocId, isSafeDocId } from "../p5/common"
import type { JobDeps } from "./dispatch"
import {
  deliveryTargetsFromEnqueue,
  readFanoutDeliverySnaps,
  stageFanoutDeliveries,
} from "./eventFanoutDelivery"
import { enqueueJobs, isSafeRef, type JobSpec } from "./enqueue"
import { entityCandidateSignalHandler } from "../d1/entity/candidateSignalJob"
import { handlerFor, jobTestSeam } from "./registry"

/**
 * Events fan-out (spec P3-15): each new `events/{eventId}` row becomes one job per registered
 * subscriber whose `eventNames` include the event's name. The job carries only the event id; the
 * handler reads the event itself. Each successful enqueue also writes `event_fanout_deliveries`
 * (audit F36). The idempotency key is `<sha256-hex(eventId)>:<subscriberId>`
 * (`fanOutKey`), so a redelivered trigger reuses the rows (delivery is at least once) and the key
 * stays far below the 512-character cap whatever the event id's length (P3-15 amendment).
 */

/** The fan-out job's idempotency key: deterministic, and free of the raw event id. */
export function fanOutKey(eventId: string, subscriberId: string): string {
  return `${createHash("sha256").update(eventId, "utf8").digest("hex")}:${subscriberId}`
}

export type Subscriber = {
  id: string
  eventNames: readonly string[]
  jobType: string
  matterIdOf?: (event: DocumentData) => string | null
}

/**
 * Production subscribers (audit F36). Each entry must name a registered `jobType` and must not listen
 * to `job.*` events (validated at load).
 */
export const SUBSCRIBERS: readonly Subscriber[] = [
  {
    id: "entity-candidate-signal",
    eventNames: ["entity.candidate"],
    jobType: entityCandidateSignalHandler.jobType,
  },
]

/** Production subscribers whose `eventNames` include `eventName` (test seam excluded). */
export function productionSubscribersForEvent(eventName: string): readonly Subscriber[] {
  return SUBSCRIBERS.filter((s) => s.eventNames.includes(eventName))
}

/**
 * The matter an event names (audit F14 R3-D1): its `payload.matterId`, the platform's event contract (matter.created,
 * the matter stage events and the draft events carry it). `undefined` when the event names no matter (absent or null).
 * Any other value is returned as is, so an unusable one fails the subscriber closed rather than reading as "no matter".
 */
export function matterNamedBy(event: DocumentData): unknown {
  const payload: unknown = event.payload
  if (payload === null || typeof payload !== "object") return undefined
  const named = (payload as Record<string, unknown>).matterId
  return named === null ? undefined : named
}

/** Throws on a duplicate id, an unregistered job type, or a `job.*` event name (a job-event loop). */
export function validateSubscribers(list: readonly Subscriber[]): void {
  const seen = new Set<string>()
  for (const s of list) {
    if (seen.has(s.id)) throw new Error(`duplicate subscriber: ${s.id}`)
    seen.add(s.id)
    if (!handlerFor(s.jobType)) throw new Error(`unregistered job type: ${s.jobType}`)
    if (s.eventNames.some((n) => n.startsWith("job."))) throw new Error(`subscriber ${s.id} listens to job.* events`)
  }
}

validateSubscribers(SUBSCRIBERS)

/**
 * Fan-out is at least once: the trigger runs with `retry: true`, so only a transient (store)
 * error may propagate. Permanent causes never throw, or a retry would loop for the platform's
 * 7-day window: an event id Firestore would not accept as a document id (logged by code only, as
 * `event_id_invalid`), an unsafe firmId, a subscriber whose `matterIdOf` throws or yields an unsafe id
 * (that subscriber alone is skipped, logged by id and code), and a 409 `job_key_conflict`
 * (logged by code; the transaction rolled back, so the whole event is dropped rather than
 * retried without the conflicting spec, which keeps the rule simple). Nothing logged carries an
 * event value.
 *
 * Audit F14 R3-D1: a job for an event that names a matter (`matterNamedBy`) is a matter job. A
 * subscriber without `matterIdOf` takes the event's matter; one whose `matterIdOf` yields no
 * matter for such an event is skipped (logged as `matter_event_without_matter`), because a
 * firm-level job carrying `events/<id>` would be judged against no matter's label or membership.
 */
export async function fanOutEvent(
  eventId: string,
  data: DocumentData | undefined,
  deps: Pick<JobDeps, "clock">
): Promise<{ created: string[]; reused: string[] }> {
  const none = { created: [], reused: [] }
  if (!isFirestoreDocId(eventId)) {
    logger.warn("event.fanout_ignored", { code: "event_id_invalid" })
    return none
  }
  // A valid id longer than a safe ref (e.g. `${matterId}_created`, 136 characters) travels in the
  // payload only: enqueue's ref validation stays strict, and the handler reads the event by payload id.
  const eventRef = `events/${eventId}`
  const inputRefs = isSafeRef(eventRef) ? [eventRef] : []
  const firmId: unknown = data?.firmId
  if (!isSafeDocId(firmId)) {
    logger.warn("event.fanout_ignored", { eventId })
    return none
  }
  const event = data as DocumentData
  const subscribers = [...SUBSCRIBERS, ...jobTestSeam.subscribers]
  validateSubscribers(subscribers)
  const classification: Classification = isKnownClassification(event.classification) ? event.classification : "privileged-restricted"
  const named = matterNamedBy(event)
  const specs: JobSpec[] = []
  const subscriberIds: string[] = []
  for (const s of subscribers) {
    if (typeof event.name !== "string" || !s.eventNames.includes(event.name)) continue
    // A subscriber's matterIdOf decides; without one, the job takes the matter the event names (audit F14 R3-D1).
    let matterId: unknown
    try {
      matterId = s.matterIdOf ? (s.matterIdOf(event) ?? null) : (named ?? null)
    } catch {
      logger.warn("event.fanout_subscriber_skipped", {
        eventId,
        subscriber: s.id,
        code: "matter_id_threw",
      })
      continue
    }
    if (matterId !== null && !isSafeDocId(matterId)) {
      logger.warn("event.fanout_subscriber_skipped", {
        eventId,
        subscriber: s.id,
        code: "matter_id_invalid",
      })
      continue
    }
    // A matter's event never makes a firm-level job: its ref (events/<id>, whose id may embed the matter's id) would be
    // judged against no matter. Fail closed: that subscriber gets no job (audit F14 R3-D1).
    if (matterId === null && named !== undefined) {
      logger.warn("event.fanout_subscriber_skipped", {
        eventId,
        subscriber: s.id,
        code: "matter_event_without_matter",
      })
      continue
    }
    specs.push({
      firmId,
      jobType: s.jobType,
      classification,
      matterId,
      payload: { eventId },
      inputRefs,
      idempotencyKey: fanOutKey(eventId, s.id),
      createdBy: "system",
    })
    subscriberIds.push(s.id)
  }
  if (specs.length === 0) return none
  const eventName = typeof event.name === "string" ? event.name : ""
  try {
    const now = deps.clock()
    const results = await adminDb().runTransaction(async (tx) => {
      const deliverySnaps = await readFanoutDeliverySnaps(
        tx,
        eventId,
        subscriberIds.map((id) => ({ subscriberId: id }))
      )
      const enqueued = await enqueueJobs(tx, specs, { now })
      const targets = deliveryTargetsFromEnqueue(eventName, subscriberIds, enqueued)
      stageFanoutDeliveries(tx, firmId, eventId, targets, deliverySnaps, Timestamp.fromMillis(now))
      return enqueued
    })
    return {
      created: results.filter((r) => !r.reused).map((r) => r.jobId),
      reused: results.filter((r) => r.reused).map((r) => r.jobId),
    }
  } catch (err) {
    if (err instanceof HttpError && err.code === "job_key_conflict") {
      logger.warn("event.fanout_conflict", { eventId, code: err.code })
      return none
    }
    throw err
  }
}
