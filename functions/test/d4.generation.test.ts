import { Timestamp } from "firebase-admin/firestore"
import { afterEach, describe, expect, it, vi } from "vitest"
import { pseudonymise } from "@/platform/p1/pseudonymiseOutboundPII"
import { getDocumentType } from "../src/d4/doctypes"
import { sha256Hex } from "../src/d4/drafts"
import { OUTLINE_PURPOSE, PROMPT_VERSION, SECTION_PURPOSE, SECTION_WORD_BUDGET, outlinePrompt, sectionPrompt } from "../src/d4/generationPrompt"
import { D4_ATTEMPT_SLACK_MS, D4_PRECALL_BUDGET_MS, D4_WRITE_DEADLINE_MS, GENERATION_LEASE_MS, d4GenerationTestSeam, d4Now, outcomeOf } from "../src/d4/generationRun"
import { generationSeam } from "../src/d4/generations"
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
import {
  MAX_OUTPUT_CHARS,
  MAX_UNSUPPORTED_REFS,
  advocateText,
  checkOutlineAnswer,
  checkSectionAnswer,
  newAuthorities,
  outlineSha256,
  parseOutlineAnswer,
  validOutline,
} from "../src/d4/guardrails"
import { EMPTY_TEMPLATE_STORE, InMemoryTemplateStore, deterministicFirstCheck, setTemplateStoreForTests } from "../src/d4/templates"
import { FUNCTION_TIMEOUT_SECONDS } from "../src/health"
import { HttpError } from "../src/http/errors"
import { COMMIT_ATTEMPT_SLACK_MS, COMMIT_DEADLINE_MS, type P1Result } from "../src/p1/gateway"
import { OPIK_TIMEOUT_MS } from "../src/p1/opik"
import { TRANSPORT_TIMEOUT_MS } from "../src/p1/transport"
import type { Caller } from "../src/p5/auth"

/**
 * Phase 4b (spec P4B-9): the template port and what needs no emulator of the generation store. Task 3 and Task 4 add
 * their unit tests here (the prompt, the guardrails, the budget arithmetic).
 */

// The Phase 4b fixtures (P4B-21), as d4.generation.emu.test.ts has them. They are repeated here, not imported: importing
// that file would run its suites in this one.
const TYPE = "constitutional_petition_199" // template_cp_199_v1
const DEED = "sale_deed" // NON_FORUM
const PERSON = "Ardeshir Testani"
const INSTITUTION = "Federation of Testlandia through the Secretary, Ministry of Fixtures"
const CNIC = "99999-9999999-9"
const PHONE = "0399-9999999"
const OWN_CITATION = "PLD 2099 SC 101"
const NEW_CITATION = "2099 SCMR 7"
const LAND = "Plot 99-T, Block Z, Test Housing Scheme, measuring 999 square yards"
const FACTS = `The petitioner ${PERSON} (CNIC ${CNIC}, mobile ${PHONE}) challenges the order of the ${INSTITUTION} dated 1 January 2099, relying on ${OWN_CITATION}.`

/** An outline answer: the bare JSON object the model is asked for (D11). */
const outlineJson = (sections: Array<{ heading: string; purpose: string }>, missingFacts: Array<{ field: string; note: string }> = []): string =>
  JSON.stringify({ sections, missingFacts })

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

  it("deterministicFirstCheck is deterministic when the store holds the type's template and ai otherwise", async () => {
    const s = new InMemoryTemplateStore().addTemplate(TYPE, "template_cp_199_v1")
    expect(await deterministicFirstCheck(s, TYPE, "template_cp_199_v1")).toBe("deterministic")
    expect(await deterministicFirstCheck(s, DEED, "template_sale_deed_v1")).toBe("ai")
    expect(await deterministicFirstCheck(s, TYPE, "template_other")).toBe("ai")
    expect(await deterministicFirstCheck(EMPTY_TEMPLATE_STORE, TYPE, "template_cp_199_v1")).toBe("ai")
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

// ---------------------------------------------------------------------------
// Task 3: the outline parser, the guardrails, the outline hash, the prompt and the time budget
// ---------------------------------------------------------------------------

/** A string of `n` characters. */
const chars = (n: number, c = "x"): string => c.repeat(n)
/** An outline with one section and no missing facts, `over` laid on top. */
const outlineOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ sections: [{ heading: "H", purpose: "P" }], missingFacts: [], ...over })

