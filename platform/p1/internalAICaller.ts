/**
 * P1 Committee Brain — the only outbound path to AI / OCR / STT / TTS / translation.
 * Only the masked, role-separated messages are sent (audit F16): one system message from the platform registry
 * (platform/p1/systemPolicy.ts), then the user and assistant turns, untrusted content in envelopes. Classification
 * travels in metadata, never in a message.
 *
 * Review round (spec rulings R3a, R4a): the system message is immutable platform text, verified against its record just
 * before dispatch; what is returned and stored (`outbound`) names it by reference and holds the body once, the same
 * shape as the Functions path; and a call whose stored record would exceed MAX_STORED_OUTBOUND_BYTES is refused before
 * anything else is decided, so even its blocked row fits a Firestore document.
 */

import { recordExternalEffect } from "@/platform/http/idempotency"
import { MAX_STORED_OUTBOUND_BYTES, PHASE0_NO_CREDENTIALS, STORED_OUTBOUND_TOO_LARGE_REASON, SYSTEM_UNVERIFIED_REASON } from "@/platform/p1/constants"
import { gatewayTransport, readGatewayApiKey } from "@/platform/p1/gatewayTransport"
import { maskOutboundPII, type MaskOptions } from "@/platform/p1/maskOutboundPII"
import { buildOutbound, verifySystemMessage, type OutboundMessage, type PromptTurn, type SystemRecord, type TurnRecord } from "@/platform/p1/outboundPrompt"
import { assertMinimised, providerAllowedFor, type ProviderId } from "@/platform/p1/providerPolicy"
import { isClassification, type Classification } from "@/platform/p1/types"

export { PHASE0_NO_CREDENTIALS } from "@/platform/p1/constants"

/** Fixed reason recorded when the transport fails for any other cause. */
export const TRANSPORT_ERROR_REASON = "transport_error"

/** What a call returns and the Next committee route stores (audit F16, review round R4a): no content is held twice. */
export type OutboundRequest = {
  /** The masked content of the final user message as sent. Never includes classification. */
  body: string
  /** Audit F16, R4a: which platform text the system message was (policy id and version, the instructions' hash), never the text. */
  system: SystemRecord
  /**
   * R4a, a conversation only (the eve bridge): each merged turn's role and envelope sources, in order, without its text.
   * Absent for a single user turn (`body`), whose record is the Functions path's shape.
   */
  turns?: TurnRecord[]
  metadata: {
    classification: Classification
    provider: ProviderId
    purpose: string
    redactionCounts: Record<string, number>
  }
}

/** What a transport receives: the record plus the role-separated messages it sends as given, the system message first. */
export type OutboundSend = OutboundRequest & { messages: OutboundMessage[] }

export type OutboundResponse = {
  blocked: boolean
  /** Set on every blocked call (L18 §4.6 / L19.11: ai.call.blocked). */
  event?: "ai.call.blocked"
  reason?: string
  provider?: ProviderId
  text?: string
  /** What was (or would have been) sent, as stored: see OutboundRequest. */
  outbound: OutboundRequest
  /**
   * The role-separated messages as built, for the caller's own request echo (the eve bridge). Never part of `outbound`
   * and never stored; empty when the call is refused for its size.
   */
  messages: OutboundMessage[]
}

export type Transport = {
  send: (request: OutboundSend) => Promise<{ text: string }>
}

