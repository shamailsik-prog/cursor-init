import { Timestamp } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Classification } from "@/platform/p1/types"
import type { Caller } from "../src/p5/auth"
import { jobTestSeam, type JobHandler } from "../src/p2/registry"
import { atMatterLabel, jobView, visibilityOf } from "../src/p2/view"

// P3-11: who sees a job row, and what a view carries. Pure: no emulator.
const FIRM = "firm-v"
const at = (ms: number) => Timestamp.fromMillis(ms)
const T = Date.parse("2026-10-08T09:00:00Z")

const caller = (role: string, clearanceLevel: Classification = "privileged-restricted", firmId = FIRM): Caller =>
  ({ uid: `u-${role}`, firmId, role, clearanceLevel }) as Caller

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: "p2",
    schemaVersion: 1,
    firmId: FIRM,
    jobType: "platform.diagnostic",
    classification: "confidential",
    matterId: "m1",
    payload: { behaviour: "succeed", marker: "secret-payload-value" },
    payloadHash: "abc",
    inputRefs: ["documents/d1"],
    outputRefs: ["counters/c1"],
    idempotencyKey: "secret-key",
    runKey: null,
    status: "queued",
    attempts: 0,
    totalAttempts: 0,
    maxAttempts: 4,
    manualRetries: 0,
    nextAttemptAt: at(T),
    lease: { owner: "w1", expiresAt: at(T + 600_000) },
    dispatchSeq: 0,
    dispatchedAt: at(T),
    traceId: "trace-1",
    lastError: null,
    logs: [{ at: at(T), event: "enqueued", attempt: 0 }],
    createdBy: "system",
    requeues: [],
    cancellation: null,
    fencedSteps: { "step-a": { at: at(T), attempt: 1 } },
    createdAt: at(T),
    updatedAt: at(T),
    startedAt: null,
    finishedAt: null,
    ...over,
  }
}

const sagaHandler: JobHandler = {
  jobType: "test.view-saga",
  saga: true,
  errorCodes: {},
  parse: (p) => p,
  run: async () => ({}),
}

describe("visibilityOf (P3-11)", () => {
  it("a matter job: full for a cleared member partner, associate or clerk; restricted for a non-member partner; none otherwise", () => {
    for (const role of ["partner", "associate", "clerk"]) {
      expect([role, "member", visibilityOf(caller(role), row(), true)]).toEqual([role, "member", "full"])
    }
    expect(visibilityOf(caller("partner"), row(), false)).toBe("restricted")
    expect(visibilityOf(caller("associate"), row(), false)).toBe("none")
    expect(visibilityOf(caller("clerk"), row(), false)).toBe("none")
  })

  it("a firm-level job (matterId null): full for a partner only, member or not", () => {
    for (const isMember of [true, false]) {
      expect(visibilityOf(caller("partner"), row({ matterId: null }), isMember)).toBe("full")
      expect(visibilityOf(caller("associate"), row({ matterId: null }), isMember)).toBe("none")
      expect(visibilityOf(caller("clerk"), row({ matterId: null }), isMember)).toBe("none")
    }
  })

  it("clearance: at the job's label is visible, below it is none (whatever the role, member or not, matter or firm-level)", () => {
    for (const role of ["partner", "associate", "clerk"]) {
      for (const isMember of [true, false]) {
        for (const matterId of ["m1", null]) {
          const job = row({ matterId })
          expect(visibilityOf(caller(role, "internal"), job, isMember)).toBe("none")
          const atLabel = visibilityOf(caller(role, "confidential"), job, isMember)
          expect(atLabel).toBe(visibilityOf(caller(role), job, isMember))
        }
      }
    }
  })

  it("intern, accounts and client never see a job, member or not", () => {
    for (const role of ["intern", "accounts", "client"]) {
      for (const isMember of [true, false]) {
        expect(visibilityOf(caller(role), row(), isMember)).toBe("none")
        expect(visibilityOf(caller(role), row({ matterId: null }), isMember)).toBe("none")
      }
    }
  })

  it("missing, another firm's, an unknown label, or a row that is not an engine row: none", () => {
    expect(visibilityOf(caller("partner"), undefined, true)).toBe("none")
    expect(visibilityOf(caller("partner", "privileged-restricted", "other-firm"), row(), true)).toBe("none")
    expect(visibilityOf(caller("partner"), row({ classification: "top-secret" }), true)).toBe("none")
    expect(visibilityOf(caller("partner"), row({ classification: "constructor" }), true)).toBe("none")
    const { engine: _e, ...legacy } = row()
    void _e
    expect(visibilityOf(caller("partner"), legacy, true)).toBe("none")
    expect(visibilityOf(caller("partner"), row({ engine: "next" }), true)).toBe("none")
  })
})

