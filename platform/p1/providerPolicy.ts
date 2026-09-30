import dpaSeed from "@/data/provider_dpa.json"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import {
  classificationRank,
  isClassification,
  type Classification,
} from "@/platform/p1/types"

/** Every provider P1 is configured to know about. Anything else is refused. */
export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "deepseek",
  "perplexity",
  "whisper",
  "elevenlabs",
  "google-vision",
  "translation",
  "ai-gateway",
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

/**
 * Per-provider facts the L18 §4.6 table depends on. Both are firm decisions
 * (DPA execution; residency per L17.13a/h) recorded in data/provider_dpa.json.
 * TODO(firm): DPA / residency — do not invent; unrecorded means false.
 */
export type ProviderConfig = { dpaExecuted: boolean; inRegion: boolean }

type DpaFile = {
  providers: Record<string, { dpaExecuted?: boolean; inRegion?: boolean }>
}

const dpa = dpaSeed as DpaFile
const PROVIDER_SET: ReadonlySet<string> = new Set(PROVIDER_IDS)

let testConfig: Partial<Record<ProviderId, ProviderConfig>> | null = null

/** Test-only override of the provider table. */
export function setProviderConfigForTests(
  next: Partial<Record<ProviderId, ProviderConfig>> | null
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("setProviderConfigForTests is test-only")
  }
  testConfig = next
}

function isConfiguredProvider(provider: string): provider is ProviderId {
  return PROVIDER_SET.has(provider)
}

/** The provider's §4.6 facts; both default to false when unrecorded. */
export function providerConfig(provider: ProviderId): ProviderConfig {
  const row = testConfig
    ? testConfig[provider]
    : Object.prototype.hasOwnProperty.call(dpa.providers, provider)
      ? dpa.providers[provider]
      : undefined
  return { dpaExecuted: row?.dpaExecuted === true, inRegion: row?.inRegion === true }
}

/** Obligations the caller must meet before the allowed call leaves (rank >= 3). */
export type ProviderRequirements = { minimiseContent: true; scrubTrace: true }

export type ProviderDecision =
  | { allowed: true; requirements?: ProviderRequirements }
  | { allowed: false; reason: string }

const PRIVILEGED_REQUIREMENTS: ProviderRequirements = { minimiseContent: true, scrubTrace: true }

/**
 * L18 §4.6 classification ranks — P1 provider table default (also L17.3 §21,
 * L19.11 §2):
 *   0 public, 1 internal       any configured provider
 *   2 confidential             providers with an executed DPA
 *   3 privileged               executed DPA; content minimisation; trace PII-scrubbed
 *   4 privileged-restricted    in-region providers only; otherwise deterministic-only
 *                              or a partner-authorised exception with recorded reason
 * Unknown labels and unconfigured providers are refused (fail closed).
 */
export function providerAllowedFor(
  provider: ProviderId,
  classification: Classification | string
): ProviderDecision {
  if (!isClassification(classification)) {
    return {
      allowed: false,
      reason: "unknown classification — P1 refuses the call",
    }
  }
  if (!isConfiguredProvider(provider)) {
    return { allowed: false, reason: "L18 §4.6: provider is not configured in P1" }
  }
  const rank = classificationRank(classification)
  const config = providerConfig(provider)
  if (rank <= 1) return { allowed: true }
  if (rank === 2) {
    return config.dpaExecuted
      ? { allowed: true }
      : { allowed: false, reason: "L18 §4.6: confidential requires a provider with an executed DPA" }
  }
  if (rank === 3) {
    return config.dpaExecuted
      ? { allowed: true, requirements: PRIVILEGED_REQUIREMENTS }
      : { allowed: false, reason: "L18 §4.6: privileged requires a provider with an executed DPA" }
  }
  if (config.inRegion) return { allowed: true, requirements: PRIVILEGED_REQUIREMENTS }
  // TODO(firm): L18 §4.6 / L17.13a/h — the deterministic-only path and the
  // partner-authorised exception (with recorded reason) are not built yet, so an
  // out-of-region privileged-restricted call is blocked (ai.call.blocked).
  return {
    allowed: false,
    reason:
      "L18 §4.6: privileged-restricted requires an in-region provider; no deterministic path or partner-authorised exception is available",
  }
}

/**
 * Rank >= 3 obligation check: the outbound body and the trace metadata that is
 * returned and persisted (purpose) carry no PII the mask would still redact.
 */
export function assertMinimised(
  request: { body: string; metadata: { purpose: string } },
  partyNames: string[] | undefined
): boolean {
  for (const text of [request.body, request.metadata.purpose]) {
    const again = maskOutboundPII(text, { partyNames })
    if (again.redactions.some((r) => r.count > 0)) return false
  }
  return true
}
