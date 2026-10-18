import { createHash } from "node:crypto"

/**
 * The eve agent's own system instructions, pinned by digest (audit F16; spec
 * docs/superpowers/specs/2026-10-17-f16-prompt-trust-roles-design.md, refinement R1b and review-round ruling R3a).
 *
 * agent/instructions.md is the single source of the text. eve 0.56 compiles it verbatim (a markdown instructions source
 * is its file text) and composes it into the system prompt as one block, `Instructions (instructions)` and a line break
 * followed by the trimmed text, joined to eve's other blocks by a blank line. P1 holds only the trimmed text's SHA-256
 * and length here, so no copy of the text can drift from the file (tests/f16-system-policy.test.ts holds both to it).
 *
 * The bridge accepts from the prompt's system text only a whole block whose text has exactly this length and digest,
 * and the builder accepts only such a text; everything else in the prompt's system text is never sent. So the only
 * text that can follow the registry policy in the system message is agent/instructions.md as pinned.
 */

/** SHA-256 (hex) of agent/instructions.md, trimmed, in UTF-8. Change it only with the file, in review. */
export const AGENT_INSTRUCTIONS_SHA256 = "45946f5c44e47d0143f496403f886b9d2ca557136b625351d78e486efe984e09"

/** The same text's length in UTF-16 code units. */
export const AGENT_INSTRUCTIONS_LENGTH = 2093

/** The header eve puts before the text (its source name is `instructions`). */
export const EVE_INSTRUCTIONS_HEADER = "Instructions (instructions)\n"

/** Whether `text` is the pinned agent instructions: their exact length and SHA-256. */
export function isPinnedAgentInstructions(text: unknown): text is string {
  return (
    typeof text === "string" &&
    text.length === AGENT_INSTRUCTIONS_LENGTH &&
    createHash("sha256").update(text, "utf8").digest("hex") === AGENT_INSTRUCTIONS_SHA256
  )
}

/**
 * The pinned agent instructions as eve composed them into `system`, or null: the first whole block that is
 * EVE_INSTRUCTIONS_HEADER followed by the pinned text, starting the text or after a blank line and ending the text or
 * before a blank line. The same block with a rule removed or a sentence added inside it is not found.
 */
export function pinnedAgentInstructionsIn(system: string): string | null {
  let from = 0
  for (;;) {
    const at = system.indexOf(EVE_INSTRUCTIONS_HEADER, from)
    if (at < 0) return null
    const start = at + EVE_INSTRUCTIONS_HEADER.length
    const end = start + AGENT_INSTRUCTIONS_LENGTH
    const startsBlock = at === 0 || system.startsWith("\n\n", at - 2)
    const endsBlock = end === system.length || system.startsWith("\n\n", end)
    const text = system.slice(start, end)
    if (startsBlock && endsBlock && isPinnedAgentInstructions(text)) return text
    from = at + 1
  }
}
