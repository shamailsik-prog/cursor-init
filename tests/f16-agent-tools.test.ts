import { readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { isDisabledToolSentinel } from "eve/tools"
import committeeAgent from "@/agent/agent"

/**
 * Audit F16, spec ruling 5: the privileged eve defaults stay disabled, exactly the read-only allowlist is enabled, and
 * every enabled tool has a strict, bounded input schema and a typed output contract. This file imports nothing that is
 * new in F16, so it loads on main; there the strictness and bound rows fail.
 */

const TOOLS_DIR = path.resolve(__dirname, "..", "agent", "tools")
const READ_ONLY_ALLOWLIST = ["classification_policy", "mask_preview", "normalise_case_number"]
const PRIVILEGED_DEFAULTS = ["bash", "web_fetch", "web_search", "write_file"]

type Schema = { safeParse: (v: unknown) => { success: boolean } }
type Tool = { inputSchema: Schema; outputSchema?: unknown; execute: (input: unknown, options?: unknown) => Promise<unknown> }

async function load(name: string): Promise<unknown> {
  return (await import(`../agent/tools/${name}.ts`)).default
}

const toolFiles = readdirSync(TOOLS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.slice(0, -3))
  .sort()

describe("audit F16: the agent's tool set (ruling 5)", () => {
  it("keeps the optional eve defaults off for the agent", () => {
    expect(committeeAgent.defaultTools).toBe(false)
  })

  it("has a disabling file for every privileged default", () => {
    for (const name of PRIVILEGED_DEFAULTS) expect(toolFiles, name).toContain(name)
  })

  it("enables exactly the read-only allowlist; every other file is disableTool()", async () => {
    const enabled: string[] = []
    for (const name of toolFiles) {
      const tool = await load(name)
      if (isDisabledToolSentinel(tool)) continue
      enabled.push(name)
    }
    expect(enabled).toEqual(READ_ONLY_ALLOWLIST)
    for (const name of PRIVILEGED_DEFAULTS) expect(isDisabledToolSentinel(await load(name)), name).toBe(true)
  })
})

describe("audit F16: strict, bounded input schemas on every enabled tool (ruling 5)", () => {
  const rows: Array<[string, unknown, boolean]> = [
    ["mask_preview", { text: "CNIC 42101-1234567-1" }, true],
    ["mask_preview", { text: "x", partyNames: ["Nura Kalbani"] }, true],
    ["mask_preview", { text: "x", extra: true }, false],
    ["mask_preview", { text: "x".repeat(100_001) }, false],
    ["mask_preview", { text: "x", partyNames: Array.from({ length: 51 }, (_, i) => `Name ${i}`) }, false],
    ["mask_preview", { text: "x", partyNames: ["x".repeat(201)] }, false],
    ["mask_preview", { text: "x", partyNames: [""] }, false],
    ["classification_policy", { classification: "internal" }, true],
    ["classification_policy", { classification: "internal", provider: "openai" }, false],
    ["classification_policy", { classification: "x".repeat(65) }, false],
    ["normalise_case_number", { raw: "C.P. No. D-1234 of 2025", courtId: "SHC" }, true],
    ["normalise_case_number", { raw: "C.P. No. D-1234 of 2025", courtId: "SHC", note: "x" }, false],
    ["normalise_case_number", { raw: "x".repeat(201), courtId: "SHC" }, false],
    ["normalise_case_number", { raw: "C.P. No. D-1234 of 2025", courtId: "constructor" }, false],
    ["normalise_case_number", { raw: "C.P. No. D-1234 of 2025", courtId: "NOT-A-COURT" }, false],
  ]

  it.each(rows)("%s accepts %j: %s", async (name, input, ok) => {
    const tool = (await load(name)) as Tool
    expect(tool.inputSchema.safeParse(input).success).toBe(ok)
  })

  it.each(READ_ONLY_ALLOWLIST)("%s declares an output schema", async (name) => {
    expect(((await load(name)) as Tool).outputSchema).toBeDefined()
  })

  it("each enabled tool refuses an input outside its contract at execution, even when called directly", async () => {
    for (const [name, input] of [
      ["mask_preview", { text: "x", extra: true }],
      ["classification_policy", { classification: "internal", provider: "openai" }],
      ["normalise_case_number", { raw: "C.P. No. D-1234 of 2025", courtId: "constructor" }],
    ] as const) {
      const tool = (await load(name)) as Tool
      await expect(tool.execute(input), name).rejects.toThrow(/contract/)
    }
  })

  it("each enabled tool returns output that its contract accepts", async () => {
    const mask = (await load("mask_preview")) as Tool
    expect(await mask.execute({ text: "CNIC 42101-1234567-1", partyNames: ["Nura Kalbani"] })).toEqual({
      masked: "CNIC [CNIC]",
      redactionCounts: { cnic: 1, phone: 0, party: 0, email: 0, iban: 0, ntn: 0, passport: 0 },
    })
    const policy = (await load("classification_policy")) as Tool
    expect(await policy.execute({ classification: "internal" })).toEqual({ allowed: true })
    expect(await policy.execute({ classification: "no-such-label" })).toMatchObject({ allowed: false })
    const normalise = (await load("normalise_case_number")) as Tool
    expect(await normalise.execute({ raw: "C.P. No. D-1234 of 2025", courtId: "SHC" })).toMatchObject({ status: "OK", canonical: "CP D-1234/2025" })
  })
})
