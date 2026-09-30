/**
 * P1 Committee Brain — the only outbound path to AI / OCR / STT / TTS / translation.
 * The masked body is the ONLY text sent. Classification travels in metadata, never in the prompt.
 */

import { PHASE0_NO_CREDENTIALS } from "@/platform/p1/constants"
import { gatewayTransport, readGatewayApiKey } from "@/platform/p1/gatewayTransport"
import { maskOutboundPII, type MaskOptions } from "@/platform/p1/maskOutboundPII"
import { providerAllowedFor, type ProviderId } from "@/platform/p1/providerPolicy"
import { isClassification, type Classification } from "@/platform/p1/types"

export { PHASE0_NO_CREDENTIALS } from "@/platform/p1/constants"

/** Fixed reason recorded when the transport fails for any other cause. */
export const TRANSPORT_ERROR_REASON = "transport_error"

export type OutboundRequest = {
  /** Masked prompt/transcript/document text. Never includes classification. */
  body: string
  metadata: {
    classification: Classification
    provider: ProviderId
    purpose: string
    redactionCounts: Record<string, number>
  }
}

export type OutboundResponse = {
  blocked: boolean
  reason?: string
  provider?: ProviderId
  text?: string
  /** Echo of what would be / was sent, for tests and audit. */
  outbound: OutboundRequest
}

export type Transport = {
  send: (request: OutboundRequest) => Promise<{ text: string }>
}

const blockedTransport: Transport = {
  async send() {
    throw new Error(PHASE0_NO_CREDENTIALS)
  },
}

let testTransport: Transport | null = null

function activeTransport(): Transport {
  if (testTransport) return testTransport
  if (readGatewayApiKey()) return gatewayTransport
  return blockedTransport
}

/** Test-only. Production never injects a transport that sees raw text. */
export function setTransportForTests(next: Transport | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("setTransportForTests is test-only")
  }
  testTransport = next
}

export type CallCommitteeBrainInput = {
  body: string
  classification: Classification
  provider: ProviderId
  purpose: string
  partyNames?: MaskOptions["partyNames"]
}

export async function callCommitteeBrain(
  input: CallCommitteeBrainInput
): Promise<OutboundResponse> {
  if (!isClassification(input.classification)) {
    throw new Error("P1 call omitted classification")
  }

  const mask = maskOutboundPII(input.body, { partyNames: input.partyNames })
  const purpose = maskOutboundPII(input.purpose, {
    partyNames: input.partyNames,
  }).masked
  const outbound: OutboundRequest = {
    body: mask.masked,
    metadata: {
      classification: input.classification,
      provider: input.provider,
      purpose,
      redactionCounts: Object.fromEntries(
        mask.redactions.map((r) => [r.kind, r.count])
      ),
    },
  }

  const policy = providerAllowedFor(input.provider, input.classification)
  if (!policy.allowed) {
    return { blocked: true, reason: policy.reason, outbound }
  }

  try {
    const result = await activeTransport().send(outbound)
    const inbound = maskOutboundPII(result.text, {
      partyNames: input.partyNames,
    })
    return {
      blocked: false,
      provider: input.provider,
      text: inbound.masked,
      outbound,
    }
  } catch (err) {
    // The reason is returned to callers and persisted with committee outputs,
    // so never echo provider/gateway error text: use a fixed code, log detail.
    if (err instanceof Error && err.message === PHASE0_NO_CREDENTIALS) {
      return { blocked: true, reason: PHASE0_NO_CREDENTIALS, outbound }
    }
    console.error("[p1] transport error", err)
    return { blocked: true, reason: TRANSPORT_ERROR_REASON, outbound }
  }
}

/** Alias used by older Correction Pack text. */
export const safePrompt = maskOutboundPII
export const internalAICaller = callCommitteeBrain
