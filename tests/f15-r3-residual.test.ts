import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import { residualPII, type ResidualKind } from "@/platform/p1/residualPII"
import { FRESH_HELDOUT, FRESH_TUNING } from "./f15-r3-fresh-corpus"
import { HELDOUT_CORPUS_R3 } from "./f15-r3-heldout-corpus"

/**
 * Audit F15, re-audit round 2 (FAIL 7/10): the residual detector. Spec rulings R3-2 (the date pin), R3-3 (a label's
 * whole value), R3-4 (kinship and role parsing), R3-5 (cues and residence) and R3-7 (exemption limits). The inputs are
 * the re-auditor's (r2-smuggle, r2-misc, r2-e2e-attack) and the even-numbered lines of the fresh false-positive corpus
 * (R3-6: the odd-numbered lines are held out). Every name is invented; every number is synthetic.
 *
 * The "counts" rows call the detector on the raw text, so they test it independently of the mask; a row the mask now
 * catches is also in tests/f15-r3-mask.test.ts.
 */

const ZERO = { id_digits: 0, labelled_identifier: 0, address: 0, kinship_name: 0 }
const minimised = (masked: string) => assertMinimised({ body: masked, metadata: { purpose: "committee-brain" } }, [])

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

describe("R3-2: the date rule is pinned (mutant N41), and a date no longer hides what follows it", () => {
  it.each([
    ["a date and a time", "The hearing on 01.02.2021 10.30 a.m. was adjourned."],
    ["a date and a case number with its year", "dated 01.02.2021 1234/2021"],
    ["a date range", "The period 01.02.2021 - 15.03.2021 is in issue."],
  ])("passes: %s", (_label, text) => expectClean(text))

  it("a mobile after a date still counts", () => {
    expect(residualPII("dated 01.02.2021 0300 1234567")).toEqual({ ...ZERO, id_digits: 1 })
  })
})

describe("R3-3: a label's minimum reads its whole value, every digit group up to the next letter", () => {
  it.each([
    ["Mobile, space slash space", "Mobile: 0300 / 1234567"],
    ["Cell No., four spaces", "Cell No. 0300    1234567"],
    ["Phone, spaced groups", "Phone: 0300  123  45  67"],
    ["CNIC No., slashes with spaces", "CNIC No. 35202 / 1234567 / 1"],
    ["NTN, a long gap", "NTN:     1234567 - 8"],
  ])("counts: %s", (_label, text) => {
    expect(residualPII(text)).toMatchObject({ labelled_identifier: 1 })
  })

  it.each([
    ["a jail cell", "He was kept in cell No. 105 of the district jail."],
    ["a phone value of six digits", "Phone No. 123456 was not traced."],
    ["a phone label and a short code", "Mobile: 0300 is the network code."],
    ["a CNIC label and four digits", "CNIC No. 1234 is incomplete."],
  ])("passes: %s", (_label, text) => expectClean(text))
})

describe("R3-4: kinship cues, determiners and party roles", () => {
  it.each([
    ["s/o one", "Tariq s/o one Kamran was arrested."],
    ["son of one", "Tariq, son of one Kamran, was arrested."],
    ["son of the said", "Tariq, son of the said Kamran, was arrested."],
    ["son of said", "Tariq son of said Kamran was arrested."],
    ["son of a role and number, then a name", "Tariq, son of Respondent No. 2 Kamran Qalvo, appeared."],
    ["wife of a role, then a lower-case name", "Nura wife of accused kamran deposed."],
    ["son of deceased, lower-case name", "the son of deceased kamran deposed"],
    ["son of his father, then a name", "Tariq, son of his father Kamran Qalvo, deposed."],
    ["widow of a rank, then a name", "The widow of Shaheed Constable Kamran was paid compensation."],
    ["Urdu: wife of the accused, then a name", "مسماۃ نورا زوجہ ملزم کامران نے بیان دیا۔"],
    ["Urdu: daughter of the plaintiff, then a name", "نورا دختر مدعی کامران"],
    ["Urdu: son of the deceased, then a name", "حارث ولد متوفی کامران"],
    ["Urdu: the idiom, then a name", "نورا بنت حوا کامران"],
    ["Urdu: wife, the honorific, then a name", "کامران کی زوجہ محترمہ نورا نے بیان دیا۔"],
    ["Urdu: parentage label", "ولدیت: کامران"],
    ["Urdu: parentage label, no colon", "ولدیت کامران قلوو"],
    ["father's name label", "Father's name: Kamran Qalvo"],
    ["father name label, lower case", "father name kamran qalvo"],
    ["husband's name label", "Husband's name: Kamran Qalvo"],
    ["parentage label", "Parentage: Kamran Qalvo"],
    ["S/o with a colon", "S/o: Kamran Qalvo"],
  ])("counts: %s", (_label, text) => expectCounts(text, "kinship_name"))

  it.each([
    ["son of a Government servant", "The petitioner is the son of a Government servant."],
    ["daughter of a Member", "She is the daughter of a Member of the Provincial Assembly."],
    ["daughter of a Sessions Judge", "The daughter of a Sessions Judge cannot be treated differently."],
    ["son of an Army officer", "He is the son of an Army officer."],
    ["son of the deceased and a verb", "The son of the deceased appeared and deposed."],
    ["son of one of the accused", "He is the son of one of the accused."],
    ["son of the said deceased", "The son of the said deceased was cited as a witness."],
    ["a role's number at a sentence end", "The petitioner is the son of Respondent No. 2. Draft the grounds."],
    ["Urdu: daughter, then legal heir", "مرحوم کی دختر قانونی وارث ہے۔"],
    ["Urdu: wife, then the honorific alone", "زوجہ محترمہ نے بیان دیا۔"],
    ["Urdu: the idiom alone", "مدعیہ بنت حوا کی طرح مظلوم ہے۔"],
    ["Urdu: resident, then to be", "وہ وہاں ساکن ہونا ثابت نہ کر سکا۔"],
    ["Urdu: parentage label before a postposition", "ولدیت کے خانے میں کچھ درج نہیں۔"],
    ["father's name before a verb", "Father's name is not mentioned in the FIR."],
  ])("passes: %s", (_label, text) => expectClean(text))
})

