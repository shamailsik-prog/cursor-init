import { REQUEST_ID_HEADERS, inFunctionsRuntime, modelId, plainId } from "./transport"

/**
 * FA-D3C-002 (spec docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-boundary-design.md, ruling R11): the Vercel AI
 * Gateway's OpenAI-compatible embeddings endpoint, called by plain `fetch` like the chat transport (no SDK, no new
 * dependency). It posts `{ model, input }` and returns the vector, the input tokens the Gateway reported, its request id
 * and the model it reported. Every error is a P1EmbeddingTransportError with a fixed code and message that carry no
 * provider text, and the chat transport's billing rule (transport.ts): a timeout or abort, a 2xx that is not JSON and a
 * 2xx without a usable vector may have been billed; a non-2xx and a request that never left cannot have been.
 *
 * `callP1Embedding` (embedding.ts) is the only caller: it masks the input first and checks the vector's dimensions.
 */

export const EMBEDDINGS_URL = "https://ai-gateway.vercel.sh/v1/embeddings"
/** Embeddings answer in well under a second; the function's whole time budget is checked in corpusEmbedding.ts. */
export const EMBEDDING_TRANSPORT_TIMEOUT_MS = 20_000
/** The largest vector accepted from the Gateway (text-embedding-3-large is 3,072); P1 then requires the route's size. */
export const MAX_EMBEDDING_DIMENSIONS = 4096

export type EmbeddingTransportCode = "gateway_timeout" | "gateway_request_failed" | "gateway_status" | "gateway_not_json" | "gateway_no_embedding"

const MESSAGES: Readonly<Record<EmbeddingTransportCode, string>> = Object.freeze({
  gateway_timeout: "gateway timeout",
  gateway_request_failed: "gateway request failed",
  gateway_status: "gateway status",
  gateway_not_json: "gateway response is not JSON",
  gateway_no_embedding: "gateway response has no usable embedding",
})

/** A failed embeddings call: a fixed code, whether it may have been billed, and the input tokens reported (if valid). */
export class P1EmbeddingTransportError extends Error {
  readonly code: EmbeddingTransportCode
  readonly billable: boolean
  readonly inputTokens: number | null
  readonly requestId?: string

  constructor(code: EmbeddingTransportCode, opts: { billable: boolean; status?: number; inputTokens?: number | null; requestId?: unknown }) {
    const status = code === "gateway_status" && Number.isInteger(opts.status) ? ` ${opts.status}` : ""
    super(`${MESSAGES[code]}${status}`)
    this.name = "P1EmbeddingTransportError"
    this.code = code
    this.billable = opts.billable
    this.inputTokens = opts.inputTokens ?? null
    const requestId = plainId(opts.requestId)
    if (requestId !== undefined) this.requestId = requestId
  }
}

export type P1EmbeddingReply = {
  embedding: number[]
  inputTokens: number | null
  requestId?: string
  /** The model the Gateway reported, when it is a model id (audit F17's rule, applied here too). */
  model?: string
}

export type P1EmbeddingTransport = {
  /**
   * Audit F34 re-audit R1-002 (spec ruling R16): which transport this is, on the embedding's decision record
   * (EMBEDDING_TRANSPORT_ID for the Gateway). A transport without one (a test double) is recorded `unidentified`.
   */
  id?: string
  embed(req: { model: string; input: string }): Promise<P1EmbeddingReply>
}

/** The Gateway embedding transport's id on decision records (R16): the Vercel AI Gateway's embeddings endpoint. */
export const EMBEDDING_TRANSPORT_ID = "ai-gateway-embeddings"

type GatewayBody = {
  data?: unknown
  model?: unknown
  usage?: { prompt_tokens?: unknown; total_tokens?: unknown }
} | null

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** The vector of the first embedding: a non-empty list of at most MAX_EMBEDDING_DIMENSIONS finite numbers; else null. */
export function vectorOf(data: unknown): number[] | null {
  if (!Array.isArray(data) || data.length === 0) return null
  const values = (data[0] as { embedding?: unknown } | null)?.embedding
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_EMBEDDING_DIMENSIONS) return null
  for (const v of values) if (typeof v !== "number" || !Number.isFinite(v)) return null
  return values as number[]
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === "TimeoutError" || name === "AbortError"
}

export function gatewayEmbeddingTransport(apiKey: string, url: string = EMBEDDINGS_URL, opts?: { timeoutMs?: number }): P1EmbeddingTransport {
  return {
    id: EMBEDDING_TRANSPORT_ID,
    async embed(req) {
      let res: Response
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: req.model, input: req.input }),
          // A redirect is refused, never followed: the key and the masked input go to the Gateway URL only.
          redirect: "error",
          signal: AbortSignal.timeout(opts?.timeoutMs ?? EMBEDDING_TRANSPORT_TIMEOUT_MS),
        })
      } catch (err) {
        throw isAbort(err) ? new P1EmbeddingTransportError("gateway_timeout", { billable: true }) : new P1EmbeddingTransportError("gateway_request_failed", { billable: false })
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new P1EmbeddingTransportError("gateway_status", { billable: false, status: res.status })
      }
      const requestId = REQUEST_ID_HEADERS.map((h) => plainId(res.headers.get(h))).find((v) => v !== undefined)
      let json: GatewayBody
      try {
        json = (await res.json()) as GatewayBody
      } catch (err) {
        throw new P1EmbeddingTransportError(isAbort(err) ? "gateway_timeout" : "gateway_not_json", { billable: true, requestId })
      }
      const inputTokens = tokenCount(json?.usage?.prompt_tokens) ?? tokenCount(json?.usage?.total_tokens)
      const embedding = vectorOf(json?.data)
      if (embedding === null) throw new P1EmbeddingTransportError("gateway_no_embedding", { billable: true, inputTokens, requestId })
      const model = modelId(json?.model)
      return { embedding, inputTokens, ...(requestId === undefined ? {} : { requestId }), ...(model === undefined ? {} : { model }) }
    },
  }
}

let testTransport: P1EmbeddingTransport | null = null

/** Test-only. Refused in production, like `setP1TransportForTests`. */
export function setP1EmbeddingTransportForTests(t: P1EmbeddingTransport | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setP1EmbeddingTransportForTests is test-only")
  testTransport = t
}

/**
 * The test transport if one is set; else the Gateway when `AI_GATEWAY_API_KEY` is non-empty and this process is the
 * Functions runtime (`inFunctionsRuntime`, audit F18 FA-F18-001); else null, which `callP1Embedding` records as
 * `no_credentials`. Outside the Functions runtime a key builds nothing and raises the same alert line as the chat
 * transport, naming the variable and never its value.
 */
export function activeEmbeddingTransport(): P1EmbeddingTransport | null {
  if (testTransport) return testTransport
  const key = process.env.AI_GATEWAY_API_KEY?.trim()
  if (!key) return null
  if (!inFunctionsRuntime()) {
    console.error("[p1] ALERT p1.provider_key_in_next_runtime", { runtime: "functions-embedding-transport", keys: ["AI_GATEWAY_API_KEY"], refused: true })
    return null
  }
  return gatewayEmbeddingTransport(key)
}
