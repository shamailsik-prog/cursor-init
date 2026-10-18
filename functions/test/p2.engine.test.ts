import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { assertJobTimings, JOB_STATUSES } from "../src/p2/constants"
import { diagnosticHandler } from "../src/p2/diagnostic"
import { canonicalJson, jobIdFor } from "../src/p2/enqueue"
import { JobError, sanitizeError } from "../src/p2/errors"
import { JOB_HANDLERS, handlerFor, jobTestSeam } from "../src/p2/registry"

/** Pure P2 job-engine units (spec P3-2, P3-4, P3-6, P3-9, P3-17). */

describe("P2 engine units", () => {
  it("jobIdFor: 'j' + 40 hex of SHA-256(firmId NUL jobType NUL key); the firm is in the hash", () => {
    const id = jobIdFor("f1", "platform.diagnostic", "k1")
    expect(id).toBe("j" + createHash("sha256").update("f1\0platform.diagnostic\0k1").digest("hex").slice(0, 40))
    expect(jobIdFor("f2", "platform.diagnostic", "k1")).not.toBe(id)
  })

  it("assertJobTimings: lease ≥ timeout + 60 s, budget < timeout", () => {
    expect(() => assertJobTimings(600_000, 300, 240_000)).not.toThrow()
    expect(() => assertJobTimings(360_000, 300, 240_000)).not.toThrow()
    expect(() => assertJobTimings(359_999, 300, 240_000)).toThrow(/lease/)
    expect(() => assertJobTimings(600_000, 300, 300_000)).toThrow(/budget/)
  })

  it("sanitizeError: declared codes keep a fixed message; everything else is internal; raw text never survives", () => {
    const h = diagnosticHandler,
      cnic = "42101-1234567-1"
    expect(sanitizeError(new JobError("diag_failure"), h)).toEqual({ code: "diag_failure", message: "Diagnostic failure (planned).", permanent: false })
    expect(sanitizeError(new JobError("diag_permanent", { permanent: true }), h)).toEqual({
      code: "diag_permanent",
      message: "Diagnostic permanent failure (planned).",
      permanent: true,
    })
    expect(sanitizeError(new JobError("invalid_payload"), h)).toMatchObject({ code: "invalid_payload", permanent: true })
    expect(sanitizeError(new JobError("undeclared"), h)).toEqual({ code: "internal", message: "The job failed with an internal error.", permanent: false })
    expect(sanitizeError(new JobError("Bad-Code"), { errorCodes: { "Bad-Code": "x" } }).code).toBe("internal")
    expect(sanitizeError(Object.assign(new Error(`UNAVAILABLE ${cnic}`), { code: 14 }), h)).toEqual({
      code: "store_unavailable",
      message: "The data store was unavailable.",
      permanent: false,
    })
    expect(JSON.stringify(sanitizeError(new Error(`CNIC ${cnic}`), h))).not.toContain("42101")
  })

  it("sanitizeError: unknown_job_type is permanent; a handler code without a handler is internal; non-errors are internal", () => {
    expect(sanitizeError(new JobError("unknown_job_type"))).toEqual({ code: "unknown_job_type", message: "The job type is not registered.", permanent: true })
    expect(sanitizeError(new JobError("diag_failure")).code).toBe("internal")
    expect(sanitizeError(new JobError("handler_timeout"))).toEqual({ code: "handler_timeout", message: "The job exceeded its time budget.", permanent: false })
    expect(sanitizeError("a string 42101-1234567-1")).toEqual({ code: "internal", message: "The job failed with an internal error.", permanent: false })
    expect(sanitizeError(Object.assign(new Error("x"), { code: 17 })).code).toBe("internal")
    expect(sanitizeError(new JobError("constructor"), diagnosticHandler).code).toBe("internal")
  })

  it("diagnostic parse accepts the five behaviours and rejects everything else as permanent invalid_payload", () => {
    expect(diagnosticHandler.parse({ behaviour: "fail_times", failTimes: 4 })).toEqual({ behaviour: "fail_times", failTimes: 4 })
    for (const behaviour of ["succeed", "throw_raw", "permanent", "hang"]) {
      expect(diagnosticHandler.parse({ behaviour, marker: "m" })).toEqual({ behaviour, marker: "m" })
    }
    for (const bad of [
      { behaviour: "explode" },
      { behaviour: "fail_times" },
      { behaviour: "fail_times", failTimes: 5 },
      { behaviour: "fail_times", failTimes: 0 },
      { behaviour: "fail_times", failTimes: 1.5 },
      { behaviour: "succeed", extra: 1 },
      { behaviour: "throw_raw", marker: "x".repeat(65) },
      { behaviour: "throw_raw", marker: 7 },
      null,
      [],
    ])
      expect(() => diagnosticHandler.parse(bad)).toThrow(expect.objectContaining({ code: "invalid_payload", permanent: true }))
  })

  it("canonicalJson sorts keys recursively", () =>
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 1, e: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"e":2,"f":1}]},"b":1}'))

  it("the registry holds platform.diagnostic, the two 3b un-merge saga types, auto-confirm and the F37 name index reconciliation only; handlerFor prefers production over the test seam", () => {
    expect([...JOB_HANDLERS.keys()]).toEqual(["platform.diagnostic", "d1.unmerge.links", "d1.unmerge.checks", "d1.autoconfirm", "d1.conflict.reindex"])
    expect(handlerFor("platform.diagnostic")).toBe(diagnosticHandler)
    expect(handlerFor("test.saga")).toBeUndefined()
    const fake = { ...diagnosticHandler, jobType: "test.saga", saga: true }
    jobTestSeam.handlers.set("test.saga", fake)
    jobTestSeam.handlers.set("platform.diagnostic", fake)
    try {
      expect(handlerFor("test.saga")).toBe(fake)
      expect(handlerFor("platform.diagnostic")).toBe(diagnosticHandler)
    } finally {
      jobTestSeam.handlers.clear()
    }
  })

  it("JOB_STATUSES are the six P3-3 statuses in order", () =>
    expect(JOB_STATUSES).toEqual(["queued", "running", "failed", "done", "dead_lettered", "cancelled"]))
})
