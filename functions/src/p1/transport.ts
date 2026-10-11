/**
 * The Vercel AI Gateway's OpenAI-compatible endpoint, called by plain `fetch` (spec P3-68): no SDK, no new
 * dependency. Failures throw errors that carry no provider text; the caller records the fixed `transport_error`.
 */

export type P1Transport = {
  send(req: { model: string; body: string; maxTokens: number }): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }>
}

export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions"
/** The function timeout is 120 s (P3-68). */
export const TRANSPORT_TIMEOUT_MS = 60_000

/** A usage figure only when it is a non-negative integer: anything else is "no usage" and gets estimated (P3-62). */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function gatewayTransport(apiKey: string, url: string = GATEWAY_URL, opts?: { timeoutMs?: number }): P1Transport {
  return {
    async send(req) {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: req.model, messages: [{ role: "user", content: req.body }], max_tokens: req.maxTokens }),
        // Covers the response body too, so a server that stalls after its headers also times out.
        signal: AbortSignal.timeout(opts?.timeoutMs ?? TRANSPORT_TIMEOUT_MS),
      })
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new Error(`gateway status ${res.status}`)
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: unknown } }[]
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
      } | null
      const text = json?.choices?.[0]?.message?.content
      if (typeof text !== "string") throw new Error("gateway response has no message content")
      return { text, inputTokens: tokenCount(json?.usage?.prompt_tokens), outputTokens: tokenCount(json?.usage?.completion_tokens) }
    },
  }
}

let testTransport: P1Transport | null = null

/** Test-only. Refused in production, like `platform/p1/internalAICaller.ts`'s `setTransportForTests`. */
export function setP1TransportForTests(t: P1Transport | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setP1TransportForTests is test-only")
  testTransport = t
}

/** The test transport if one is set, else the Gateway when `AI_GATEWAY_API_KEY` is non-empty, else null (P3-68). */
export function activeTransport(): P1Transport | null {
  if (testTransport) return testTransport
  const key = process.env.AI_GATEWAY_API_KEY?.trim()
  return key ? gatewayTransport(key) : null
}