/** UTF-8 length of a string, without encoding it. */
function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** The size a stored outbound takes: its JSON in UTF-8, at least what Firestore counts for the same strings. */
export function storedOutboundBytes(outbound: OutboundRequest): number {
  return utf8Length(JSON.stringify(outbound))
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

type CallCommitteeBrainCommon = {
  classification: Classification
  provider: ProviderId
  /** Selects the system policy (systemPolicy.ts); free text falls back to the default policy. Never sent as text. */
  purpose: string
  partyNames?: MaskOptions["partyNames"]
}

/**
 * Audit F16: the caller's own text as one user turn (`body`: the HTTP route, translation), or the turns of a
 * conversation (`turns`: the eve bridge, which passes the agent instructions it found in the prompt, spec refinements
 * R1b and R3a). No caller supplies other system text: the system message is the registry's text for the purpose and,
 * on the bridge, agent/instructions.md as pinned by its digest after it; any other instructions text is refused.
 */
export type CallCommitteeBrainInput = CallCommitteeBrainCommon &
  ({ body: string; turns?: never; agentInstructions?: never } | { turns: readonly PromptTurn[]; agentInstructions?: string; body?: never })

export async function callCommitteeBrain(
  input: CallCommitteeBrainInput
): Promise<OutboundResponse> {
  if (!isClassification(input.classification)) {
    throw new Error("P1 call omitted classification")
  }

  const conversation = input.turns !== undefined
  const turns: readonly PromptTurn[] = conversation ? input.turns : [{ role: "user", segments: [{ kind: "text", text: input.body }] }]
  const built = buildOutbound({
    purpose: input.purpose,
    turns,
    agentInstructions: conversation ? input.agentInstructions : undefined,
    partyNames: input.partyNames,
  })
  const purpose = maskOutboundPII(input.purpose, {
    partyNames: input.partyNames,
  }).masked
  const lastUser = [...built.messages].reverse().find((m) => m.role === "user")
  const metadata: OutboundRequest["metadata"] = {
    classification: input.classification,
    provider: input.provider,
    purpose,
    redactionCounts: built.redactionCounts,
  }
  const outbound: OutboundRequest = {
    body: lastUser?.content ?? "",
    system: built.system,
    ...(conversation ? { turns: built.turns } : {}),
    metadata,
  }
  const messages = built.messages
  const blocked = (reason: string, record: OutboundRequest = outbound, sent: OutboundMessage[] = messages): OutboundResponse => ({
    blocked: true,
    event: "ai.call.blocked",
    reason,
    outbound: record,
    messages: sent,
  })

  // R4a: a record too large to store is refused before anything else is decided, so even a blocked call's row fits a
  // document. Its record keeps the system reference, the turn records and the counts, without the body.
  if (storedOutboundBytes(outbound) > MAX_STORED_OUTBOUND_BYTES) {
    return blocked(STORED_OUTBOUND_TOO_LARGE_REASON, { ...outbound, body: "" }, [])
  }

  // R3a: the system message is exactly the platform text its record names, or nothing is sent.
  if (!verifySystemMessage(messages, built.system)) return blocked(SYSTEM_UNVERIFIED_REASON)

  const policy = providerAllowedFor(input.provider, input.classification)
  if (!policy.allowed) return blocked(policy.reason)
  // L18 §4.6 rank >= 3: content minimisation and a PII-scrubbed trace are
  // obligations of the allow decision. The mask above provides both; verify it
  // actually did before anything leaves: the body, every user and assistant message
  // and the purpose (the verified system message is platform text, R3a).
  if (policy.requirements && !assertMinimised({ body: outbound.body, messages, metadata }, input.partyNames)) {
    return blocked("L18 §4.6: content minimisation not applied")
  }

  const transport = activeTransport()
  // Audit F10: a dispatch that can reach a provider is an effect. Inside an idempotent request it is marked through the
  // request's write fence first, so a retry of the same Idempotency-Key never pays for a second call. A transport with
  // no credentials sends nothing and is not marked.
  if (transport !== blockedTransport) await recordExternalEffect("p1_dispatch")

  try {
    const result = await transport.send({ ...outbound, messages })
    const inbound = maskOutboundPII(result.text, {
      partyNames: input.partyNames,
    })
    return {
      blocked: false,
      provider: input.provider,
      text: inbound.masked,
      outbound,
      messages,
    }
  } catch (err) {
    // The reason is returned to callers and persisted with committee outputs,
    // so never echo provider/gateway error text: use a fixed code, log detail.
    if (err instanceof Error && err.message === PHASE0_NO_CREDENTIALS) {
      return blocked(PHASE0_NO_CREDENTIALS)
    }
    console.error("[p1] transport error", err)
    return blocked(TRANSPORT_ERROR_REASON)
  }
}

/** Alias used by older Correction Pack text. */
export const safePrompt = maskOutboundPII
export const internalAICaller = callCommitteeBrain
