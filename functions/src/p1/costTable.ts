import type { TaskType } from "./types"

/** Task type to model (P3-62). Frozen, like the price table. */
export const TASK_MODEL: Readonly<Record<TaskType, string>> = Object.freeze({ committee: "anthropic/claude-opus-5.5" })

/**
 * Input tokens a request may carry beyond its messages' content (audit F07, re-audit R1-D1, Copilot finding on PR #40):
 * the begin and end tokens of the provider's chat template and anything the Gateway or the provider adds on its own
 * side. Each message's own role and turn markers are reserved per message (MESSAGE_OVERHEAD_TOKENS, audit F16). The
 * request carries no tools (transport.ts sends `model`, the role-separated `messages` and `max_tokens`); 1,024 is
 * deliberately generous, because what a provider adds unseen is not documented. At the Opus input price it holds 4,096
 * micro-USD per call. The exact figure is [REQUIRES VERIFICATION] at G-1: measure the Gateway's `prompt_tokens` for a
 * one-byte body (O-57). A provider that bills more than this is still charged in full; the breach is recorded and
 * raises the overhead for later calls of that model (`platform/p1Overhead`, gateway.ts), up to
 * LEARNED_OVERHEAD_MAX_FACTOR times this figure (re-audit R3-D1).
 */
export const REQUEST_OVERHEAD_TOKENS = 1024

/**
 * Input tokens reserved per message for its role and turn markers (audit F16, spec ruling 3). Chat templates spend a
 * handful of tokens per message on them; 16 is generous. [REQUIRES VERIFICATION] at G-1 with the request overhead; a
 * provider that bills more is still charged in full and the breach is learned.
 */
export const MESSAGE_OVERHEAD_TOKENS = 16

/**
 * FA-D3C-002: the request overhead reserved for an embedding call beyond its input. An embeddings request carries one
 * input and no chat template; 16 tokens is generous. [REQUIRES VERIFICATION] at G-1 with the other overheads; a provider
 * that bills more is still charged in full and the breach is learned (`platform/p1Overhead`).
 */
export const EMBEDDING_OVERHEAD_TOKENS = 16

/** A message as the transport sends it (platform/p1/outboundPrompt.ts `OutboundMessage`). */
type SentMessage = { readonly role: string; readonly content: string }

/**
 * Per model: integer nano-USD per token, with where and when the price was taken (P3-62), and the request overhead
 * reserved on top of the body (`inputOverheadTokens`) with whether it has been measured against the provider
 * (`inputOverheadVerified`, false until G-1). Frozen: nothing changes a price at run time. The metered model replaces
 * these at G-1. A model with no entry here, or an entry without a valid overhead, is never dispatched (fail closed:
 * `model_unpriced`).
 */
export const MODEL_PRICES: Readonly<
  Record<
    string,
    Readonly<{
      inputNanoUsdPerToken: number
      outputNanoUsdPerToken: number
      source: string
      fetchedAt: string
      inputOverheadTokens: number
      inputOverheadVerified: boolean
    }>
  >
> = Object.freeze({
  "anthropic/claude-opus-5.5": Object.freeze({
    inputNanoUsdPerToken: 4000,
    outputNanoUsdPerToken: 20000,
    source: "Vercel AI Gateway public model list, GET https://ai-gateway.vercel.sh/v1/models",
    fetchedAt: "2026-10-11",
    inputOverheadTokens: REQUEST_OVERHEAD_TOKENS,
    inputOverheadVerified: false,
  }),
  // FA-D3C-002 (spec R12): the corpus service's embedding model, routed by `callP1Embedding` (embedding.ts). The Gateway
  // lists `"pricing": {"input": "0.00000002"}` USD per token, so 20 nano-USD; an embedding has no output side. It carries
  // no chat template, so its overhead is 16 tokens, unmeasured until G-1 like the Opus figure.
  "openai/text-embedding-3-small": Object.freeze({
    inputNanoUsdPerToken: 20,
    outputNanoUsdPerToken: 0,
    source: "Vercel AI Gateway public model list, GET https://ai-gateway.vercel.sh/v1/models",
    fetchedAt: "2026-10-24",
    inputOverheadTokens: EMBEDDING_OVERHEAD_TOKENS,
    inputOverheadVerified: false,
  }),
})

/** Sent as `max_tokens` on every call (P3-62). */
export const MAX_OUTPUT_TOKENS = 4096

/** The provider id the Gateway has in the provider policy table (P3-68). */
export const PROVIDER_ID = "ai-gateway"

/** Micro-USD for a call at a given price, rounded up: ceil((in x inputPrice + out x outputPrice) / 1000) (P3-62). */
export function priceMicroUsd(price: { inputNanoUsdPerToken: number; outputNanoUsdPerToken: number }, inputTokens: number, outputTokens: number): number {
  return Math.ceil((inputTokens * price.inputNanoUsdPerToken + outputTokens * price.outputNanoUsdPerToken) / 1000)
}