describe("D4 outline answer parser (P4B-12 step 2)", () => {
  // Review Focus 3
  it("accepts the bare JSON object or exactly one json fence, and nothing else", () => {
    const j = outlineJson([{ heading: "Facts", purpose: "State the facts." }])
    for (const ok of [j, `  ${j}\n`, "```json\n" + j + "\n```", "```JSON\n" + j + "\n```"]) expect(parseOutlineAnswer(ok)).not.toBeNull()
    for (const bad of [`Here is the outline:\n${j}`, `${j}\nHope this helps.`, "```json\n" + j + "\n```\n```json\n" + j + "\n```", "```\n" + j + "\n```", "{}", "not json"]) expect(parseOutlineAnswer(bad)).toBeNull()
    // What parses is the outline itself, its strings trimmed.
    expect(parseOutlineAnswer("```json\n" + outlineJson([{ heading: "  Facts ", purpose: " State the facts.\n" }], [{ field: " asAtDate", note: "Not given. " }]) + "\n```")).toEqual({
      sections: [{ heading: "Facts", purpose: "State the facts." }],
      missingFacts: [{ field: "asAtDate", note: "Not given." }],
    })
    // Prose inside the fence, an empty fence, a fence with text after it, and a JSON value that is not an object.
    for (const bad of ["```json\nHere: " + j + "\n```", "```json\n\n```", "```json\n" + j + "\n```\nDone.", "[" + j + "]", '"text"', "", "   "]) expect(parseOutlineAnswer(bad)).toBeNull()
  })

  it("enforces the limits: 1-25 sections, one-line headings of 1-200, purposes of 1-2,000, 0-50 missing facts with one-line fields of 1-100 and notes of 1-500", () => {
    const section = (heading: string, purpose = "P") => ({ heading, purpose })
    const missing = (field: string, note = "N") => ({ field, note })
    const passes: Array<[string, Record<string, unknown>]> = [
      ["1 section", outlineOf()],
      ["25 sections", outlineOf({ sections: Array.from({ length: 25 }, (_, i) => section(`H${i}`)) })],
      ["a heading of 1", outlineOf({ sections: [section("h")] })],
      ["a heading of 200", outlineOf({ sections: [section(chars(200))] })],
      ["a purpose of 1", outlineOf({ sections: [section("H", "p")] })],
      ["a purpose of 2,000", outlineOf({ sections: [section("H", chars(2000))] })],
      ["a purpose over several lines", outlineOf({ sections: [section("H", "one\ntwo")] })],
      ["0 missing facts", outlineOf({ missingFacts: [] })],
      ["50 missing facts", outlineOf({ missingFacts: Array.from({ length: 50 }, (_, i) => missing(`f${i}`)) })],
      ["a field of 100", outlineOf({ missingFacts: [missing(chars(100))] })],
      ["a note of 500", outlineOf({ missingFacts: [missing("f", chars(500))] })],
      ["a heading of 200 once trimmed", outlineOf({ sections: [section(`  ${chars(200)}  `)] })],
    ]
    for (const [name, value] of passes) expect([name, validOutline(value) !== null]).toEqual([name, true])
    const fails: Array<[string, Record<string, unknown>]> = [
      ["0 sections", outlineOf({ sections: [] })],
      ["26 sections", outlineOf({ sections: Array.from({ length: 26 }, (_, i) => section(`H${i}`)) })],
      ["an empty heading", outlineOf({ sections: [section("")] })],
      ["a blank heading", outlineOf({ sections: [section("   ")] })],
      ["a heading of 201", outlineOf({ sections: [section(chars(201))] })],
      ["a heading with a line break", outlineOf({ sections: [section("Fa\ncts")] })],
      ["a heading with a tab", outlineOf({ sections: [section("Fa\tcts")] })],
      ["an empty purpose", outlineOf({ sections: [section("H", "")] })],
      ["a purpose of 2,001", outlineOf({ sections: [section("H", chars(2001))] })],
      ["51 missing facts", outlineOf({ missingFacts: Array.from({ length: 51 }, (_, i) => missing(`f${i}`)) })],
      ["an empty field", outlineOf({ missingFacts: [missing("")] })],
      ["a field of 101", outlineOf({ missingFacts: [missing(chars(101))] })],
      ["a field with a line break", outlineOf({ missingFacts: [missing("as\nAtDate")] })],
      ["an empty note", outlineOf({ missingFacts: [missing("f", "")] })],
      ["a note of 501", outlineOf({ missingFacts: [missing("f", chars(501))] })],
    ]
    for (const [name, value] of fails) expect([name, validOutline(value)]).toEqual([name, null])
    // The parser applies the same limits.
    expect(parseOutlineAnswer(outlineJson(Array.from({ length: 26 }, (_, i) => section(`H${i}`))))).toBeNull()
    expect(parseOutlineAnswer(outlineJson([section(chars(201))]))).toBeNull()
  })

  it("refuses extra keys, a missing missingFacts, and a non-string value", () => {
    expect(validOutline({ sections: [{ heading: "H", purpose: "P" }], missingFacts: [], extra: 1 })).toBeNull()
    expect(validOutline({ sections: [{ heading: "H", purpose: "P" }] })).toBeNull()
    expect(validOutline({ sections: [{ heading: "H", purpose: 7 }], missingFacts: [] })).toBeNull()
    expect(validOutline({ sections: [{ heading: "H", purpose: "P", note: "x" }], missingFacts: [] })).toBeNull()
    expect(validOutline({ sections: [{ heading: "H" }], missingFacts: [] })).toBeNull()
    expect(validOutline({ sections: [{ heading: "H", purpose: "P" }], missingFacts: [{ field: "f" }] })).toBeNull()
    expect(validOutline({ sections: [{ heading: "H", purpose: "P" }], missingFacts: [{ field: "f", note: "n", extra: "x" }] })).toBeNull()
    expect(validOutline({ sections: [{ heading: "H", purpose: "P" }], missingFacts: [{ field: 1, note: "n" }] })).toBeNull()
    expect(validOutline({ sections: "H", missingFacts: [] })).toBeNull()
    expect(validOutline({ sections: [["H", "P"]], missingFacts: [] })).toBeNull()
    expect(validOutline({ sections: [null], missingFacts: [] })).toBeNull()
    expect(validOutline({ sections: [{ heading: "H", purpose: "P" }], missingFacts: {} })).toBeNull()
    for (const v of [null, undefined, "x", 1, [], [outlineOf()]]) expect(validOutline(v)).toBeNull()
    // A key that JSON can carry but an object literal cannot: refused as an extra key.
    expect(validOutline(JSON.parse('{"sections":[{"heading":"H","purpose":"P"}],"missingFacts":[],"__proto__":{}}'))).toBeNull()
  })
})

