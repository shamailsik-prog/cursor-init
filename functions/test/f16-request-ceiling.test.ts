import { describe, expect, it } from "vitest"
import { SYSTEM_POLICIES } from "@/platform/p1/systemPolicy"
import { MESSAGE_OVERHEAD_TOKENS, bodyTokenCeiling, estimateRequestTokens, estimateTokens, requestTokenCeiling } from "../src/p1/costTable"

/**
 * Audit F16, spec ruling 3 with audit F07: the reservation's input ceiling covers every message the request carries,
 * so adding the system message can never make a call under-reserve.
 */

const SYSTEM = SYSTEM_POLICIES["committee-brain"].text
const BODIES = ["", "abc", "Draft the bail grounds.", "ﷺ", "ضمانت کی درخواست تیار کریں۔", "x".repeat(10_000)]

describe("audit F16: requestTokenCeiling (ruling 3, F07)", () => {
  it("pins the per-message overhead", () => {
    expect(MESSAGE_OVERHEAD_TOKENS).toBe(16)
  })

  it("is the sum of each message's ceiling plus the per-message overhead", () => {
    expect(requestTokenCeiling([])).toBe(0)
    expect(requestTokenCeiling([{ role: "user", content: "abc" }])).toBe(3 + 16)
    expect(requestTokenCeiling([{ role: "system", content: "ﷺ" }, { role: "user", content: "abc" }])).toBe(33 + 16 + 3 + 16)
  })

  it.each(BODIES)("is never below the pre-F16 body-only ceiling for the same user text (%#)", (body) => {
    expect(requestTokenCeiling([{ role: "user", content: body }])).toBeGreaterThanOrEqual(bodyTokenCeiling(body))
    expect(requestTokenCeiling([{ role: "system", content: SYSTEM }, { role: "user", content: body }])).toBeGreaterThanOrEqual(bodyTokenCeiling(body))
  })

  it.each(BODIES)("rises when a system message is added (%#)", (body) => {
    const userOnly = requestTokenCeiling([{ role: "user", content: body }])
    const withSystem = requestTokenCeiling([{ role: "system", content: SYSTEM }, { role: "user", content: body }])
    expect(withSystem).toBe(userOnly + bodyTokenCeiling(SYSTEM) + MESSAGE_OVERHEAD_TOKENS)
    expect(withSystem).toBeGreaterThan(userOnly)
  })

  it("estimates the charge over every message, the system message included", () => {
    expect(estimateRequestTokens([{ role: "system", content: SYSTEM }, { role: "user", content: "abcdef" }])).toBe(estimateTokens(SYSTEM) + 2)
  })
})
