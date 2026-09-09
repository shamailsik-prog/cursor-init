import { describe, expect, it } from "vitest"
import {
  callCommitteeBrain,
  setTransportForTests,
} from "@/platform/p1/internalAICaller"
import type { OutboundRequest } from "@/platform/p1/internalAICaller"

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
        classification: "internal",
        provider: "openai",
        purpose: "test-mask",
        partyNames: [party],
      })

      expect(result.blocked).toBe(false)
      const outbound = result.outbound
      expect(outbound.body).not.toContain(cnic)
      expect(outbound.body).not.toContain("4210112345671")
      expect(outbound.body).not.toContain(phone)
      expect(outbound.body).not.toContain(party)
      expect(outbound.body).toContain("[CNIC]")
      expect(outbound.body).toContain("[PHONE]")
      expect(outbound.body).toContain("[PARTY]")
      expect(outbound.body.toLowerCase()).not.toContain("privileged")
      expect(outbound.body.toLowerCase()).not.toContain("internal")
      expect(outbound.metadata.classification).toBe("internal")
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
})
