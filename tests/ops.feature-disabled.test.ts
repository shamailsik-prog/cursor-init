import { describe, expect, it } from "vitest"
import {
  FeatureDisabledError,
  apiCallError,
  runApiCallAllowingStatuses,
  stepFailureOutcome,
} from "@/app/ops/api-call-helpers"

const DISABLED_BODY = { error: "feature_disabled", flag: "LEGACY_GOVERNANCE_CHAINS" }

describe("/ops console: calls into a frozen layer", () => {
  it("turns a 404 feature_disabled into a FeatureDisabledError naming the step and flag", () => {
    const err = apiCallError("Read ops activity reporting index", 404, DISABLED_BODY)
    expect(err).toBeInstanceOf(FeatureDisabledError)
    expect((err as FeatureDisabledError).flag).toBe("LEGACY_GOVERNANCE_CHAINS")
    expect(err.message).toBe(
      "Read ops activity reporting index: disabled (LEGACY_GOVERNANCE_CHAINS is off)"
    )
  })

  it("keeps ordinary errors as plain Errors with the server message", () => {
    const err = apiCallError("Create matter fixture", 404, { error: "unknown actor" })
    expect(err).not.toBeInstanceOf(FeatureDisabledError)
    expect(err.message).toBe("unknown actor")
  })

  it("does not let an allowed 404 swallow feature_disabled", async () => {
    await expect(
      runApiCallAllowingStatuses({
        step: "Batch E: annexure checkpoint partner signoff",
        allowedStatuses: [200, 403, 404, 422],
        execute: async () => ({ ok: false, status: 404, body: DISABLED_BODY }),
      })
    ).rejects.toBeInstanceOf(FeatureDisabledError)
  })

  it("maps a failed console step: frozen layer -> notice, anything else -> error", () => {
    expect(
      stepFailureOutcome("Read ops", apiCallError("Read ops", 404, DISABLED_BODY))
    ).toEqual({ kind: "notice", message: "Read ops: disabled (LEGACY_GOVERNANCE_CHAINS is off)" })
    expect(stepFailureOutcome("Seed matter", new Error("unknown actor"))).toEqual({
      kind: "error",
      message: "unknown actor",
    })
    expect(stepFailureOutcome("Seed matter", "thrown string")).toEqual({
      kind: "error",
      message: "Seed matter failed",
    })
  })
})
