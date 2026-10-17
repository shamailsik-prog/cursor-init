/**
 * The structured P1 request (audit F16; spec docs/superpowers/specs/2026-10-17-f16-prompt-trust-roles-design.md, rulings
 * 1 to 4, review-round amendments R3a and R4a), shared by the Functions gateway (`callP1`) and the Next caller
 * (`callCommitteeBrain`).
 *
 * A request is one system message, first, then the user and assistant turns in order, adjacent turns of one role merged.
 * A turn is a list of segments: the turn author's own text, or untrusted content (a tool result, a document, a tool
 * call's arguments) that is rendered in an envelope (platform/p1/promptEnvelope.ts). There is no system turn: the type
 * has none and the builder refuses one.
 *
 * The system message is immutable platform text (R3a): the registry policy for the purpose
 * (platform/p1/systemPolicy.ts) and, on the eve bridge only, the pinned agent instructions
 * (platform/p1/agentInstructions.ts). It is never masked and never neutralised, so no party name or other caller input
 * can change it, and it is not user data: it adds nothing to the redaction or residual counts. It is recorded by
 * reference (`SystemRecord`: the policy id and version, and the instructions' hash), never by its text (R4a), and
 * `verifySystemMessage` checks a request against that record before it is sent.
 *
 * Every string a caller supplies is masked with the call's party names, redaction counts are summed by kind over those
 * parts, and every turn is neutralised and checked for envelope integrity. Classification never enters a message: it
 * is metadata.
 */

import { AGENT_INSTRUCTIONS, AGENT_INSTRUCTIONS_SHA256 } from "@/platform/p1/agentInstructions"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { envelopeIntegrity, isEnvelopeSource, neutraliseEnvelopeTags, wrapNeutralised } from "@/platform/p1/promptEnvelope"
import { RESIDUAL_KINDS, residualPII, type ResidualCounts } from "@/platform/p1/residualPII"
import { systemPolicyFor, systemPolicyText, type SystemPolicyId } from "@/platform/p1/systemPolicy"

export type OutboundRole = "system" | "user" | "assistant"
export type OutboundMessage = { role: OutboundRole; content: string }

export type PromptSegment = { kind: "text"; text: string } | { kind: "untrusted"; source: string; text: string }
export type PromptTurn = { role: "user" | "assistant"; segments: readonly PromptSegment[] }

/**
 * Which platform text the system message is (R4a): the registry policy's id and version and, on the eve bridge, the
 * SHA-256 of the pinned agent instructions appended to it. The text itself is re-derived from these, never stored.
 */
export type SystemRecord = { policyId: SystemPolicyId; version: string; agentInstructionsSha256?: string }

/** One merged turn as sent, recorded without its text (R4a): its role and the sources of its envelopes, in order. */
export type TurnRecord = { role: "user" | "assistant"; envelopes: string[] }

export type BuiltOutbound = {
  /** The system message first, then the turns. */
  messages: OutboundMessage[]
  system: SystemRecord
  /** The merged turns, one record per non-system message, in order. */
  turns: TurnRecord[]
  /** Summed over every caller-supplied part, by kind (the mask's seven kinds, zeros included). */
  redactionCounts: Record<string, number>
  /** Tag-name look-alikes neutralised in the turns. */
  neutralised: number
}

/** The heading the pinned agent instructions sit under, after the registry policy (R1b). */
export const AGENT_INSTRUCTIONS_HEADING = "Agent instructions:"
/** Between segments of one turn, and between merged turns. */
export const SEGMENT_SEPARATOR = "\n\n"

export type BuildOutboundInput = {
  purpose: string
  turns: readonly PromptTurn[]
  /** The eve bridge only: append the pinned agent instructions to the system message (R1b, R3a). */
  withAgentInstructions?: boolean
  partyNames?: string[]
}

const SYSTEM_RECORD_KEYS = new Set(["policyId", "version", "agentInstructionsSha256"])

/**
 * The system text a record names (R3a, R4a): the registry policy's text at that version, followed, when the record
 * carries the pinned instructions' hash, by the heading and the pinned agent instructions. Null for anything else: a
 * non-object, an unknown key, an unknown policy or version, or a hash that is not the pinned instructions'.
 */