describe("D4 guardrails (P4B-12)", () => {
  const pseudo = pseudonymise(FACTS, { partyNames: [INSTITUTION, PERSON] })
  const own = advocateText({ title: "T", facts: FACTS, verbatim: [] })
  const section = (text: string, o: { heading?: string; truncated?: boolean; ownText?: string; map?: typeof pseudo.map | null } = {}) =>
    checkSectionAnswer({ text, truncated: o.truncated ?? false, pseudonyms: o.map === null ? undefined : (o.map ?? pseudo.map) }, o.ownText ?? own, o.heading ?? "H")

  it("the checks run in order and the first failure wins: truncated, unparseable, rehydration, size, charset, authority", () => {
    expect(checkSectionAnswer({ text: "", truncated: true, pseudonyms: pseudo.map }, own, "Grounds")).toMatchObject({ ok: false, reason: "output_truncated" })
    expect(checkSectionAnswer({ text: "⟦PARTY_9⟧ \u202e 2099 SCMR 7", truncated: false, pseudonyms: pseudo.map }, own, "Grounds")).toMatchObject({ ok: false, reason: "rehydration_failed" })
    expect(checkSectionAnswer({ text: "\u202e 2099 SCMR 7", truncated: false, pseudonyms: pseudo.map }, own, "Grounds")).toMatchObject({ ok: false, reason: "output_unsupported_characters" })
    // Each step before the next: empty before rehydration, rehydration before size, size before charset.
    expect(section("", { map: null })).toMatchObject({ ok: false, reason: "output_unparseable" })
    expect(section(`${chars(MAX_OUTPUT_CHARS + 1, "a")} ⟦PARTY_9⟧`)).toMatchObject({ ok: false, reason: "rehydration_failed" })
    expect(section(`${chars(MAX_OUTPUT_CHARS + 1, "a")}\u202e`)).toMatchObject({ ok: false, reason: "output_too_large" })
    expect(section(`Relies on ${NEW_CITATION}.\u202e`)).toMatchObject({ ok: false, reason: "output_unsupported_characters" })
    // The outline answer runs the same steps in the same order.
    const outline = (purpose: string, truncated = false) => checkOutlineAnswer({ text: outlineJson([{ heading: "Facts", purpose }]), truncated, pseudonyms: pseudo.map }, own)
    expect(outline("p", true)).toMatchObject({ ok: false, reason: "output_truncated" })
    expect(checkOutlineAnswer({ text: "not json", truncated: false, pseudonyms: pseudo.map }, own)).toMatchObject({ ok: false, reason: "output_unparseable" })
    expect(outline(`⟦PARTY_9⟧ \u202e ${NEW_CITATION}`)).toMatchObject({ ok: false, reason: "rehydration_failed" })
    expect(outline(`\u202e ${NEW_CITATION}`)).toMatchObject({ ok: false, reason: "output_unsupported_characters" })
    expect(outline(`Relies on ${NEW_CITATION}.`)).toEqual({ ok: false, reason: "unsupported_authority", unsupportedRefs: [NEW_CITATION] })
    expect(outline(`Relies on ${OWN_CITATION}.`)).toMatchObject({ ok: true })
  })

  // Review Focus 1
  it("rehydration_failed for any bracket, lossy token or bare token left after re-hydration, a damaged token included", () => {
    for (const t of ["⟦PARTY_9⟧", "⟦party_1⟧", "⟦PARTY_1 ⟧", "a lone ⟧", "PARTY_1", "CNIC_1", "VERBATIM_2", "[CNIC]", "[PARTY]", "no pseudonyms"])
      expect([t, checkSectionAnswer({ text: t, truncated: false, pseudonyms: t === "no pseudonyms" ? undefined : pseudo.map }, own, "H").ok]).toEqual([t, false])
    for (const t of ["⟦PARTY_9⟧", "⟦party_1⟧", "⟦PARTY_1 ⟧", "a lone ⟧", "a lone ⟦", "PARTY_1", "CNIC_1", "VERBATIM_2", "[CNIC]", "[PARTY]", "[PASSPORT]", "no pseudonyms"])
      expect([t, section(t, { map: t === "no pseudonyms" ? null : undefined })]).toEqual([t, { ok: false, reason: "rehydration_failed", unsupportedRefs: [] }])
    // A token the map holds comes back as its value; nothing is left.
    expect(section("⟦PARTY_2⟧ was served; his CNIC is ⟦CNIC_1⟧.")).toEqual({ ok: true, value: `${PERSON} was served; his CNIC is ${CNIC}.` })
    // An outline is judged string by string: one bad token anywhere refuses the whole answer.
    expect(checkOutlineAnswer({ text: outlineJson([{ heading: "Facts", purpose: "p" }], [{ field: "f", note: "See PARTY_1." }]), truncated: false, pseudonyms: pseudo.map }, own)).toMatchObject({ ok: false, reason: "rehydration_failed" })
    expect(checkOutlineAnswer({ text: outlineJson([{ heading: "Facts", purpose: "p" }]), truncated: false }, own)).toMatchObject({ ok: false, reason: "rehydration_failed" })
  })

  it("rehydration_failed for a reserved token that exists only once the charset rule has normalised the answer: a soft hyphen or a zero-width space inside PARTY_1 or [CNIC]", () => {
    const SOFT_HYPHEN = "\u00ad"
    const ZWSP = "\u200b"
    for (const hidden of [SOFT_HYPHEN, ZWSP]) {
      for (const text of [`Against PAR${hidden}TY_1.`, `Was [CN${hidden}IC] given?`, `See CN${hidden}IC_1.`]) {
        const name = JSON.stringify(text)
        // As sent, the text holds no reserved token; only its stored form does.
        expect([name, RESERVED_TOKEN.test(text)]).toEqual([name, false])
        expect([name, section(text)]).toEqual([name, { ok: false, reason: "rehydration_failed", unsupportedRefs: [] }])
        const asPurpose = checkOutlineAnswer({ text: outlineJson([{ heading: "Facts", purpose: text }]), truncated: false, pseudonyms: pseudo.map }, own)
        expect([name, asPurpose]).toEqual([name, { ok: false, reason: "rehydration_failed", unsupportedRefs: [] }])
        const asNote = checkOutlineAnswer({ text: outlineJson([{ heading: "Facts", purpose: "p" }], [{ field: "asAtDate", note: text }]), truncated: false, pseudonyms: pseudo.map }, own)
        expect([name, asNote]).toEqual([name, { ok: false, reason: "rehydration_failed", unsupportedRefs: [] }])
      }
    }
    // The charset rule still comes first: a string it refuses is output_unsupported_characters.
    expect(section(`Against PAR\u00adTY_1 \u202e.`)).toMatchObject({ ok: false, reason: "output_unsupported_characters" })
    // A soft hyphen that hides no token is the advocate's ordinary text and is stored without it.
    expect(section(`The peti\u00adtioner was served.`)).toEqual({ ok: true, value: "The petitioner was served." })
  })

  it("output_too_large over 200,000 characters after re-hydration, and not at 200,000", () => {
    expect(MAX_OUTPUT_CHARS).toBe(200_000)
    expect(section(chars(200_000, "a"))).toEqual({ ok: true, value: chars(200_000, "a") })
    // ⟦PARTY_1⟧ is the institution: the text is short of the cap as sent and one over it once re-hydrated.
    const text = `${chars(200_001 - INSTITUTION.length, "a")}⟦PARTY_1⟧`
    expect(text.length).toBeLessThan(200_000)
    expect(section(text)).toMatchObject({ ok: false, reason: "output_too_large" })
    expect(section(`${chars(200_000 - INSTITUTION.length, "a")}⟦PARTY_1⟧`)).toMatchObject({ ok: true })
    // For an outline, the total of its strings counts: 21 purposes that each re-hydrate to a 10,000-character verbatim
    // value make 210,000. The size check comes before the outline's own limits are judged again on the stored strings.
    const value = chars(10_000, "v")
    const big = pseudonymise(`${FACTS} ${value}`, { partyNames: [PERSON], verbatim: [value] })
    const sections = (n: number) => Array.from({ length: n }, (_, i) => ({ heading: `H${i}`, purpose: "⟦VERBATIM_1⟧" }))
    expect(checkOutlineAnswer({ text: outlineJson(sections(21)), truncated: false, pseudonyms: big.map }, own)).toMatchObject({ ok: false, reason: "output_too_large" })
    expect(checkOutlineAnswer({ text: outlineJson(sections(19)), truncated: false, pseudonyms: big.map }, own)).toMatchObject({ ok: false, reason: "output_unparseable" })
    // The largest outline the limits allow is well inside the cap.
    const many = Array.from({ length: 25 }, (_, i) => ({ heading: `H${i}`, purpose: chars(2000, "a") }))
    const notes = Array.from({ length: 50 }, (_, i) => ({ field: `f${i}`, note: chars(500, "n") }))
    const total = many.reduce((n, s) => n + s.heading.length + s.purpose.length, 0) + notes.reduce((n, m) => n + m.field.length + m.note.length, 0)
    expect(total).toBeLessThan(MAX_OUTPUT_CHARS)
    expect(checkOutlineAnswer({ text: outlineJson(many, notes), truncated: false, pseudonyms: pseudo.map }, own)).toMatchObject({ ok: true })
  })

  it("unsupported_authority: a ref not in the advocate's own text, or an UNRECOGNISED suspect, is new; at most 50 are recorded", () => {
    expect(checkSectionAnswer({ text: `Relies on ${NEW_CITATION}.`, truncated: false, pseudonyms: pseudo.map }, own, "H")).toEqual({ ok: false, reason: "unsupported_authority", unsupportedRefs: [NEW_CITATION] })
    expect(checkSectionAnswer({ text: `Relies on ${OWN_CITATION}.`, truncated: false, pseudonyms: pseudo.map }, own, "H")).toMatchObject({ ok: true })
    // 60 distinct refs: every one is new, and 50 are recorded, in order.
    const sixty = Array.from({ length: 60 }, (_, i) => `2099 SCMR ${i + 1}`)
    const many = section(`Relies on ${sixty.join("; ")}.`)
    expect(many).toMatchObject({ ok: false, reason: "unsupported_authority" })
    expect(MAX_UNSUPPORTED_REFS).toBe(50)
    expect(many.ok === false && many.unsupportedRefs).toEqual(sixty.slice(0, 50))
    expect(newAuthorities(`Relies on ${sixty.join("; ")}.`, own)).toEqual(sixty)
    // A repeated new ref is recorded once.
    expect(section(`${NEW_CITATION}, and again ${NEW_CITATION}.`)).toEqual({ ok: false, reason: "unsupported_authority", unsupportedRefs: [NEW_CITATION] })
    // A suspect the strict extractor cannot read is always new, even when the advocate wrote the same text.
    const suspect = "2099SCMR7"
    const suspects = newAuthorities(`See ${suspect}.`, advocateText({ title: "T", facts: `See ${suspect}.`, verbatim: [] }))
    expect(suspects).toHaveLength(1)
    expect(suspects[0]!.startsWith("UNRECOGNISED: ")).toBe(true)
    // For a section, refs in the approved outline count as the advocate's.
    const approved = { sections: [{ heading: "Grounds", purpose: `Rely on ${NEW_CITATION}.` }], missingFacts: [] }
    const withOutline = advocateText({ title: "T", facts: FACTS, verbatim: [] }, approved)
    expect(section(`Relies on ${NEW_CITATION}.`, { ownText: withOutline })).toMatchObject({ ok: true })
    // The title and the verbatim texts are the advocate's too.
    expect(section(`Relies on ${NEW_CITATION}.`, { ownText: advocateText({ title: `Petition under ${NEW_CITATION}`, facts: "f", verbatim: [] }) })).toMatchObject({ ok: true })
    expect(section(`Relies on ${NEW_CITATION}.`, { ownText: advocateText({ title: "T", facts: "f", verbatim: [{ field: "reliefSought", text: `As in ${NEW_CITATION}` }] }) })).toMatchObject({ ok: true })
    expect(advocateText({ title: "T", facts: "F", verbatim: [{ field: "a", text: "V" }] }, { sections: [{ heading: "H", purpose: "P" }], missingFacts: [{ field: "m", note: "N" }] })).toBe(["T", "F", "V", "H", "P", "m", "N"].join("\n"))
  })

  // Review Focus 5
  it("an authority the advocate wrote in another form is the advocate's authority", () => {
    const ownOdd = advocateText({ title: "T", facts: "Relies on P.L.D. 2099 Supreme Court 101.", verbatim: [] })
    expect(checkSectionAnswer({ text: `As held in ${OWN_CITATION}.`, truncated: false, pseudonyms: pseudo.map }, ownOdd, "H")).toMatchObject({ ok: true })
    expect(newAuthorities(`As held in ${OWN_CITATION} and in P.L.D. 2099 S.C. 101.`, ownOdd)).toEqual([])
  })

  // Review Focus 4
  it("a section whose first line repeats its heading loses that line; a section with nothing else is output_unparseable", () => {
    expect(checkSectionAnswer({ text: "GROUNDS:\n\nThe order is void.", truncated: false, pseudonyms: pseudo.map }, own, "Grounds")).toEqual({ ok: true, value: "The order is void." })
    expect(checkSectionAnswer({ text: "Grounds\n\n", truncated: false, pseudonyms: pseudo.map }, own, "Grounds")).toMatchObject({ ok: false, reason: "output_unparseable" })
    // Only the first line, and only when it is the heading; a heading that names a party is matched once re-hydrated.
    expect(section("The order is void.\nGrounds", { heading: "Grounds" })).toEqual({ ok: true, value: "The order is void.\nGrounds" })
    expect(section("Grounds of challenge\nThe order is void.", { heading: "Grounds" })).toEqual({ ok: true, value: "Grounds of challenge\nThe order is void." })
    expect(section("  grounds :  \n\n\nThe order is void.\n", { heading: "Grounds" })).toEqual({ ok: true, value: "The order is void." })
    expect(section(`Case of ⟦PARTY_2⟧\nThe order is void.`, { heading: `Case of ${PERSON}` })).toEqual({ ok: true, value: "The order is void." })
    expect(section("   \n\n ", { heading: "Grounds" })).toMatchObject({ ok: false, reason: "output_unparseable" })
    // A body that is nothing once the charset rule has normalised it is empty too.
    expect(section("\u200b", { heading: "Grounds" })).toMatchObject({ ok: false, reason: "output_unparseable" })
  })

  it("an outline answer is re-hydrated string by string and stored in the charset rule's normalised form", () => {
    const r = checkOutlineAnswer({ text: outlineJson([{ heading: "Facts", purpose: "The case of ⟦PARTY_2⟧ against ⟦PARTY_1⟧." }]), truncated: false, pseudonyms: pseudo.map }, own)
    expect(r).toEqual({ ok: true, value: { sections: [{ heading: "Facts", purpose: `The case of ${PERSON} against ${INSTITUTION}.` }], missingFacts: [] } })
    // Normalised: NFC, CRLF to LF and an ASCII dash, in every string.
    const n = checkOutlineAnswer({ text: outlineJson([{ heading: "Cafe\u0301", purpose: "Line one\r\nline two \u2013 end" }], [{ field: "na\u0308me", note: "Note \u2014 x" }]), truncated: false, pseudonyms: pseudo.map }, own)
    expect(n).toEqual({ ok: true, value: { sections: [{ heading: "Caf\u00e9", purpose: "Line one\nline two - end" }], missingFacts: [{ field: "n\u00e4me", note: "Note - x" }] } })
    // A string that breaks a limit once re-hydrated is refused, never stored outside the limits: a heading over 200
    // characters, or one that a verbatim value turns into two lines.
    const long = checkOutlineAnswer({ text: outlineJson([{ heading: `${chars(190, "h")} ⟦PARTY_1⟧`, purpose: "p" }]), truncated: false, pseudonyms: pseudo.map }, own)
    expect(long).toMatchObject({ ok: false, reason: "output_unparseable" })
    const verbatim = pseudonymise(`${FACTS} ${LAND}\nsecond line`, { partyNames: [PERSON], verbatim: [`${LAND}\nsecond line`] })
    const twoLines = checkOutlineAnswer({ text: outlineJson([{ heading: "Land: ⟦VERBATIM_1⟧", purpose: "p" }]), truncated: false, pseudonyms: verbatim.map }, own)
    expect(twoLines).toMatchObject({ ok: false, reason: "output_unparseable" })
  })
})

