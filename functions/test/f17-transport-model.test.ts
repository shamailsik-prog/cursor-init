import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { gatewayTransport } from "../src/p1/transport"

/**
 * Audit F17, spec ruling 4: the Gateway transport returns the model the provider reports (the OpenAI-compatible body's
 * `model`), so P1 can record it beside the configured model. Only a model id is returned (letters, digits, `.`, `_`,
 * `:`, `/`, `@`, `+`, `-`, at most 200 characters, starting with a letter or digit): never other provider text.
 */

let server: Server
let base: string
let body: unknown

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume()
    req.on("end", () => {
      res.setHeader("connection", "close")
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))
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
  body = null
})

const reply = (model: unknown) => ({ id: "resp-1", model, choices: [{ message: { content: "ANSWER" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
const send = () =>
  gatewayTransport("test-key", base).send({
    model: "anthropic/claude-opus-5.5",
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ],
    maxTokens: 16,
  })

describe("audit F17: the transport reports the provider's model (spec ruling 4)", () => {
  it.each(["anthropic/claude-opus-5.5", "claude-opus-5.5", "claude-opus-5.5-20261001", "vendor/model@2026-10:latest+eu"])("returns a model id as given: %s", async (model) => {
    body = reply(model)
    const r = await send()
    expect(r.text).toBe("ANSWER")
    expect((r as { model?: unknown }).model).toBe(model)
  })

  it.each([
    ["absent", undefined],
    ["a number", 42],
    ["text with spaces", "the best model"],
    ["markup", "<script>model</script>"],
    ["a leading symbol", "/model"],
    ["over 200 characters", `m${"x".repeat(200)}`],
    ["an object", { name: "model" }],
  ])("returns no model for %s, and still the answer", async (_label, model) => {
    body = reply(model)
    const r = await send()
    expect(r.text).toBe("ANSWER")
    expect(r).not.toHaveProperty("model")
  })
})
