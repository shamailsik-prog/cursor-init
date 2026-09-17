import { afterEach, describe, expect, it } from "vitest"
import { committeeBrainLanguageModel } from "@/platform/p1/committeeBrainModel"
import {
  callCommitteeBrain,
  setTransportForTests,
} from "@/platform/p1/internalAICaller"
import type { OutboundRequest } from "@/platform/p1/internalAICaller"
import { readGatewayApiKey } from "@/platform/p1/gatewayTransport"
import committeeAgent from "@/agent/agent"
import { classificationPolicy, maskPreview, normaliseCaseNumber } from "@/platform/p1/eveTools"

afterEach(() => {
  setTransportForTests(null)
})

describe("eve Committee Brain — P1 is the only outbound path", () => {
  it("does not expose a live Gateway key in Phase 0", () => {
    expect(readGatewayApiKey()).toBeUndefined()
  })

  it("wires the eve agent to the P1 LanguageModel, not a Gateway string", () => {
    expect(committeeAgent.model).toBe(committeeBrainLanguageModel)
    expect(committeeAgent.defaultTools).toBe(false)
    expect(committeeBrainLanguageModel.provider).toBe("sikander-p1")
    expect(committeeBrainLanguageModel.modelId).toBe("anthropic/claude-sonnet-4.6")
  })

  it("LanguageModel.doGenerate masks CNIC and keeps classification out of the body", async () => {
    const cnic = "42101-1234567-1"
    const party = "Muhammad Ali Khan"
    let captured: OutboundRequest | null = null
    setTransportForTests({
      async send(request) {
        captured = request
        return { text: "ok" }
      },
    })

    const result = await committeeBrainLanguageModel.doGenerate({
      prompt: [
        { role: "system", content: "You are Committee Brain." },
        {
          role: "user",
          content: [{ type: "text", text: `Counsel for ${party}, CNIC ${cnic}` }],
        },
      ],
      providerOptions: {
        sikander: { classification: "public", partyNames: [party] },
      },
    })

    expect(captured).not.toBeNull()
    expect(captured!.body).not.toContain(cnic)
    expect(captured!.body).not.toContain(party)
    expect(captured!.body).toContain("[CNIC]")
    expect(captured!.metadata.classification).toBe("public")
    expect(JSON.stringify(captured!.body)).not.toMatch(/"classification"/)
    const text = result.content
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? p.text : ""))
      .join("")
    expect(text).toBe("ok")
  })

  it("refuses a LanguageModel call with no classification instead of treating it as public", async () => {
    let sent = false
    setTransportForTests({
      async send() {
        sent = true
        return { text: "no" }
      },
    })
    const result = await committeeBrainLanguageModel.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })
    expect(sent).toBe(false)
    const text = result.content
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? p.text : ""))
      .join("")
    expect(text).toMatch(/classification missing/)
    expect(result.finishReason.unified).toBe("error")
  })

  it("blocks internal via the LanguageModel — DPA table is empty", async () => {
    let sent = false
    setTransportForTests({
      async send() {
        sent = true
        return { text: "no" }
      },
    })
    const result = await committeeBrainLanguageModel.doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "internal opinion" }] },
      ],
      providerOptions: { sikander: { classification: "internal" } },
    })
    expect(sent).toBe(false)
    const text = result.content
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? p.text : ""))
      .join("")
    expect(text).toMatch(/DPA|internal\+/)
  })

  it("callCommitteeBrain with ai-gateway still masks and blocks without credentials", async () => {
    const cnic = "42101-1234567-1"
    const result = await callCommitteeBrain({
      body: `Note ${cnic}`,
      classification: "public",
      provider: "ai-gateway",
      purpose: "committee-brain",
    })
    expect(result.blocked).toBe(true)
    expect(result.outbound.body).not.toContain(cnic)
    expect(result.reason).toMatch(/no live provider credentials/)
  })
})

describe("eve Committee Brain local tools", () => {
  it("mask_preview redacts CNIC without calling a provider", () => {
    const preview = maskPreview({
      text: "CNIC 42101-1234567-1",
    })
    expect(preview.masked).not.toContain("42101-1234567-1")
    expect(preview.redactionCounts.cnic).toBeGreaterThan(0)
  })

  it("classification_policy blocks internal without DPA", () => {
    const policy = classificationPolicy({ classification: "internal" })
    expect(policy.allowed).toBe(false)
  })

  it("classification_policy allows public", () => {
    const policy = classificationPolicy({ classification: "public" })
    expect(policy.allowed).toBe(true)
  })

  it("normalise_case_number uses the seeded SHC fixture", () => {
    const result = normaliseCaseNumber({
      raw: "C.P. No. D-1234 of 2025",
      courtId: "SHC",
    })
    expect(result.status).toBe("OK")
    if (result.status === "OK") {
      expect(result.canonical).toBe("CP D-1234/2025")
    }
  })
})
