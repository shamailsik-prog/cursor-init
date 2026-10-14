import type { TaskType } from "./types"

/** Task type to model (P3-62). Frozen, like the price table. */
export const TASK_MODEL: Readonly<Record<TaskType, string>> = Object.freeze({ committee: "anthropic/claude-opus-5.5" })

/**
 * Input tokens a request may carry beyond its body (audit F07, re-audit R1-D1, Copilot finding on PR #40): the
 * provider's chat template around the one user message the transport sends (role and turn markers, begin and end
 * tokens, and anything the Gateway or the provider adds on its own side). The request carries no system prompt and
 * no tools (transport.ts sends `model`, one user message and `max_tokens`), so the visible template is a handful of
 * tokens; 1,024 is deliberately generous, because what a provider adds unseen is not documented. At the Opus input
 * price it holds 4,096 micro-USD per call. The exact figure is [REQUIRES VERIFICATION] at G-1: measure the Gateway's
 * `prompt_tokens` for a one-byte body (O-57). A provider that bills more than this is still charged in full; the
 * breach is recorded and raises the overhead for later calls of that model (`platform/p1Overhead`, gateway.ts).
 */
export const REQUEST_OVERHEAD_TOKENS = 1024

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
