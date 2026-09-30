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
  | "ai-gateway"

type DpaFile = {
  providers: Record<string, { dpaExecuted?: boolean; inRegion?: boolean }>
}

const dpa = dpaSeed as DpaFile

/**
 * Allow-list: only an explicit rank-0 (public) label may leave for an external
 * provider. Everything else — every rank >= 1 and any unknown/malformed label —
 * is blocked. (The DPA/residency rows are kept for the reason text; enabling
 * internal+ traffic is a future, explicit firm decision, not a default.)
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
  if (rank === 0) return { allowed: true }
  const row = dpa.providers[provider]
  if (rank >= 4 && !row?.inRegion) {
    return {
      allowed: false,
      reason:
        "TODO(firm): data-residency region unset — privileged-restricted blocked (L17.13 / L18 §4.6)",
    }
  }
  if (!row?.dpaExecuted) {
    return {
      allowed: false,
      reason:
        "TODO(firm): DPA status unknown — provider blocked for internal+ (client-identifying; L18 §4.6 conservative)",
    }
  }
  return {
    allowed: false,
    reason: "P1 policy: only public (rank 0) material may leave for an external provider",
  }
}