describe("R3-5: residence cues, address labels and numbered places", () => {
  it.each([
    ["plural, village and a name", "Tariq and Haris, residents of village Kot Qalvo, were arrested."],
    ["plural, chak and a number", "the plaintiffs, both residents of Chak No. 45/GB, Tehsil Jaranwala"],
    ["Urdu plural saakinaan", "کامران اور حارث ساکنان موضع قلوو"],
    ["Urdu plural saknaey", "کامران و حارث سکنائے موضع قلوو کی ضمانت"],
    ["Urdu resident, a role noun, then a place", "ساکن مدعی گاؤں قلوو"],
    ["r/o the house of a name", "Tariq r/o the house of Kamran Qalvo, Lahore"],
    ["r/o in a place", "Tariq r/o in Lahore"],
    ["address mid-sentence with a colon", "The accused gave his address: 12-B Qalvo Road, Lahore."],
    ["address as", "He gave his address as 12-B Qalvo Road, Lahore."],
    ["lives at", "He lives at 12-B Qalvo Road, Model Town, Lahore."],
    ["House No. 12 M Block", "House No. 12 M Block, Model Town, Lahore"],
    ["House No. 12 ft", "House No. 12 ft wide lane, Qalvo Town"],
    ["House 12 near", "House 12 near the mosque, Qalvo Town"],
    ["Street 5 of a proper place", "Street 5 of Qalvo Town"],
    ["Plot without No.", "Plot 45, Sector G-9/1, Islamabad"],
    ["Flat No. 4 floor 3", "Flat No. 4 floor 3, Qalvo Heights, Clifton"],
    ["resident of Pakistan and of a city", "a resident of Pakistan and of Lahore"],
    ["residence label", "Residence: 14-B, Qalvo Town, Lahore"],
    ["abode after a qualifier", "permanent abode 14-B Qalvo Town Lahore"],
    ["Urdu mohalla and a name", "محلہ قلوو پورہ لاہور"],
    ["an address label at a field start, a place only", "Address: Qalvo, Kasur"],
    ["a numbered house in a named town", "The complainant shifted to House No. 5 in Qalvo Town."],
    ["a numbered house at a sentence end", "He lives in House No. 7."],
  ])("counts: %s", (_label, text) => expectCounts(text, "address"))

  it.each([
    ["plural, a territory", "Are residents of Islamabad Capital Territory governed by the ICT Rent Restriction Ordinance?"],
    ["plural, the village and a verb", "Residents of the village protested against the decision."],
    ["Urdu plural, a general area", "ساکنان علاقہ نے احتجاج کیا۔"],
    ["Urdu residential scheme", "رہائشی اسکیم کی منظوری دی گئی۔"],
    ["Urdu residential colony", "رہائشی کالونی کی سڑکیں خراب ہیں۔"],
    ["Urdu residential project", "رہائشی منصوبہ مکمل نہ ہو سکا۔"],
    ["Urdu residential society", "رہائشی سوسائٹی کا نقشہ منظور ہوا۔"],
    ["Urdu residential plot", "رہائشی پلاٹ کمرشل استعمال میں ہے۔"],
    ["Urdu residential house", "رہائشی مکان کرایہ پر دیا گیا۔"],
    ["address: same as above", "Address: same as above."],
    ["address: N/A", "Present address: N/A"],
    ["address as stated", "His address as stated in the plaint is incorrect."],
    ["address is not known", "His address is not known to the prosecution."],
    ["address used as a verb", "Counsel will address: the jurisdiction point first."],
    ["lives in an abstract noun", "He lives in fear of the accused."],
    ["resides at a distance", "The witness resides at a distance from the spot."],
    ["a range of flats", "Flats No. 4 to 9 of the project were never completed."],
    ["House of the Senate", "The House 2 of the Senate committee met."],
    ["a province", "The petitioner is a permanent resident of Sindh."],
    ["the said house for years", "The tenant was a resident of the said house for twenty years."],
  ])("passes: %s", (_label, text) => expectClean(text))
})

