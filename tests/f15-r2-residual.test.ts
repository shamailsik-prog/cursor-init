import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import { residualPII } from "@/platform/p1/residualPII"
import { AUDITOR_FP_CORPUS, RULED_TRUE_POSITIVE } from "./f15-r2-corpus"

/**
 * Audit F15, re-audit round 1 (FAIL 6/10): the residual detector's false positives (MEDIUM-3) and the false negatives
 * the re-auditor found. Spec rulings R2-3 (false positives) and R2-4 (formats). Every name is invented; every number is
 * synthetic.
 */

const ZERO = { id_digits: 0, labelled_identifier: 0, address: 0, kinship_name: 0 }
const minimised = (masked: string) => assertMinimised({ body: masked, metadata: { purpose: "committee-brain" } }, [])

describe("R2-3: the re-auditor's false-positive corpus passes (126 lines)", () => {
  const clean = AUDITOR_FP_CORPUS.filter(([, text]) => !RULED_TRUE_POSITIVE.has(text))

  it("has 126 lines, 2 of them ruled true positives", () => {
    expect(AUDITOR_FP_CORPUS).toHaveLength(126)
    expect(clean).toHaveLength(124)
  })

  it.each(clean)("[%s] %s", (_category, text) => {
    const masked = maskOutboundPII(text).masked
    expect(residualPII(masked)).toEqual(ZERO)
    expect(minimised(masked)).toBe(true)
  })

  it.each([...RULED_TRUE_POSITIVE])("ruled a true positive: %s", (text, kind) => {
    expect(residualPII(maskOutboundPII(text).masked)).toEqual({ ...ZERO, [kind]: 1 })
  })
})

