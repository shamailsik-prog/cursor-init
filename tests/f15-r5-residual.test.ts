import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import { residualPII, type ResidualKind } from "@/platform/p1/residualPII"
import { FRESH_R4 } from "./f15-r5-fresh-corpus"
import { HELDOUT_CORPUS_R5 } from "./f15-r5-heldout-corpus"

/**
 * Audit F15, re-audit round 4 (FAIL 7/10): the residual detector. Spec rulings R5-2 (the English kinship walk skips
 * every lower-case word but a finite verb, and titles, ranks and offices like roles), R5-3 (residence cues) and R5-4
 * (pins for the surviving mutants U21, U24 and U25). The inputs are the re-auditor's (r4-attack, r4-walk2), with
 * further rows for each rule. Every name is invented; every number is synthetic.
 */

const ZERO = { id_digits: 0, labelled_identifier: 0, address: 0, kinship_name: 0 }
const minimised = (masked: string, names: string[] = []) => assertMinimised({ body: masked, metadata: { purpose: "committee-brain" } }, names)

function expectCounts(text: string, kind: ResidualKind): void {
  expect(residualPII(text)[kind]).toBeGreaterThan(0)
  expect(minimised(maskOutboundPII(text).masked)).toBe(false)
}

function expectClean(text: string): void {
  expect(residualPII(text)).toEqual(ZERO)
  const masked = maskOutboundPII(text).masked
  expect(masked).toBe(text)
  expect(minimised(masked)).toBe(true)
}

describe("R5-2: after a kinship cue the walk skips lower-case words, titles, ranks and offices", () => {
  it.each([
    // the re-auditor's leaks (r4-walk2, r4-attack)
    ["the then SHO", "Tariq, son of the then SHO Kamran Qalvo, was transferred."],
    ["a sitting MNA", "Tariq, son of a sitting MNA Kamran Qalvo, was arrested."],
    ["a serving Major", "Nura, wife of a serving Major Kamran Qalvo, applied for custody."],
    ["a leading businessman", "The petitioner, son of a leading businessman Kamran Qalvo, seeks bail."],
    ["a practising lawyer", "Haris, son of a practising lawyer Kamran Qalvo, appeared."],
    ["the outgoing Chairman", "Nura, wife of the outgoing Chairman Kamran Qalvo, was summoned."],
    ["a recently retired Judge", "Tariq, son of a recently retired Judge Kamran Qalvo, applied."],
    ["a highly placed officer", "Tariq, son of a highly placed officer Kamran Qalvo, applied."],
    ["none other than", "The accused is the son of none other than Kamran Qalvo."],
    ["the then Deputy Commissioner", "Nura, daughter of the then Deputy Commissioner Kamran Qalvo, applied."],
    // further rows
    ["a Lambardar", "Tariq, son of the Lambardar Kamran Qalvo, objected."],
    ["an MPA", "Nura, widow of an MPA Kamran Qalvo, applied."],
    ["an office, then a lower-case name", "Tariq, son of the then SHO kamran qalvo, was transferred."],
    ["a preposition between the cue and the name", "Tariq, son of one of the partners Kamran Qalvo, objected."],
    ["a participle and an adverb", "Tariq, son of a widely respected Kamran Qalvo, applied."],
    ["eight words to the name", "Tariq, son of a much loved and highly respected local Kamran Qalvo, applied."],
  ])("counts: %s", (_label, text) => expectCounts(text, "kinship_name"))

  it.each([
    // R5-2 accepts these false positives (R4-0): a capitalised word that is not listed is a name.
    ["a court named after a city (recorded false positive)", "The petitioner is the son of a Lahore High Court judge."],
  ])("counts, accepted under R4-0: %s", (_label, text) => expectCounts(text, "kinship_name"))

  it.each([
    ["an office and a verb", "The son of the then SHO was transferred to another district."],
    ["a sentence end after an occupation", "He is the son of a farmer. The Court then adjourned."],
    ["the son of the soil", "The appellant, a son of the soil, served the nation."],
    ["a sentence end after a role", "The witness is the son of the deceased. Kamran Qalvo is the investigating officer."],
    ["a role, a preposition and a lower-case noun", "The son of the accused in custody was produced before the Court."],
    ["an organisation, then an occupation", "She is the daughter of a Federal Government employee."],
    ["a participle after a role, then an auxiliary", "The widow of the deceased constable is entitled to the pension."],
    ["the window ends before a capitalised word", "The son of the deceased and his two young minor sons and the Investigating Officer appeared."],
    // pins (mutants M13 and M14): an office is skipped like a role; a participle after a role is no name
    ["an office alone", "The petitioner is the son of a former MNA."],
    ["an office and a place word", "He is the son of a Lambardar of the village."],
    ["a participle after a role", "The son of the deceased constable serving in the Police was examined."],
  ])("passes: %s", (_label, text) => expectClean(text))
})

