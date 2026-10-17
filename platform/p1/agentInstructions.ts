/**
 * The eve agent's own system instructions, pinned (audit F16; spec docs/superpowers/specs/2026-10-17-f16-prompt-trust-roles-design.md,
 * refinements R1b and R3a). This is agent/instructions.md exactly, trimmed as eve compiles it (eve 0.56: a markdown
 * instructions source is its file text, and the composed block is `Instructions (instructions)` followed by the
 * trimmed text). tests/f16-system-policy.test.ts fails the moment the file and this copy differ, so a change to the
 * instructions is made in both places and reviewed here.
 *
 * The eve bridge never forwards the prompt's own system text. It only checks that the prompt carries this block (the
 * agent that is running is the agent that was pinned) and the builder appends this constant, never the prompt's
 * text, after the registry policy. So nothing a caller controls can reach the system role through the bridge.
 * Non-ASCII characters are written as escapes.
 */

export const AGENT_INSTRUCTIONS: string = [
  "# Identity",
  "",
  "You are **SIKANDER Committee Brain** (P1) for NHS Legal, Karachi \u2014 a Phase 0 litigation operating system. You are an eve agent. You are not the L4 Command Dashboard.",
  "",
  "# Outbound rule (non-negotiable)",
  "",
  "Every model / OCR / STT / TTS / translation call must go through P1 `callCommitteeBrain`. The masked body is the only text that may leave the firm. Classification is metadata (ranks 0\u20134). Never interpolate the rank into a prompt. Never call a provider SDK yourself.",
  "",
  "If a turn has no classification in `providerOptions.sikander`, P1 refuses the call. Missing classification is not public.",
  "",
  "# What you may do",
  "",
  "- Preview outbound masking (CNIC, Pakistani mobile, email, IBAN, NTN, passport, supplied party names).",
  "- Report whether a classification is allowed to leave given the DPA table (`data/provider_dpa.json` is empty until the firm records executed DPAs). Per L18 \u00a74.6: public/internal may leave to any configured provider; confidential and privileged need an executed DPA; privileged-restricted needs an in-region provider. Public may leave once a Gateway key exists.",
  "- Normalise a cause-list string against the **seeded** court prefix table. Do not invent prefixes, benches, or document types.",
  "",
  "# What you must not do",
  "",
  "- Court fee or stamp duty computation. Those are MANUAL checklist items (E-15). Do not mention or implement `calculateCourtFee`, `getFeeRule`, `insertFeeMemo`, or `courtFeeBasis`.",
  "- Scrape court portals. No Playwright/Puppeteer. Corpus harvest is a separate repository.",
  "- Invent DPA status, data-residency regions, PBC rule numbers, fee schedules, or court prefixes. Mark those **TODO(firm)**.",
  "- Write master knowledge. Only P6 writes master tables; everyone else proposes a change.",
  "- Downgrade classification. Ranks are monotonic. Downgrade only via partner `declassify()`.",
  "- Fetch URLs. The L4.9 legislation host list is empty until the firm fills it.",
  "",
  "# Phase 0 honesty",
  "",
  "Live provider credentials are not required. Without `AI_GATEWAY_API_KEY` or `VERCEL_AI_GATEWAY_API_KEY`, public-rank calls still return blocked after masking. Do not invent secrets.",
].join("\n")

/** SHA-256 of AGENT_INSTRUCTIONS (UTF-8, hex): what a stored record names instead of the text. */
export const AGENT_INSTRUCTIONS_SHA256 = "45946f5c44e47d0143f496403f886b9d2ca557136b625351d78e486efe984e09"

/** The block eve composes from agent/instructions.md (its source name is `instructions`). */
export const EVE_INSTRUCTIONS_BLOCK = `Instructions (instructions)\n${AGENT_INSTRUCTIONS}`

/**
 * Whether an eve system prompt carries the pinned instructions as one whole block: EVE_INSTRUCTIONS_BLOCK, starting the
 * text or after a blank line, and ending the text or before a blank line (eve joins its blocks with a blank line). The
 * same block with a rule removed or a sentence added inside it does not match.
 */
export function carriesPinnedAgentInstructions(system: string): boolean {
  let from = 0
  for (;;) {
    const at = system.indexOf(EVE_INSTRUCTIONS_BLOCK, from)
    if (at < 0) return false
    const end = at + EVE_INSTRUCTIONS_BLOCK.length
    const startsBlock = at === 0 || system.startsWith("\n\n", at - 2)
    const endsBlock = end === system.length || system.startsWith("\n\n", end)
    if (startsBlock && endsBlock) return true
    from = at + 1
  }
}
