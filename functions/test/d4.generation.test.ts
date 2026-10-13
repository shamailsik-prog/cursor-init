import { Timestamp } from "firebase-admin/firestore"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  RESERVED_TOKEN,
  generationLabel,
  generationSummary,
  generationView,
  liveLease,
  outlineId,
  parseGenerationId,
  refuseReservedTokens,
  sectionId,
} from "../src/d4/generations"
import { EMPTY_TEMPLATE_STORE, InMemoryTemplateStore, setTemplateStoreForTests } from "../src/d4/templates"
import { HttpError } from "../src/http/errors"
import type { Caller } from "../src/p5/auth"

/**
 * Phase 4b (spec P4B-9): the template port and what needs no emulator of the generation store. Task 3 and Task 4 add
 * their unit tests here (the prompt, the guardrails, the budget arithmetic).
 */

const TYPE = "constitutional_petition_199" // template_cp_199_v1
const DEED = "sale_deed" // NON_FORUM

describe("D4 template port (P4B-9)", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    setTemplateStoreForTests(null)
  })

  it("EMPTY_TEMPLATE_STORE is frozen and finds nothing; InMemoryTemplateStore finds a template by type and id only", async () => {
    expect(Object.isFrozen(EMPTY_TEMPLATE_STORE)).toBe(true)
    expect(await EMPTY_TEMPLATE_STORE.findTemplate(TYPE, "template_cp_199_v1")).toBeNull()
    const s = new InMemoryTemplateStore().addTemplate(TYPE, "template_cp_199_v1")
    expect(await s.findTemplate(TYPE, "template_cp_199_v1")).toEqual({ documentTypeId: TYPE, templateId: "template_cp_199_v1" })
    expect(await s.findTemplate(DEED, "template_cp_199_v1")).toBeNull()
    expect(await s.findTemplate(TYPE, "template_other")).toBeNull()
  })

  it("setTemplateStoreForTests throws when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(() => setTemplateStoreForTests(null)).toThrow("setTemplateStoreForTests is test-only")
  })
})

// ---------------------------------------------------------------------------
// The pure parts of the generation store
// ---------------------------------------------------------------------------

const caller = (clearanceLevel: Caller["clearanceLevel"]): Caller => ({ uid: "u1", firmId: "f1", role: "associate", clearanceLevel })
const refusal = (fn: () => unknown): [number, string] => {
  try {
    fn()
  } catch (e) {
    if (e instanceof HttpError) return [e.status, e.code]
    throw e
  }
  throw new Error("expected an HttpError, nothing was thrown")
}

describe("D4 generation store: ids and the lease (P4B-1, P4B-8)", () => {
  it("a generation id is a non-empty string; an outline and a section take their ids from it", () => {
    expect(parseGenerationId("abc123")).toBe("abc123")
    for (const bad of [undefined, null, "", 5, {}, ["a"]]) expect([String(bad), ...refusal(() => parseGenerationId(bad))]).toEqual([String(bad), 400, "invalid_generation_id"])
    expect(outlineId("g1", 3)).toBe("g1_3")
    expect(sectionId("g1", 2, 5)).toBe("g1_2_5")
  })

  it("a lease is live only while leaseUntil is after now", () => {
    const now = 1_000_000
    const brief = (inFlight: unknown) => ({ inFlight })
    expect(liveLease(brief(null), now)).toBe(false)
    expect(liveLease({}, now)).toBe(false)
    expect(liveLease(brief({ claimId: "c", leaseUntil: Timestamp.fromMillis(now + 1) }), now)).toBe(true)
    expect(liveLease(brief({ claimId: "c", leaseUntil: Timestamp.fromMillis(now) }), now)).toBe(false)
    expect(liveLease(brief({ claimId: "c", leaseUntil: Timestamp.fromMillis(now - 1) }), now)).toBe(false)
    // A lease that cannot be read cannot hold the generation for ever.
    expect(liveLease(brief({ claimId: "c" }), now)).toBe(false)
    expect(liveLease(brief({ claimId: "c", leaseUntil: "tomorrow" }), now)).toBe(false)
  })
})

