import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { committeeBrainLanguageModel } from "@/platform/p1/committeeBrainModel"
import { setTransportForTests } from "@/platform/p1/internalAICaller"

/**
 * Audit F34, spec ruling R12: the eve bridge reports real usage, or says that usage was not reported and why. On main
 * f39d007 every result carries `EMPTY_USAGE` (every count undefined), even on the paths where nothing was sent and the
 * true usage is zero. Here: nothing sent is zero, with `none_sent`; an answer reports the transport's counts when both
 * are valid, and otherwise `usage_unreported` with its reason; the stream's finish part says the same.
 */

const INSTRUCTIONS = `Instructions (instructions)\n${readFileSync(path.resolve(__dirname, "..", "agent", "instructions.md"), "utf8").trim()}`

const call = (classification: string | undefined): LanguageModelV3CallOptions =>
  ({
    prompt: [
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: [{ type: "text", text: "Summarise the notice." }] },
    ],
    providerOptions: classification === undefined ? {} : { sikander: { classification } },
  }) as never

const ZERO = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
}

afterEach(() => setTransportForTests(null))

describe("audit F34 R12: the eve bridge's usage", () => {
  it("a call P1 blocks (no transport in this runtime) sent nothing: zero usage, none_sent", async () => {
    const r = await committeeBrainLanguageModel.doGenerate(call("public"))
    expect(r.finishReason.unified).toBe("error")
    expect(r.usage).toEqual({ ...ZERO, raw: { status: "none_sent" } })
    expect(r.providerMetadata).toEqual({ sikander: { usageStatus: "none_sent" } })
  })

  it("a call refused before P1 (no classification) sent nothing: zero usage, none_sent", async () => {
    const r = await committeeBrainLanguageModel.doGenerate(call(undefined))
    expect(r.usage).toEqual({ ...ZERO, raw: { status: "none_sent" } })
    expect(r.providerMetadata).toEqual({ sikander: { usageStatus: "none_sent" } })
  })

  it("an answer reports the counts the transport reported", async () => {
    setTransportForTests({ send: async () => ({ text: "ok", inputTokens: 120, outputTokens: 40 }) })
    const r = await committeeBrainLanguageModel.doGenerate(call("public"))
    expect(r.finishReason.unified).toBe("stop")
    expect(r.usage).toEqual({
      inputTokens: { total: 120, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 40, text: undefined, reasoning: undefined },
      raw: { status: "reported" },
    })
    expect(r.providerMetadata).toEqual({ sikander: { usageStatus: "reported" } })
  })

  it.each([
    ["no counts", {}],
    ["one count", { inputTokens: 120 }],
    ["a negative count", { inputTokens: -1, outputTokens: 40 }],
    ["a fraction", { inputTokens: 1.5, outputTokens: 40 }],
  ])("an answer whose transport gave %s is usage_unreported, with the reason", async (_label, counts) => {
    setTransportForTests({ send: async () => ({ text: "ok", ...counts }) as never })
    const r = await committeeBrainLanguageModel.doGenerate(call("public"))
    expect(r.finishReason.unified).toBe("stop")
    expect(r.usage.inputTokens.total).toBeUndefined()
    expect(r.usage.outputTokens.total).toBeUndefined()
    expect(r.usage.raw).toEqual({ status: "usage_unreported", reason: "transport_reported_no_usage" })
    expect(r.providerMetadata).toEqual({ sikander: { usageStatus: "usage_unreported", usageReason: "transport_reported_no_usage" } })
  })

  it("the stream's finish part carries the same usage and status", async () => {
    const { stream } = await committeeBrainLanguageModel.doStream(call("public"))
    const parts: LanguageModelV3StreamPart[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    const finish = parts.find((p) => p.type === "finish") as Extract<LanguageModelV3StreamPart, { type: "finish" }>
    expect(finish.usage).toEqual({ ...ZERO, raw: { status: "none_sent" } })
    expect(finish.providerMetadata).toEqual({ sikander: { usageStatus: "none_sent" } })
  })
})
