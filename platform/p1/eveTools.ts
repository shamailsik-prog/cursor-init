/**
 * Local (non-provider) helpers the eve Committee Brain agent may call.
 * These never reach a model. Mask / policy / normaliser stay in-process.
 */

import courtsSeed from "@/data/courts.json"
import { loadCourts, normalise } from "@/core/case-number-normaliser"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { providerAllowedFor, type ProviderId } from "@/platform/p1/providerPolicy"
import { isClassification } from "@/platform/p1/types"

const courts = loadCourts(courtsSeed)

export function maskPreview(input: { text: string; partyNames?: string[] }) {
  const result = maskOutboundPII(input.text, { partyNames: input.partyNames })
  return {
    masked: result.masked,
    redactionCounts: Object.fromEntries(
      result.redactions.map((r) => [r.kind, r.count])
    ),
  }
}

export function classificationPolicy(input: {
  classification: string
  provider?: ProviderId
}) {
  if (!isClassification(input.classification)) {
    return {
      allowed: false as const,
      reason: "unknown classification — P1 refuses the call",
    }
  }
  return providerAllowedFor(input.provider ?? "ai-gateway", input.classification)
}

export function normaliseCaseNumber(input: { raw: string; courtId: string }) {
  return normalise(input.raw, input.courtId, courts)
}