describe("D4 generation store: the generation label (P4B-13)", () => {
  it("is the strictest of the brief's label and the matter's, by rank, and never falls", () => {
    expect(generationLabel(caller("privileged-restricted"), { classification: "internal" }, { classification: "internal" })).toBe("internal")
    expect(generationLabel(caller("privileged-restricted"), { classification: "internal" }, { classification: "privileged" })).toBe("privileged")
    expect(generationLabel(caller("privileged-restricted"), { classification: "confidential" }, { classification: "public" })).toBe("confidential")
    expect(generationLabel(caller("privileged-restricted"), { classification: "privileged-restricted" }, { classification: "internal" })).toBe("privileged-restricted")
  })

  it("is 403 clearance when either label is unreadable or the result is above the caller's clearance", () => {
    expect(refusal(() => generationLabel(caller("privileged-restricted"), { classification: "bogus" }, { classification: "internal" }))).toEqual([403, "clearance"])
    expect(refusal(() => generationLabel(caller("privileged-restricted"), { classification: "internal" }, { classification: "constructor" }))).toEqual([403, "clearance"])
    expect(refusal(() => generationLabel(caller("privileged-restricted"), {}, { classification: "internal" }))).toEqual([403, "clearance"])
    expect(refusal(() => generationLabel(caller("internal"), { classification: "internal" }, { classification: "privileged" }))).toEqual([403, "clearance"])
    expect(refusal(() => generationLabel(caller("internal"), { classification: "confidential" }, { classification: "internal" }))).toEqual([403, "clearance"])
  })
})

describe("D4 generation store: reserved tokens (P4B-6, D26)", () => {
  it("RESERVED_TOKEN is not global or sticky, so test() carries no lastIndex from one text to the next", () => {
    expect(RESERVED_TOKEN.global).toBe(false)
    expect(RESERVED_TOKEN.sticky).toBe(false)
    for (let i = 0; i < 4; i += 1) expect(RESERVED_TOKEN.test("See PARTY_1.")).toBe(true)
    expect(RESERVED_TOKEN.lastIndex).toBe(0)
  })

  it("refuses an index bracket, a lossy token and a bare token, and nothing that only resembles one", () => {
    for (const text of ["⟦", "⟧", "a ⟦PARTY_1⟧ b", "[PARTY]", "[CNIC]", "[PHONE]", "[EMAIL]", "[IBAN]", "[NTN]", "[PASSPORT]", "PARTY_1", "x CNIC_12 y", "(VERBATIM_3)", "EMAIL_9.", "PASSPORT_1"]) {
      expect([text, ...refusal(() => refuseReservedTokens(["fine", text]))]).toEqual([text, 422, "reserved_tokens"])
    }
    expect(() => refuseReservedTokens([])).not.toThrow()
    for (const text of ["", "party_1", "MYPARTY_1", "PARTY1", "PARTY_", "PARTY_x", "[party]", "[VERBATIM]", "[ABC]", "PARTY 1", "the party", "PARTYS_1"]) {
      expect([text, (() => refuseReservedTokens([text]))()]).toEqual([text, undefined])
    }
  })
})

