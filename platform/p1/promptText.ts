import type { LanguageModelV3CallOptions, LanguageModelV3ToolResultOutput } from "@ai-sdk/provider"
import type { PromptSegment, PromptTurn } from "@/platform/p1/outboundPrompt"
import { isEnvelopeSource } from "@/platform/p1/promptEnvelope"
import { isClassification, type Classification } from "@/platform/p1/types"

/**
 * An AI SDK prompt as P1 turns (audit F16; spec docs/superpowers/specs/2026-10-17-f16-prompt-trust-roles-design.md,
 * rulings 1 and 2). Nothing is flattened and nothing is silently dropped:
 *
 * - `system` messages are the eve agent's compiled system-role instructions (agent/instructions.md): they become
 *   `agentInstructions`, which the builder places in the system message after the registry policy (refinement R1b);
 * - `user` text parts stay the user's turn; `assistant` text parts stay the assistant's turn;
 * - a `tool-call` part is enveloped (`tool-call:<name>`, its JSON input) in the assistant turn that made it;
 * - a `tool-result` part (from a `tool` message, or provider-executed in an `assistant` message) is enveloped
 *   (`tool:<name>`, its output as text) in a user turn, because the request carries no structured tool calls;
 * - anything P1 cannot carry safely (`file`, `reasoning`, `tool-approval-response`, a tool output with media, an unknown
 *   part or role, a tool name outside the envelope source grammar) fails closed with a reason, and nothing is sent.
 *
 * Classification is never read from or added to the prompt.
 */
export type PromptConversion = { ok: true; agentInstructions: string[]; turns: PromptTurn[] } | { ok: false; reason: string }

const cannotCarry = (what: string): PromptConversion => ({ ok: false, reason: `P1 cannot carry ${what}; nothing was sent` })

/** The envelope source for a tool part, when its tool name fits the grammar; else null. */
function sourceFor(kind: "tool" | "tool-call", toolName: unknown): string | null {
  if (typeof toolName !== "string") return null
  const source = `${kind}:${toolName}`
  return isEnvelopeSource(source) ? source : null
}

function json(value: unknown): string | null {
  try {
    return JSON.stringify(value ?? null) ?? null
  } catch {
    return null
  }
}

/** A tool result's output as text, or null when it carries something other than text or JSON (media). */
function toolOutputText(output: LanguageModelV3ToolResultOutput | undefined): string | null {
  switch (output?.type) {
    case "text":
    case "error-text":
      return typeof output.value === "string" ? output.value : null
    case "json":
    case "error-json":
      return json(output.value)
    case "execution-denied":
      return typeof output.reason === "string" ? `execution denied: ${output.reason}` : "execution denied"
    case "content": {
      const texts: string[] = []
      for (const item of output.value) {
        if (item.type !== "text") return null
        texts.push(item.text)
      }
      return texts.join("\n")
    }
    default:
      return null
  }
}

/** The enveloped segment for a tool-result part, or the reason it cannot be carried. */
function toolResultSegment(part: { toolName: unknown; output: LanguageModelV3ToolResultOutput }): PromptSegment | string {
  const source = sourceFor("tool", part.toolName)
  if (source === null) return "a tool name outside the envelope source grammar"
  const text = toolOutputText(part.output)
  if (text === null) return `a tool result whose output is ${String(part.output?.type)} with media`
  return { kind: "untrusted", source, text }
}

export function promptToTurns(prompt: LanguageModelV3CallOptions["prompt"]): PromptConversion {
  const agentInstructions: string[] = []
  const turns: PromptTurn[] = []
  for (const message of prompt) {
    if (message.role === "system") {
      // eve places its compiled system-role instructions before the conversation; a system message after a turn has no
      // such source and could carry conversation data into the system role (R1b), so it fails closed.
      if (turns.length > 0) return cannotCarry("a system message after the conversation has started")
      if (typeof message.content !== "string") return cannotCarry("a system message that is not text")
      agentInstructions.push(message.content)
      continue
    }
    if (message.role === "user") {
      const segments: PromptSegment[] = []
      for (const part of message.content) {
        if (part.type === "text") segments.push({ kind: "text", text: part.text })
        else return cannotCarry(`${String((part as { type?: unknown }).type)} parts`)
      }
      turns.push({ role: "user", segments })
      continue
    }
    if (message.role === "assistant") {
      const segments: PromptSegment[] = []
      const results: PromptSegment[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          segments.push({ kind: "text", text: part.text })
        } else if (part.type === "tool-call") {
          const source = sourceFor("tool-call", part.toolName)
          if (source === null) return cannotCarry("a tool name outside the envelope source grammar")
          const input = json(part.input)
          if (input === null) return cannotCarry("a tool call whose input is not JSON")
          segments.push({ kind: "untrusted", source, text: input })
        } else if (part.type === "tool-result") {
          const segment = toolResultSegment(part)
          if (typeof segment === "string") return cannotCarry(segment)
          results.push(segment)
        } else {
          return cannotCarry(`${String((part as { type?: unknown }).type)} parts`)
        }
      }
      if (segments.length > 0) turns.push({ role: "assistant", segments })
      if (results.length > 0) turns.push({ role: "user", segments: results })
      continue
    }
    if (message.role === "tool") {
      const segments: PromptSegment[] = []
      for (const part of message.content) {
        if (part.type !== "tool-result") return cannotCarry(`${String((part as { type?: unknown }).type)} parts`)
        const segment = toolResultSegment(part)
        if (typeof segment === "string") return cannotCarry(segment)
        segments.push(segment)
      }
      if (segments.length > 0) turns.push({ role: "user", segments })
      continue
    }
    return cannotCarry("a message with an unknown role")
  }
  if (turns.length === 0) return cannotCarry("a prompt without a user or assistant turn")
  return { ok: true, agentInstructions, turns }
}

/**
 * Classification travels in providerOptions metadata, never in the prompt.
 * Missing classification is not treated as public.
 */
export function classificationFromProviderOptions(
  providerOptions: LanguageModelV3CallOptions["providerOptions"]
): Classification | undefined {
  const raw = providerOptions?.sikander?.classification
  if (typeof raw !== "string") return undefined
  if (!isClassification(raw)) return undefined
  return raw
}

export function partyNamesFromProviderOptions(
  providerOptions: LanguageModelV3CallOptions["providerOptions"]
): string[] | undefined {
  const raw = providerOptions?.sikander?.partyNames
  if (!Array.isArray(raw)) return undefined
  const names = raw.filter((n): n is string => typeof n === "string" && n.length > 0)
  return names.length ? names : undefined
}
