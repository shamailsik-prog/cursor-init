import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { MAX_OUTPUT_TOKENS } from "../src/p1/costTable"
import { OPIK_TIMEOUT_MS, exportTrace, setOpikFetchForTests, type OpikConfig, type TraceRecord } from "../src/p1/opik"
import { GATEWAY_URL, P1TransportError, TRANSPORT_TIMEOUT_MS, activeTransport, gatewayTransport, setP1TransportForTests, type P1Transport } from "../src/p1/transport"

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
      // One request per socket, so fetch's connection pool never reuses a socket this test file has torn down.
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
  vi.unstubAllEnvs() // first: the seams refuse to be set while NODE_ENV is "production"
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setP1TransportForTests(null)
  setOpikFetchForTests(null)
})

const json = (status: number, body: unknown) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}
const never = () => {}
/** The message a promise rejects with; fails the test if it resolves. */
const rejection = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => {
      throw new Error("expected a rejection")
    },
    (e: unknown) => (e as Error).message,
  )
/** The error a promise rejects with; fails the test if it resolves. */
const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error("expected a rejection")
    },
    (e: unknown) => e,
  )
/** The P1TransportError fields that decide the charge and the log line (I1). */
const fields = (e: unknown) => {
  expect(e).toBeInstanceOf(P1TransportError)
  const t = e as P1TransportError
  return { name: t.name, code: t.code, billable: t.billable, inputTokens: t.inputTokens, outputTokens: t.outputTokens }
}
// Audit F16: a request is role-separated messages (the system message first), posted as given.
const request = {
  model: "anthropic/claude-opus-5.5",
  messages: [
    { role: "system" as const, content: "Platform policy." },
    { role: "user" as const, content: "hello ک" },
  ],
  maxTokens: MAX_OUTPUT_TOKENS,
}