describe("R3-7: no exemption for 13 digits or a mobile without its prefix", () => {
  it.each([
    ["a mobile without prefix after fine", "the fine 3001234567 was paid by him"],
    ["a mobile without prefix after Rs", "paid Rs. 3001234567 from his phone"],
    ["a mobile without prefix before /-", "his number 3001234567/- is off"],
    ["a mobile without prefix after FIR No.", "FIR No. 3001234567 lodged"],
    ["a CNIC 4-4-4-1 after amount", "the amount 3520 2123 4567 1 was noted"],
    ["a CNIC 4-4-4-1 after Rs", "Rs. 3520 2123 4567 1"],
    ["a CNIC 4-4-4-1 before /-", "3520 2123 4567 1/-"],
    ["a CNIC 4-4-4-1 after Diary No.", "Diary No. 3520 2123 4567 1"],
    ["a CNIC 4-4-4-1 after khasra", "khasra 3520 2123 4567 1"],
    ["a CNIC 4-4-4-1 after case No.", "case No. 3520-2123-4567-1"],
    ["a form-box CNIC", "CNIC 3 5 2 0 2 - 1 2 3 4 5 6 7 - 1"],
    ["a 16-digit card after sum of", "the sum of 1234 5678 9012 3456 was charged to his card"],
    ["a 14-digit account after valued at", "account valued at 12345678901234 belongs to Kamran"],
    ["a 14-digit account before a parenthetical and rupees", "account 12345678901234 (held by Kamran) rupees"],
  ])("counts on the raw text: %s", (_label, text) => {
    expect(residualPII(text).id_digits).toBeGreaterThan(0)
  })

  it.each([
    ["a section list starting 3", "The FIR was registered under sections 302/324/337/148/149 PPC."],
    ["an amount of ten digits", "An amount of Rs. 2500000000 was claimed."],
    ["an amount with /=", "The property was valued at 12500000000/= by the valuer."],
    ["a reference number with its No.", "Reference No. 123456789012 of 2019 was decided."],
  ])("passes: %s", (_label, text) => expectClean(text))
})

describe("R3-6: the even-numbered lines of the re-auditor's fresh false-positive corpus pass", () => {
  it("has the 60 tuning lines", () => {
    expect(FRESH_TUNING).toHaveLength(60)
    expect(FRESH_TUNING.every(([line]) => line % 2 === 0)).toBe(true)
  })

  it.each(FRESH_TUNING.map(([line, lang, text]) => [line, lang, text]))("line %i [%s] %s", (_line, _lang, text) => {
    const masked = maskOutboundPII(text).masked
    expect(masked).toBe(text)
    expect(residualPII(masked)).toEqual(ZERO)
    expect(minimised(masked)).toBe(true)
  })
})

// R3-6: added only after the measurement (at 76902de: fresh odd 2 of 60, lines 37 and 69; the new held-out corpus 1 of
// 134, line 121), so the rates reported in the spec are held-out rates. Every line must pass from here on, except the
// lines a later ruling makes true positives (each with its ruling).
/** Ruling R4-3: an explicit "House No." with a number always counts, so fresh line 69 is a true positive. */
const RULED_TRUE_POSITIVE_R4: ReadonlyMap<number, "address"> = new Map([[69, "address"]])

describe("R3-6: the held-out lines pass (regression rows, added after the measurement)", () => {
  it("has the 60 held-out fresh lines and the 134 lines of the new corpus", () => {
    expect(FRESH_HELDOUT).toHaveLength(60)
    expect(FRESH_HELDOUT.every(([line]) => line % 2 === 1)).toBe(true)
    expect(HELDOUT_CORPUS_R3).toHaveLength(134)
  })

  it.each([...RULED_TRUE_POSITIVE_R4])("fresh line %i is a true positive by ruling R4-3 (%s)", (line, kind) => {
    const text = FRESH_HELDOUT.find(([n]) => n === line)![2]
    expect(residualPII(maskOutboundPII(text).masked)).toEqual({ ...ZERO, [kind]: 1 })
  })

  it.each([
    ...FRESH_HELDOUT.filter(([line]) => !RULED_TRUE_POSITIVE_R4.has(line)).map(([line, lang, text]) => [`fresh line ${line}`, lang, text]),
    ...HELDOUT_CORPUS_R3.map(([category, text], i) => [`new corpus line ${i + 1}`, category, text]),
  ])("%s [%s] %s", (_line, _lang, text) => {
    const masked = maskOutboundPII(text).masked
    expect(masked).toBe(text)
    expect(residualPII(masked)).toEqual(ZERO)
    expect(minimised(masked)).toBe(true)
  })
})
