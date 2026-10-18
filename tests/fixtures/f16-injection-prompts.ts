import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { buildOutbound } from "@/platform/p1/outboundPrompt"
import { promptToTurns } from "@/platform/p1/promptText"
import type { InjectionCase } from "@/tests/fixtures/f16-injection-corpus"

/**
 * Audit F16 (spec ruling 6) prompts for the injection corpus, shared by the deterministic structure suite
 * (tests/f16-injection-structure.test.ts) and the live evaluation (functions/test/f16-injection-live.test.ts).
 *
 * Audit F18 re-audit follow-up (FA-F18-001a): the live evaluation moved into functions/test, because G-0 [19] lets no
 * root test import the Functions transport. It sends `requestMessages(c)`: the two steps the eve bridge runs
 * (`promptToTurns`, then the shared builder `buildOutbound`), without the bridge's call path. The structure suite holds
 * `requestMessages(c)` equal to the request the bridge itself builds, for every case, so the live run sends exactly what
 * the bridge would.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

/** The pinned agent instructions (agent/instructions.md, trimmed). */
export const INSTRUCTIONS = readFileSync(path.resolve(here, "..", "..", "agent", "instructions.md"), "utf8").trim()
/** The system message as eve composes it. */
export const AGENT_SYSTEM = `Instructions (instructions)\n${INSTRUCTIONS}`

export const toolPrompt = (c: InjectionCase): LanguageModelV3Prompt => [
  { role: "system", content: AGENT_SYSTEM },
  { role: "user", content: [{ type: "text", text: "Preview the mask for the attached note." }] },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "mask_preview", input: { text: "note" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "mask_preview", output: { type: "text", value: c.text } }] },
]

export const userPrompt = (c: InjectionCase): LanguageModelV3Prompt => [
  { role: "system", content: AGENT_SYSTEM },
  { role: "user", content: [{ type: "text", text: c.text }] },
]

export type RequestMessage = { role: "system" | "user" | "assistant"; content: string }

/** The messages a committee-brain request carries for this prompt: the bridge's two building steps. */
export function requestMessages(prompt: LanguageModelV3Prompt): RequestMessage[] {
  const converted = promptToTurns(prompt)
  if (!converted.ok) throw new Error(converted.reason)
  return buildOutbound({ purpose: "committee-brain", turns: converted.turns, agentInstructions: converted.agentInstructions }).messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
}
