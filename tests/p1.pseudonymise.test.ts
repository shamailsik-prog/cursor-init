import { describe, expect, it } from "vitest"
import { LOSSY_TOKENS, MASK_PATTERNS, maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { INDEXED_TOKEN, applyMap, pseudonymise, rehydrate } from "@/platform/p1/pseudonymiseOutboundPII"

// The Phase 4b fixtures (P4B-21): citations use 2099, CNICs and phones are all nines, parties are fictitious.
const PERSON = "Ardeshir Testani"
const INSTITUTION = "Federation of Testlandia through the Secretary, Ministry of Fixtures"
const CNIC = "99999-9999999-9"
const CNIC_PLAIN = "9999999999999"
const PHONE = "0399-9999999"
const LAND = "Plot 99-T, Block Z, Test Housing Scheme, measuring 999 square yards"

describe("P1 indexed pseudonymiser (P4B-6)", () => {
  it("replaces verbatim strings first, longest first, numbered in the order given", () => {
    expect(pseudonymise(`Land: ${LAND}. Short: Plot 99-T.`, { verbatim: ["Plot 99-T", LAND] }).text).toBe("Land: ⟦VERBATIM_2⟧. Short: ⟦VERBATIM_1⟧.")
  })
  it("gives each distinct pattern value one token per kind, numbered pattern by pattern in the mask's order", () => {
    expect(pseudonymise(`B ${CNIC_PLAIN}, A ${CNIC}, again ${CNIC}; call ${PHONE}.`, {}).text).toBe("B ⟦CNIC_2⟧, A ⟦CNIC_1⟧, again ⟦CNIC_1⟧; call ⟦PHONE_1⟧.")
  })
  it("gives every supplied party name one token, matched case-insensitively and longest first, even when absent from the text", () => {
    const r = pseudonymise(`${PERSON.toUpperCase()} v. the ${INSTITUTION}`, { partyNames: [INSTITUTION, PERSON, "Absent Party"] })
    expect(r.text).toBe("⟦PARTY_2⟧ v. the ⟦PARTY_1⟧")
    expect(r.map.filter((p) => p.kind === "party").map((p) => [p.token, p.value])).toEqual([
      ["⟦PARTY_1⟧", INSTITUTION],
      ["⟦PARTY_2⟧", PERSON],
      ["⟦PARTY_3⟧", "Absent Party"],
    ])
  })
  it("never rewrites inside a token already placed, even for a party name that spells a token", () => {
    expect(pseudonymise(`Party ${CNIC} and Party`, { partyNames: ["Party", "CNIC_1"] }).text).toBe("⟦PARTY_1⟧ ⟦CNIC_1⟧ and ⟦PARTY_1⟧")
  })
  it("redactionCounts counts every replacement by kind, verbatim included", () => {
    expect(pseudonymise(`${LAND}; ${PERSON}, ${PERSON}; ${CNIC}; ${PHONE}`, { verbatim: [LAND], partyNames: [PERSON] }).redactionCounts).toEqual({
      verbatim: 1,
      cnic: 1,
      phone: 1,
      email: 0,
      iban: 0,
      ntn: 0,
      passport: 0,
      party: 2,
    })
  })
  it("the map is frozen, entry by entry, and holds every supplied name and verbatim string", () => {
    const { map } = pseudonymise("nothing here", { verbatim: [LAND], partyNames: [PERSON] })
    expect(Object.isFrozen(map) && map.every((p) => Object.isFrozen(p))).toBe(true)
    expect(map.map((p) => [p.token, p.kind, p.value])).toEqual([
      ["⟦VERBATIM_1⟧", "verbatim", LAND],
      ["⟦PARTY_1⟧", "party", PERSON],
    ])
  })
  it("applyMap turns a mapped value into its token and any other pattern match into the lossy token", () => {
    const { map } = pseudonymise(`${PERSON} ${CNIC}`, { partyNames: [PERSON] })
    expect(applyMap(`${PERSON.toLowerCase()} holds ${CNIC}; another ${CNIC_PLAIN}; mail x@example.test`, map, { partyNames: [PERSON] })).toBe(
      "⟦PARTY_1⟧ holds ⟦CNIC_1⟧; another [CNIC]; mail [EMAIL]"
    )
  })
  it("rehydrate restores every known token in one pass, a party name as supplied, and leaves an unknown token in place", () => {
    const { map } = pseudonymise(`${PERSON} ${CNIC}`, { partyNames: [PERSON] })
    expect(rehydrate("⟦PARTY_1⟧ ⟦CNIC_1⟧ ⟦PARTY_9⟧", map)).toBe(`${PERSON} ${CNIC} ⟦PARTY_9⟧`)
  })
  // Review Focus 2
  it("a party name the model writes in another case, the institutional name included, re-hydrates as supplied", () => {
    const names = [INSTITUTION, PERSON]
    const { map } = pseudonymise("x", { partyNames: names })
    expect(rehydrate(applyMap(`THE ${INSTITUTION.toUpperCase()} and ${PERSON.toLowerCase()}`, map, { partyNames: names }), map)).toBe(`THE ${INSTITUTION} and ${PERSON}`)
  })
  it("maskOutboundPII is unchanged: the exported patterns are in the mask's order and its lossy output is as before", () => {
    expect(MASK_PATTERNS.map((p) => p.kind)).toEqual(["cnic", "cnic", "phone", "phone", "email", "iban", "ntn", "passport"])
    expect(maskOutboundPII(`${PERSON} ${CNIC} ${PHONE}`, { partyNames: [PERSON] }).masked).toBe("[PARTY] [CNIC] [PHONE]")
  })

  // Pins beyond the brief's list, for the input classes Tasks 3 and 4 depend on.
  it("INDEXED_TOKEN matches the eight kinds with a positive index and nothing else", () => {
    const sample = "⟦PARTY_1⟧ ⟦CNIC_10⟧ ⟦VERBATIM_2⟧ ⟦PARTY_0⟧ ⟦PARTY_01⟧ ⟦party_1⟧ ⟦PARTY_1 ⟧ ⟦FOO_1⟧ PARTY_1"
    expect(sample.match(INDEXED_TOKEN)).toEqual(["⟦PARTY_1⟧", "⟦CNIC_10⟧", "⟦VERBATIM_2⟧"])
    expect(INDEXED_TOKEN.source).toBe("⟦(VERBATIM|CNIC|PHONE|EMAIL|IBAN|NTN|PASSPORT|PARTY)_([1-9]\\d*)⟧")
    expect(INDEXED_TOKEN.flags).toBe("g")
  })
  it("LOSSY_TOKENS lists exactly the tokens the mask writes", () => {
    const everyKind = `${PERSON} ${CNIC} ${PHONE} x@example.test PK36SCBL0000001123456702 NTN 1234567-8 passport AB1234567`
    const masked = maskOutboundPII(everyKind, { partyNames: [PERSON] }).masked
    expect([...LOSSY_TOKENS].sort()).toEqual(["[CNIC]", "[EMAIL]", "[IBAN]", "[NTN]", "[PARTY]", "[PASSPORT]", "[PHONE]"])
    expect(masked).toBe("[PARTY] [CNIC] [PHONE] [EMAIL] [IBAN] [NTN] [PASSPORT]")
  })
  it("rehydrate puts a value in literally: no replacement-pattern expansion, and no second pass over what it inserted", () => {
    const map = Object.freeze([
      Object.freeze({ token: "⟦PARTY_1⟧", kind: "party", value: "Rs. $& and $1 and $$" } as const),
      Object.freeze({ token: "⟦PARTY_2⟧", kind: "party", value: "⟦PARTY_1⟧" } as const),
    ])
    expect(rehydrate("a ⟦PARTY_1⟧ b ⟦PARTY_2⟧ c", map)).toBe("a Rs. $& and $1 and $$ b ⟦PARTY_1⟧ c")
  })
  it("applyMap leaves tokens the model wrote as they are, and masks a supplied party name the map does not hold", () => {
    const { map } = pseudonymise(`${PERSON} ${CNIC}`, { partyNames: [PERSON] })
    expect(applyMap(`⟦PARTY_1⟧ and ⟦PARTY_9⟧ and Absent Party`, map, { partyNames: [PERSON, "Absent Party"] })).toBe("⟦PARTY_1⟧ and ⟦PARTY_9⟧ and [PARTY]")
  })
  it("round-trips over many mixed texts: re-hydrating the pseudonymised text restores every value, a party name in the case supplied", () => {
    // A fixed-seed generator, so a failure repeats. Pieces never hold a bracket, so no input is a reserved token.
    let seed = 20261013
    const roll = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % n
    }
    const pieces = [PERSON, PERSON.toUpperCase(), INSTITUTION.toLowerCase(), CNIC, CNIC_PLAIN, PHONE, LAND, "Plot 99-T", "x@example.test", "99999", "-", " ", ", ", ". ", "v.", "the", "9", "0399"]
    const names = [INSTITUTION, PERSON, "Absent Party"]
    for (let i = 0; i < 300; i++) {
      // Odd rounds glue the pieces together; even rounds keep them apart, as prose does.
      const text = Array.from({ length: 1 + roll(12) }, () => pieces[roll(pieces.length)]).join(i % 2 === 0 ? " " : "")
      const r = pseudonymise(text, { partyNames: names, verbatim: ["Plot 99-T", LAND] })
      // Case aside (a party name comes back as supplied), nothing is lost, added or moved.
      expect(rehydrate(r.text, r.map).toLowerCase(), text).toBe(text.toLowerCase())
      // And no verbatim string or party name is left in what goes out (a pattern value can be: the patterns need word
      // boundaries, and these texts glue pieces together).
      for (const v of [PERSON, INSTITUTION, LAND, "Plot 99-T"]) expect(r.text.toLowerCase(), text).not.toContain(v.toLowerCase())
      // Echoed back, the tokens survive applyMap untouched. (Glued texts are left out: a pattern the mask could not see
      // for want of a word boundary can be seen once the name beside it is a token, and then becomes a lossy token, which is
      // the safe direction.)
      if (i % 2 === 0) expect(rehydrate(applyMap(r.text, r.map, { partyNames: names }), r.map), text).toBe(rehydrate(r.text, r.map))
    }
  })
  it("party names that overlap are replaced longest first and numbered in the order given, in the request and in the answer", () => {
    const names = ["Ali Raza", "Ali Raza Khan"]
    const r = pseudonymise("Ali Raza Khan and Ali Raza signed.", { partyNames: names })
    expect(r.text).toBe("⟦PARTY_2⟧ and ⟦PARTY_1⟧ signed.")
    expect(applyMap("ALI RAZA KHAN and ali raza agreed.", r.map, { partyNames: names })).toBe("⟦PARTY_2⟧ and ⟦PARTY_1⟧ agreed.")
    expect(rehydrate("⟦PARTY_2⟧ and ⟦PARTY_1⟧", r.map)).toBe("Ali Raza Khan and Ali Raza")
  })
  it("skips an empty verbatim string and a blank party name, trims a party name, and numbers the rest from 1", () => {
    const r = pseudonymise(`${LAND} ${PERSON}`, { verbatim: ["", LAND], partyNames: ["   ", `  ${PERSON}  `] })
    expect(r.text).toBe("⟦VERBATIM_1⟧ ⟦PARTY_1⟧")
    expect(r.map.map((p) => [p.token, p.kind, p.value])).toEqual([
      ["⟦VERBATIM_1⟧", "verbatim", LAND],
      ["⟦PARTY_1⟧", "party", PERSON],
    ])
  })
})