describe("R2-3: the rulings, row by row", () => {
  it.each([
    // Urdu cues before a function word, a role noun, an adjectival collocation or an idiom do not count.
    ["an Urdu cue before a postposition", "اس کی زوجہ نے عدالت میں بیان دیا۔"],
    ["an Urdu cue before an auxiliary", "وہ اسی گاؤں کا ساکن ہے۔"],
    ["ساکن meaning still", "ساکن پانی میں مچھر پیدا ہوتے ہیں۔"],
    ["ساکن meaning immovable", "یہ ساکن جائیداد ہے اور منقولہ نہیں۔"],
    ["an Urdu cue before a legal-heir noun", "متوفی کی زوجہ اور دختر قانونی وارث ہیں۔"],
    ["the idiom بنت حوا", "مدعیہ بنت حوا کی طرح مظلوم ہے۔"],
    ["a new Urdu cue before a conjunction", "وراثت کا مقدمہ بیوہ اور پسر کے درمیان ہے۔"],
    // English cues before a party-role reference do not count.
    ["son of Respondent No. 2", "The petitioner is the son of Respondent No. 2."],
    ["wife of Accused No. 1", "The wife of Accused No. 1 was not cited as a witness."],
    ["son of the complainant", "The son of the complainant deposed."],
    ["son of the deceased", "The son of the deceased appeared as PW-1."],
    ["widow of Shaheed", "The widow of Shaheed was granted compensation under the Policy."],
    ["daughter of Opposite Party No. 3", "She is the daughter of Opposite Party No. 3."],
    ["son of PW-2", "He is the son of PW-2 and was not examined."],
    // Residence cues.
    ["residents of (plural)", "Residents of Karachi suffered from load shedding."],
    ["resident of the said house", "The tenant was a resident of the said house for twenty years."],
    ["resident of the Province", "The petitioner is a permanent resident of the Province of Punjab."],
    ["resident of the village, no name", "No resident of the village came forward as a witness."],
    // Labels with too few digits for their kind.
    ["a jail cell number", "He was kept in cell No. 105 of the district jail."],
    ["a cell with a year", "The Anti-Corruption cell - 2021 report was relied upon."],
    ["a six-digit phone value", "Phone No. 123456 was not traced."],
    ["an NTN of six digits", "NTN: 123456 is invalid."],
    ["a CNIC of four digits", "CNIC No. 1234 is incomplete."],
    ["a short passport token", "Passport No. 12 of the bundle."],
    ["an email label before prose", "Email - see the annexed print-outs."],
    // The address label away from a field start.
    ["address used as a verb", "Counsel will address: the jurisdiction point first."],
    // Numbered places before a unit, or with no place follower.
    ["house before years", "He sold the house 12 years ago."],
    ["house before marla", "A house 10 marla in area was mortgaged."],
    ["street before metres", "The street 3 metres wide was blocked."],
    ["House of the Senate", "The House 2 of the Senate committee met."],
    ["mohallah residents", "Mohallah 7 residents protested (as reported in the newspaper)."],
    // id_digits exemptions.
    ["an amount with /=", "The property was valued at 12500000000/= by the valuer."],
    ["an amount with a parenthetical before rupees", "The claim is for 2500000000 (two billion five hundred million) rupees."],
    ["an amount after amount of", "An amount of 1500000000 was transferred."],
    ["a diary number with its year", "Diary No. 123456-2021 of the Registrar's office was returned."],
    ["khasra numbers", "Khasra Nos. 1234/1 1235/2 1236/3 were in dispute."],
    ["Urdu khasra numbers", "خسرہ نمبر ۱۲۳۴/۱ ۱۲۳۵/۲ ۱۲۳۶/۳ متنازعہ ہیں۔"],
  ])("passes: %s", (_label, text) => {
    expect(residualPII(maskOutboundPII(text).masked)).toEqual(ZERO)
  })

  it.each([
    // Urdu cues before a name.
    ["ساکنہ", "ملزمہ نورا ساکنہ لاہور کو گرفتار کیا گیا۔", { address: 1 }],
    ["پسر and رہائشی", "ملزم کامران پسر عمر رہائشی لاہور گرفتار ہوا۔", { kinship_name: 1, address: 1 }],
    ["بیوہ", "مسماۃ نورا بیوہ عمر نے بیان دیا۔", { kinship_name: 1 }],
    // English: after a title any word is a name; after a role, a capitalised word is.
    ["son of Mr. lower-case", "Kamran Qalvo, son of Mr. omer, appeared.", { kinship_name: 1 }],
    ["wife of the accused with a name", "Nura, wife of the accused Kamran Qalvo, deposed.", { kinship_name: 1 }],
    ["son of the deceased with a name", "The son of the deceased Kamran was examined.", { kinship_name: 1 }],
    ["widow of Shaheed with a name", "The widow of Shaheed Kamran was granted compensation.", { kinship_name: 1 }],
    ["a name-title alone", "The son of Malik was arrested.", { kinship_name: 1 }],
    // Residence: a lower-case place, a place after the village.
    ["resident of a lower-case city", "The accused Kamran, resident of lahore, appeared.", { address: 1 }],
    ["resident of the village with a name", "A resident of the village Kot Qalvo appeared.", { address: 1 }],
    // New numbered-place cues.
    ["Plot No.", "The plaintiff resides at Plot No. 123, Sector G-9/1, Islamabad.", { address: 1 }],
    ["Flat No.", "Flat No. 4, Qalvo Heights, Block 7, Clifton, Karachi.", { address: 1 }],
    ["Apartment", "Apartment 5-B, Qalvo Towers, Karachi.", { address: 1 }],
    ["Shop No.", "Shop No. 12, Qalvo Market, Lahore.", { address: 1 }],
    ["a bare number before a place cue", "Gali 4 and Mohalla 3.", { address: 2 }],
    // The address label at a field start or after a qualifier.
    ["a permanent address", "Permanent address: Qalvo Town, Kasur.", { address: 1 }],
    ["an address after a pipe", "Name: Tariq | Address: Qalvo Town", { address: 1 }],
    ["an address in brackets", "The witness (address: Qalvo Town) appeared.", { address: 1 }],
    // Labels at their minimums.
    ["a seven-digit phone", "Mobile No. 300-1234 is off.", { labelled_identifier: 1 }],
    ["a five-digit CNIC fragment", "CNIC No. 35202 only.", { labelled_identifier: 1 }],
    ["a seven-character passport token", "Passport No. A123456 issued.", { labelled_identifier: 1 }],
    ["a driving licence", "Driving licence No. 12345678 issued at Lahore.", { labelled_identifier: 1 }],
    // id_digits: a mobile-shaped run keeps no exemption.
    ["a run starting 0 with short groups", "Ref 030 012 345 67 today.", { id_digits: 1 }],
    ["a run starting 92 ending in a year", "Ref 92 300 123 2019 today.", { id_digits: 1 }],
  ])("counts: %s", (_label, text, expected) => {
    expect(residualPII(text)).toEqual({ ...ZERO, ...expected })
  })
})