export function expectedSystemText(record: unknown): string | null {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null
  const r = record as Record<string, unknown>
  if (Object.keys(r).some((key) => !SYSTEM_RECORD_KEYS.has(key))) return null
  const policy = systemPolicyText(r.policyId, r.version)
  if (policy === null) return null
  if (!Object.hasOwn(r, "agentInstructionsSha256")) return policy
  if (r.agentInstructionsSha256 !== AGENT_INSTRUCTIONS_SHA256) return null
  return `${policy}\n\n${AGENT_INSTRUCTIONS_HEADING}\n${AGENT_INSTRUCTIONS}`
}

/**
 * The send-time check (R3a): the request has exactly one system message, it is first, and its content is exactly the
 * text its record names. A caller sends nothing unless this passes.
 */
export function verifySystemMessage(messages: readonly OutboundMessage[], record: unknown): boolean {
  const expected = expectedSystemText(record)
  if (expected === null || messages.length === 0) return false
  if (messages[0]!.role !== "system" || messages[0]!.content !== expected) return false
  return messages.every((m, i) => i === 0 || m.role !== "system")
}

/** Throws on a request it cannot build safely (a system turn, no turn, an unknown segment, an invalid source). */
export function buildOutbound(input: BuildOutboundInput): BuiltOutbound {
  // Every kind the mask knows, at zero (the mask lists all of them), so the shape never depends on which parts were masked.
  const counts: Record<string, number> = Object.fromEntries(maskOutboundPII("").redactions.map((r) => [r.kind, 0]))
  const mask = (text: string): string => {
    const result = maskOutboundPII(text, { partyNames: input.partyNames })
    for (const r of result.redactions) counts[r.kind] = (counts[r.kind] ?? 0) + r.count
    return result.masked
  }

  // The system message: platform text only, never masked or neutralised (R3a), recorded by reference (R4a).
  const policy = systemPolicyFor(input.purpose)
  const system: SystemRecord =
    input.withAgentInstructions === true
      ? { policyId: policy.id, version: policy.version, agentInstructionsSha256: AGENT_INSTRUCTIONS_SHA256 }
      : { policyId: policy.id, version: policy.version }
  const systemText = expectedSystemText(system)
  if (systemText === null) throw new Error("P1: the system policy is not in the registry")

  if (!Array.isArray(input.turns as unknown) || input.turns.length === 0) throw new Error("P1: a request needs at least one turn")
  let neutralised = 0
  const turns: OutboundMessage[] = []
  const records: TurnRecord[] = []
  for (const turn of input.turns) {
    if (turn.role !== "user" && turn.role !== "assistant") throw new Error("P1: unsupported turn role")
    const envelopes: string[] = []
    const parts = turn.segments.map((segment) => {
      if (segment.kind === "text") {
        const out = neutraliseEnvelopeTags(mask(segment.text))
        neutralised += out.count
        return out.text
      }
      if (segment.kind === "untrusted") {
        if (!isEnvelopeSource(segment.source)) throw new Error("P1: invalid envelope source")
        const out = neutraliseEnvelopeTags(mask(segment.text))
        neutralised += out.count
        envelopes.push(segment.source)
        return wrapNeutralised(segment.source, out.text)
      }
      throw new Error("P1: unsupported prompt segment")
    })
    const content = parts.join(SEGMENT_SEPARATOR)
    const last = turns[turns.length - 1]
    if (last !== undefined && last.role === turn.role) {
      last.content += SEGMENT_SEPARATOR + content
      records[records.length - 1]!.envelopes.push(...envelopes)
    } else {
      turns.push({ role: turn.role, content })
      records.push({ role: turn.role, envelopes })
    }
  }
  for (const m of turns) {
    if (!envelopeIntegrity(m.content)) throw new Error("P1: envelope integrity check failed")
  }

  return {
    messages: [{ role: "system", content: systemText }, ...turns],
    system,
    turns: records,
    redactionCounts: counts,
    neutralised,
  }
}

/**
 * The residual detector's counts (audit F15) summed over the user and assistant messages. The system message is
 * verified platform text, not user data (R3a), and is not counted.
 */
export function residualCountsOfMessages(messages: readonly OutboundMessage[]): ResidualCounts {
  const total = Object.fromEntries(RESIDUAL_KINDS.map((kind) => [kind, 0])) as ResidualCounts
  for (const m of messages) {
    if (m.role === "system") continue
    const found = residualPII(m.content)
    for (const kind of RESIDUAL_KINDS) total[kind] += found[kind]
  }
  return total
}