describe("P1 Gateway transport (P3-68)", () => {
  it("pins the Gateway endpoint and a 60 second timeout", () => {
    expect(GATEWAY_URL).toBe("https://ai-gateway.vercel.sh/v1/chat/completions")
    expect(TRANSPORT_TIMEOUT_MS).toBe(60_000)
  })

  it("posts the OpenAI-compatible body with the bearer key and parses text and usage", async () => {
    respond = json(200, { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } })
    const out = await gatewayTransport("k", `${base}/v1/chat/completions`).send(request)
    expect(out).toEqual({ text: "hi", inputTokens: 7, outputTokens: 3 })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe("POST")
    expect(seen[0]?.url).toBe("/v1/chat/completions")
    expect(seen[0]?.headers.authorization).toBe("Bearer k")
    expect(seen[0]?.headers["content-type"]).toMatch(/^application\/json/)
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      model: "anthropic/claude-opus-5.5",
      messages: [
        { role: "system", content: "Platform policy." },
        { role: "user", content: "hello ک" },
      ],
      max_tokens: 4096,
    })
  })

  it("carries the provider's response id and the request-id header when they are plain ids, and drops anything else (audit F08 R1-D5)", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_7f3a-01" }).end(JSON.stringify({ id: "gen-01J9ZXK4", choices: [{ message: { content: "hi" } }] }))
    }
    expect(await gatewayTransport("k", base).send(request)).toEqual({ text: "hi", inputTokens: null, outputTokens: null, responseId: "gen-01J9ZXK4", requestId: "req_7f3a-01" })
    // Not a plain id (spaces, provider text, over 200 characters, not a string): left out, never stored.
    for (const bad of ["has spaces in it", "x".repeat(201), 42, { nested: "id" }]) {
      respond = json(200, { id: bad, choices: [{ message: { content: "hi" } }] })
      const out = await gatewayTransport("k", base).send(request)
      expect(out, JSON.stringify(bad)).not.toHaveProperty("responseId")
      expect(out).not.toHaveProperty("requestId")
    }
  })

  it("sends the max_tokens it is given", async () => {
    respond = json(200, { choices: [{ message: { content: "x" } }] })
    await gatewayTransport("k", base).send({ ...request, maxTokens: 17 })
    expect((JSON.parse(seen[0]?.body ?? "") as { max_tokens: number }).max_tokens).toBe(17)
  })

  it("gives null tokens when the response carries no usage", async () => {
    respond = json(200, { choices: [{ message: { content: "hi" } }] })
    expect(await gatewayTransport("k", base).send(request)).toEqual({ text: "hi", inputTokens: null, outputTokens: null })
  })

  it("treats each side of usage on its own and nulls anything that is not a count", async () => {
    respond = json(200, { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 7 } })
    expect(await gatewayTransport("k", base).send(request)).toMatchObject({ inputTokens: 7, outputTokens: null })
    for (const bad of [-1, 1.5, "7", null, Number.MAX_SAFE_INTEGER + 2]) {
      respond = json(200, { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: bad, completion_tokens: bad } })
      expect(await gatewayTransport("k", base).send(request), String(bad)).toMatchObject({ inputTokens: null, outputTokens: null })
    }
    respond = json(200, { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 0, completion_tokens: 0 } })
    expect(await gatewayTransport("k", base).send(request)).toMatchObject({ inputTokens: 0, outputTokens: 0 })
  })

  it("rejects a non-2xx response with a fixed message that does not echo the provider text", async () => {
    respond = json(500, { error: { message: "SECRET provider detail" } })
    expect(await rejection(gatewayTransport("k", base).send(request))).toBe("gateway status 500")
    for (const status of [401, 429, 502]) {
      respond = json(status, { error: "SECRET provider detail", choices: [{ message: { content: "should not be used" } }] })
      const message = await rejection(gatewayTransport("k", base).send(request))
      expect(message, String(status)).toBe(`gateway status ${status}`)
      expect(message).not.toContain("SECRET")
    }
  })

  it("rejects a 200 with no usable choices[0].message.content, with a fixed message", async () => {
    const bodies: unknown[] = [
      { choices: [], detail: "SECRET provider detail" },
      { detail: "SECRET provider detail" },
      { choices: [{ detail: "SECRET provider detail" }] },
      { choices: [{ message: { detail: "SECRET provider detail" } }] },
      { choices: [{ message: { content: null, detail: "SECRET provider detail" } }] },
      { choices: [{ message: { content: 42, detail: "SECRET provider detail" } }] },
      { choices: "SECRET provider detail" },
      null,
    ]
    for (const b of bodies) {
      respond = json(200, b)
      const message = await rejection(gatewayTransport("k", base).send(request))
      expect(message, JSON.stringify(b)).toBe("gateway response has no message content")
      expect(message).not.toContain("SECRET")
    }
  })

  it("rejects a 2xx body that is not JSON with a fixed message that does not quote the body", async () => {
    for (const text of ["SECRETPROV not json", "", "<html>SECRET</html>", '{"choices":[{"message":{"content":"SECRET"']) {
      respond = (_req, res) => res.writeHead(200).end(text)
      const message = await rejection(gatewayTransport("k", base).send(request))
      expect(message, text).toBe("gateway response is not JSON")
      expect(message).not.toContain("SECRET")
    }
  })

  it("accepts an empty-string completion", async () => {
    respond = json(200, { choices: [{ message: { content: "" } }] })
    expect(await gatewayTransport("k", base).send(request)).toMatchObject({ text: "" })
  })

  it("rejects when the server never answers within the timeout", async () => {
    respond = never
    const started = Date.now()
    expect(await rejection(gatewayTransport("k", base, { timeoutMs: 100 }).send(request))).toBe("gateway timeout")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("rejects when the server sends headers and then stalls the body", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.write('{"choices":[{"message":')
    }
    expect(await rejection(gatewayTransport("k", base, { timeoutMs: 100 }).send(request))).toBe("gateway timeout")
  })

  it("rejects when the connection is refused", async () => {
    expect(await rejection(gatewayTransport("k", "http://127.0.0.1:1/v1/chat/completions").send(request))).toBe("gateway request failed")
  })
})

