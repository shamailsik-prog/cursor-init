import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { logger } from "firebase-functions"
import { adminDb } from "../src/admin"
import { fanOutEvent, type Subscriber } from "../src/p2/fanout"
import { jobIdFor } from "../src/p2/enqueue"
import { jobTestSeam } from "../src/p2/registry"
import { EMULATORS, uniq } from "./emu"
import { FakeClock, T0, installTestHandlers, jobAuditRows, newFirm, readJob, removeTestHandlers, testDeps } from "./jobs"

/** The fan-out idempotency key (P3-15 amendment): `<sha256-hex(eventId)>:<subscriberId>`. */
const keyOf = (eventId: string, subscriberId: string) => `${createHash("sha256").update(eventId, "utf8").digest("hex")}:${subscriberId}`

/** Runs `fn` with `subs` as the test subscribers, restoring the seam even if `fn` throws. */
async function withSubscribers<T>(subs: Subscriber[], fn: () => Promise<T>): Promise<T> {
  const saved = jobTestSeam.subscribers
  jobTestSeam.subscribers = subs
  try {
    return await fn()
  } finally {
    jobTestSeam.subscribers = saved
  }
}

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
    data = {
      name: "entity.candidate",
      firmId,
      classification: "confidential",
      payload: { entityIds: ["a", "b"], note: marker },
    }
    await adminDb().collection("events").doc(eventId).set(data)
  })
  afterEach(() => {
    jobTestSeam.subscribers = []
    removeTestHandlers()
    vi.restoreAllMocks()
  })

  it("one job per matching subscriber, keyed sha256(eventId):subscriberId, carrying only the event id", async () => {
    const id = jobIdFor(firmId, "test.event", keyOf(eventId, "diag"))
    expect(await fanOutEvent(eventId, data, clock)).toEqual({
      created: [id],
      reused: [],
    })
    expect(await readJob(id)).toMatchObject({
      jobType: "test.event",
      firmId,
      classification: "confidential",
      matterId: null,
      payload: { eventId },
      inputRefs: [`events/${eventId}`],
      idempotencyKey: keyOf(eventId, "diag"),
      createdBy: "system",
    })
    expect((await jobAuditRows(id)).map((r) => r.action)).toEqual(["job.enqueue"])
  })

  it("a redelivered trigger reuses the job and writes no second audit row", async () => {
    const id = jobIdFor(firmId, "test.event", keyOf(eventId, "diag"))
    await fanOutEvent(eventId, data, clock)
    const before = await readJob(id)
    expect(await fanOutEvent(eventId, data, clock)).toEqual({
      created: [],
      reused: [id],
    })
    expect((await readJob(id)).updateTime.isEqual(before.updateTime)).toBe(true)
    expect(await jobAuditRows(id)).toHaveLength(1)
  })

  it("no matching subscriber, no job", async () => {
    const e2 = uniq("evt")
    expect(await fanOutEvent(e2, { ...data, name: "matter.created" }, clock)).toEqual({ created: [], reused: [] })
    const snap = await adminDb().collection("jobs").where("idempotencyKey", "==", keyOf(e2, "diag")).get()
    expect(snap.empty).toBe(true)
  })

  it("a payload value in the event never appears in the job", async () => {
    const id = jobIdFor(firmId, "test.event", keyOf(eventId, "diag"))
    await fanOutEvent(eventId, data, clock)
    const { updateTime: _u, ...row } = await readJob(id)
    expect(JSON.stringify(row)).not.toContain(marker)
    expect(JSON.stringify(await jobAuditRows(id))).not.toContain(marker)
  })

  it("an unknown label reads as privileged-restricted; matterIdOf sets the matter", async () => {
    const subs: Subscriber[] = [
      {
        id: "m",
        eventNames: ["entity.candidate"],
        jobType: "test.event",
        matterIdOf: (e) => (e.payload as { matterId: string }).matterId,
      },
    ]
    const e2 = uniq("evt")
    const id = jobIdFor(firmId, "test.event", keyOf(e2, "m"))
    const ev = {
      ...data,
      classification: "secret",
      payload: { matterId: "m-1" },
    }
    expect(await withSubscribers(subs, () => fanOutEvent(e2, ev, clock))).toEqual({ created: [id], reused: [] })
    expect(await readJob(id)).toMatchObject({
      classification: "privileged-restricted",
      matterId: "m-1",
    })
  })

  it("two matching subscribers get two jobs from one transaction", async () => {
    const subs: Subscriber[] = [
      { id: "a", eventNames: ["entity.candidate"], jobType: "test.event" },
      { id: "b", eventNames: ["entity.candidate", "x"], jobType: "test.event" },
    ]
    const ids = ["a", "b"].map((s) => jobIdFor(firmId, "test.event", keyOf(eventId, s)))
    expect(await withSubscribers(subs, () => fanOutEvent(eventId, data, clock))).toEqual({ created: ids, reused: [] })
  })

  it("an event without firmId is logged and ignored", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    expect(await fanOutEvent("e-nofirm", { name: "entity.candidate" }, clock)).toEqual({ created: [], reused: [] })
    expect(warn).toHaveBeenCalledWith("event.fanout_ignored", {
      eventId: "e-nofirm",
    })
  })

  it("an unsafe firmId is logged and ignored, not thrown", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    for (const bad of ["a/b", "__x__", "x".repeat(129), 7]) {
      expect(await fanOutEvent(eventId, { ...data, firmId: bad }, clock)).toEqual({ created: [], reused: [] })
    }
    expect(warn).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenCalledWith("event.fanout_ignored", { eventId })
  })

  it("a non-string event name matches no subscriber", async () => {
    for (const name of [undefined, 5, { a: 1 }]) {
      expect(await fanOutEvent(eventId, { ...data, name }, clock)).toEqual({
        created: [],
        reused: [],
      })
    }
  })

  it("a throwing or unsafe matterIdOf skips that subscriber only; the others still enqueue", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const subs: Subscriber[] = [
      {
        id: "boom",
        eventNames: ["entity.candidate"],
        jobType: "test.event",
        matterIdOf: () => {
          throw new Error(marker)
        },
      },
      {
        id: "bad",
        eventNames: ["entity.candidate"],
        jobType: "test.event",
        matterIdOf: () => "a/b",
      },
      { id: "good", eventNames: ["entity.candidate"], jobType: "test.event" },
    ]
    const good = jobIdFor(firmId, "test.event", keyOf(eventId, "good"))
    expect(await withSubscribers(subs, () => fanOutEvent(eventId, data, clock))).toEqual({ created: [good], reused: [] })
    expect(warn).toHaveBeenCalledWith("event.fanout_subscriber_skipped", {
      eventId,
      subscriber: "boom",
      code: "matter_id_threw",
    })
    expect(warn).toHaveBeenCalledWith("event.fanout_subscriber_skipped", {
      eventId,
      subscriber: "bad",
      code: "matter_id_invalid",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(marker)
  })

  it("a job_key_conflict is permanent: logged by code, nothing thrown, nothing created", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    await fanOutEvent(eventId, data, clock)
    const relabelled = { ...data, classification: "internal" }
    expect(await fanOutEvent(eventId, relabelled, clock)).toEqual({
      created: [],
      reused: [],
    })
    expect(warn).toHaveBeenCalledWith("event.fanout_conflict", {
      eventId,
      code: "job_key_conflict",
    })
  })

  it("a transient store error propagates so the platform redelivers", async () => {
    const boom = Object.assign(new Error("unavailable"), { code: 14 })
    const spy = vi.spyOn(adminDb(), "runTransaction").mockRejectedValueOnce(boom)
    await expect(fanOutEvent(eventId, data, clock)).rejects.toBe(boom)
    spy.mockRestore()
    const id = jobIdFor(firmId, "test.event", keyOf(eventId, "diag"))
    expect(await fanOutEvent(eventId, data, clock)).toEqual({
      created: [id],
      reused: [],
    })
  })
  it("a valid event id longer than a safe id (136 characters) fans out once; its redelivery is deduped", async () => {
    const longId = `${"m".repeat(128)}_created`
    expect(longId).toHaveLength(136)
    await adminDb().collection("events").doc(longId).set(data)
    const id = jobIdFor(firmId, "test.event", keyOf(longId, "diag"))
    expect(await fanOutEvent(longId, data, clock)).toEqual({ created: [id], reused: [] })
    const row = await readJob(id)
    // The raw id is carried in the payload only: the key is its hash, and the ref is omitted as unsafe.
    expect(row).toMatchObject({ payload: { eventId: longId }, idempotencyKey: keyOf(longId, "diag"), inputRefs: [] })
    expect(row.idempotencyKey).not.toContain(longId)
    expect(await fanOutEvent(longId, data, clock)).toEqual({ created: [], reused: [id] })
    expect(await jobAuditRows(id)).toHaveLength(1)
    // The handler reads the event by the payload's id.
    expect(await testDeps(new FakeClock(T0)).dispatcher.deliver({ jobId: id, seq: 0 }, T0)).toBe("done")
  })

  it("an event id Firestore rejects (reserved __x__, over 1500 bytes, '/', '.', '..', empty) is logged and skipped, never thrown", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    for (const bad of ["__x__", "é".repeat(751), "a/b", ".", "..", ""]) {
      expect(await fanOutEvent(bad, data, clock)).toEqual({ created: [], reused: [] })
    }
    expect(warn).toHaveBeenCalledTimes(6)
    for (const call of warn.mock.calls) expect(call).toEqual(["event.fanout_ignored", { code: "event_id_invalid" }])
    // 1500 bytes exactly is still a valid id.
    const edge = "e".repeat(1500)
    expect((await fanOutEvent(edge, data, clock)).created).toHaveLength(1)
  })
})
