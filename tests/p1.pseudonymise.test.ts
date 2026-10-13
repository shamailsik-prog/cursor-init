import { describe, expect, it } from "vitest"
import {
  CNIC_PLAIN as CNIC_PLAIN_RE,
  CNIC_SEPARATED,
  EMAIL,
  LOSSY_TOKENS,
  MASK_PATTERNS,
  NTN,
  PASSPORT,
  PK_IBAN,
  PK_MOBILE,
  PK_MOBILE_PAREN,
  maskOutboundPII,
} from "@/platform/p1/maskOutboundPII"
import { INDEXED_TOKEN, applyMap, assertPseudonymised, pseudonymise, rehydrate } from "@/platform/p1/pseudonymiseOutboundPII"

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
    // Pieces in the case the names were supplied in, among them words that merely contain a name (maintainable holds
    // nab, the statement holds the state), which must come back untouched.
    const exact = [PERSON, INSTITUTION, "NAB", "NAB's", "(NAB)", "The State", "maintainable", "unreasonable", "the statement", CNIC, CNIC_PLAIN, PHONE, LAND, "Plot 99-T", "x@example.test", "99999", "-", " ", ", ", ". ", "v.", "the", "9", "0399"]
    // And the same with a name in another case, which a party name always brings back as supplied.
    const cased = [...exact, PERSON.toUpperCase(), INSTITUTION.toLowerCase(), "nab", "THE STATE"]
    const names = [INSTITUTION, PERSON, "Absent Party", "NAB", "The State"]
    const wholeWord = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "iu")
    for (let i = 0; i < 400; i++) {
      // Odd rounds glue the pieces together; even rounds keep them apart, as prose does. Rounds 2 and 3 of every four use
      // the pieces with a name in another case.
      const glued = i % 2 === 1
      const anyCase = i % 4 >= 2
      const pool = anyCase ? cased : exact
      const text = Array.from({ length: 1 + roll(12) }, () => pool[roll(pool.length)]).join(glued ? "" : " ")
      const r = pseudonymise(text, { partyNames: names, verbatim: ["Plot 99-T", LAND] })
      // Nothing is lost, added or moved: the same text back, case-exact wherever no name was written in another case.
      const back = rehydrate(r.text, r.map)
      if (anyCase) expect(back.toLowerCase(), text).toBe(text.toLowerCase())
      else expect(back, text).toBe(text)
      // No verbatim string is left in what goes out; nor is a party name that stands as a whole word (a pattern value can
      // be left, and a name can be part of a longer word: these texts glue pieces together).
      for (const v of ["Plot 99-T", LAND]) expect(r.text.toLowerCase(), text).not.toContain(v.toLowerCase())
      if (!glued) for (const n of names.slice(0, 2).concat(names.slice(3))) expect(wholeWord(n).test(r.text), text).toBe(false)
      // Echoed back, the tokens survive applyMap untouched. (Glued texts are left out: a pattern the mask could not see
      // for want of a word boundary can be seen once the name beside it is a token, and then becomes a lossy token, which is
      // the safe direction.)
      if (!glued) expect(rehydrate(applyMap(r.text, r.map, { partyNames: names }), r.map), text).toBe(back)
    }
  })
  it("a party name inside another word is left alone: NAB in maintainable and The State in the statement round-trip case-exact", () => {
    const names = ["NAB", "The State"]
    const text = "NAB held the appeal not maintainable and unreasonable; The State disputes the statement."
    const r = pseudonymise(text, { partyNames: names })
    expect(r.text).toBe("⟦PARTY_1⟧ held the appeal not maintainable and unreasonable; ⟦PARTY_2⟧ disputes the statement.")
    expect(rehydrate(r.text, r.map)).toBe(text)
    // The model's answer is read the same way: a name in any case at a word edge is a token, inside a word it is not.
    const answer = applyMap("It is maintainable. nab and THE STATE, unreasonable, the statement.", r.map, { partyNames: names })
    expect(answer).toBe("It is maintainable. ⟦PARTY_1⟧ and ⟦PARTY_2⟧, unreasonable, the statement.")
    expect(rehydrate(answer, r.map)).toBe("It is maintainable. NAB and The State, unreasonable, the statement.")
    // And a supplied name the map does not hold is read that way too.
    expect(applyMap("NAB is maintainable", [], { partyNames: ["NAB"] })).toBe("[PARTY] is maintainable")
  })
  it("a party name at word edges is still replaced, next to punctuation and possessives (NAB's, (NAB), NAB.)", () => {
    const r = pseudonymise("NAB's case; (NAB); NAB. Then NAB, NAB: \"NAB\" and NAB-led.", { partyNames: ["NAB"] })
    expect(r.text).toBe("⟦PARTY_1⟧'s case; (⟦PARTY_1⟧); ⟦PARTY_1⟧. Then ⟦PARTY_1⟧, ⟦PARTY_1⟧: \"⟦PARTY_1⟧\" and ⟦PARTY_1⟧-led.")
    expect(r.redactionCounts.party).toBe(7)
    expect(applyMap("nab's, (Nab) and NAB.", r.map, { partyNames: ["NAB"] })).toBe("⟦PARTY_1⟧'s, (⟦PARTY_1⟧) and ⟦PARTY_1⟧.")
    expect(rehydrate(r.text, r.map)).toBe("NAB's case; (NAB); NAB. Then NAB, NAB: \"NAB\" and NAB-led.")
  })
  it("a letter, digit or underscore beside a party name keeps it part of that word, in any script", () => {
    expect(pseudonymise("Ali and Alié and Ali2 and Ali_b and 2Ali and Ali.", { partyNames: ["Ali"] }).text).toBe("⟦PARTY_1⟧ and Alié and Ali2 and Ali_b and 2Ali and ⟦PARTY_1⟧.")
    // Urdu: a name followed by a letter is part of a longer word; followed by the Arabic comma it stands alone.
    expect(pseudonymise("علیہ اور علی، اور علی", { partyNames: ["علی"] }).text).toBe("علیہ اور ⟦PARTY_1⟧، اور ⟦PARTY_1⟧")
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
  it("assertPseudonymised passes a tokenised body whose words merely contain a party name or spell a token word, and fails on a leftover pattern value or a whole-word party name", () => {
    const names = ["Tim", "Nic", "Party", "Phone", "NAB", "The State"]
    // Tokens are blanked first, so Tim in VERBATIM, Nic in CNIC and Party in PARTY are not found; words that contain a name are not either.
    expect(assertPseudonymised("⟦PARTY_1⟧ v. ⟦PARTY_2⟧ owns ⟦VERBATIM_1⟧, ⟦CNIC_1⟧, ⟦PHONE_1⟧, ⟦EMAIL_1⟧; Timothy found it maintainable, in the statement.", names)).toBe(true)
    expect(assertPseudonymised("Nothing to find here.", undefined)).toBe(true)
    expect(assertPseudonymised("", names)).toBe(true)
    // A pattern value left in the body fails it, whatever the kind, and whatever sits beside a token.
    for (const left of [CNIC, CNIC_PLAIN, PHONE, "(0399) 9999999", "x@example.test", "PK36SCBL0000001123456702", "NTN 1234567-8", "passport AB1234567"]) {
      expect(assertPseudonymised(`⟦PARTY_1⟧ ${left} ⟦VERBATIM_1⟧`, names), left).toBe(false)
      expect(assertPseudonymised(`⟦PARTY_1⟧${left}⟦VERBATIM_1⟧`, names), left).toBe(false)
    }
    // A party name standing as a whole word fails it, in any case.
    for (const left of ["NAB", "nab's appeal", "(The State)", "Tim.", "a party", "the PHONE"]) expect(assertPseudonymised(`⟦CNIC_1⟧ ${left}`, names), left).toBe(false)
    // The words a token is built from are only found outside a token, and a name that spells a whole token goes with it.
    expect(assertPseudonymised("⟦PARTY_1⟧", ["Party"])).toBe(true)
    expect(assertPseudonymised("⟦PARTY_1⟧ and ⟦CNIC_1⟧", ["PARTY_1", "CNIC_1"])).toBe(true)
    expect(assertPseudonymised("[PARTY]", ["Party"])).toBe(false)
  })
  it("the shared regexes are safe after a stray test(): INDEXED_TOKEN.lastIndex set to 5 before applyMap and pseudonymise changes nothing", () => {
    const text = `${CNIC} ${PERSON} ${PHONE} x@example.test`
    const answer = `⟦PARTY_1⟧ holds ⟦CNIC_1⟧ and ${CNIC_PLAIN}; ⟦PHONE_1⟧`
    const opts = { partyNames: [PERSON], verbatim: [] }
    const first = pseudonymise(text, opts)
    const applied = applyMap(answer, first.map, { partyNames: [PERSON] })
    const restored = rehydrate(answer, first.map)
    // A name that spells a token is the one thing that would rewrite a token the module failed to see.
    const spelled = ["PARTY_1", PERSON]
    const spelledMap = pseudonymise("x", { partyNames: spelled }).map
    const spelledAnswer = "⟦PARTY_1⟧ and ⟦PARTY_2⟧ and PARTY_1"
    const spelledApplied = applyMap(spelledAnswer, spelledMap, { partyNames: spelled })
    const spelledIn = pseudonymise("⟦PARTY_1⟧ and PARTY_1", { partyNames: ["PARTY_1"] }).text
    expect([spelledApplied, spelledIn]).toEqual(["⟦PARTY_1⟧ and ⟦PARTY_2⟧ and ⟦PARTY_1⟧", "⟦PARTY_1⟧ and ⟦PARTY_1⟧"])
    try {
      // What a stray `.test()` or `.exec()` by a consumer leaves behind.
      INDEXED_TOKEN.lastIndex = 5
      for (const { re } of MASK_PATTERNS) re.lastIndex = 5
      expect(applyMap(spelledAnswer, spelledMap, { partyNames: spelled })).toBe(spelledApplied)
      expect(pseudonymise("⟦PARTY_1⟧ and PARTY_1", { partyNames: ["PARTY_1"] }).text).toBe(spelledIn)
      expect(pseudonymise(text, opts)).toEqual(first)
      expect(applyMap(answer, first.map, { partyNames: [PERSON] })).toBe(applied)
      expect(rehydrate(answer, first.map)).toBe(restored)
      expect(assertPseudonymised(`⟦PARTY_1⟧ ${PHONE}`, [PERSON])).toBe(false)
      expect(assertPseudonymised("⟦PARTY_1⟧ ⟦CNIC_1⟧ fine", [PERSON])).toBe(true)
      // The module reads copies, so it does not move the shared regex either.
      expect(INDEXED_TOKEN.lastIndex).toBe(5)
    } finally {
      INDEXED_TOKEN.lastIndex = 0
      for (const { re } of MASK_PATTERNS) re.lastIndex = 0
    }
    expect([applied, restored]).toEqual(["⟦PARTY_1⟧ holds ⟦CNIC_1⟧ and [CNIC]; ⟦PHONE_1⟧", `${PERSON} holds ${CNIC} and ${CNIC_PLAIN}; ${PHONE}`])
  })
  it("MASK_PATTERNS holds the exported regexes in the mask's order, not only its kinds", () => {
    expect(MASK_PATTERNS.map((p) => p.re)).toEqual([CNIC_SEPARATED, CNIC_PLAIN_RE, PK_MOBILE_PAREN, PK_MOBILE, EMAIL, PK_IBAN, NTN, PASSPORT])
    expect(MASK_PATTERNS.map((p) => p.re)).not.toEqual([CNIC_SEPARATED, CNIC_PLAIN_RE, PK_MOBILE, PK_MOBILE_PAREN, EMAIL, PK_IBAN, NTN, PASSPORT])
  })
})