describe("P1 Gateway transport errors (I1: billed failures are charged)", () => {
  const P1 = { name: "P1TransportError", inputTokens: null, outputTokens: null }

  it("a non-2xx is gateway_status, not billable", async () => {
    for (const status of [400, 401, 429, 500, 503]) {
      respond = json(status, { error: "SECRET provider detail" })
      const e = await failure(gatewayTransport("k", base).send(request))
      expect(fields(e), String(status)).toEqual({ ...P1, code: "gateway_status", billable: false })
      expect((e as Error).message).toBe(`gateway status ${status}`)
    }
  })

  it("a refused connection is gateway_request_failed, not billable", async () => {
    const e = await failure(gatewayTransport("k", "http://127.0.0.1:1/v1/chat/completions").send(request))
    expect(fields(e)).toEqual({ ...P1, code: "gateway_request_failed", billable: false })
    expect((e as Error).message).toBe("gateway request failed")
  })

  it("a timeout, before the headers or while the body streams, is gateway_timeout and billable", async () => {
    respond = never
    const before = await failure(gatewayTransport("k", base, { timeoutMs: 100 }).send(request))
    expect(fields(before)).toEqual({ ...P1, code: "gateway_timeout", billable: true })
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.write('{"choices":[{"message":')
    }
    const during = await failure(gatewayTransport("k", base, { timeoutMs: 100 }).send(request))
    expect(fields(during)).toEqual({ ...P1, code: "gateway_timeout", billable: true })
    expect((during as Error).message).toBe("gateway timeout")
  })

  it("a timeout while the body streams still carries the request-id header (re-audit R3 INFO)", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_9f-03" })
      res.write('{"choices":[{"message":')
    }
    const e = (await failure(gatewayTransport("k", base, { timeoutMs: 100 }).send(request))) as P1TransportError
    expect([e.code, e.billable, e.responseId, e.requestId]).toEqual(["gateway_timeout", true, undefined, "req_9f-03"])
  })

  it("a 2xx whose body is not JSON is gateway_not_json and billable, with no usage", async () => {
    respond = (_req, res) => res.writeHead(200).end("SECRET not json")
    const e = await failure(gatewayTransport("k", base).send(request))
    expect(fields(e)).toEqual({ ...P1, code: "gateway_not_json", billable: true })
    expect((e as Error).message).toBe("gateway response is not JSON")
  })

  it("a billable 2xx without usable content still carries the provider's response id and the request-id header (Codex P2)", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_9f-01" }).end(JSON.stringify({ id: "gen-9F01", choices: [], usage: { prompt_tokens: 7 } }))
    }
    const e = (await failure(gatewayTransport("k", base).send(request))) as P1TransportError
    expect([e.code, e.billable, e.responseId, e.requestId]).toEqual(["gateway_no_text", true, "gen-9F01", "req_9f-01"])
  })

  it("a billable 2xx whose body is not JSON still carries the request-id header (Codex P2)", async () => {
    respond = (_req, res) => res.writeHead(200, { "x-request-id": "req_9f-02" }).end("SECRET not json")
    const e = (await failure(gatewayTransport("k", base).send(request))) as P1TransportError
    expect([e.code, e.billable, e.responseId, e.requestId]).toEqual(["gateway_not_json", true, undefined, "req_9f-02"])
  })

  it("a 2xx without usable content is gateway_no_text and billable, carrying the usage figures that are valid counts", async () => {
    respond = json(200, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })
    const e = await failure(gatewayTransport("k", base).send(request))
    expect(fields(e)).toEqual({ ...P1, code: "gateway_no_text", billable: true, inputTokens: 7, outputTokens: 3 })
    expect((e as Error).message).toBe("gateway response has no message content")
    respond = json(200, { choices: [{ message: { content: null } }], usage: { prompt_tokens: 7, completion_tokens: -3 } })
    expect(fields(await failure(gatewayTransport("k", base).send(request)))).toEqual({ ...P1, code: "gateway_no_text", billable: true, inputTokens: 7, outputTokens: null })
    respond = json(200, { detail: "SECRET" })
    expect(fields(await failure(gatewayTransport("k", base).send(request)))).toEqual({ ...P1, code: "gateway_no_text", billable: true })
  })

  it("a redirect is refused: gateway_request_failed, not billable, and the redirect target receives nothing", async () => {
    const reached: string[] = []
    const target = createServer((req, res) => {
      reached.push(String(req.url))
      res.setHeader("connection", "close")
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "redirected" } }] }))
    })
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve))
    try {
      const to = `http://127.0.0.1:${(target.address() as AddressInfo).port}/elsewhere`
      for (const status of [301, 302, 303, 307, 308]) {
        respond = (_req, res) => res.writeHead(status, { location: to }).end()
        const e = await failure(gatewayTransport("k", `${base}/v1/chat/completions`).send(request))
        expect(fields(e), String(status)).toEqual({ ...P1, code: "gateway_request_failed", billable: false })
      }
      expect(reached).toEqual([])
      expect(seen).toHaveLength(5)
    } finally {
      target.closeAllConnections()
      await new Promise<void>((resolve) => target.close(() => resolve()))
    }
  })

  it("passes redirect: error to fetch", async () => {
    const inits: (RequestInit | undefined)[] = []
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init)
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 })
    })
    await gatewayTransport("k", base).send(request)
    expect(inits[0]?.redirect).toBe("error")
  })
})

