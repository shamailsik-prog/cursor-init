/** Shared P1 constants. Do not invent DPA, residency, or provider credentials. */

export const PHASE0_NO_CREDENTIALS =
  "blocked: no live provider credentials in Phase 0"

/**
 * Vercel AI Gateway model id. Routed only from `platform/p1` after mask + policy.
 * Not a provider API key. TODO(firm): confirm the production Gateway model.
 */
export const COMMITTEE_BRAIN_GATEWAY_MODEL = "anthropic/claude-sonnet-4.6"

/** Context-window override so eve does not look the custom P1 model up in the Gateway catalog. */
export const COMMITTEE_BRAIN_CONTEXT_WINDOW_TOKENS = 200_000
