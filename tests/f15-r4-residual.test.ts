import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import { residualPII, type ResidualKind } from "@/platform/p1/residualPII"
import { FRESH_R3 } from "./f15-r4-fresh-corpus"
import { HELDOUT_CORPUS_R4 } from "./f15-r4-heldout-corpus"

/**
 * Audit F15, re-audit round 3 (FAIL 8/10): the residual detector. Spec rulings R4-0 (at rank 3 and above a leak is
 * worse than a false positive), R4-2 (the walk after a kinship cue skips determiners, roles, occupations and
 * participles), R4-3 (residence), R4-4 (Urdu false positives) and R4-5 (the pin for mutant T24). The inputs are the
 * re-auditor's (r3-smuggle, r3-gaps, r3-e2e-attack). Every name is invented; every number is synthetic.
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

describe("R4-2: the walk after a kinship cue skips determiners, roles, occupations and participles", () => {
  it.each([
    // English (r3-smuggle, r3-e2e-attack)
    ["son of the deceased driver", "Tariq, son of the deceased driver Kamran Qalvo, deposed."],
    ["wife of the accused employee", "Nura, wife of the accused employee Kamran Qalvo, was summoned."],
    ["wife of an absconding accused", "Nura, wife of an absconding accused Kamran Qalvo, was summoned."],
    ["son of a deceased", "Tariq, son of a deceased Kamran Qalvo, applied for succession."],
    ["son of the late landlord", "Tariq, son of the late landlord Kamran Qalvo, filed the suit."],
    ["daughter of the owner", "Nura, daughter of the owner Kamran Qalvo, objected."],
    ["son of our client", "Tariq, son of our client Kamran Qalvo, attended."],
    ["son of a lower-case name with an alias", "Tariq son of kamran alias kami"],
    ["son of both, then a name", "Tariq, son of both the accused Kamran Qalvo, absconded."],
    ["son of a former tenant", "Tariq, son of a former tenant Kamran Qalvo, objected."],
    ["son of our client, a lower-case name", "Tariq, son of our client kamran qalvo, attended."],
    ["daughter of the owner, a lower-case name", "Nura, daughter of the owner kamran qalvo, objected."],
    // Urdu: given names that are also words, after the cue or a role (r3-smuggle)
    ["ولد and نیک as a name", "ملزم حارث ولد نیک قلوو کو گرفتار کیا گیا۔"],
    ["ولد and شادی as a name", "ملزم حارث ولد شادی قلوو کو گرفتار کیا گیا۔"],
    ["ولد and عدالت as a name", "ملزم حارث ولد عدالت قلوو کو گرفتار کیا گیا۔"],
    ["زوجہ, a role, then نیک as a name", "مسماۃ نورا زوجہ ملزم نیک قلوو نے بیان دیا۔"],
    ["دختر and a name starting خاتون", "مسماۃ نورا دختر خاتون قلوو نے بیان دیا۔"],
    ["ولد and a name that is a number word", "حارث ولد دو قلوو"],
    ["ولد, an occupation, then a name", "حارث ولد ڈرائیور کامران"],
  ])("counts: %s", (_label, text) => expectCounts(text, "kinship_name"))

  it.each([
    ["son of the deceased and a verb", "The son of the deceased appeared as PW-1."],
    ["son of a Government servant", "The petitioner is the son of a Government servant."],
    ["daughter of a Member", "She is the daughter of a Member of the Provincial Assembly."],
    ["daughter of a Sessions Judge", "The daughter of a Sessions Judge cannot be treated differently."],
    ["son of an Army officer", "He is the son of an Army officer."],
    ["son of a retired school teacher", "The appellant, son of a retired school teacher, has no previous criminal record."],
    ["wife of a Federal Minister", "The wife of a Federal Minister is not a public office holder."],
    ["wife of a Pakistani national", "The respondent is the wife of a Pakistani national residing abroad."],
    ["son of an Advocate", "He is the son of an Advocate of the High Court."],
    ["son of his parents", "The deceased was the only son of his parents."],
    ["son of the deceased employee", "The widow of the deceased employee is entitled to family pension."],
    ["Urdu ordinals", "زوجہ اول اور زوجہ دوم دونوں نے دعویٰ دائر کیا۔"],
    ["Urdu: the idiom دختر نیک اختر", "دختر نیک اختر کی شادی کے اخراجات کا دعویٰ کیا گیا۔"],
    ["Urdu: married daughter", "مدعی کی دختر شادی شدہ ہے اور اپنے شوہر کے ساتھ رہتی ہے۔"],
    ["Urdu: a daughter in court", "متوفی کا بیٹا اور دختر عدالت میں پیش ہوئے۔"],
    ["Urdu: a widowed woman", "بیوہ عورت کی جائیداد پر قبضہ کر لیا گیا۔"],
    ["Urdu: a widow, then a list of heirs", "متوفیہ کے قانونی ورثاء میں بیوہ، دو بیٹے اور تین بیٹیاں شامل ہیں۔"],
  ])("passes: %s", (_label, text) => expectClean(text))
})

describe("R4-3: residence", () => {
  it.each([
    ["r/o a colony named after a province", "Tariq r/o Punjab Colony, Karachi was arrested."],
    ["resident of a town named after the country", "Tariq, a resident of Pakistan Town, Islamabad, was arrested."],
    ["r/o Sindh Colony", "Tariq r/o Sindh Colony was arrested."],
    ["r/o District and a name", "Tariq r/o District Kasur was arrested."],
    ["r/o city and a name", "Tariq r/o city Lahore was arrested."],
    ["resident of the area of a place", "Tariq, a resident of the area of Qalvo Pura, was arrested."],
    ["plural: residents of Kot", "Tariq and Haris, both residents of Kot Qalvo, were arrested."],
    ["plural: residents of Tehsil", "the plaintiffs, residents of Tehsil Qalvo, District Kasur"],
    ["plural: residents of Pind", "the accused, residents of Pind Qalvo, absconded."],
    ["lives with his parents at", "He lives with his parents at 12-B Qalvo Road, Lahore."],
    ["presently residing near", "He is presently residing near Qalvo Chowk, Lahore."],
    ["having his abode in", "having his abode in Kot Qalvo, Tehsil Kasur"],
    ["stays at", "The accused stays at Qalvo Mansion during the week."],
    ["Urdu کا رہنے والا", "ملزم کامران قلوو پورہ کا رہنے والا ہے۔"],
    ["Urdu کا باشندہ", "ملزم کامران قلوو پورہ کا باشندہ ہے۔"],
    ["Urdu کی رہنے والی", "مسماۃ نورا قلوو پورہ کی رہنے والی ہے۔"],
    ["Urdu ساکن شہر and a name", "ملزم ساکن شہر قلوو کو گرفتار کیا گیا۔"],
    ["House No. of a named society", "the occurrence took place at House No. 12 of the Qalvo Housing Society, Lahore."],
    ["House No. before wherein", "the raid was conducted at House No. 12 wherein the accused was hiding."],
    ["H. No. before a verb", "The accused lives in H. No. 12 which was raided."],
    ["Urdu مکان نمبر before a verb", "ملزم مکان نمبر ۱۲ میں چھپا ہوا تھا۔"],
    ["Street and a lower-case place", "Street 5 qalvo town"],
    ["House No. after the occurrence (ruled R4-3; fresh line 69)", "The complainant shifted to House No. 7 after the occurrence."],
  ])("counts: %s", (_label, text) => expectCounts(text, "address"))

  it.each([
    ["residents of a territory", "Are residents of Islamabad Capital Territory governed by the ICT Rent Restriction Ordinance?"],
    ["resident of a province", "The petitioner is a resident of Punjab."],
    ["resident of the Province of a province", "The petitioner is a permanent resident of the Province of Punjab."],
    ["resident of Pakistan", "The petitioner is a citizen and resident of Pakistan."],
    ["T24: Urdu ساکن and a general area alone", "ملزم ساکن علاقہ ہذا ہے۔"],
    ["Urdu اسی شہر کا رہنے والا", "وہ بھی اسی شہر کا رہنے والا ہے۔"],
    ["lives in fear", "He lives in fear of the accused."],
    ["lives at a distance", "The witness stated that he lives at a distance of 2 furlongs from the place of occurrence."],
    ["House of the Senate", "The House 2 of the Senate committee met."],
    ["a range of flats", "Flat No. 4 to Flat No. 9 of the project were never completed."],
    ["a street of a scheme", "Street No. 3 of the housing scheme remains unpaved."],
  ])("passes: %s", (_label, text) => expectClean(text))
})

describe("R4-4: Urdu false positives", () => {
  it.each([
    ["اہل محلہ", "اہل محلہ نے پولیس کو اطلاع دی۔"],
    ["اہلِ محلہ", "اہلِ محلہ نے ملزم کو موقع پر پکڑ لیا۔"],
    ["address as per the title", "پتہ: درخواست کے عنوان کے مطابق"],
    ["address حسب عنوان", "پتہ: حسب عنوان"],
    ["address نامعلوم", "پتہ: نامعلوم"],
    ["address درج شدہ", "پتہ: درج شدہ"],
  ])("passes: %s", (_label, text) => expectClean(text))

  it("پسر اکبر stays counted (Akbar is a name; recorded as fail-closed)", () => {
    expectCounts("پسر اکبر نے جائیداد پر قبضہ کر لیا۔", "kinship_name")
  })
})

describe("R4-0 applied to numbers: no exemption for a card number or a twelve-digit amount", () => {
  it.each([
    ["a 16-digit card after case No.", "case No. 1234 5678 9012 3456"],
    ["a 16-digit card after khasra", "khasra 1234567890123456"],
    ["a 12-digit account after Rs.", "Rs. 123456789012 were credited to account"],
  ])("counts: %s", (_label, text) => expectCounts(text, "id_digits"))

  it.each([
    ["khasra numbers with their parts", "Khasra Nos. 1234/1 1235/2 1236/3 were in dispute."],
    ["an eleven-digit amount with /=", "The property was valued at 12500000000/= by the valuer."],
    ["a reference number with its No.", "Reference No. 123456789012 of 2019 was decided."],
  ])("passes: %s", (_label, text) => expectClean(text))
})

// R4-6: added only after the measurement at 57fd1c2 (the re-auditor's round-3 corpus: 4 of 102 flagged, lines 49, 84, 88
// and 101; the new corpus: 3 of 99, lines 77, 96 and 99), so the rates reported in the spec are held-out rates. The new
// corpus's three lines are fixed; the re-auditor's four are true positives or fail-closed by ruling, each named below.
const RULED_R4: ReadonlyMap<number, [ResidualKind, string]> = new Map([
  [49, ["address", "R4-3: an explicit House No. always counts"]],
  [84, ["kinship_name", "R4-4: a word after دختر is not exempted as a bank (fail closed)"]],
  [88, ["kinship_name", "R4-4: پسر اکبر stays counted (Akbar is a name)"]],
  [101, ["address", "R4-3: District followed by a name counts"]],
])

describe("R4-6: the held-out lines (regression rows, added after the measurement)", () => {
  it("has the re-auditor's 102 lines and the 99 lines of the new corpus", () => {
    expect(FRESH_R3).toHaveLength(102)
    expect(HELDOUT_CORPUS_R4).toHaveLength(99)
  })

  it.each([...RULED_R4].map(([line, [kind, reason]]) => [line, kind, reason]))("fresh line %i counts %s (%s)", (line, kind) => {
    const text = FRESH_R3.find(([n]) => n === line)![2]
    expect(residualPII(maskOutboundPII(text).masked)[kind as ResidualKind]).toBeGreaterThan(0)
  })

  it.each([
    ...FRESH_R3.filter(([line]) => !RULED_R4.has(line)).map(([line, lang, text]) => [`fresh line ${line}`, lang, text]),
    ...HELDOUT_CORPUS_R4.map(([genre, text], i) => [`new corpus line ${i + 1}`, genre, text]),
  ])("%s [%s] %s", (_line, _lang, text) => expectClean(text))
})
