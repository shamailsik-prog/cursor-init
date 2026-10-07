// L18 §4.6 classification ranks — P1 provider table default:
//   public 0 / internal 1   any configured provider
//   confidential 2          providers with an executed DPA
//   privileged 3            DPA + content minimisation + PII-scrubbed trace
//   privileged-restricted 4 in-region providers only (with an executed DPA, as rank 3 —
//                           U-3); otherwise deterministic-only or partner-authorised
//                           exception with recorded reason
// (L17.3 §21, L19.11 §2 for the same rules seen from the gateway / research side.)
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  PROVIDER_IDS,
  assertMinimised,
  providerAllowedFor,
  providerConfig,
  setProviderConfigForTests,
  type ProviderConfig,
} from "@/platform/p1/providerPolicy"
import { callCommitteeBrain, setTransportForTests, type OutboundRequest } from "@/platform/p1/internalAICaller"
import type { Classification } from "@/platform/p1/types"

const COMBOS: ProviderConfig[] = [
  { dpaExecuted: false, inRegion: false },
  { dpaExecuted: true, inRegion: false },
  { dpaExecuted: false, inRegion: true },
  { dpaExecuted: true, inRegion: true },
]

function expected(label: Classification, c: ProviderConfig): boolean {
  switch (label) {
    case "public":
    case "internal":
      return true
    case "confidential":
    case "privileged":
      return c.dpaExecuted
    case "privileged-restricted":
      // U-3 (final spec audit): in-region AND an executed DPA — rank 4 is never less
      // constrained than rank 3
      return c.inRegion && c.dpaExecuted
  }
}

const LABELS: Classification[] = [
  "public",
  "internal",
  "confidential",
  "privileged",
  "privileged-restricted",
]

const TABLE = LABELS.flatMap((label) =>
  COMBOS.map((c) => ({ label, ...c, allowed: expected(label, c) }))
)

let sent: OutboundRequest[] = []
beforeEach(() => {
  sent = []
  setTransportForTests({
    async send(request) {
      sent.push(request)
      return { text: "ok" }
    },
  })
})
afterEach(() => {
  setTransportForTests(null)
  setProviderConfigForTests(null)
})

describe("L18 §4.6 provider table: every rank x {dpaExecuted, inRegion}", () => {
  it.each(TABLE)(
    "§4.6 $label with dpaExecuted=$dpaExecuted inRegion=$inRegion -> allowed=$allowed",
    ({ label, dpaExecuted, inRegion, allowed }) => {
      setProviderConfigForTests({ openai: { dpaExecuted, inRegion } })
      const decision = providerAllowedFor("openai", label)
      expect(decision.allowed).toBe(allowed)
      if (!decision.allowed) expect(decision.reason).toMatch(/§4\.6|unknown/)
    }
  )

  it.each(TABLE)(
    "§4.6 end to end: $label dpa=$dpaExecuted inRegion=$inRegion reaches the transport only when allowed",
    async ({ label, dpaExecuted, inRegion, allowed }) => {
      setProviderConfigForTests({ openai: { dpaExecuted, inRegion } })
      const result = await callCommitteeBrain({
        body: "note",
        classification: label,
        provider: "openai",
        purpose: "research",
      })
      expect(result.blocked).toBe(!allowed)
      expect(sent.length).toBe(allowed ? 1 : 0)
      if (!allowed) expect(result.event).toBe("ai.call.blocked")
    }
  )
})

describe("U-3: the table is monotonic in rank", () => {
  it.each(COMBOS)("dpaExecuted=$dpaExecuted inRegion=$inRegion: a provider allowed at a rank is allowed at every lower rank", (c) => {
    setProviderConfigForTests({ openai: c })
    const allowed = LABELS.map((label) => providerAllowedFor("openai", label).allowed)
    for (let rank = 1; rank < allowed.length; rank += 1) {
      if (allowed[rank]) expect(allowed[rank - 1], `${LABELS[rank]} allowed but ${LABELS[rank - 1]} refused`).toBe(true)
    }
  })

  it("an in-region provider without an executed DPA is refused at privileged-restricted", () => {
    setProviderConfigForTests({ openai: { dpaExecuted: false, inRegion: true } })
    const decision = providerAllowedFor("openai", "privileged-restricted")
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toMatch(/§4\.6.*DPA/)
  })
})

