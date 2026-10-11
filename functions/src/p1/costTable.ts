import type { TaskType } from "./types"

/** Task type to model (P3-62). */
export const TASK_MODEL: Readonly<Record<TaskType, string>> = { committee: "anthropic/claude-opus-5.5" }

/** Integer nano-USD per token, with where and when the price was taken (P3-62). The metered model replaces these at G-1. */
export const MODEL_PRICES: Readonly<
  Record<string, { inputNanoUsdPerToken: number; outputNanoUsdPerToken: number; source: string; fetchedAt: string }>
> = {
  "anthropic/claude-opus-5.5": {
    inputNanoUsdPerToken: 4000,
    outputNanoUsdPerToken: 20000,
    source: "Vercel AI Gateway published list price",
    fetchedAt: "2026-10-11",
  },
}

/** Sent as `max_tokens` on every call (P3-62). */
export const MAX_OUTPUT_TOKENS = 4096

/** The provider id the Gateway has in the provider policy table (P3-68). */
export const PROVIDER_ID = "ai-gateway"

/** Micro-USD for a call, rounded up; null when the model has no price (P3-62). Own keys only: "constructor" is unpriced. */
export function costMicroUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  if (!Object.hasOwn(MODEL_PRICES, model)) return null
  const price = MODEL_PRICES[model]!
  return Math.ceil((inputTokens * price.inputNanoUsdPerToken + outputTokens * price.outputNanoUsdPerToken) / 1000)
}

/** Token estimate for a side the provider gave no usage for: ceil(UTF-8 bytes / 3), which over-counts English and Urdu (P3-62). */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3)
}
