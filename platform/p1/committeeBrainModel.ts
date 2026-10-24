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
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider"
import { callCommitteeBrain, type OutboundResponse } from "@/platform/p1/internalAICaller"
import {
  COMMITTEE_BRAIN_GATEWAY_MODEL,
} from "@/platform/p1/constants"
import {
  classificationFromProviderOptions,
  partyNamesFromProviderOptions,
  promptToTurns,
} from "@/platform/p1/promptText"
import { PROVIDER_KEY_IN_RUNTIME_REASON, checkProviderKeys } from "@/platform/p1/providerKeyGuard"

/**
 * Audit F34 (spec docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md, ruling R12): the bridge
 * reports real usage, or says it was not reported and why. A call refused before P1 or blocked by P1 sent nothing, so its
 * usage is zero (`none_sent`); in every deployment the bridge is blocked (audit F18: no provider transport in Next or eve),
 * so that is what production reports. An answered call reports the transport's counts when it gave both (`reported`);
 * otherwise every count stays undefined and the status says `usage_unreported` with the reason. The status rides in
 * `usage.raw` and in `providerMetadata.sikander`, on the result and on the stream's finish part.
 */
type UsageReport = { usage: LanguageModelV3Usage; providerMetadata: SharedV3ProviderMetadata }

export const USAGE_UNREPORTED_REASON = "transport_reported_no_usage"

const noneSent = (): UsageReport => ({
  usage: {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
    raw: { status: "none_sent" },
  },
  providerMetadata: { sikander: { usageStatus: "none_sent" } },
})

function usageOf(result: OutboundResponse): UsageReport {
  if (result.blocked) return noneSent()
  if (result.usage !== undefined) {
    return {
      usage: {
        inputTokens: { total: result.usage.inputTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: result.usage.outputTokens, text: undefined, reasoning: undefined },
        raw: { status: "reported" },
      },
      providerMetadata: { sikander: { usageStatus: "reported" } },
    }
  }
  return {
    usage: {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      raw: { status: "usage_unreported", reason: USAGE_UNREPORTED_REASON },
    },
    providerMetadata: { sikander: { usageStatus: "usage_unreported", usageReason: USAGE_UNREPORTED_REASON } },
  }
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
    ...noneSent(),
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
    ...usageOf(result),
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
          ...(result.providerMetadata === undefined ? {} : { providerMetadata: result.providerMetadata }),
        })
        controller.close()
      },
    })
    return { stream, request: result.request }
  },
}
