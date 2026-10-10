import { createHash, randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { HttpError } from "../src/http/errors"
import { createRouter, type Route } from "../src/http/router"
import type { Operation, Session } from "../src/p5/common"
import { enqueueJob, enqueueJobs, jobIdFor, jobKey, jobsRef, type JobSpec } from "../src/p2/enqueue"
import { EMULATORS, mintIdToken, mockRes, uniq } from "./emu"
import { T0, diagSpec, enqueueAt, jobAuditRows, newFirm, readJob } from "./jobs"

/** Transactional enqueue (spec P3-2, P3-4, P3-18) and the router's Idempotency-Key pass-through. */

const claims = (firmId: string, role: string) => ({ firmId, role, clearanceLevel: "privileged-restricted" })

/** A payload object nested `levels` deep (the payload itself is level 1). */
function nested(levels: number): Record<string, unknown> {
  let v: Record<string, unknown> = { leaf: 1 }
  for (let i = 1; i < levels; i++) v = { a: v }
  return v
}

const enqueueAll = (specs: JobSpec[], now = T0) => adminDb().runTransaction((tx) => enqueueJobs(tx, specs, { now }))

describe.skipIf(!EMULATORS)("P2 enqueue (P3-2, P3-4)", () => {
  it("enqueueJob creates an engine row with the P3-2 fields, timed from the caller's clock", async () => {
    const firm = await newFirm()
    const partnerUid = uniq("uid")
    const spec = diagSpec(firm, { behaviour: "succeed" }, { createdBy: partnerUid, idempotencyKey: "k1" })
    const { jobId, reused } = await enqueueAt(spec, T0)
    expect(reused).toBe(false)
    expect(jobId).toBe(jobIdFor(firm, "platform.diagnostic", "k1"))
    const row = await readJob(jobId)
    expect(row).toMatchObject({
      engine: "p2",
      schemaVersion: 1,
      firmId: firm,
      jobType: "platform.diagnostic",
      classification: "internal",
      matterId: null,
      payload: { behaviour: "succeed" },
      payloadHash: createHash("sha256").update('{"behaviour":"succeed"}').digest("hex"),
      inputRefs: [],
      outputRefs: [],
      idempotencyKey: "k1",
      runKey: null,
      status: "queued",
      attempts: 0,
      totalAttempts: 0,
      maxAttempts: 4,
      manualRetries: 0,
      lease: null,
      dispatchSeq: 0,
      lastError: null,
      createdBy: partnerUid,
      requeues: [],
      cancellation: null,
      startedAt: null,
      finishedAt: null,
    })
    for (const f of ["nextAttemptAt", "dispatchedAt", "createdAt", "updatedAt"] as const) expect(row[f]?.toMillis()).toBe(T0)
    // The sweeper may act on a new row once the dispatch grace has passed (P3-34); no re-dispatch yet (P3-35).
    expect(row.sweepAt?.toMillis()).toBe(T0 + 30_000)
    expect(row.redispatches).toBe(0)
    expect(row.traceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.logs.map((l) => [l.event, l.attempt])).toEqual([["enqueued", 0]])
    expect(row.logs[0].at.toMillis()).toBe(T0)
  })

  it("a repeated key reuses the row; a different payload, label or matter is 409 job_key_conflict", async () => {
    const firm = await newFirm()
    const spec = diagSpec(firm, { behaviour: "succeed" }, { inputRefs: ["clients/c1"] })
    const { jobId } = await enqueueAt(spec, T0)
    const before = await readJob(jobId)
    expect(await enqueueAt(spec, T0 + 5)).toEqual({ jobId, reused: true })
    expect((await readJob(jobId)).updateTime.isEqual(before.updateTime)).toBe(true)
    const seededMatterId = uniq("matter")
    for (const over of [{ payload: { behaviour: "permanent" } }, { classification: "confidential" as const }, { matterId: seededMatterId }]) {
      const err = await enqueueAt({ ...spec, ...over }, T0).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HttpError)
      expect(err).toMatchObject({ status: 409, code: "job_key_conflict" })
    }
    expect((await readJob(jobId)).updateTime.isEqual(before.updateTime)).toBe(true)
  })

  it("a rolled-back transaction leaves no row", async () => {
    const firm = await newFirm()
    const spec = diagSpec(firm, { behaviour: "succeed" })
    const id = jobIdFor(firm, spec.jobType, spec.idempotencyKey)
    await expect(
      adminDb().runTransaction(async (tx) => {
        await enqueueJob(tx, spec, { now: T0 })
        throw new Error("caller failed after enqueue")
      })
    ).rejects.toThrow(/caller failed/)
    expect((await jobsRef().doc(id).get()).exists).toBe(false)
    expect(await jobAuditRows(id)).toEqual([])
  })

  it("invalid specs throw before any write", async () => {
    const firm = await newFirm()
    const base = () => diagSpec(firm, { behaviour: "succeed" })
    const tooMany = Array.from({ length: 21 }, (_, i) => `clients/c${i}`)
    const cases: Array<[string, Partial<JobSpec> | Record<string, unknown>]> = [
      ["jobType", { jobType: "nope.type" }],
      ["classification", { classification: "secret" }],
      ["matterId", { matterId: undefined }],
      ["matterId", { matterId: "a/b" }],
      ["payload", { payload: { s: "x".repeat(16_400) } }],
      ["payload", { payload: { d: new Date() } }],
      ["payload", { payload: { n: Number.NaN } }],
      ["payload", { payload: { u: undefined } }],
      ["payload", { payload: [] }],
      ["payload", { payload: { "": 1 } }],
      ["payload", { payload: { nested: { "": 1 } } }],
      ["payload", { payload: { __x__: 1 } }],
      ["payload", { payload: { list: [{ __proto_key__: 1 }] } }],
      ["payload", { payload: { a: [[1]] } }],
      ["payload", { payload: nested(21) }],
      ["inputRefs", { inputRefs: tooMany }],
      ["inputRefs", { inputRefs: ["a/b/c"] }],
      ["inputRefs", { inputRefs: ["../x"] }],
      ["createdBy", { createdBy: "a/b" }],
      ["idempotencyKey", { idempotencyKey: "" }],
      ["idempotencyKey", { idempotencyKey: "k".repeat(513) }],
    ]
    for (const [field, over] of cases) {
      const spec = { ...base(), ...over } as JobSpec
      const err = await enqueueAt(spec, T0).catch((e: unknown) => e)
      expect(err, field).toBeInstanceOf(Error)
      expect((err as Error).message, field).toBe(`enqueue: invalid ${field}`)
      if (typeof spec.idempotencyKey === "string" && spec.idempotencyKey !== "") {
        expect((await jobsRef().doc(jobIdFor(firm, String(spec.jobType), spec.idempotencyKey)).get()).exists, field).toBe(false)
      }
    }
    // Whatever a case's key was (including the invalid keys, which the per-key check skips), the
    // firm has no job row at all: nothing was written by any rejected spec.
    expect((await jobsRef().where("firmId", "==", firm).get()).size).toBe(0)
    // A bad spec anywhere in a batch rejects the whole call before any write.
    const good = base()
    await expect(enqueueAll([good, { ...base(), jobType: "nope.type" }])).rejects.toThrow("enqueue: invalid jobType")
    expect((await jobsRef().doc(jobIdFor(firm, good.jobType, good.idempotencyKey)).get()).exists).toBe(false)
    // The error names the field only, never the value.
    const secret = "42101-1234567-1"
    const err = (await enqueueAt({ ...base(), createdBy: `${secret}/x` }, T0).catch((e: unknown) => e)) as Error
    expect(err.message).not.toContain(secret)
    // Nesting of exactly 20 levels (the payload object is level 1) and an ordinary list of maps are accepted.
    const deep = await enqueueAt({ ...base(), idempotencyKey: uniq("deep"), payload: nested(20) }, T0)
    expect((await readJob(deep.jobId)).payload).toEqual(nested(20))
    const listed = await enqueueAt({ ...base(), idempotencyKey: uniq("list"), payload: { list: [{ a: 1 }, 2, "x"], _single: 1, "a__": 2 } }, T0)
    expect(listed.reused).toBe(false)
    // A payload whose canonical JSON is exactly 16 384 bytes is accepted.
    const exact = { s: "x".repeat(16_384 - '{"s":""}'.length) }
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(16_384)
    const ok = await enqueueAt({ ...base(), payload: exact }, T0)
    expect(ok.reused).toBe(false)
    expect((await readJob(ok.jobId)).payload).toEqual(exact)
  })

  it("one enqueueJobs per transaction: a second call after a write fails (the SDK refuses the read) and nothing is written", async () => {
    // The module cannot throw its own error: runTransaction re-runs the callback with the same
    // Transaction object on a retry, so a per-transaction mark would reject a correct retry.
    const firm = await newFirm()
    const first = diagSpec(firm, { behaviour: "succeed" })
    const second = diagSpec(firm, { behaviour: "succeed" })
    const err = await adminDb()
      .runTransaction(async (tx) => {
        await enqueueJobs(tx, [first], { now: T0 })
        await enqueueJobs(tx, [second], { now: T0 })
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/all reads|before all writes|read.*after.*write/i)
    expect((await jobsRef().where("firmId", "==", firm).get()).size).toBe(0)
    // The supported form, both specs in one call, commits both.
    const both = await enqueueAll([first, second])
    expect(both.map((r) => r.reused)).toEqual([false, false])
  })

  it("one call with the same key twice: identical → one row (second reused); different → 409", async () => {
    const firm = await newFirm()
    const s = diagSpec(firm, { behaviour: "succeed" })
    const jobId = jobIdFor(firm, s.jobType, s.idempotencyKey)
    expect(await enqueueAll([s, s])).toEqual([
      { jobId, reused: false },
      { jobId, reused: true },
    ])
    expect(await jobAuditRows(jobId)).toHaveLength(1)
    const t = diagSpec(firm, { behaviour: "succeed" })
    await expect(enqueueAll([t, { ...t, payload: { behaviour: "permanent" } }])).rejects.toMatchObject({ status: 409, code: "job_key_conflict" })
    expect((await jobsRef().doc(jobIdFor(firm, t.jobType, t.idempotencyKey)).get()).exists).toBe(false)
  })

  it("system-created jobs stage one job.enqueue audit row; an HTTP-caused one stages none", async () => {
    const firm = await newFirm()
    const { jobId: sysId } = await enqueueAt(diagSpec(firm, { behaviour: "succeed" }), T0)
    const { jobId: userId } = await enqueueAt(diagSpec(firm, { behaviour: "succeed" }, { createdBy: uniq("uid") }), T0)
    expect(await jobAuditRows(sysId)).toEqual([
      expect.objectContaining({
        actorId: "system",
        onBehalfOf: "system",
        action: "job.enqueue",
        target: `jobs/${sysId}`,
        decision: "allow",
        reason: "ok",
        classification: "internal",
        firmId: firm,
      }),
    ])
    expect(await jobAuditRows(userId)).toEqual([])
    // A reuse stages no second row.
    await enqueueAt({ ...diagSpec(firm, { behaviour: "succeed" }), idempotencyKey: (await readJob(sysId)).idempotencyKey }, T0)
    expect(await jobAuditRows(sysId)).toHaveLength(1)
  })

  it("the router gives a POST op session.idempotencyKey and a GET op none; jobKey appends the suffix", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const seen: Record<string, Session> = {}
    const probe = (name: string): Operation => ({
      auth: "firm",
      kind: "general",
      action: "test.probe",
      target: "test",
      run: async (session) => {
        seen[name] = session
        return { ok: true }
      },
    })
    const routes: Route[] = [
      { method: "POST", path: "/api/t/jobs/postProbe", handler: probe("post"), kind: "general" },
      { method: "GET", path: "/api/t/jobs/getProbe", handler: probe("get"), kind: "general" },
    ]
    const router = createRouter(routes, { now: () => T0 })
    // The router's idempotency layer requires a UUID v4 key, so the probe uses one.
    const key = randomUUID()
    const base = { authorization: `Bearer ${partner.token}`, "x-firm-id": firmId, "x-forwarded-for": "203.0.113.7" }
    const post = mockRes()
    await router(
      {
        method: "POST",
        path: "/api/t/jobs/postProbe",
        headers: { ...base, "content-type": "application/json", "idempotency-key": key },
        body: {},
        rawBody: Buffer.from("{}"),
        ip: "127.0.0.1",
      } as never,
      post.res as never
    )
    expect(post.out.status).toBe(200)
    const get = mockRes()
    await router(
      { method: "GET", path: "/api/t/jobs/getProbe", headers: { ...base, "idempotency-key": key }, body: {}, query: {}, ip: "127.0.0.1" } as never,
      get.res as never
    )
    expect(get.out.status).toBe(200)
    const postSession = seen.post,
      getSession = seen.get
    expect(postSession.idempotencyKey).toBe(key)
    expect(postSession.now).toBe(T0)
    expect(getSession.idempotencyKey).toBeUndefined()
    expect("idempotencyKey" in getSession).toBe(false)
    expect(postSession.route).toBe("POST /api/t/jobs/postProbe")
    expect(getSession.route).toBeUndefined()
    expect("route" in getSession).toBe(false)
    expect(jobKey(postSession, "ocr")).toBe(`${postSession.caller.uid}:POST /api/t/jobs/postProbe:${key}:ocr`)
    expect(() => jobKey(getSession, "ocr")).toThrow(/no idempotency key/)
  })
})
