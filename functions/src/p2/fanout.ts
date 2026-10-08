import type { DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { isKnownClassification } from "../p5/classification"
import type { JobDeps } from "./dispatch"
import { enqueueJobs, type JobSpec } from "./enqueue"
import { handlerFor, jobTestSeam } from "./registry"

/**
 * Events fan-out (spec P3-15): each new `events/{eventId}` row becomes one job per registered
 * subscriber whose `eventNames` include the event's name. The job carries only the event id; the
 * handler reads the event itself. The job id is derived from `${eventId}:${subscriber.id}`, so a
 * redelivered trigger reuses the rows (delivery is at least once).
 */

export type Subscriber = {
  id: string
  eventNames: readonly string[]
  jobType: string
  matterIdOf?: (event: DocumentData) => string | null
}

/** Production subscribers. 3a registers none (P3-15). */
export const SUBSCRIBERS: readonly Subscriber[] = []

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

export async function fanOutEvent(
  eventId: string,
  data: DocumentData | undefined,
  deps: Pick<JobDeps, "clock">
): Promise<{ created: string[]; reused: string[] }> {
  const firmId: unknown = data?.firmId
  if (typeof firmId !== "string" || firmId === "") {
    logger.warn("event.fanout_ignored", { eventId })
    return { created: [], reused: [] }
  }
  const event = data as DocumentData
  const subscribers = [...SUBSCRIBERS, ...jobTestSeam.subscribers]
  validateSubscribers(subscribers)
  const classification: Classification = isKnownClassification(event.classification) ? event.classification : "privileged-restricted"
  const specs: JobSpec[] = subscribers
    .filter((s) => typeof event.name === "string" && s.eventNames.includes(event.name))
    .map((s) => ({
      firmId,
      jobType: s.jobType,
      classification,
      matterId: s.matterIdOf?.(event) ?? null,
      payload: { eventId },
      inputRefs: [`events/${eventId}`],
      idempotencyKey: `${eventId}:${s.id}`,
      createdBy: "system",
    }))
  if (specs.length === 0) return { created: [], reused: [] }
  const results = await adminDb().runTransaction((tx) => enqueueJobs(tx, specs, { now: deps.clock() }))
  return {
    created: results.filter((r) => !r.reused).map((r) => r.jobId),
    reused: results.filter((r) => r.reused).map((r) => r.jobId),
  }
}

