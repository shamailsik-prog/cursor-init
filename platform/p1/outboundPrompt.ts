/**
 * The structured P1 request (audit F16; spec docs/superpowers/specs/2026-10-17-f16-prompt-trust-roles-design.md, rulings
 * 1 to 3), shared by the Functions gateway (`callP1`) and the Next caller (`callCommitteeBrain`).
 *
 * A request is one system message, first, whose text comes only from the registry (platform/p1/systemPolicy.ts), plus,
 * on the eve bridge only, the agent's own compiled system instructions (refinement R1b); then the user and assistant
 * turns in order, adjacent turns of one role merged. A turn is a list of segments: the turn author's own text, or
 * untrusted content (a tool result, a document, a tool call's arguments) that is rendered in an envelope
 * (platform/p1/promptEnvelope.ts). There is no system turn: the type has none and the builder refuses one.
 *
 * Every string that leaves is masked with the call's party names (the system text included), redaction counts are
 * summed by kind over every part, and every non-system message is neutralised and checked for envelope integrity.
 * Classification never enters a message: it is metadata.
 */

import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { envelopeIntegrity, isEnvelopeSource, neutraliseEnvelopeTags, wrapNeutralised } from "@/platform/p1/promptEnvelope"
import { RESIDUAL_KINDS, residualPII, type ResidualCounts } from "@/platform/p1/residualPII"
import { systemPolicyFor, type SystemPolicyId } from "@/platform/p1/systemPolicy"

export type OutboundRole = "system" | "user" | "assistant"
export type OutboundMessage = { role: OutboundRole; content: string }

export type PromptSegment = { kind: "text"; text: string } | { kind: "untrusted"; source: string; text: string }
export type PromptTurn = { role: "user" | "assistant"; segments: readonly PromptSegment[] }

/** What the system message was: the registry policy it came from and the masked text that was sent. */
export type SystemRecord = { policyId: SystemPolicyId; version: string; text: string }

export type BuiltOutbound = {
  /** The system message first, then the turns. */
  messages: OutboundMessage[]
  system: SystemRecord
  /** Summed over every part, by kind (the mask's seven kinds, zeros included). */
  redactionCounts: Record<string, number>
  /** Tag-name look-alikes neutralised in the turns. */
  neutralised: number
}

/** The heading the eve agent's own system text sits under, after the registry policy (R1b). */
export const AGENT_INSTRUCTIONS_HEADING = "Agent instructions:"
/** Between segments of one turn, and between merged turns. */
export const SEGMENT_SEPARATOR = "\n\n"

export type BuildOutboundInput = {
  purpose: string
  turns: readonly PromptTurn[]
  /** The eve bridge only: the AI SDK prompt's system messages, which eve compiles from agent/instructions.md (R1b). */
  agentInstructions?: readonly string[]
  partyNames?: string[]
}

/** Throws on a request it cannot build safely (a system turn, no turn, an unknown segment, an invalid source). */
export function buildOutbound(input: BuildOutboundInput): BuiltOutbound {
  const counts: Record<string, number> = {}
  const mask = (text: string): string => {
    const result = maskOutboundPII(text, { partyNames: input.partyNames })
    for (const r of result.redactions) counts[r.kind] = (counts[r.kind] ?? 0) + r.count
    return result.masked
  }

  const policy = systemPolicyFor(input.purpose)
  const agent = (input.agentInstructions ?? []).filter((text) => typeof text === "string" && text.trim() !== "")
  const systemText = agent.length === 0 ? mask(policy.text) : `${mask(policy.text)}\n\n${AGENT_INSTRUCTIONS_HEADING}\n${agent.map(mask).join(SEGMENT_SEPARATOR)}`

  if (!Array.isArray(input.turns as unknown) || input.turns.length === 0) throw new Error("P1: a request needs at least one turn")
  let neutralised = 0
  const turns: OutboundMessage[] = []
  for (const turn of input.turns) {
    if (turn.role !== "user" && turn.role !== "assistant") throw new Error("P1: unsupported turn role")
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
        return wrapNeutralised(segment.source, out.text)
      }
      throw new Error("P1: unsupported prompt segment")
    })
    const content = parts.join(SEGMENT_SEPARATOR)
    const last = turns[turns.length - 1]
    if (last !== undefined && last.role === turn.role) last.content += SEGMENT_SEPARATOR + content
    else turns.push({ role: turn.role, content })
  }
  for (const m of turns) {
    if (!envelopeIntegrity(m.content)) throw new Error("P1: envelope integrity check failed")
  }

  return {
    messages: [{ role: "system", content: systemText }, ...turns],
    system: { policyId: policy.id, version: policy.version, text: systemText },
    redactionCounts: counts,
    neutralised,
  }
}

/** The residual detector's counts (audit F15) summed over every message. */
export function residualCountsOfMessages(messages: readonly OutboundMessage[]): ResidualCounts {
  const total = Object.fromEntries(RESIDUAL_KINDS.map((kind) => [kind, 0])) as ResidualCounts
  for (const m of messages) {
    const found = residualPII(m.content)
    for (const kind of RESIDUAL_KINDS) total[kind] += found[kind]
  }
  return total
}
