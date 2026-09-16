/**
 * Optional live transport. Uses Vercel AI Gateway model strings only.
 * Does not import provider SDKs. Does not invent API keys.
 * Fires only when AI_GATEWAY_API_KEY or VERCEL_AI_GATEWAY_API_KEY is already set.
 */

import { createGateway, generateText } from "ai"
import {
  COMMITTEE_BRAIN_GATEWAY_MODEL,
  PHASE0_NO_CREDENTIALS,
} from "@/platform/p1/constants"

type GatewaySend = {
  send: (request: { body: string }) => Promise<{ text: string }>
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
        prompt: request.body,
      })
      return { text: result.text }
    },
  }
}

export const gatewayTransport = createGatewayTransport()
