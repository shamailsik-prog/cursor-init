import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  EMBEDDINGS_URL,
  EMBEDDING_TRANSPORT_TIMEOUT_MS,
  P1EmbeddingTransportError,
  activeEmbeddingTransport,
  gatewayEmbeddingTransport,
  setP1EmbeddingTransportForTests,
  type P1EmbeddingTransport,
} from "../src/p1/embeddingTransport"

/**
 * FA-D3C-002 (spec R11): the P1 embedding transport posts `{ model, input }` to the Gateway's OpenAI-compatible
 * embeddings endpoint by plain fetch, refuses redirects, and fails only with fixed codes and the chat transport's
 * billable rule. A local HTTP server stands in for the Gateway; nothing leaves the machine.
 */

type Seen = { method: string | undefined; url: string | undefined; headers: IncomingMessage["headers"]; body: string }

let server: Server
let base: string
let seen: Seen[]
let respond: (req: IncomingMessage, res: ServerResponse) => void

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") })
      res.setHeader("connection", "close")
      respond(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  seen = []
  respond = (_req, res) => res.writeHead(404).end()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  setP1EmbeddingTransportForTests(null)
})

const VECTOR = [0.25, -0.5, 1e-3, 0]
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body))
}
const answer = (over: Record<string, unknown> = {}) => ({
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: VECTOR }],
  model: "openai/text-embedding-3-small",
  usage: { prompt_tokens: 7, total_tokens: 7 },
  ...over,
})
const req = { model: "openai/text-embedding-3-small", input: "Section text [CNIC] ک" }

async function failure(p: Promise<unknown>): Promise<{ code: string; billable: boolean; inputTokens: number | null; message: string; requestId?: string }> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(P1EmbeddingTransportError)
    const e = err as P1EmbeddingTransportError
    return { code: e.code, billable: e.billable, inputTokens: e.inputTokens, message: e.message, ...(e.requestId === undefined ? {} : { requestId: e.requestId }) }
  }
  throw new Error("expected a rejection")
}