describe("D4 generation store: the view (P4B-8, D2)", () => {
  const T = Timestamp.fromMillis(Date.parse("2026-10-13T10:00:00.000Z"))
  const stored = (over: Record<string, unknown> = {}) => ({
    firmId: "f1",
    matterId: "m1",
    documentTypeId: "constitutional_petition_199",
    title: "Petition",
    facts: "The facts.",
    verbatim: [{ field: "petitioner", text: "Ardeshir Testani" }],
    partyNames: ["Ardeshir Testani"],
    classification: "internal",
    stage: "approved",
    outlineVersion: 2,
    approvedOutline: { version: 2, sha256: "a".repeat(64), by: "u1", at: T, acknowledgedMissingFacts: [0] },
    sectionCount: 3,
    sectionsStored: 1,
    templateId: "template_cp_199_v1",
    path: "ai",
    model: "anthropic/claude-opus-5.5",
    promptVersion: "4b.1",
    calls: 2,
    costMicroUsd: 28000,
    lastAttempt: { step: "section", outlineVersion: 2, section: 2, outcome: "refused", reason: "unsupported_authority", unsupportedRefs: ["2099 SCMR 7"], usageLogId: "ul1", traceId: "tr1", costMicroUsd: 14000, at: T, by: "u1" },
    inFlight: { claimId: "claim-secret", step: "section", outlineVersion: 2, section: 2, by: "u1", leaseUntil: Timestamp.fromMillis(2_000_000) },
    draftId: null,
    createdBy: "u1",
    createdAt: T,
    updatedAt: T,
    internalNote: "never shown",
    ...over,
  })

  it("shows every brief field with the generation id, ISO times and inProgress in place of the lease", () => {
    const live = generationView("g1", stored(), 1_000_000)
    expect(live).toEqual({
      generationId: "g1",
      firmId: "f1",
      matterId: "m1",
      documentTypeId: "constitutional_petition_199",
      title: "Petition",
      facts: "The facts.",
      verbatim: [{ field: "petitioner", text: "Ardeshir Testani" }],
      partyNames: ["Ardeshir Testani"],
      classification: "internal",
      stage: "approved",
      outlineVersion: 2,
      approvedOutline: { version: 2, sha256: "a".repeat(64), by: "u1", at: "2026-10-13T10:00:00.000Z", acknowledgedMissingFacts: [0] },
      sectionCount: 3,
      sectionsStored: 1,
      templateId: "template_cp_199_v1",
      path: "ai",
      model: "anthropic/claude-opus-5.5",
      promptVersion: "4b.1",
      calls: 2,
      costMicroUsd: 28000,
      lastAttempt: { step: "section", outlineVersion: 2, section: 2, outcome: "refused", reason: "unsupported_authority", unsupportedRefs: ["2099 SCMR 7"], usageLogId: "ul1", traceId: "tr1", costMicroUsd: 14000, at: "2026-10-13T10:00:00.000Z", by: "u1" },
      inProgress: true,
      draftId: null,
      createdBy: "u1",
      createdAt: "2026-10-13T10:00:00.000Z",
      updatedAt: "2026-10-13T10:00:00.000Z",
    })
    expect(generationView("g1", stored(), 2_000_000).inProgress).toBe(false)
    expect(generationView("g1", stored({ inFlight: null }), 0).inProgress).toBe(false)
    expect(JSON.stringify(live)).not.toMatch(/claim-secret|internalNote|inFlight|leaseUntil/)
  })

  it("shows null for what a fresh brief has not got", () => {
    const fresh = generationView("g2", stored({ stage: "facts", outlineVersion: 0, approvedOutline: null, sectionCount: null, sectionsStored: 0, path: null, model: null, promptVersion: null, calls: 0, costMicroUsd: 0, lastAttempt: null, inFlight: null, draftId: null }), 0)
    expect(fresh).toMatchObject({ approvedOutline: null, sectionCount: null, lastAttempt: null, inProgress: false, draftId: null, path: null, model: null, promptVersion: null })
  })

  it("the summary is the view without the facts, verbatim, party names and refused references", () => {
    const summary = generationSummary("g1", stored(), 1_000_000)
    const { facts: _facts, verbatim: _verbatim, partyNames: _partyNames, lastAttempt, ...rest } = generationView("g1", stored(), 1_000_000)
    expect(summary).toEqual({ ...rest, lastAttempt: { ...lastAttempt!, unsupportedRefs: undefined } })
    for (const k of ["facts", "verbatim", "partyNames", "inFlight"]) expect(summary).not.toHaveProperty(k)
    expect(summary.lastAttempt).not.toHaveProperty("unsupportedRefs")
    expect(JSON.stringify(summary)).not.toMatch(/The facts|Ardeshir|2099 SCMR/)
    expect(generationSummary("g2", stored({ lastAttempt: null }), 0).lastAttempt).toBeNull()
  })
})
