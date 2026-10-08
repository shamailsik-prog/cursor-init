import { describe, expect, it } from "vitest"
import { HttpError } from "../src/http/errors"
import { isContentionAbort } from "../src/d1/matter/ops"

// PR #9 CI: openMatter's round transaction gave up under lock contention (gRPC ABORTED) and the
// router answered 500 internal. A contention abort is now a moved round, never a 500.
describe("isContentionAbort (openMatter round retry)", () => {
  it("a gRPC ABORTED error (numeric code 10, or the string code) is a contention abort", () => {
    expect(isContentionAbort(Object.assign(new Error("10 ABORTED: Transaction lock timeout."), { code: 10 }))).toBe(true)
    expect(isContentionAbort(Object.assign(new Error("aborted"), { code: "aborted" }))).toBe(true)
    expect(isContentionAbort(Object.assign(new Error("ABORTED"), { code: "ABORTED" }))).toBe(true)
  })

  it("an HttpError, another gRPC code, or a non-error is not", () => {
    expect(isContentionAbort(new HttpError(409, "check_stale"))).toBe(false)
    expect(isContentionAbort(Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }))).toBe(false)
    expect(isContentionAbort(Object.assign(new Error("deadline"), { code: "deadline-exceeded" }))).toBe(false)
    expect(isContentionAbort(new Error("boom"))).toBe(false)
    expect(isContentionAbort(undefined)).toBe(false)
    expect(isContentionAbort("aborted")).toBe(false)
  })
})