/** Micro-USD for a call; null when the model has no price (P3-62). Own keys only: "constructor" is unpriced. */
export function costMicroUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  if (!Object.hasOwn(MODEL_PRICES, model)) return null
  return priceMicroUsd(MODEL_PRICES[model]!, inputTokens, outputTokens)
}

/**
 * The request overhead the cost table reserves for `model` (Copilot finding on PR #40); null for a model with no
 * entry or no valid overhead, which is never dispatched. Own keys only, like `costMicroUsd`.
 */
export function modelInputOverhead(model: string): number | null {
  if (!Object.hasOwn(MODEL_PRICES, model)) return null
  const n = MODEL_PRICES[model]!.inputOverheadTokens
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/**
 * How far a breach may raise a model's request overhead for every firm (re-audit R3-D1): the learned overhead counts
 * up to this many times the cost table's `inputOverheadTokens` for the model (4 x 1,024 = 4,096 tokens for Opus). The
 * learned overhead is platform-wide, so one provider report raises every firm's reservations; the clamp bounds that
 * cross-tenant effect to at most 3,072 extra input tokens (12,288 micro-USD at the Opus input price) per call. A breach
 * that shows more than the clamp is an anomaly: it is learned only up to the clamp, and recorded and raised as
 * `ai.usage.anomaly`. The cost table carries no context window per model, so no window check is made.
 */
export const LEARNED_OVERHEAD_MAX_FACTOR = 4

/** The most a learned overhead may count for `model`: LEARNED_OVERHEAD_MAX_FACTOR times its table overhead; null for a model the table does not know. */
export function learnedOverheadCap(model: string): number | null {
  const table = modelInputOverhead(model)
  return table === null ? null : table * LEARNED_OVERHEAD_MAX_FACTOR
}

/**
 * The request overhead a reservation for `model` holds (Copilot finding on PR #40, re-audit R3-D1): the larger of the
 * table's figure and the learned one, the learned one counted only up to the clamp (`learnedOverheadCap`). A learned
 * value that is not a non-negative safe integer counts as nothing learned. Null for a model the table does not know,
 * which is never dispatched.
 */
export function reservationOverheadTokens(model: string, learned: unknown): number | null {
  const table = modelInputOverhead(model)
  if (table === null) return null
  const cap = table * LEARNED_OVERHEAD_MAX_FACTOR
  const valid = typeof learned === "number" && Number.isSafeInteger(learned) && learned >= 0 ? learned : 0
  return Math.max(table, Math.min(valid, cap))
}

/** Token estimate for a side the provider gave no usage for: ceil(UTF-8 bytes / 3), which over-counts English and Urdu (P3-62). */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3)
}

const NORMAL_FORMS = ["NFC", "NFD", "NFKC", "NFKD"] as const

/**
 * An upper bound on the tokens a provider can bill for the body `text` (re-audit R1-D1, R2-D3): one per UTF-8 byte,
 * because a byte-level BPE token always covers at least one byte, taken over the text as sent and its four Unicode
 * normal forms, because a tokenizer may normalise before it splits. NFKC and NFKD expand some characters far beyond
 * their own length (U+FDFA, 3 bytes, is 33 bytes in both), so the largest of the five is reserved. This is
 * conservative: it assumes the worst normalisation and one token per byte of it. That no provider bills more for the
 * body is [REQUIRES VERIFICATION] at G-1 (O-57); a provider that does is still charged in full and the breach is
 * recorded.
 */
export function bodyTokenCeiling(text: string): number {
  return Math.max(Buffer.byteLength(text, "utf8"), ...NORMAL_FORMS.map((form) => Buffer.byteLength(text.normalize(form), "utf8")))
}

/**
 * The input tokens reserved for a request with body `text`: `bodyTokenCeiling(text)` plus the request overhead
 * (REQUEST_OVERHEAD_TOKENS unless the model's own figure, or a larger learned one, is given). `estimateTokens` is the
 * charge estimate when no usage is reported (P3-62) and stays as it is; only the reservation uses this ceiling.
 */
export function inputTokenCeiling(text: string, overheadTokens: number = REQUEST_OVERHEAD_TOKENS): number {
  return bodyTokenCeiling(text) + overheadTokens
}

/**
 * The content ceiling of a role-separated request (audit F16, spec ruling 3, with F07): for each message,
 * `bodyTokenCeiling` of its content plus MESSAGE_OVERHEAD_TOKENS. A tokenizer splits each message on its own, so the
 * per-byte bound holds message by message. For the same user text it is never below the pre-F16 body ceiling, and a
 * system message raises it. The reservation adds the model's request overhead to it, as before.
 */
export function requestTokenCeiling(messages: readonly SentMessage[]): number {
  return messages.reduce((total, m) => total + bodyTokenCeiling(m.content) + MESSAGE_OVERHEAD_TOKENS, 0)
}

/** The charge estimate for the input side when no usage is reported (P3-62), over every message sent (audit F16). */
export function estimateRequestTokens(messages: readonly SentMessage[]): number {
  return messages.reduce((total, m) => total + estimateTokens(m.content), 0)
}
