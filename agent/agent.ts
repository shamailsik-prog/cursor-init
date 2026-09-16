import { defineAgent } from "eve"
import { committeeBrainLanguageModel } from "../platform/p1/committeeBrainModel"
import { COMMITTEE_BRAIN_CONTEXT_WINDOW_TOKENS } from "../platform/p1/constants"

/**
 * SIKANDER Committee Brain (eve). Identity is package.json name `sikander-ai`.
 *
 * The model is a P1 LanguageModel, not a Gateway string. A Gateway id here
 * would let eve call the provider without mask + classification.
 *
 * defaultTools: false — web_fetch / web_search / bash would bypass P1 and
 * the L4.9 allowlist. Authored tools under agent/tools/ remain.
 */
export default defineAgent({
  model: committeeBrainLanguageModel,
  modelContextWindowTokens: COMMITTEE_BRAIN_CONTEXT_WINDOW_TOKENS,
  defaultTools: false,
})
