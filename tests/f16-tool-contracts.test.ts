import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  CLASSIFICATION_POLICY_OUTPUT,
  MASK_PREVIEW_OUTPUT,
  NORMALISE_CASE_NUMBER_OUTPUT,
  ToolContractError,
  runContractTool,
} from "@/platform/p1/eveToolContracts"
import { normaliseCaseNumber } from "@/platform/p1/eveTools"

/** Audit F16, spec ruling 5: a tool's output is validated against its typed contract before it reaches the model. */

describe("audit F16: runContractTool fails closed on a contract violation (ruling 5)", () => {
  const input = z.object({ text: z.string().max(10) }).strict()
  const output = z.object({ masked: z.string() }).strict()

  it("passes a valid input through and returns a valid output", async () => {
    await expect(runContractTool(input, output, (i) => ({ masked: i.text.toUpperCase() }), { text: "abc" })).resolves.toEqual({ masked: "ABC" })
  })

  it("refuses an invalid input without running the tool", async () => {
    let ran = false
    const run = () => {
      ran = true
      return { masked: "x" }
    }
    await expect(runContractTool(input, output, run, { text: "x", extra: 1 })).rejects.toBeInstanceOf(ToolContractError)
    await expect(runContractTool(input, output, run, { text: "x".repeat(11) })).rejects.toThrow("tool input contract violation")
    expect(ran).toBe(false)
  })

  it.each([
    ["an extra key", { masked: "x", leaked: "secret" }],
    ["a wrong type", { masked: 1 }],
    ["nothing", undefined],
  ])("refuses an output with %s, and the error carries no output text", async (_name, bad) => {
    const err = await runContractTool(input, output, () => bad as never, { text: "x" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ToolContractError)
    expect((err as Error).message).toBe("tool output contract violation")
    expect(String((err as Error).message)).not.toContain("secret")
  })
})

describe("audit F16: the enabled tools' output contracts (ruling 5)", () => {
  it("mask_preview: masked text and a count for each known kind only", () => {
    const ok = { masked: "[CNIC]", redactionCounts: { cnic: 1, phone: 0, party: 0, email: 0, iban: 0, ntn: 0, passport: 0 } }
    expect(MASK_PREVIEW_OUTPUT.safeParse(ok).success).toBe(true)
    expect(MASK_PREVIEW_OUTPUT.safeParse({ ...ok, raw: "42101-1234567-1" }).success).toBe(false)
    expect(MASK_PREVIEW_OUTPUT.safeParse({ ...ok, redactionCounts: { ...ok.redactionCounts, nickname: 1 } }).success).toBe(false)
    expect(MASK_PREVIEW_OUTPUT.safeParse({ ...ok, redactionCounts: { ...ok.redactionCounts, cnic: -1 } }).success).toBe(false)
  })

  it("classification_policy: the provider decision union", () => {
    expect(CLASSIFICATION_POLICY_OUTPUT.safeParse({ allowed: true }).success).toBe(true)
    expect(CLASSIFICATION_POLICY_OUTPUT.safeParse({ allowed: true, requirements: { minimiseContent: true, scrubTrace: true } }).success).toBe(true)
    expect(CLASSIFICATION_POLICY_OUTPUT.safeParse({ allowed: false, reason: "L18 §4.6: no DPA" }).success).toBe(true)
    expect(CLASSIFICATION_POLICY_OUTPUT.safeParse({ allowed: false }).success).toBe(false)
    expect(CLASSIFICATION_POLICY_OUTPUT.safeParse({ allowed: true, reason: "x", extra: 1 }).success).toBe(false)
  })

  it("normalise_case_number: OK, AMBIGUOUS or REJECT with bounded strings", () => {
    expect(NORMALISE_CASE_NUMBER_OUTPUT.safeParse(normaliseCaseNumber({ raw: "C.P. No. D-1234 of 2025", courtId: "SHC" })).success).toBe(true)
    expect(NORMALISE_CASE_NUMBER_OUTPUT.safeParse({ status: "REJECT", reason: "unknown court" }).success).toBe(true)
    expect(NORMALISE_CASE_NUMBER_OUTPUT.safeParse({ status: "REJECT", reason: "x".repeat(1001) }).success).toBe(false)
    expect(NORMALISE_CASE_NUMBER_OUTPUT.safeParse({ status: "MAYBE" }).success).toBe(false)
  })

  it("normaliseCaseNumber refuses a court id that is not an own key of the seeded table", () => {
    for (const courtId of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(normaliseCaseNumber({ raw: "C.P. No. D-1234 of 2025", courtId }), courtId).toEqual({ status: "REJECT", reason: "unknown court" })
    }
  })
})
