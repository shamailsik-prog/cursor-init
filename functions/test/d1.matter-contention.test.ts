import { describe, expect, it } from "vitest"
import { HttpError } from "../src/http/errors"
import { isContentionAbort } from "../src/d1/contention"

// PR #9 CI: openMatter's round transaction gave up under lock contention (gRPC ABORTED) and the
// router answered 500 internal. A contention abort is now a moved round, never a 500.
describe("isContentionAbort (openMatter round retry)", () => {
  it("a gRPC ABORTED error (numeric code 10, or the string code) is a contention abort", () => {
    expect(isContentionAbort(Object.assign(new Error("10 ABORTED: Transaction lock timeout."), { code: 10 }))).toBe(true)
    expect(isContentionAbort(Object.assign(new Error("aborted"), { code: "aborted" }))).toBe(true)
    expect(isContentionAbort(Object.assign(new Error("ABORTED"), { code: "ABORTED" }))).toBe(true)
  })

  it("a gRPC INVALID_ARGUMENT for a closed or expired transaction is a contention abort (PR #9 flake)", () => {
    // The emulator's shape: a transactional read hit its 2s lock timeout (10 ABORTED), gax's stream retry
    // re-sent it on the transaction the abort had closed. grpc-js sets code, details and the "3 ..." message.
    const closed = Object.assign(new Error("3 INVALID_ARGUMENT: Transaction is invalid or closed."), {
      code: 3,
      details: "Transaction is invalid or closed.",
      metadata: {},
    })
    expect(isContentionAbort(closed)).toBe(true)
    // Production's expired transaction (the SDK's own retryable INVALID_ARGUMENT), after its attempts ran out.
    expect(isContentionAbort(Object.assign(new Error("3 INVALID_ARGUMENT: The referenced transaction has expired or is no longer valid."), { code: 3, details: "The referenced transaction has expired or is no longer valid." }))).toBe(true)
    expect(isContentionAbort(Object.assign(new Error("3 INVALID_ARGUMENT: Transaction has expired."), { code: 3 }))).toBe(true)
  })

  it("any other INVALID_ARGUMENT is a bug, not contention (stays a 500)", () => {
    expect(isContentionAbort(Object.assign(new Error("3 INVALID_ARGUMENT: Document path is invalid."), { code: 3, details: "Document path is invalid." }))).toBe(false)
    expect(isContentionAbort(Object.assign(new Error("3 INVALID_ARGUMENT: Value for argument is not a valid Firestore document."), { code: 3 }))).toBe(false)
    // The message alone, without the gRPC code, is not enough.
    expect(isContentionAbort(new Error("Transaction is invalid or closed."))).toBe(false)
    expect(isContentionAbort(Object.assign(new Error("Transaction is invalid or closed."), { code: "invalid-argument" }))).toBe(false)
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
