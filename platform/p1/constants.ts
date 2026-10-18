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

/**
 * The longest answer a committee row is sized for (audit F16 review round, ruling R4a), as on the Functions path
 * (functions/src/p1/costTable.ts MAX_OUTPUT_TOKENS). The answer is stored beside the outbound in one 1 MiB document,
 * and the outbound is bounded at MAX_STORED_OUTBOUND_BYTES, so the answer must be bounded too. Since audit F18 the Next
 * runtime has no provider transport of its own; every answer comes from Cloud Functions P1, which asks for this bound.
 */
export const COMMITTEE_BRAIN_MAX_OUTPUT_TOKENS = 4096

/**
 * The largest stored outbound a call may make (audit F16 review round, ruling R4a): 900 KiB of UTF-8 JSON. The Next
 * committee route stores the outbound with the answer in one `committee_outputs` document, which Firestore caps at
 * 1 MiB (1,048,576 bytes); the 124 KiB left over holds the answer (at most COMMITTEE_BRAIN_MAX_OUTPUT_TOKENS) and the
 * row's other fields. A call over it is refused before dispatch.
 */
export const MAX_STORED_OUTBOUND_BYTES = 900 * 1024

/** The reason a call over MAX_STORED_OUTBOUND_BYTES is refused with. Fixed text: no size or content is echoed. */
export const STORED_OUTBOUND_TOO_LARGE_REASON =
  "P1: the request is too large to store with its answer (its stored record would exceed 900 KiB); nothing was sent"

/** The reason a call whose system message fails the send-time check is refused with (audit F16 review round, R3a). */
export const SYSTEM_UNVERIFIED_REASON = "P1: the system message is not the platform's policy text; nothing was sent"