describe("§4.6 provider configuration", () => {
  it("every configured provider defaults to dpaExecuted=false, inRegion=false", () => {
    for (const provider of PROVIDER_IDS) {
      expect(providerConfig(provider)).toEqual({ dpaExecuted: false, inRegion: false })
    }
  })

  it("§4.6 ranks 0-1 go to any configured provider under the default (no DPA) table", () => {
    for (const provider of PROVIDER_IDS) {
      expect(providerAllowedFor(provider, "public").allowed).toBe(true)
      expect(providerAllowedFor(provider, "internal").allowed).toBe(true)
      expect(providerAllowedFor(provider, "confidential").allowed).toBe(false)
    }
  })

  it("an unconfigured provider id is refused at every rank", () => {
    for (const label of LABELS) {
      expect(providerAllowedFor("not-a-provider" as never, label).allowed).toBe(false)
    }
  })

  it("unknown classification labels still block, whatever the provider row says", () => {
    setProviderConfigForTests({ openai: { dpaExecuted: true, inRegion: true } })
    for (const label of ["secret", "constructor", "__proto__", ""]) {
      expect(providerAllowedFor("openai", label).allowed).toBe(false)
    }
  })
})

describe("§4.6 rank 3 (privileged): content minimisation and PII-scrubbed trace", () => {
  it("requires minimisation and a scrubbed trace on the allow decision (rank 3 and above)", () => {
    setProviderConfigForTests({ openai: { dpaExecuted: true, inRegion: true } })
    for (const label of ["privileged", "privileged-restricted"] as const) {
      const decision = providerAllowedFor("openai", label)
      expect(decision).toEqual({
        allowed: true,
        requirements: { minimiseContent: true, scrubTrace: true },
      })
    }
    expect(providerAllowedFor("openai", "confidential")).toEqual({ allowed: true })
  })

  it("sends only masked text and a masked trace for a privileged call", async () => {
    setProviderConfigForTests({ openai: { dpaExecuted: true, inRegion: false } })
    const cnic = "42101-1234567-1"
    const result = await callCommitteeBrain({
      body: `Client Ayesha Malik, CNIC ${cnic}, phone 0300-1234567`,
      classification: "privileged",
      provider: "openai",
      purpose: `review for Ayesha Malik ${cnic}`,
      partyNames: ["Ayesha Malik"],
    })
    expect(result.blocked).toBe(false)
    expect(sent).toHaveLength(1)
    const wire = JSON.stringify(sent[0])
    expect(wire).not.toContain(cnic)
    expect(wire).not.toContain("Ayesha Malik")
    expect(wire).not.toContain("0300-1234567")
    // The trace returned to callers and persisted with committee outputs is scrubbed too.
    expect(JSON.stringify(result.outbound)).not.toContain(cnic)
    expect(JSON.stringify(result.outbound)).not.toContain("Ayesha Malik")
  })

  it("assertMinimised rejects an outbound request that still carries PII", () => {
    const leaky: OutboundRequest = {
      body: "CNIC 42101-1234567-1",
      metadata: { classification: "privileged", provider: "openai", purpose: "x", redactionCounts: {} },
    }
    expect(assertMinimised(leaky, [])).toBe(false)
    const leakyPurpose: OutboundRequest = {
      body: "[CNIC]",
      metadata: {
        classification: "privileged",
        provider: "openai",
        purpose: "for Ayesha Malik",
        redactionCounts: {},
      },
    }
    expect(assertMinimised(leakyPurpose, ["Ayesha Malik"])).toBe(false)
    const clean: OutboundRequest = {
      body: "[CNIC] [PARTY]",
      metadata: { classification: "privileged", provider: "openai", purpose: "x", redactionCounts: {} },
    }
    expect(assertMinimised(clean, ["Ayesha Malik"])).toBe(true)
  })
})

describe("§4.6 rank 4 (privileged-restricted) outside the region", () => {
  it("blocks with ai.call.blocked: no deterministic path or partner exception is wired", async () => {
    setProviderConfigForTests({ openai: { dpaExecuted: true, inRegion: false } })
    const decision = providerAllowedFor("openai", "privileged-restricted")
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toMatch(/in-region/)
      expect(decision.reason).toMatch(/partner-authorised exception/)
    }
    const result = await callCommitteeBrain({
      body: "restricted",
      classification: "privileged-restricted",
      provider: "openai",
      purpose: "research",
    })
    expect(result).toMatchObject({ blocked: true, event: "ai.call.blocked" })
    expect(sent).toHaveLength(0)
  })
})