describe("D4 generation step outcome and seam (P4B-12, P4B-14)", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const key of Object.keys(d4GenerationTestSeam) as Array<keyof typeof d4GenerationTestSeam>) delete d4GenerationTestSeam[key]
  })

  const p1 = (over: Partial<P1Result>): P1Result => ({
    outcome: "ok",
    blockReason: null,
    text: "t",
    truncated: false,
    usageLogId: "u1",
    traceId: "t1",
    model: "anthropic/claude-opus-5.5",
    classification: "internal",
    inputTokens: 1000,
    outputTokens: 500,
    costMicroUsd: 14000,
    outbound: { body: "b", purpose: "draft-outline", redactionCounts: {} },
    ...over,
  })

  it("outcomeOf: blocked with P1's reason, failed with transport_error, refused with the guardrail's reason and at most 50 refs, otherwise stored", () => {
    expect(outcomeOf(p1({ outcome: "blocked", blockReason: "policy_denied", text: undefined }), null)).toEqual({ outcome: "blocked", reason: "policy_denied", unsupportedRefs: [] })
    expect(outcomeOf(p1({ outcome: "failed", text: undefined }), null)).toEqual({ outcome: "failed", reason: "transport_error", unsupportedRefs: [] })
    const refs = Array.from({ length: 60 }, (_, i) => `2099 SCMR ${i + 1}`)
    expect(outcomeOf(p1({}), { ok: false, reason: "unsupported_authority", unsupportedRefs: refs })).toEqual({ outcome: "refused", reason: "unsupported_authority", unsupportedRefs: refs.slice(0, 50) })
    expect(outcomeOf(p1({}), { ok: false, reason: "output_truncated", unsupportedRefs: [] })).toEqual({ outcome: "refused", reason: "output_truncated", unsupportedRefs: [] })
    expect(outcomeOf(p1({}), { ok: true, value: "x" })).toEqual({ outcome: "stored", reason: null, unsupportedRefs: [] })
    // P1's outcome comes first: a blocked or failed call is never judged by a guardrail.
    expect(outcomeOf(p1({ outcome: "blocked", blockReason: "budget_exhausted" }), { ok: false, reason: "output_truncated", unsupportedRefs: [] })).toMatchObject({ outcome: "blocked", reason: "budget_exhausted" })
  })

  it("outcomeOf refuses a blocked P1 result without a reason, never recording it as transport_error", () => {
    expect(() => outcomeOf(p1({ outcome: "blocked", blockReason: null, text: undefined }), null)).toThrow("blocked without a reason")
  })

  it("the generation seam is inert when NODE_ENV is production: the real clock, no hooks and no injected failures", () => {
    d4GenerationTestSeam.wallClock = () => 5
    d4GenerationTestSeam.outcomeWriteFailures = [new Error("x")]
    expect(d4Now()).toBe(5)
    expect(generationSeam().outcomeWriteFailures).toHaveLength(1)
    vi.stubEnv("NODE_ENV", "production")
    expect(generationSeam()).toEqual({})
    const before = Date.now()
    const now = d4Now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })
})

