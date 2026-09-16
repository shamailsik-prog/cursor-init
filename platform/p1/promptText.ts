import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { isClassification, type Classification } from "@/platform/p1/types"

/** Flatten an AI SDK prompt to text. Classification is never added here. */
export function promptToOutboundBody(
  prompt: LanguageModelV3CallOptions["prompt"]
): string {
  const chunks: string[] = []
  for (const message of prompt) {
    if (message.role === "system") {
      chunks.push(message.content)
      continue
    }
    for (const part of message.content) {
      if ("type" in part && part.type === "text" && "text" in part) {
        chunks.push(part.text)
      }
    }
  }
  return chunks.join("\n")
}

/**
 * Classification travels in providerOptions metadata, never in the prompt.
 * Missing classification is not treated as public.
 */
export function classificationFromProviderOptions(
  providerOptions: LanguageModelV3CallOptions["providerOptions"]
): Classification | undefined {
  const raw = providerOptions?.sikander?.classification
  if (typeof raw !== "string") return undefined
  if (!isClassification(raw)) return undefined
  return raw
}

export function partyNamesFromProviderOptions(
  providerOptions: LanguageModelV3CallOptions["providerOptions"]
): string[] | undefined {
  const raw = providerOptions?.sikander?.partyNames
  if (!Array.isArray(raw)) return undefined
  const names = raw.filter((n): n is string => typeof n === "string" && n.length > 0)
  return names.length ? names : undefined
}
