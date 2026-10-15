/**
 * The Vercel AI Gateway's OpenAI-compatible endpoint, called by plain `fetch` (spec P3-68): no SDK, no new
 * dependency. Every error `send` throws is a P1TransportError with a fixed code and a fixed message that carries
 * no provider text (not a parse error that quotes the body, not a runtime message about the socket); the caller
 * records the fixed `transport_error` and charges the call by the error's `billable` flag (I1).
 */

/**
 * What a call answered. `responseId` is the provider's own response id (the OpenAI-compatible body's `id`) and
 * `requestId` the request-id header the Gateway answered with; each is present only when it is a plain id (audit F08,
 * re-audit R1-D5), so a later per-request reconciliation against the provider's records can find the call (O-57).
 */
export type P1TransportReply = { text: string; inputTokens: number | null; outputTokens: number | null; responseId?: string; requestId?: string }

export type P1Transport = {
  send(req: { model: string; body: string; maxTokens: number }): Promise<P1TransportReply>
}

/**
 * The response headers that may carry the Gateway's request id, in the order read. Which one the Vercel AI Gateway
 * sets is to be confirmed at G-1 (O-57); `x-vercel-id` is set on responses served through Vercel's edge.
 */
export const REQUEST_ID_HEADERS = ["x-request-id", "x-vercel-id"] as const

/** A provider or Gateway id when it is a plain id (letters, digits, `.`, `_`, `:`, `-`, at most 200 characters); else undefined. Never provider text. */
export function plainId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) ? value : undefined
}

export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions"
/** The function timeout is 120 s (P3-68). */
export const TRANSPORT_TIMEOUT_MS = 60_000

/** Why a Gateway call failed: a fixed set, logged as is, never provider text (I1). */
export type TransportCode = "gateway_timeout" | "gateway_request_failed" | "gateway_status" | "gateway_not_json" | "gateway_no_text"

const MESSAGES: Readonly<Record<TransportCode, string>> = Object.freeze({
  gateway_timeout: "gateway timeout",
  gateway_request_failed: "gateway request failed",
  gateway_status: "gateway status",
  gateway_not_json: "gateway response is not JSON",
  gateway_no_text: "gateway response has no message content",
})

/** True for one of the fixed transport codes (own keys only, so "constructor" is not one). */
export function isTransportCode(value: unknown): value is TransportCode {
  return typeof value === "string" && Object.hasOwn(MESSAGES, value)
}

/**
 * A failed Gateway call. `billable` is true when the provider may have charged for it: a timeout or abort (the
 * request may have reached the provider), a 2xx whose body is not JSON, and a 2xx without usable message content.
 * It is false when it cannot have been charged: a non-2xx status, and a fetch that failed before any response
 * (refused connection, DNS, a refused redirect). `inputTokens` and `outputTokens` are the usage the response
 * reported, when it reported valid counts; null otherwise. `responseId` and `requestId` are the provider's ids for a
 * response that came back (Codex P2 on PR #40): a billed failure keeps them like an answer does, so the charge can be
 * found in the provider's records; each is present only when it is a plain id (`plainId`). The message is fixed by
 * the code (and, for `gateway_status`, the numeric status).
 */
export class P1TransportError extends Error {
  readonly code: TransportCode
  readonly billable: boolean
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly responseId?: string
  readonly requestId?: string

  constructor(
    code: TransportCode,
    opts: { billable: boolean; status?: number; inputTokens?: number | null; outputTokens?: number | null; responseId?: unknown; requestId?: unknown }
  ) {
    const status = code === "gateway_status" && Number.isInteger(opts.status) ? ` ${opts.status}` : ""
    super(`${MESSAGES[code]}${status}`)
    this.name = "P1TransportError"
    this.code = code
    this.billable = opts.billable
    this.inputTokens = opts.inputTokens ?? null
    this.outputTokens = opts.outputTokens ?? null
    const [responseId, requestId] = [plainId(opts.responseId), plainId(opts.requestId)]
    if (responseId !== undefined) this.responseId = responseId
    if (requestId !== undefined) this.requestId = requestId
  }
}

type GatewayBody = {
  id?: unknown
  choices?: { message?: { content?: unknown } }[]
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
} | null

/** A usage figure only when it is a non-negative integer: anything else is "no usage" and gets estimated (P3-62). */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** An abort, from `AbortSignal.timeout` or otherwise. */
function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === "TimeoutError" || name === "AbortError"
}

/** A timeout or abort: the request may have reached the provider, so it is billed conservatively (I1). */
const timedOut = () => new P1TransportError("gateway_timeout", { billable: true })

export function gatewayTransport(apiKey: string, url: string = GATEWAY_URL, opts?: { timeoutMs?: number }): P1Transport {
  return {
    async send(req) {
      let res: Response
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: req.model, messages: [{ role: "user", content: req.body }], max_tokens: req.maxTokens }),
          // A redirect is refused, never followed: the bearer key and the masked body go to the Gateway URL only.
          redirect: "error",
          // Covers the response body too, so a server that stalls after its headers also times out.
          signal: AbortSignal.timeout(opts?.timeoutMs ?? TRANSPORT_TIMEOUT_MS),
        })
      } catch (err) {
        // Anything but an abort is fetch's TypeError before any response: nothing reached the model.
        throw isAbort(err) ? timedOut() : new P1TransportError("gateway_request_failed", { billable: false })
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new P1TransportError("gateway_status", { billable: false, status: res.status })
      }
      // Read before the body is parsed (Codex P2 on PR #40): a billed failure keeps the request id too.
      const requestId = REQUEST_ID_HEADERS.map((h) => plainId(res.headers.get(h))).find((v) => v !== undefined)
      let json: GatewayBody
      try {
        json = (await res.json()) as GatewayBody
      } catch (err) {
        throw new P1TransportError(isAbort(err) ? "gateway_timeout" : "gateway_not_json", { billable: true, requestId })
      }
      const text = json?.choices?.[0]?.message?.content
      const inputTokens = tokenCount(json?.usage?.prompt_tokens)
      const outputTokens = tokenCount(json?.usage?.completion_tokens)
      const responseId = plainId(json?.id)
      if (typeof text !== "string") throw new P1TransportError("gateway_no_text", { billable: true, inputTokens, outputTokens, responseId, requestId })
      return { text, inputTokens, outputTokens, ...(responseId === undefined ? {} : { responseId }), ...(requestId === undefined ? {} : { requestId }) }
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
