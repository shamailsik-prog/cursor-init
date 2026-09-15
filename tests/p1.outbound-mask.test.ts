import { afterEach, describe, expect, it } from "vitest"
import {
  callCommitteeBrain,
  PHASE0_NO_CREDENTIALS,
  setTransportForTests,
} from "@/platform/p1/internalAICaller"
import type { OutboundRequest } from "@/platform/p1/internalAICaller"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { providerAllowedFor } from "@/platform/p1/providerPolicy"

afterEach(() => {
  setTransportForTests(null)
})


describe("Job F — P1 outbound mask", () => {
  it("sends only the masked body; CNIC, phone and party name never leave", async () => {
    const cnic = "42101-1234567-1"
    const phone = "03001234567"
    const party = "Muhammad Ali Khan"
    const raw = `Counsel for ${party}, CNIC ${cnic}, mobile ${phone}, files today.`

    let captured: OutboundRequest | null = null
    setTransportForTests({
      async send(request) {
        captured = request
        return { text: "mock" }
      },
    })

    try {
      const result = await callCommitteeBrain({
        body: raw,
        classification: "public",
        provider: "openai",
        purpose: "test-mask",
        partyNames: [party],
      })

      expect(result.blocked).toBe(false)
      const outbound = result.outbound
      expect(outbound.body).toBe(
        maskOutboundPII(raw, { partyNames: [party] }).masked
      )
      expect(outbound.body).not.toContain(cnic)
      expect(outbound.body).not.toContain("4210112345671")
      expect(outbound.body).not.toContain(phone)
      expect(outbound.body).not.toContain(party)
      expect(outbound.body).toContain("[CNIC]")
      expect(outbound.body).toContain("[PHONE]")
      expect(outbound.body).toContain("[PARTY]")
      expect(outbound.metadata.classification).toBe("public")
      expect(JSON.stringify(outbound.body)).not.toMatch(/"classification"/)
      expect(captured).not.toBeNull()
      expect(captured!.body).toBe(outbound.body)
      expect(JSON.stringify(captured!.body)).not.toContain(cnic)
      expect(JSON.stringify(captured!.body)).not.toContain(phone)
      expect(JSON.stringify(captured!.body)).not.toContain(party)
    } finally {
      setTransportForTests(null)
    }
  })

  it("blocks privileged content when DPA is unknown; prepared payload is still masked", async () => {
    const cnic = "3520212345671"
    const phone = "+923001234567"
    const party = "Ayesha Siddiqui"
    const raw = `${party} CNIC ${cnic} tel ${phone}`

    let sent = false
    setTransportForTests({
      async send() {
        sent = true
        return { text: "should-not-run" }
      },
    })

    try {
      const result = await callCommitteeBrain({
        body: raw,
        classification: "privileged",
        provider: "openai",
        purpose: "translate",
        partyNames: [party],
      })

      expect(result.blocked).toBe(true)
      expect(sent).toBe(false)
      expect(result.outbound.body).not.toContain(cnic)
      expect(result.outbound.body).not.toContain(phone)
      expect(result.outbound.body).not.toContain(party)
      expect(result.outbound.metadata.classification).toBe("privileged")
      expect(result.reason).toMatch(/DPA/)
    } finally {
      setTransportForTests(null)
    }
  })

  it("masks spaced CNIC and dashed / spaced Pakistani mobiles", () => {
    const samples: [string, string][] = [
      ["CNIC 42101 1234567 1 on file", "42101 1234567 1"],
      ["mobile 0300-1234567", "0300-1234567"],
      ["mobile 0300 1234567", "0300 1234567"],
      ["mobile +92-300-1234567", "+92-300-1234567"],
      ["mobile +92 300 1234567", "+92 300 1234567"],
      ["mobile (0300) 1234567", "(0300) 1234567"],
      ["CNIC dotted 42101.1234567.1", "42101.1234567.1"],
      ["email counsel@nhslegal.pk", "counsel@nhslegal.pk"],
      ["IBAN PK36SCBL0000001123456702", "PK36SCBL0000001123456702"],
      ["IBAN spaced PK36 SCBL 0000 0011 2345 6702", "PK36 SCBL 0000 0011 2345 6702"],
      ["mobile dotted 0300.1234567", "0300.1234567"],
      ["NTN NTN 1234567-8", "1234567-8"],
      ["passport Passport AB1234567", "AB1234567"],
    ]
    for (const [raw, leak] of samples) {
      const masked = maskOutboundPII(raw).masked
      expect(masked, raw).not.toContain(leak)
      expect(masked === raw, `expected a redaction in: ${raw}`).toBe(false)
    }
  })

  it("returns blocked (does not throw) when Phase 0 has no provider credentials", async () => {
    const cnic = "42101-1234567-1"
    const result = await callCommitteeBrain({
      body: `Note ${cnic}`,
      classification: "public",
      provider: "openai",
      purpose: "research",
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe(PHASE0_NO_CREDENTIALS)
    expect(result.outbound.body).not.toContain(cnic)
    expect(result.outbound.body).toContain("[CNIC]")
    expect(result.text).toBeUndefined()
  })

  it("refuses unknown classification labels instead of treating them as public", async () => {
    expect(providerAllowedFor("openai", "super-secret")).toEqual({
      allowed: false,
      reason: "unknown classification — P1 refuses the call",
    })

    let sent = false
    setTransportForTests({
      async send() {
        sent = true
        return { text: "should-not-run" }
      },
    })
    await expect(
      callCommitteeBrain({
        body: "secret memo",
        classification: "super-secret" as never,
        provider: "openai",
        purpose: "exfil",
      })
    ).rejects.toThrow(/omitted classification/)
    expect(sent).toBe(false)
  })

  it("masks CNIC and party names in purpose metadata, not only the body", async () => {
    const cnic = "42101-1234567-1"
    const party = "Muhammad Ali Khan"
    let captured: OutboundRequest | null = null
    setTransportForTests({
      async send(request) {
        captured = request
        return { text: "mock" }
      },
    })
    const result = await callCommitteeBrain({
      body: "summarise the filing",
      classification: "public",
      provider: "openai",
      purpose: `translate ${cnic} for ${party}`,
      partyNames: [party],
    })
    expect(result.blocked).toBe(false)
    expect(captured!.metadata.purpose).not.toContain(cnic)
    expect(captured!.metadata.purpose).not.toContain(party)
    expect(captured!.metadata.purpose).toContain("[CNIC]")
    expect(captured!.metadata.purpose).toContain("[PARTY]")
  })

  it("does not interpolate classification into the prompt even when the body uses those words", async () => {
    const body = "This privileged internal memo is for the public digest."
    let captured: OutboundRequest | null = null
    setTransportForTests({
      async send(request) {
        captured = request
        return { text: "ok" }
      },
    })
    const result = await callCommitteeBrain({
      body,
      classification: "public",
      provider: "openai",
      purpose: "summarise",
    })
    expect(result.blocked).toBe(false)
    expect(captured!.body).toBe(body)
    expect(captured!.body).toContain("privileged")
    expect(captured!.body).toContain("internal")
    expect(captured!.metadata.classification).toBe("public")
    expect(captured!.body.startsWith("public")).toBe(false)
  })

  it("blocks internal content without DPA — internal opinions are client-identifying", async () => {
    let sent = false
    setTransportForTests({
      async send() {
        sent = true
        return { text: "no" }
      },
    })
    const result = await callCommitteeBrain({
      body: "Internal opinion for the client",
      classification: "internal",
      provider: "openai",
      purpose: "summarise",
    })
    expect(result.blocked).toBe(true)
    expect(sent).toBe(false)
    expect(result.reason).toMatch(/internal\+/)
  })

  it("masks CNIC in the provider response before returning it", async () => {
    const cnic = "42101-1234567-1"
    setTransportForTests({
      async send() {
        return { text: `Found ${cnic}` }
      },
    })
    const result = await callCommitteeBrain({
      body: "summarise",
      classification: "public",
      provider: "openai",
      purpose: "summarise",
    })
    expect(result.blocked).toBe(false)
    expect(result.text).not.toContain(cnic)
    expect(result.text).toContain("[CNIC]")
  })
})