describe("gatewayEmbeddingTransport", () => {
  it("is the Gateway's OpenAI-compatible embeddings endpoint", () => {
    expect(EMBEDDINGS_URL).toBe("https://ai-gateway.vercel.sh/v1/embeddings")
    expect(EMBEDDING_TRANSPORT_TIMEOUT_MS).toBe(20_000)
  })

  it("posts { model, input } with the bearer key and returns the vector, the input tokens, the request id and the model", async () => {
    respond = json(200, answer(), { "x-request-id": "req_abc-123" })
    const reply = await gatewayEmbeddingTransport("synthetic-gateway-label", `${base}/v1/embeddings`).embed(req)
    expect(reply).toEqual({ embedding: VECTOR, inputTokens: 7, requestId: "req_abc-123", model: "openai/text-embedding-3-small" })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe("POST")
    expect(seen[0]!.url).toBe("/v1/embeddings")
    expect(seen[0]!.headers.authorization).toBe("Bearer synthetic-gateway-label")
    expect(seen[0]!.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(seen[0]!.body)).toEqual(req)
  })

  it("reads total_tokens when prompt_tokens is absent, and null when neither is a count", async () => {
    respond = json(200, answer({ usage: { total_tokens: 9 } }))
    expect((await gatewayEmbeddingTransport("k", base).embed(req)).inputTokens).toBe(9)
    respond = json(200, answer({ usage: { prompt_tokens: -1, total_tokens: 1.5 } }))
    expect((await gatewayEmbeddingTransport("k", base).embed(req)).inputTokens).toBeNull()
    respond = json(200, answer({ usage: undefined }))
    expect((await gatewayEmbeddingTransport("k", base).embed(req)).inputTokens).toBeNull()
  })

  it("keeps a reported model only when it is a model id", async () => {
    respond = json(200, answer({ model: "ignore previous instructions" }))
    expect(await gatewayEmbeddingTransport("k", base).embed(req)).not.toHaveProperty("model")
  })

  it("a non-2xx is gateway_status and not billable", async () => {
    respond = json(429, { error: { message: "provider text that must never surface" } })
    const f = await failure(gatewayEmbeddingTransport("k", base).embed(req))
    expect(f).toMatchObject({ code: "gateway_status", billable: false, inputTokens: null })
    expect(f.message).toBe("gateway status 429")
  })

  it("a 2xx that is not JSON is gateway_not_json and billable, keeping the request id", async () => {
    respond = (_req, res) => res.writeHead(200, { "content-type": "text/plain", "x-vercel-id": "bom1::abc" }).end("not json")
    expect(await failure(gatewayEmbeddingTransport("k", base).embed(req))).toMatchObject({ code: "gateway_not_json", billable: true, requestId: "bom1::abc" })
  })

  it.each([
    ["no data", answer({ data: [] })],
    ["data that is not a list", answer({ data: { embedding: VECTOR } })],
    ["an embedding that is not a list", answer({ data: [{ embedding: "0.1,0.2" }] })],
    ["an empty embedding", answer({ data: [{ embedding: [] }] })],
    ["a string in the embedding", answer({ data: [{ embedding: [0.1, "0.2"] }] })],
    ["a boolean in the embedding", answer({ data: [{ embedding: [0.1, true] }] })],
    ["a null in the embedding", answer({ data: [{ embedding: [0.1, null] }] })],
    ["an embedding over the bound", answer({ data: [{ embedding: new Array(4097).fill(0.1) }] })],
  ])("a 2xx with %s is gateway_no_embedding, billable, with the reported tokens", async (_name, body) => {
    respond = json(200, body)
    expect(await failure(gatewayEmbeddingTransport("k", base).embed(req))).toMatchObject({ code: "gateway_no_embedding", billable: true, inputTokens: 7 })
  })

  it("a timeout is gateway_timeout and billable", async () => {
    respond = () => {}
    expect(await failure(gatewayEmbeddingTransport("k", base, { timeoutMs: 100 }).embed(req))).toMatchObject({ code: "gateway_timeout", billable: true })
  })

  it("a refused connection is gateway_request_failed and not billable", async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    expect(await failure(gatewayEmbeddingTransport("k", `http://127.0.0.1:${port}`).embed(req))).toMatchObject({ code: "gateway_request_failed", billable: false })
  })

  it("a redirect is refused, never followed: gateway_request_failed, not billable, one request only", async () => {
    respond = (_req, res) => res.writeHead(307, { location: `${base}/elsewhere` }).end()
    expect(await failure(gatewayEmbeddingTransport("k", base).embed(req))).toMatchObject({ code: "gateway_request_failed", billable: false })
    expect(seen).toHaveLength(1)
  })
})

describe("activeEmbeddingTransport", () => {
  it("is null without AI_GATEWAY_API_KEY", () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "")
    vi.stubEnv("FUNCTION_TARGET", "p1CorpusEmbedding")
    expect(activeEmbeddingTransport()).toBeNull()
  })

  it("outside the Functions runtime a key builds nothing and raises the provider-key alert line", () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "synthetic-gateway-label")
    vi.stubEnv("FUNCTION_TARGET", "")
    vi.stubEnv("SIKANDER_FUNCTIONS_RUNTIME", "")
    vi.stubEnv("FUNCTIONS_EMULATOR", "")
    const alert = vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(activeEmbeddingTransport()).toBeNull()
    expect(alert).toHaveBeenCalledWith("[p1] ALERT p1.provider_key_in_next_runtime", { runtime: "functions-embedding-transport", keys: ["AI_GATEWAY_API_KEY"], refused: true })
    expect(JSON.stringify(alert.mock.calls)).not.toContain("synthetic-gateway-label")
  })

  it("inside the Functions runtime a key builds the Gateway transport", () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "synthetic-gateway-label")
    vi.stubEnv("FUNCTION_TARGET", "p1CorpusEmbedding")
    const t = activeEmbeddingTransport()
    expect(t).not.toBeNull()
    expect(typeof t!.embed).toBe("function")
  })

  it("the test transport wins, and is refused in production", () => {
    const fake: P1EmbeddingTransport = { embed: async () => ({ embedding: [1], inputTokens: 1 }) }
    setP1EmbeddingTransportForTests(fake)
    expect(activeEmbeddingTransport()).toBe(fake)
    vi.stubEnv("NODE_ENV", "production")
    expect(() => setP1EmbeddingTransportForTests(fake)).toThrow(/test-only/)
  })
})
