import type { TaskType } from "./types"

/** Task type to model (P3-62). Frozen, like the price table. */
export const TASK_MODEL: Readonly<Record<TaskType, string>> = Object.freeze({ committee: "anthropic/claude-opus-5.5" })

/** Integer nano-USD per token, with where and when the price was taken (P3-62). Frozen: nothing changes a price at run time. The metered model replaces these at G-1. */
export const MODEL_PRICES: Readonly<
  Record<string, Readonly<{ inputNanoUsdPerToken: number; outputNanoUsdPerToken: number; source: string; fetchedAt: string }>>
> = Object.freeze({
  "anthropic/claude-opus-5.5": Object.freeze({
    inputNanoUsdPerToken: 4000,
    outputNanoUsdPerToken: 20000,
    source: "Vercel AI Gateway public model list, GET https://ai-gateway.vercel.sh/v1/models",
    fetchedAt: "2026-10-11",
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

/** Token estimate for a side the provider gave no usage for: ceil(UTF-8 bytes / 3), which over-counts English and Urdu (P3-62). */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3)
}

/**
 * Input tokens a request may carry beyond its body (audit F07, re-audit R1-D1): the provider's chat template around
 * the one user message the transport sends (role and turn markers, begin and end tokens). The request carries no
 * system prompt and no tools (transport.ts sends `model`, one user message and `max_tokens`), so the template is a
 * handful of tokens; 64 leaves a wide margin and costs 256 micro-USD of reservation at the Opus input price. To be
 * measured at G-1 against the Gateway's `prompt_tokens` for a one-byte body (O-57).
 */
export const REQUEST_OVERHEAD_TOKENS = 64

/**
 * An upper bound on the input tokens a provider can bill for `text` (re-audit R1-D1): one per UTF-8 byte, because a
 * byte-level BPE token always covers at least one byte, plus REQUEST_OVERHEAD_TOKENS. `estimateTokens` is the charge
 * estimate when no usage is reported (P3-62) and stays as it is; only the reservation uses this ceiling.
 */
export function inputTokenCeiling(text: string): number {
  return Buffer.byteLength(text, "utf8") + REQUEST_OVERHEAD_TOKENS
}