describe("D4 outline hash (P4B-10)", () => {
  it("outlineSha256 is the SHA-256 of JSON.stringify({ sections: [{ heading, purpose }], missingFacts: [{ field, note }] }), keys in that order", () => {
    const o = { missingFacts: [{ note: "n", field: "f" }], sections: [{ purpose: "p", heading: "h" }] }
    expect(outlineSha256(o)).toBe(sha256Hex('{"sections":[{"heading":"h","purpose":"p"}],"missingFacts":[{"field":"f","note":"n"}]}'))
    expect(outlineSha256({ sections: [{ heading: "h", purpose: "p" }], missingFacts: [] })).toMatch(/^[0-9a-f]{64}$/)
    expect(outlineSha256({ sections: [{ heading: "h", purpose: "p" }], missingFacts: [] })).not.toBe(outlineSha256({ sections: [{ heading: "h", purpose: "q" }], missingFacts: [] }))
  })
})

describe("D4 generation prompt (P4B-4, prompt contract)", () => {
  it("the outline prompt carries the fixed instructions, the type's name, firstGroundRule and requiredFields, the verbatim fields as <field>: <text>, and the facts; never a label, a matter id or a party list", () => {
    const p = outlinePrompt({ type: getDocumentType(DEED)!, verbatim: [{ field: "exactLandDescription", text: LAND }], facts: FACTS })
    for (const s of [getDocumentType(DEED)!.name, getDocumentType(DEED)!.firstGroundRule, ...getDocumentType(DEED)!.requiredFields, `exactLandDescription: ${LAND}`, FACTS, '"sections"', '"missingFacts"', "⟦"]) expect(p).toContain(s)
    for (const s of ["classification", "matterId", "partyNames"]) expect(p).not.toContain(s) // the signature takes no label, id or party list; the emulator tests 1 and "classification" check the sent bodies
    expect(outlinePrompt({ type: getDocumentType(DEED)!, verbatim: [], facts: FACTS })).toBe(outlinePrompt({ type: getDocumentType(DEED)!, verbatim: [], facts: FACTS }))
    // The fixed text holds no well-formed token, which P1 would treat as one it placed.
    expect(p).not.toMatch(/⟦(?:VERBATIM|CNIC|PHONE|EMAIL|IBAN|NTN|PASSPORT|PARTY)_\d+⟧/)
  })

  it("the section prompt carries section i of k, the numbered approved outline and section i − 1's text", () => {
    const p = sectionPrompt({ type: getDocumentType(TYPE)!, verbatim: [], facts: FACTS, outline: { sections: [{ heading: "Facts", purpose: "pf" }, { heading: "Grounds", purpose: "pg" }], missingFacts: [] }, section: 2, previousText: "PREVIOUS SECTION TEXT" })
    for (const s of ["2 of 2", "1. Facts", "2. Grounds", "PREVIOUS SECTION TEXT", getDocumentType(TYPE)!.firstGroundRule]) expect(p).toContain(s)
    for (const s of [getDocumentType(TYPE)!.name, "1. Facts: pf", "2. Grounds: pg", FACTS]) expect(p).toContain(s)
    for (const s of ["classification", "matterId", "partyNames"]) expect(p).not.toContain(s)
    // Section 1 has no previous section.
    const first = sectionPrompt({ type: getDocumentType(DEED)!, verbatim: [{ field: "exactLandDescription", text: LAND }], facts: FACTS, outline: { sections: [{ heading: "Recitals", purpose: "pr" }], missingFacts: [] }, section: 1, previousText: null })
    for (const s of ["1 of 1", "1. Recitals: pr", `exactLandDescription: ${LAND}`, getDocumentType(DEED)!.firstGroundRule]) expect(first).toContain(s)
    expect(first).not.toContain("PREVIOUS SECTION TEXT")
  })

  it("both prompts carry the section word budget: the section prompt caps the body at about 1,000 words and the outline prompt asks for longer parts to be split (D25)", () => {
    expect(SECTION_WORD_BUDGET).toBe(1_000)
    expect(sectionPrompt({ type: getDocumentType(TYPE)!, verbatim: [], facts: FACTS, outline: { sections: [{ heading: "Facts", purpose: "pf" }], missingFacts: [] }, section: 1, previousText: null })).toContain("1,000 words")
    expect(outlinePrompt({ type: getDocumentType(TYPE)!, verbatim: [], facts: FACTS })).toContain("1,000 words")
  })

  it("PROMPT_VERSION is 4b.1 and the purposes are draft-outline and draft-section", () => {
    expect([PROMPT_VERSION, OUTLINE_PURPOSE, SECTION_PURPOSE]).toEqual(["4b.1", "draft-outline", "draft-section"])
  })
})

describe("D4 generation time budget (P4B-17)", () => {
  it("P1's 102 s worst case, the 5 s pre-call budget and the 10 s write deadline make 117 s, inside the 120 s timeout; 4 s of the write deadline is the in-flight slack; the 180 s lease outlives the timeout", () => {
    expect(TRANSPORT_TIMEOUT_MS + OPIK_TIMEOUT_MS + COMMIT_DEADLINE_MS + COMMIT_ATTEMPT_SLACK_MS).toBe(102_000)
    expect([D4_PRECALL_BUDGET_MS, D4_WRITE_DEADLINE_MS, D4_ATTEMPT_SLACK_MS, GENERATION_LEASE_MS]).toEqual([5_000, 10_000, 4_000, 180_000])
    expect(102_000 + D4_PRECALL_BUDGET_MS + D4_WRITE_DEADLINE_MS).toBe(117_000); expect(117_000).toBeLessThan(FUNCTION_TIMEOUT_SECONDS * 1000)
    expect(GENERATION_LEASE_MS).toBeGreaterThan(FUNCTION_TIMEOUT_SECONDS * 1000)
  })
})
