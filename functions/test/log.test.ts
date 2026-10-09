import { describe, expect, it } from "vitest"
import { errorCode } from "../src/log"

describe("errorCode (log)", () => {
  it("keeps a string code, maps a gRPC numeric code to grpc_<n>, and never logs the message", () => {
    expect(errorCode(Object.assign(new Error("x@example.com"), { code: "auth/user-not-found" }))).toBe("auth/user-not-found")
    // Firestore Admin SDK errors carry numeric gRPC codes; "unknown" hid the PR #9 contention error (code 3).
    expect(errorCode(Object.assign(new Error("3 INVALID_ARGUMENT: Transaction is invalid or closed."), { code: 3 }))).toBe("grpc_3")
    expect(errorCode(Object.assign(new Error("10 ABORTED"), { code: 10 }))).toBe("grpc_10")
  })

  it("anything else is unknown", () => {
    expect(errorCode(new Error("boom"))).toBe("unknown")
    expect(errorCode(Object.assign(new Error("x"), { code: 99 }))).toBe("unknown")
    expect(errorCode(Object.assign(new Error("x"), { code: 1.5 }))).toBe("unknown")
    expect(errorCode(null)).toBe("unknown")
    expect(errorCode(undefined)).toBe("unknown")
  })
})
