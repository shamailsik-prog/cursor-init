import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { ENTITY_CANDIDATE_SIGNAL_JOB_TYPE } from "../src/d1/entity/candidateSignalJob"
import { deliveryRef, EVENT_FANOUT_DELIVERIES } from "../src/p2/eventFanoutDelivery"
import { fanOutEvent, fanOutKey, SUBSCRIBERS } from "../src/p2/fanout"
import { repairFanoutForEvent, reconcileEventFanout } from "../src/p2/fanoutReconcile"
import { jobIdFor } from "../src/p2/enqueue"
import { runJobTask } from "../src/p2/worker"
import { EMULATORS, uniq } from "./emu"
import { FakeClock, T0, installTestHandlers, newFirm, readJob, removeTestHandlers, testDeps } from "./jobs"

describe.skipIf(!EMULATORS)("P2 event fan-out production (F36)", () => {
  const clock = { clock: () => T0 }
  let firmId: string
  let eventId: string
  let data: Record<string, unknown>

  beforeEach(async () => {
    installTestHandlers()
    firmId = await newFirm()
    eventId = uniq("evt")
    data = {
      name: "entity.candidate",
      firmId,
      classification: "confidential",
      payload: { entityIds: ["a", "b"], mergeEventId: null, score: 0.99 },
    }
  })
  afterEach(removeTestHandlers)

  it("registers a production subscriber for entity.candidate", () => {
    expect(SUBSCRIBERS.map((s) => s.id)).toEqual(["entity-candidate-signal"])
    expect(SUBSCRIBERS[0].jobType).toBe(ENTITY_CANDIDATE_SIGNAL_JOB_TYPE)
  })

  it("fan-out enqueues the signal job, writes a delivery row, and the handler records the firm counter", async () => {
    await adminDb().collection("events").doc(eventId).set(data)
    const sub = SUBSCRIBERS[0]
    const jobId = jobIdFor(firmId, ENTITY_CANDIDATE_SIGNAL_JOB_TYPE, fanOutKey(eventId, sub.id))

    expect(await fanOutEvent(eventId, data, clock)).toEqual({ created: [jobId], reused: [] })

    const delivery = await deliveryRef(eventId, sub.id).get()
    expect(delivery.exists).toBe(true)
    expect(delivery.data()).toMatchObject({
      eventId,
      subscriberId: sub.id,
      firmId,
      eventName: "entity.candidate",
      jobId,
    })

    await runJobTask({ jobId, seq: 0 }, testDeps(new FakeClock(T0 + 1000)))
    const job = await readJob(jobId)
    expect(job.status).toBe("done")

    const counter = await adminDb().collection("counters").doc(`${firmId}_entity_candidate_signal`).get()
    expect(counter.data()).toMatchObject({ lastEventId: eventId, lastPairKey: "a_b", signalCount: 1 })
  })

  it("the reconciler backfills fan-out when the delivery row is missing but the event exists", async () => {
    await adminDb().collection("events").doc(eventId).set(data)
    const sub = SUBSCRIBERS[0]
    expect((await deliveryRef(eventId, sub.id).get()).exists).toBe(false)
    expect(await repairFanoutForEvent(eventId, data, clock)).toBe(true)
    const sweep = await reconcileEventFanout(clock)
    expect(sweep.repaired).toBeGreaterThanOrEqual(0)
    expect((await deliveryRef(eventId, sub.id).get()).exists).toBe(true)
    const deliveries = await adminDb().collection(EVENT_FANOUT_DELIVERIES).where("eventId", "==", eventId).get()
    expect(deliveries.size).toBe(1)
    const jobId = jobIdFor(firmId, ENTITY_CANDIDATE_SIGNAL_JOB_TYPE, fanOutKey(eventId, sub.id))
    expect((await readJob(jobId)).jobType).toBe(ENTITY_CANDIDATE_SIGNAL_JOB_TYPE)
  })

  it("a redelivered fan-out reuses the job and does not duplicate the delivery row", async () => {
    await adminDb().collection("events").doc(eventId).set(data)
    const first = await fanOutEvent(eventId, data, clock)
    const second = await fanOutEvent(eventId, data, clock)
    expect(first.created).toHaveLength(1)
    expect(second).toEqual({ created: [], reused: first.created })
    const deliveries = await adminDb().collection(EVENT_FANOUT_DELIVERIES).where("eventId", "==", eventId).get()
    expect(deliveries.size).toBe(1)
  })
})