describe("atMatterLabel (audit F14)", () => {
  const matter = (classification: unknown, firmId: unknown = FIRM) => ({ firmId, classification })
  const LABELS: Classification[] = ["public", "internal", "confidential", "privileged", "privileged-restricted"]

  it("a matter job takes the stricter of its own label and its matter's current label, for every pair", () => {
    for (const [i, jobLabel] of LABELS.entries()) {
      for (const [j, matterLabel] of LABELS.entries()) {
        const effective = atMatterLabel(row({ classification: jobLabel }), matter(matterLabel))?.classification
        expect([jobLabel, matterLabel, effective]).toEqual([jobLabel, matterLabel, LABELS[Math.max(i, j)]])
      }
    }
  })

  it("a raised matter label hides the job from a member cleared for the job's own label, and shows the raised label to one cleared for it", () => {
    const job = row({ classification: "internal" })
    expect(visibilityOf(caller("clerk", "confidential"), job, true)).toBe("full")
    const raised = atMatterLabel(job, matter("privileged-restricted"))
    expect(visibilityOf(caller("clerk", "confidential"), raised, true)).toBe("none")
    expect(visibilityOf(caller("partner", "confidential"), raised, false)).toBe("none")
    expect(visibilityOf(caller("clerk"), raised, true)).toBe("full")
    expect(jobView("j1", raised!, "full", { logs: false }).classification).toBe("privileged-restricted")
    // The stored row is not rewritten.
    expect(job.classification).toBe("internal")
  })

  it("a matter job whose matter is missing, another firm's, or of an unknown label, or whose own label is unknown, is hidden", () => {
    expect(atMatterLabel(row(), null)).toBeUndefined()
    expect(atMatterLabel(row(), matter("internal", "other-firm"))).toBeUndefined()
    expect(atMatterLabel(row(), matter("top-secret"))).toBeUndefined()
    expect(atMatterLabel(row(), matter("constructor"))).toBeUndefined()
    expect(atMatterLabel(row(), matter(undefined))).toBeUndefined()
    expect(atMatterLabel(row({ classification: "constructor" }), matter("internal"))).toBeUndefined()
    expect(atMatterLabel(undefined, matter("internal"))).toBeUndefined()
    expect(visibilityOf(caller("partner"), atMatterLabel(row(), null), true)).toBe("none")
  })

  it("a firm-level job keeps its own label and rule, whatever matter is passed", () => {
    const firmLevel = row({ matterId: null })
    for (const m of [null, matter("privileged-restricted"), matter("top-secret", "other-firm")]) {
      expect(atMatterLabel(firmLevel, m)).toBe(firmLevel)
    }
    expect(visibilityOf(caller("partner", "confidential"), atMatterLabel(firmLevel, null), false)).toBe("full")
  })
})

describe("jobView (P3-11)", () => {
  beforeEach(() => {
    jobTestSeam.handlers.set(sagaHandler.jobType, sagaHandler)
  })
  afterEach(() => {
    jobTestSeam.handlers.delete(sagaHandler.jobType)
  })

  it("the restricted view hides the matter, refs and logs; no view carries payload, payloadHash, idempotencyKey or lease", () => {
    const v = jobView("j1", row(), "restricted", { logs: true })
    expect(v.matterId).toBe("restricted")
    for (const key of ["inputRefs", "outputRefs", "logs", "payload", "payloadHash", "idempotencyKey", "lease"]) expect(v).not.toHaveProperty(key)
    const full = jobView("j1", row(), "full", { logs: true })
    for (const key of ["payload", "payloadHash", "idempotencyKey", "lease", "dispatchSeq", "requeues", "cancellation", "fencedSteps"]) expect(full).not.toHaveProperty(key)
    expect(JSON.stringify([v, full])).not.toContain("secret-payload-value")
    expect(JSON.stringify([v, full])).not.toContain("step-a")
    expect(JSON.stringify([v, full])).not.toContain("secret-key")
  })

  it("the full view carries the refs, and the logs only when asked, with ISO times", () => {
    const v = jobView("j1", row(), "full", { logs: true })
    expect(v).toMatchObject({
      jobId: "j1",
      jobType: "platform.diagnostic",
      status: "queued",
      matterId: "m1",
      classification: "confidential",
      attempts: 0,
      maxAttempts: 4,
      totalAttempts: 0,
      manualRetries: 0,
      maxManualRetries: 3,
      nextAttemptAt: new Date(T).toISOString(),
      createdAt: new Date(T).toISOString(),
      startedAt: null,
      finishedAt: null,
      createdBy: "system",
      traceId: "trace-1",
      runKey: null,
      lastError: null,
      inputRefs: ["documents/d1"],
      outputRefs: ["counters/c1"],
      logs: [{ at: new Date(T).toISOString(), event: "enqueued", attempt: 0 }],
    })
    expect(jobView("j1", row(), "full", { logs: false })).not.toHaveProperty("logs")
    expect(jobView("j1", row({ matterId: null }), "full", { logs: false }).matterId).toBeNull()
  })

  it("lastError keeps only its code and fixed message", () => {
    const v = jobView("j1", row({ status: "dead_lettered", lastError: { code: "internal", message: "The job failed with an internal error.", extra: "x" } }), "full", { logs: false })
    expect(v.lastError).toEqual({ code: "internal", message: "The job failed with an internal error." })
  })

  it("retryable: dead-lettered with fewer than 3 manual retries", () => {
    const cases: Array<[string, number, boolean]> = [
      ["dead_lettered", 0, true],
      ["dead_lettered", 2, true],
      ["dead_lettered", 3, false],
      ["failed", 0, false],
      ["queued", 0, false],
      ["running", 0, false],
      ["done", 0, false],
      ["cancelled", 0, false],
    ]
    for (const [status, manualRetries, retryable] of cases) {
      expect([status, manualRetries, jobView("j", row({ status, manualRetries }), "full", { logs: false }).retryable]).toEqual([status, manualRetries, retryable])
    }
  })

  it("cancellable: queued, failed or dead-lettered, of a registered type that is not a saga", () => {
    for (const status of ["queued", "failed", "dead_lettered"]) {
      expect([status, jobView("j", row({ status }), "full", { logs: false }).cancellable]).toEqual([status, true])
      expect([status, "saga", jobView("j", row({ status, jobType: sagaHandler.jobType }), "full", { logs: false }).cancellable]).toEqual([status, "saga", false])
      expect([status, "unregistered", jobView("j", row({ status, jobType: "gone.type" }), "full", { logs: false }).cancellable]).toEqual([status, "unregistered", false])
    }
    for (const status of ["running", "done", "cancelled"]) {
      expect([status, jobView("j", row({ status }), "restricted", { logs: false }).cancellable]).toEqual([status, false])
    }
  })
})
