import dpaSeed from "@/data/provider_dpa.json"
import {
  classificationRank,
  isClassification,
  type Classification,
} from "@/platform/p1/types"

export type ProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "deepseek"
  | "perplexity"
  | "whisper"
  | "elevenlabs"
  | "google-vision"
  | "translation"

type DpaFile = {
  providers: Record<string, { dpaExecuted?: boolean; inRegion?: boolean }>
}

const dpa = dpaSeed as DpaFile

/**
 * Conservative default: unknown DPA → block internal (rank 1) and above.
 * Internal opinions still carry client facts. Public (rank 0) may leave.
 * privileged-restricted additionally requires an in-region flag the firm has not set.
 * TODO(firm): DPA / residency — do not invent.
 */
export function providerAllowedFor(
  provider: ProviderId,
  classification: Classification | string
): { allowed: true } | { allowed: false; reason: string } {
  if (!isClassification(classification)) {
    return {
      allowed: false,
      reason: "unknown classification — P1 refuses the call",
    }
  }
  const rank = classificationRank(classification)
  const row = dpa.providers[provider]
  if (rank >= 4) {
    if (!row?.inRegion) {
      return {
        allowed: false,
        reason:
          "TODO(firm): data-residency region unset — privileged-restricted blocked (L17.13 / L18 §4.6)",
      }
    }
  }
  if (rank >= 1) {
    if (!row?.dpaExecuted) {
      return {
        allowed: false,
        reason:
          "TODO(firm): DPA status unknown — provider blocked for internal+ (client-identifying; L18 §4.6 conservative)",
      }
    }
  }
  return { allowed: true }
}
