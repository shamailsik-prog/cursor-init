/**
 * AI SDK LanguageModel used by the eve Committee Brain agent.
 * Every generate/stream call goes through `callCommitteeBrain` (mask + policy).
 * A Gateway model string is never passed to eve — that would bypass P1.
 *
 * Audit F16: the prompt keeps its roles. `promptToTurns` turns it into P1 turns (tool calls and tool results in
 * envelopes); the system message is the registry policy and, when the prompt carries them, agent/instructions.md as
 * pinned by its digest, never anything else from the prompt's system text (review round, R3a). A part P1 cannot carry safely blocks the call
 * with its reason, and nothing is sent.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { callCommitteeBrain } from "@/platform/p1/internalAICaller"
import {
  COMMITTEE_BRAIN_GATEWAY_MODEL,
} from "@/platform/p1/constants"
import {
  classificationFromProviderOptions,
  partyNamesFromProviderOptions,
  promptToTurns,
} from "@/platform/p1/promptText"
import { PROVIDER_KEY_IN_RUNTIME_REASON, checkProviderKeys } from "@/platform/p1/providerKeyGuard"

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
}

function blockedAssistantText(reason: string): string {
  return `P1 Committee Brain blocked the provider call. ${reason}`
}

/**
 * A refusal the bridge makes before it reaches callCommitteeBrain. Audit F18 (R5; PR #88 review round 1): callCommitteeBrain
 * runs the provider-key check first, so these two exits run it themselves: the alert line is logged on every bridge path,
 * and in production with a key the key reason is reported, as callCommitteeBrain reports it.
 */
function refusedBeforeP1(reason: string, raw: string): LanguageModelV3GenerateResult {
  const keys = checkProviderKeys("p1-call")
  return {
    content: [{ type: "text", text: blockedAssistantText(keys.refuse ? PROVIDER_KEY_IN_RUNTIME_REASON : reason) }],
    finishReason: { unified: "error", raw: keys.refuse ? "provider key in runtime" : raw },
    usage: EMPTY_USAGE,
    warnings: [],
  }
}

async function runP1(
  options: LanguageModelV3CallOptions
): Promise<LanguageModelV3GenerateResult> {
  const classification = classificationFromProviderOptions(options.providerOptions)
  if (!classification) {
    return refusedBeforeP1("classification missing from providerOptions.sikander — P1 refuses the call", "omitted classification")
  }

  const converted = promptToTurns(options.prompt)
  if (!converted.ok) {
    return refusedBeforeP1(converted.reason, "unsupported prompt part")
  }

  const result = await callCommitteeBrain({
    turns: converted.turns,
    agentInstructions: converted.agentInstructions,
    classification,
    provider: "ai-gateway",
    purpose: "committee-brain",
    partyNames: partyNamesFromProviderOptions(options.providerOptions),
  })

  const text = result.blocked
    ? blockedAssistantText(result.reason ?? "blocked")
    : (result.text ?? "")

  return {
    content: [{ type: "text", text }],
    finishReason: {
      unified: result.blocked ? "error" : "stop",
      raw: result.blocked ? result.reason : "stop",
    },
    usage: EMPTY_USAGE,
    warnings: [],
    request: { body: { messages: result.messages } },
  }
}

export const committeeBrainLanguageModel: LanguageModelV3 = {
  specificationVersion: "v3",
  provider: "sikander-p1",
  modelId: COMMITTEE_BRAIN_GATEWAY_MODEL,
  supportedUrls: {},
  async doGenerate(options) {
    return runP1(options)
  },
  async doStream(options): Promise<LanguageModelV3StreamResult> {
    const result = await runP1(options)
    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join("")
    const id = "p1-text"
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: result.warnings })
        controller.enqueue({ type: "text-start", id })
        controller.enqueue({ type: "text-delta", id, delta: text })
        controller.enqueue({ type: "text-end", id })
        controller.enqueue({
          type: "finish",
          finishReason: result.finishReason,
          usage: result.usage,
        })
        controller.close()
      },
    })
    return { stream, request: result.request }
  },
}