describe("R5-3: residence cues", () => {
  it.each([
    // English (r4-attack, r4-walk2)
    ["hails from", "The accused hails from Kot Qalvo, Tehsil Kasur."],
    ["originally from", "The accused, originally from Kot Qalvo, was arrested."],
    ["belong to", "Both accused belong to Kot Qalvo near Kasur."],
    ["belongs to a village", "The complainant belongs to village Qalvo Pura."],
    ["permanently settled at", "He is permanently settled at Qalvo Town, Lahore."],
    ["settled in", "The family settled in Qalvo Pura after the floods."],
    ["residence at", "The raid was conducted at his residence at Kot Qalvo."],
    ["residence in", "His residence in Qalvo Town was searched."],
    ["address of a role and a colon", "Address of accused: 12-B Qalvo Road, Lahore"],
    ["address of the petitioner and a colon", "Address of the petitioner: Qalvo Pura, Kasur"],
    ["C/o and a name", "Notice be sent C/o Kamran Qalvo, Lahore."],
    ["lives, eight words, at", "He lives with his widowed mother and two sisters at 12-B Qalvo Road."],
    ["lives, nine words, at", "He lives with his old parents in a rented house at 12-B Qalvo Road, Lahore."],
    // Urdu
    ["رہائش پذیر after a place and میں", "مدعی قلوو ٹاؤن میں رہائش پذیر ہے۔"],
    ["مقیم after a place and میں", "ملزم لاہور کے قلوو ٹاؤن میں مقیم ہے۔"],
    ["سکونت پذیر after بمقام and a place", "مدعی بمقام قلوو پورہ سکونت پذیر ہے۔"],
    ["مقیم before a place", "ملزم مقیم قلوو پورہ ضلع قصور ہے۔"],
    ["رہائش پذیر before بمقام and a place", "ملزم رہائش پذیر بمقام قلوو پورہ ہے۔"],
    ["رہائش پزیر, the other spelling", "مدعی قلوو پورہ میں رہائش پزیر ہے۔"],
  ])("counts: %s", (_label, text) => expectCounts(text, "address"))

  it("counts: C/o a masked name, then an address", () => {
    const names = ["Tariq Zarvani"]
    const masked = maskOutboundPII("Notice be sent C/o Tariq Zarvani, 12-B Qalvo Road, Lahore.", { partyNames: names }).masked
    expect(masked).toBe("Notice be sent C/o [PARTY], 12-B Qalvo Road, Lahore.")
    expect(residualPII(masked).address).toBeGreaterThan(0)
    expect(minimised(masked, names)).toBe(false)
  })

  it("counts: s/o in a table cell (| is a word separator)", () => {
    expectCounts("| Tariq | s/o | Kamran Qalvo |", "kinship_name")
  })

  it.each([
    ["hails from a background", "The appellant hails from a humble background."],
    ["belongs to the same khewat", "The land belongs to the same khewat."],
    ["belongs to a respondent", "The disputed land belongs to Respondent No. 1."],
    ["originally from the area", "The deceased was originally from the area."],
    ["settled in a year", "The dispute was settled in 2019 by a compromise."],
    ["settled at a sum", "The claim was settled at a sum agreed by the parties."],
    ["residence in the country", "His residence in Pakistan is not disputed."],
    ["the address of a role, no colon", "The address of the respondent was given in the plaint."],
    ["c/o and a lower-case word", "Copies were sent c/o the office of the counsel."],
    ["Urdu مقیم after a role", "ملزم عارضی طور پر یہاں مقیم ہے۔"],
    ["Urdu مقیم in one's own village", "گواہ اپنے گاؤں میں مقیم ہے۔"],
    // after the R5-5 measurement: a postposition of company before مقیم names a person, not a place (new corpus line 67)
    ["Urdu مقیم with a relative", "ملزم اپنے بھائی کے ساتھ مقیم ہے۔"],
  ])("passes: %s", (_label, text) => expectClean(text))
})

