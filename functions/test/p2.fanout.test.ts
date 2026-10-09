import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { validateSubscribers, type Subscriber } from "../src/p2/fanout"
import { installTestHandlers, removeTestHandlers } from "./jobs"

describe("P2 subscriber validation (P3-15)", () => {
  beforeEach(installTestHandlers)
  afterEach(removeTestHandlers)

  it("validateSubscribers: unique ids, registered types, no job.* events", () => {
    const ok: Subscriber = { id: "s1", eventNames: ["entity.candidate"], jobType: "platform.diagnostic" }
    expect(() => validateSubscribers([ok])).not.toThrow()
    expect(() => validateSubscribers([ok, ok])).toThrow(/duplicate subscriber/)
    expect(() => validateSubscribers([{ ...ok, jobType: "nope" }])).toThrow(/unregistered job type/)
    for (const n of ["job.failed", "job.deadLettered"]) expect(() => validateSubscribers([{ ...ok, eventNames: [n] }])).toThrow(/job\.\* events/)
  })

  it("a type registered only in the test seam is accepted while it is installed", () => {
    expect(() => validateSubscribers([{ id: "s", eventNames: ["x"], jobType: "test.event" }])).not.toThrow()
    removeTestHandlers()
    expect(() => validateSubscribers([{ id: "s", eventNames: ["x"], jobType: "test.event" }])).toThrow(/unregistered job type/)
  })
})
