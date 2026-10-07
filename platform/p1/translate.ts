import { callCommitteeBrain } from "@/platform/p1/internalAICaller"
import type { Classification } from "@/platform/p1/types"

export async function requestTranslation(input: {
  text: string
  classification: Classification
  partyNames?: string[]
}) {
  const result = await callCommitteeBrain({
    body: input.text,
    classification: input.classification,
    provider: "openai",
    purpose: "translate",
    partyNames: input.partyNames,
  })
  if (result.blocked) {
    return {
      event: "ai.call.blocked" as const,
      blocked: true as const,
      reason: result.reason,
      classification: input.classification,
    }
  }
  // L18 §4.7 event catalogue: ai.call.requested/completed/failed/blocked (spec audit U-15).
  return { event: "ai.call.completed" as const, blocked: false as const, text: result.text }
}
