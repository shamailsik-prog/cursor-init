import { defineAgent } from "eve"
import { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"
import { COMMITTEE_BRAIN_CONTEXT_WINDOW_TOKENS } from "../platform/p1/constants"
import { assertNoProviderKeyAtStartup } from "../platform/p1/providerKeyGuard"

/**
 * SIKANDER Committee Brain (eve). Identity is package.json name `sikander-ai`.
 *
 * The model is a P1 LanguageModel, not a Gateway string. A Gateway id here
 * would let eve call the provider without mask + classification.
 *
 * defaultTools: false — web_fetch / web_search / bash would bypass P1 and
 * the L4.9 allowlist. Authored tools under agent/tools/ remain.
 *
 * Audit F18 (spec ruling R5, as amended by the re-audit follow-up): eve
 * refuses to start when a provider API key is in its environment, unless
 * NODE_ENV is exactly `development` or `test`. The P1 bridge has no provider
 * transport, but eve's framework has model calls of its own (its default
 * agent, self-modification) that read the AI Gateway key from the environment
 * directly; refusing to start is the only control that covers them.
 */
assertNoProviderKeyAtStartup("eve")

export default defineAgent({
  model: committeeBrainLanguageModel,
  modelContextWindowTokens: COMMITTEE_BRAIN_CONTEXT_WINDOW_TOKENS,
  defaultTools: false,
})
