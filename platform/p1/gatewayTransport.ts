/**
 * Optional live transport. Uses Vercel AI Gateway model strings only.
 * Does not import provider SDKs. Does not invent API keys.
 * Fires only when AI_GATEWAY_API_KEY or VERCEL_AI_GATEWAY_API_KEY is already set.
 *
 * Audit F16 (spec ruling 1): it sends the request's role-separated `messages` as given, the platform's system message
 * first; it never sends a flattened prompt, which the AI SDK would turn into a single user message. Review round (R4a):
 * the answer is bounded at COMMITTEE_BRAIN_MAX_OUTPUT_TOKENS, because it is stored beside the outbound in one document.
 */

import { createGateway, generateText } from "ai"
import {
  COMMITTEE_BRAIN_GATEWAY_MODEL,
  COMMITTEE_BRAIN_MAX_OUTPUT_TOKENS,
  PHASE0_NO_CREDENTIALS,
} from "@/platform/p1/constants"
import type { OutboundMessage } from "@/platform/p1/outboundPrompt"

type GatewaySend = {
  send: (request: { messages: readonly OutboundMessage[] }) => Promise<{ text: string }>
}

export function readGatewayApiKey(): string | undefined {
  const key =
    process.env.AI_GATEWAY_API_KEY?.trim() ||
    process.env.VERCEL_AI_GATEWAY_API_KEY?.trim()
  return key || undefined
}

export function createGatewayTransport(
  modelId: string = COMMITTEE_BRAIN_GATEWAY_MODEL
): GatewaySend {
  return {
    async send(request) {
      const apiKey = readGatewayApiKey()
      if (!apiKey) {
        throw new Error(PHASE0_NO_CREDENTIALS)
      }
      const gateway = createGateway({ apiKey })
      const result = await generateText({
        model: gateway.languageModel(modelId),
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        maxOutputTokens: COMMITTEE_BRAIN_MAX_OUTPUT_TOKENS,
      })
      return { text: result.text }
    },
  }
}

export const gatewayTransport = createGatewayTransport()