describe("P1 active transport and test seam (P3-68)", () => {
  const fake: P1Transport = { send: async () => ({ text: "t", inputTokens: 1, outputTokens: 1 }) }

  it("is null with no key and no seam", () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "")
    expect(activeTransport()).toBeNull()
    vi.stubEnv("AI_GATEWAY_API_KEY", "   ")
    expect(activeTransport()).toBeNull()
  })

  it("is the Gateway transport when AI_GATEWAY_API_KEY is set", () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "key-1")
    const t = activeTransport()
    expect(t).not.toBeNull()
    expect(typeof t?.send).toBe("function")
  })

  it("is the test transport when one is set, whatever the key", () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "key-1")
    setP1TransportForTests(fake)
    expect(activeTransport()).toBe(fake)
    vi.stubEnv("AI_GATEWAY_API_KEY", "")
    expect(activeTransport()).toBe(fake)
    setP1TransportForTests(null)
    expect(activeTransport()).toBeNull()
  })

  it("the transport made from the key sends to the Gateway URL with the trimmed bearer key and a 60 s timeout", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }), { status: 200 })
    })
    const timeout = vi.spyOn(AbortSignal, "timeout")
    vi.stubEnv("AI_GATEWAY_API_KEY", "  k  ")
    expect(await activeTransport()?.send(request)).toEqual({ text: "hi", inputTokens: 1, outputTokens: 2 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions")
    expect(calls[0]?.init?.method).toBe("POST")
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer k")
    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(60_000)
  })

  it("refuses the test seam in production", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(() => setP1TransportForTests(fake)).toThrow(/test-only/)
    expect(() => setP1TransportForTests(null)).toThrow(/test-only/)
  })
})

