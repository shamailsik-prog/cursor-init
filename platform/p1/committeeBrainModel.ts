/**
 * AI SDK LanguageModel used by the eve Committee Brain agent.
 * Every generate/stream call goes through `callCommitteeBrain` (mask + policy).
 * A Gateway model string is never passed to eve — that would bypass P1.
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
  promptToOutboundBody,
} from "@/platform/p1/promptText"

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

async function runP1(
  options: LanguageModelV3CallOptions
): Promise<LanguageModelV3GenerateResult> {
  const body = promptToOutboundBody(options.prompt)
  const classification = classificationFromProviderOptions(options.providerOptions)
  if (!classification) {
    return {
      content: [
        {
          type: "text",
          text: blockedAssistantText(
            "classification missing from providerOptions.sikander — P1 refuses the call"
          ),
        },
      ],
      finishReason: { unified: "error", raw: "omitted classification" },
      usage: EMPTY_USAGE,
      warnings: [],
    }
  }

  const result = await callCommitteeBrain({
    body,
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
    request: { body: result.outbound.body },
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
