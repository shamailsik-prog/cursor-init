/**
 * Strict input and output contracts for the eve Committee Brain agent's enabled tools (audit F16; spec
 * docs/superpowers/specs/2026-10-17-f16-prompt-trust-roles-design.md, ruling 5). Every input is a `.strict()` object with
 * bounded strings; every output is checked against a `.strict()` typed contract before it is returned, so nothing
 * unvalidated reaches the model. A violation throws ToolContractError with a fixed message that carries no input or
 * output text (fail closed).
 *
 * The privileged eve defaults (bash, web_fetch, web_search, write_file) stay disabled (agent/tools/*.ts, `disableTool()`);
 * tests/f16-agent-tools.test.ts enumerates the tool directory.
 */

import { z } from "zod"
import { SEEDED_COURT_IDS } from "@/platform/p1/eveTools"

export class ToolContractError extends Error {
  constructor(side: "input" | "output") {
    super(`tool ${side} contract violation`)
    this.name = "ToolContractError"
  }
}

/** The committeeBrain body cap (functions/src/p1/ops.ts MAX_BODY_CHARS): the most text a tool previews. */
export const MAX_TOOL_TEXT_CHARS = 100_000
/** A masked text can be longer than its input (`[PARTY]` for a one-letter name); 8 times the input cap. */
const MAX_MASKED_CHARS = 8 * MAX_TOOL_TEXT_CHARS
const MAX_PARTY_NAMES = 50
const MAX_PARTY_NAME_CHARS = 200
const COURTS: ReadonlySet<string> = new Set(SEEDED_COURT_IDS)

const count = z.number().int().nonnegative()

export const MASK_PREVIEW_INPUT = z
  .object({
    text: z.string().min(1).max(MAX_TOOL_TEXT_CHARS),
    partyNames: z.array(z.string().min(1).max(MAX_PARTY_NAME_CHARS)).max(MAX_PARTY_NAMES).optional(),
  })
  .strict()

export const MASK_PREVIEW_OUTPUT = z
  .object({
    masked: z.string().max(MAX_MASKED_CHARS),
    redactionCounts: z.object({ cnic: count, phone: count, party: count, email: count, iban: count, ntn: count, passport: count }).strict(),
  })
  .strict()

export const CLASSIFICATION_POLICY_INPUT = z.object({ classification: z.string().min(1).max(64) }).strict()

export const CLASSIFICATION_POLICY_OUTPUT = z.union([
  z
    .object({
      allowed: z.literal(true),
      requirements: z.object({ minimiseContent: z.literal(true), scrubTrace: z.literal(true) }).strict().optional(),
    })
    .strict(),
  z.object({ allowed: z.literal(false), reason: z.string().min(1).max(500) }).strict(),
])

export const NORMALISE_CASE_NUMBER_INPUT = z
  .object({
    raw: z.string().min(1).max(200),
    courtId: z
      .string()
      .max(32)
      .refine((id) => COURTS.has(id), "unknown court"),
  })
  .strict()

export const NORMALISE_CASE_NUMBER_OUTPUT = z.union([
  z
    .object({
      status: z.enum(["OK", "AMBIGUOUS"]),
      canonical: z.string().min(1).max(200),
      prefix: z.string().min(1).max(64),
      bench: z.string().max(8).nullable(),
      number: z.string().min(1).max(16),
      year: z.string().regex(/^\d{4}$/),
      flags: z.array(z.string().max(32)).max(8),
      note: z.string().max(1000).optional(),
    })
    .strict(),
  z.object({ status: z.literal("REJECT"), reason: z.string().min(1).max(1000), input: z.string().max(200).optional() }).strict(),
])

/** Parses `input` by its contract, runs the tool, and returns its output only when its contract accepts it. */
export async function runContractTool<I, O>(inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>, run: (input: I) => unknown, input: unknown): Promise<O> {
  const parsedInput = inputSchema.safeParse(input)
  if (!parsedInput.success) throw new ToolContractError("input")
  const output = await run(parsedInput.data)
  const parsedOutput = outputSchema.safeParse(output)
  if (!parsedOutput.success) throw new ToolContractError("output")
  return parsedOutput.data
}
