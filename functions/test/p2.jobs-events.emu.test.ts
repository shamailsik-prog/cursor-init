import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { logger } from "firebase-functions"
import { adminDb } from "../src/admin"
import { fanOutEvent } from "../src/p2/fanout"
import { jobIdFor } from "../src/p2/enqueue"
import { jobTestSeam } from "../src/p2/registry"
import { EMULATORS, uniq } from "./emu"
import { T0, installTestHandlers, jobAuditRows, newFirm, readJob, removeTestHandlers } from "./jobs"

describe.skipIf(!EMULATORS)("P2 events fan-out (P3-15)", () => {
  const marker = "SECRET-NOTE-MARKER-7f3a"
  const clock = { clock: () => T0 }
  let firmId: string
  let eventId: string
  let data: Record<string, unknown>

  beforeEach(async () => {
    installTestHandlers()
    jobTestSeam.subscribers = [{ id: "diag", eventNames: ["entity.candidate"], jobType: "test.event" }]
    firmId = await newFirm()
    eventId = uniq("evt")
    data = { name: "entity.candidate", firmId, classification: "confidential", payload: { entityIds: ["a", "b"], note: marker } }
    await adminDb().collection("events").doc(eventId).set(data)
  })
  afterEach(() => {
    jobTestSeam.subscribers = []
    removeTestHandlers()
    vi.restoreAllMocks()
  })

  it("one job per matching subscriber, keyed eventId:subscriberId, carrying only the event id", async () => {
    const id = jobIdFor(firmId, "test.event", `${eventId}:diag`)
    expect(await fanOutEvent(eventId, data, clock)).toEqual({ created: [id], reused: [] })
    expect(await readJob(id)).toMatchObject({
      jobType: "test.event",
      firmId,
      classification: "confidential",
      matterId: null,
      payload: { eventId },
      inputRefs: [`events/${eventId}`],
      idempotencyKey: `${eventId}:diag`,
      createdBy: "system",
    })
    expect((await jobAuditRows(id)).map((r) => r.action)).toEqual(["job.enqueue"])
  })

  it("a redelivered trigger reuses the job and writes no second audit row", async () => {
    const id = jobIdFor(firmId, "test.event", `${eventId}:diag`)
    await fanOutEvent(eventId, data, clock)
    const before = await readJob(id)
    expect(await fanOutEvent(eventId, data, clock)).toEqual({ created: [], reused: [id] })
    expect((await readJob(id)).updateTime.isEqual(before.updateTime)).toBe(true)
    expect(await jobAuditRows(id)).toHaveLength(1)
  })

  it("no matching subscriber, no job", async () => {
    const e2 = uniq("evt")
    expect(await fanOutEvent(e2, { ...data, name: "matter.created" }, clock)).toEqual({ created: [], reused: [] })
    const snap = await adminDb().collection("jobs").where("idempotencyKey", "==", `${e2}:diag`).get()
    expect(snap.empty).toBe(true)
  })

  it("a payload value in the event never appears in the job", async () => {
    const id = jobIdFor(firmId, "test.event", `${eventId}:diag`)
    await fanOutEvent(eventId, data, clock)
    const { updateTime: _u, ...row } = await readJob(id)
    expect(JSON.stringify(row)).not.toContain(marker)
    expect(JSON.stringify(await jobAuditRows(id))).not.toContain(marker)
  })

  it("an unknown label reads as privileged-restricted; matterIdOf sets the matter", async () => {
    jobTestSeam.subscribers = [
      { id: "m", eventNames: ["entity.candidate"], jobType: "test.event", matterIdOf: (e) => (e.payload as { matterId: string }).matterId },
    ]
    const e2 = uniq("evt")
    const id = jobIdFor(firmId, "test.event", `${e2}:m`)
    const ev = { ...data, classification: "secret", payload: { matterId: "m-1" } }
    expect(await fanOutEvent(e2, ev, clock)).toEqual({ created: [id], reused: [] })
    expect(await readJob(id)).toMatchObject({ classification: "privileged-restricted", matterId: "m-1" })
  })

  it("two matching subscribers get two jobs from one transaction", async () => {
    jobTestSeam.subscribers = [
      { id: "a", eventNames: ["entity.candidate"], jobType: "test.event" },
      { id: "b", eventNames: ["entity.candidate", "x"], jobType: "test.event" },
    ]
    const ids = ["a", "b"].map((s) => jobIdFor(firmId, "test.event", `${eventId}:${s}`))
    expect(await fanOutEvent(eventId, data, clock)).toEqual({ created: ids, reused: [] })
  })

  it("an event without firmId is logged and ignored", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    expect(await fanOutEvent("e-nofirm", { name: "entity.candidate" }, clock)).toEqual({ created: [], reused: [] })
    expect(warn).toHaveBeenCalledWith("event.fanout_ignored", { eventId: "e-nofirm" })
  })
})
