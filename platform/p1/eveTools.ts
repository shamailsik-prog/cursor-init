/**
 * Local (non-provider) helpers the eve Committee Brain agent may call.
 * These never reach a model. Mask / policy / normaliser stay in-process.
 * Their input and output contracts (audit F16, spec ruling 5) are in platform/p1/eveToolContracts.ts.
 */

import courtsSeed from "@/data/courts.json"
import { loadCourts, normalise } from "@/core/case-number-normaliser"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { providerAllowedFor, type ProviderId } from "@/platform/p1/providerPolicy"
import { isClassification } from "@/platform/p1/types"

const courts = loadCourts(courtsSeed)

/** The seeded court ids (data/courts.json): the only ids normalise_case_number accepts. */
export const SEEDED_COURT_IDS: readonly string[] = Object.freeze(Object.keys(courts))

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
  // Own keys only (audit F16): "constructor" or "__proto__" would reach an inherited property of the table.
  if (!Object.hasOwn(courts, input.courtId)) return { status: "REJECT" as const, reason: "unknown court" }
  return normalise(input.raw, input.courtId, courts)
}