describe("R5-4: pins for the re-auditor's surviving mutants", () => {
  it("U21: a lower-case place-name noun after a province counts", () => {
    expectCounts("Tariq r/o punjab colony was arrested.", "address")
  })

  it.each([
    ["U24: Urdu اسی گاؤں کا رہنے والا", "گواہ اسی گاؤں کا رہنے والا ہے۔"],
    ["U24: Urdu اسی شہر کا رہنے والا", "وہ بھی اسی شہر کا رہنے والا ہے۔"],
  ])("passes: %s", (_label, text) => expectClean(text))

  it("U25: lives, with the preposition the tenth word after it, counts", () => {
    expectCounts("He lives with his widowed mother and his two unmarried sisters at 12-B Qalvo Road.", "address")
  })

  it("U25: lives, with the preposition the eleventh word after it, is past the window", () => {
    expectClean("He lives with his widowed mother and his two young unmarried sisters at 12-B Qalvo Road.")
  })
})

// R5-5: added only after the measurement at 86c42a2 (the new corpus: 2 of 92 flagged, Urdu lines 67 and 74; the
// re-auditor's round-4 corpus: 3 of 128, its "debatable" lines 125, 126 and 128), so the rates reported in the spec are
// held-out rates. Line 67 of the new corpus is fixed (a postposition before مقیم: "والدین کے ہمراہ مقیم"); the other four
// count by ruling, each named below.
const RULED_R5_NEW: ReadonlyMap<number, [ResidualKind, string]> = new Map([
  [74, ["address", "R5-3: a named city before سکونت پذیر is a place"]],
])
const RULED_R5_FRESH: ReadonlyMap<number, [ResidualKind, string]> = new Map([
  [125, ["address", "R3-5: Mauza and a name is a locality (flagged at 810fa74 too)"]],
  [126, ["address", "R5-3: belongs to and a named Tehsil"]],
  [128, ["address", "R3-5: موضع and a name is a locality (flagged at 810fa74 too)"]],
  // R6-1: a district and its name before کا رہائشی counts, as "r/o District Kasur" does (R4-3); the line was debatable
  [127, ["address", "R6-1: ضلع and a name before کا رہائشی is a place"]],
])

describe("R5-5: the held-out lines (regression rows, added after the measurement)", () => {
  it("has the 92 lines of the new corpus and the re-auditor's 128 lines", () => {
    expect(HELDOUT_CORPUS_R5).toHaveLength(92)
    expect(FRESH_R4).toHaveLength(128)
  })

  it.each([...RULED_R5_NEW].map(([line, [kind, reason]]) => [line, kind, reason]))("new corpus line %i counts %s (%s)", (line, kind) => {
    const text = HELDOUT_CORPUS_R5[(line as number) - 1]![1]
    expect(residualPII(maskOutboundPII(text).masked)[kind as ResidualKind]).toBeGreaterThan(0)
  })

  it.each([...RULED_R5_FRESH].map(([line, [kind, reason]]) => [line, kind, reason]))("fresh line %i counts %s (%s)", (line, kind) => {
    const text = FRESH_R4.find(([n]) => n === line)![2]
    expect(residualPII(maskOutboundPII(text).masked)[kind as ResidualKind]).toBeGreaterThan(0)
  })

  it.each([
    ...HELDOUT_CORPUS_R5.filter((_row, i) => !RULED_R5_NEW.has(i + 1)).map(([genre, text]) => [`new corpus line ${HELDOUT_CORPUS_R5.findIndex(([, t]) => t === text) + 1}`, genre, text]),
    ...FRESH_R4.filter(([line]) => !RULED_R5_FRESH.has(line)).map(([line, lang, text]) => [`fresh line ${line}`, lang, text]),
  ])("%s [%s] %s", (_line, _lang, text) => expectClean(text))
})