describe("activeTransport outside the Functions runtime (FA-F18-001)", () => {
  const FAKE_KEY = "placeholder-not-a-key"
  const fake: P1Transport = { send: async () => ({ text: "t", inputTokens: 1, outputTokens: 1 }) }
  const clearRuntime = () => {
    vi.stubEnv("FUNCTION_TARGET", "")
    vi.stubEnv("K_SERVICE", "")
    vi.stubEnv("SIKANDER_FUNCTIONS_RUNTIME", "")
  }

  it("with a key and no Functions runtime marker, builds nothing and does not call fetch", () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    clearRuntime()
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_KEY)
    expect(activeTransport()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("logs the provider-key alert naming the variable and never the value", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    clearRuntime()
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_KEY)
    expect(activeTransport()).toBeNull()
    const lines = spy.mock.calls.map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    const alerts = lines.filter((l) => l.includes("p1.provider_key_in_next_runtime"))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain("AI_GATEWAY_API_KEY")
    expect(alerts[0]).not.toContain(FAKE_KEY)
  })

  it.each([
    ["FUNCTION_TARGET", "api"],
    ["K_SERVICE", "api"],
    ["SIKANDER_FUNCTIONS_RUNTIME", "1"],
    ["SIKANDER_FUNCTIONS_RUNTIME", "true"],
    ["SIKANDER_FUNCTIONS_RUNTIME", " TRUE "],
  ] as const)("is the Gateway transport when %s is %j and the key is set, and does not alert", (name, value) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    clearRuntime()
    vi.stubEnv(name, value)
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_KEY)
    const t = activeTransport()
    expect(t).not.toBeNull()
    expect(typeof t?.send).toBe("function")
    expect(spy.mock.calls.flat().join(" ")).not.toContain("p1.provider_key_in_next_runtime")
  })

  it("does not treat a blank or whitespace marker, or a flag other than 1 or true, as the Functions runtime", () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_KEY)
    for (const env of [
      { FUNCTION_TARGET: "   ", K_SERVICE: "", SIKANDER_FUNCTIONS_RUNTIME: "" },
      { FUNCTION_TARGET: "", K_SERVICE: " \t ", SIKANDER_FUNCTIONS_RUNTIME: "" },
      { FUNCTION_TARGET: "", K_SERVICE: "", SIKANDER_FUNCTIONS_RUNTIME: "yes" },
      { FUNCTION_TARGET: "", K_SERVICE: "", SIKANDER_FUNCTIONS_RUNTIME: "0" },
      { FUNCTION_TARGET: "", K_SERVICE: "", SIKANDER_FUNCTIONS_RUNTIME: "false" },
    ]) {
      vi.stubEnv("FUNCTION_TARGET", env.FUNCTION_TARGET)
      vi.stubEnv("K_SERVICE", env.K_SERVICE)
      vi.stubEnv("SIKANDER_FUNCTIONS_RUNTIME", env.SIKANDER_FUNCTIONS_RUNTIME)
      expect(activeTransport(), JSON.stringify(env)).toBeNull()
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("still returns the test transport outside the Functions runtime, and does not alert", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    clearRuntime()
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_KEY)
    setP1TransportForTests(fake)
    expect(activeTransport()).toBe(fake)
    expect(spy.mock.calls.flat().join(" ")).not.toContain("p1.provider_key_in_next_runtime")
  })

  it("does not alert when the key is absent", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    clearRuntime()
    vi.stubEnv("AI_GATEWAY_API_KEY", "")
    expect(activeTransport()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("P1 Opik exporter (P3-67)", () => {
  const T0 = Date.parse("2026-10-11T10:00:00.000Z")
  const record: TraceRecord = {
    traceId: "0199c3a0-0000-7000-8000-000000000001",
    startMs: T0,
    endMs: T0 + 10,
    taskType: "committee",
    classification: "internal",
    outcome: "ok",
    blockReason: null,
    model: "anthropic/claude-opus-5.5",
    provider: "ai-gateway",
    inputTokens: 1,
    outputTokens: 2,
    costMicroUsd: 3,
    firmId: "firm-1",
    matterId: null,
    usageLogId: "usage-1",
    maskedBody: "MASKED",
    maskedResponse: "REPLY",
  }
  const enabled = (): OpikConfig => ({ enabled: true, baseUrl: base, project: "sikander-p1" })

  it("pins the 2 second timeout", () => {
    expect(OPIK_TIMEOUT_MS).toBe(2000)
  })

  it("posts {traces:[...]} to the batch endpoint and returns exported on 204", async () => {
    respond = (_req, res) => res.writeHead(204).end()
    expect(await exportTrace(record, enabled())).toBe("exported")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe("POST")
    expect(seen[0]?.url).toBe("/v1/private/traces/batch")
    expect(seen[0]?.headers["content-type"]).toMatch(/^application\/json/)
    const body = JSON.parse(seen[0]?.body ?? "") as { traces: Record<string, unknown>[] }
    expect(Object.keys(body)).toEqual(["traces"])
    expect(body.traces).toHaveLength(1)
    expect(body.traces[0]).toMatchObject({
      id: record.traceId,
      project_name: "sikander-p1",
      name: "p1.committee",
      input: { prompt: "MASKED" },
      output: { text: "REPLY" },
      tags: ["internal", "ok"],
    })
  })

  it("returns exported on any 2xx", async () => {
    respond = json(200, {})
    expect(await exportTrace(record, enabled())).toBe("exported")
  })

  it("returns failed on 500 and on 4xx, and never throws", async () => {
    for (const status of [500, 400, 404]) {
      respond = (_req, res) => res.writeHead(status).end("provider text")
      expect(await exportTrace(record, enabled()), String(status)).toBe("failed")
    }
  })

  it("returns failed when Opik hangs past the timeout", async () => {
    respond = never
    const started = Date.now()
    expect(await exportTrace(record, enabled(), { timeoutMs: 100 })).toBe("failed")
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("returns failed when the connection is refused", async () => {
    expect(await exportTrace(record, { enabled: true, baseUrl: "http://127.0.0.1:1", project: "p" })).toBe("failed")
  })

  it("returns failed, not a throw, when the trace cannot be built", async () => {
    respond = (_req, res) => res.writeHead(204).end()
    expect(await exportTrace({ ...record, classification: "constructor" as never }, enabled())).toBe("failed")
    expect(await exportTrace({ ...record, startMs: Number.NaN }, enabled())).toBe("failed")
    expect(seen).toHaveLength(0)
  })

  it("returns disabled, and makes no request, when the config is disabled", async () => {
    for (const reason of ["unset", "unconfirmed", "third_party_host"] as const) {
      expect(await exportTrace(record, { enabled: false, reason }), reason).toBe("disabled")
    }
    expect(seen).toHaveLength(0)
  })

  it("reads its config from the environment when none is passed", async () => {
    vi.stubEnv("OPIK_BASE_URL", base)
    vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", "true")
    vi.stubEnv("OPIK_PROJECT_NAME", "env-project")
    respond = (_req, res) => res.writeHead(204).end()
    expect(await exportTrace(record)).toBe("exported")
    expect((JSON.parse(seen[0]?.body ?? "") as { traces: { project_name: string }[] }).traces[0]?.project_name).toBe("env-project")
    vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", "")
    expect(await exportTrace(record)).toBe("disabled")
    expect(seen).toHaveLength(1)
  })

  it("uses the fetch set for tests in place of the global one", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    setOpikFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(null, { status: 204 })
    }) as typeof fetch)
    expect(await exportTrace(record, { enabled: true, baseUrl: "http://opik.invalid/api", project: "p" })).toBe("exported")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://opik.invalid/api/v1/private/traces/batch")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
    expect(seen).toHaveLength(0)
    setOpikFetchForTests((async () => {
      throw new Error("boom")
    }) as typeof fetch)
    expect(await exportTrace(record, enabled())).toBe("failed")
  })

  it("passes the 2 s default timeout, or the one it is given, to AbortSignal.timeout", async () => {
    setOpikFetchForTests((async () => new Response(null, { status: 204 })) as typeof fetch)
    const timeout = vi.spyOn(AbortSignal, "timeout")
    expect(await exportTrace(record, enabled())).toBe("exported")
    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenLastCalledWith(2000)
    expect(await exportTrace(record, enabled(), { timeoutMs: 250 })).toBe("exported")
    expect(timeout).toHaveBeenCalledTimes(2)
    expect(timeout).toHaveBeenLastCalledWith(250)
  })

  it("a redirect is refused: failed, and the redirect target receives nothing", async () => {
    const reached: string[] = []
    const target = createServer((req, res) => {
      reached.push(String(req.url))
      res.setHeader("connection", "close")
      res.writeHead(204).end()
    })
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve))
    try {
      const to = `http://127.0.0.1:${(target.address() as AddressInfo).port}/elsewhere`
      for (const status of [301, 302, 303, 307, 308]) {
        respond = (_req, res) => res.writeHead(status, { location: to }).end()
        expect(await exportTrace(record, enabled()), String(status)).toBe("failed")
      }
      expect(reached).toEqual([])
      expect(seen).toHaveLength(5)
    } finally {
      target.closeAllConnections()
      await new Promise<void>((resolve) => target.close(() => resolve()))
    }
  })

  it("passes redirect: error to fetch", async () => {
    const inits: (RequestInit | undefined)[] = []
    setOpikFetchForTests((async (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init)
      return new Response(null, { status: 204 })
    }) as typeof fetch)
    expect(await exportTrace(record, enabled())).toBe("exported")
    expect(inits[0]?.redirect).toBe("error")
  })

  it("refuses the fetch seam in production", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(() => setOpikFetchForTests(fetch)).toThrow(/test-only/)
    expect(() => setOpikFetchForTests(null)).toThrow(/test-only/)
  })
})
