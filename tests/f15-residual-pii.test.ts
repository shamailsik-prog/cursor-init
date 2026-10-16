import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { RESIDUAL_KINDS, residualPII, residualTotal } from "@/platform/p1/residualPII"

/**
 * Audit F15, spec ruling 5: the independent residual detector. It runs on already-masked text and returns counts by
 * kind, never text. docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md
 *
 * Every name is invented; every number is synthetic.
 */

const ZERO = { id_digits: 0, labelled_identifier: 0, address: 0, kinship_name: 0 }

describe("residualPII: true positives by kind (English and Urdu)", () => {
  it.each([
    // id_digits: ten or more digits joined by single separators.
    ["a landline", "Office 042 3576 1234.", { id_digits: 1 }],
    ["a ten-digit mobile without its prefix", "Contact 3001234567 today.", { id_digits: 1 }],
    ["a CNIC grouped 4-4-4-1", "Card 3520 2123 4567 1 held.", { id_digits: 1 }],
    ["an account number", "Account 0123-4567-8901-23 frozen.", { id_digits: 1 }],
    ["a sixteen-digit number", "Card 1234567890123456 used.", { id_digits: 1 }],
    ["a landline in Urdu digits", "رابطہ ۰۴۲ ۳۵۷۶ ۱۲۳۴ پر کریں۔", { id_digits: 1 }],
    ["a landline in full-width digits", "Office ０４２ ３５７６ １２３４.", { id_digits: 1 }],
    ["digits split by a zero-width space", "Office 042​35761234.", { id_digits: 1 }],
    ["two runs", "Office 042 3576 1234 or 051 2345 6789.", { id_digits: 2 }],
    ["two groups joined by a slash whose second is not a year", "Ref 123456/78901 held.", { id_digits: 1 }],
    ["two groups joined by a dash whose second is a year", "Ref 123456-2021 held.", { id_digits: 1 }],
    ["a CNIC glued to its label by a zero-width space (the mask's word boundary is gone)", "CNIC​3520212345671", { id_digits: 1 }],
    // labelled_identifier: a label, a separator and a value that is not a mask token.
    ["a CNIC one digit short", "CNIC No. 35202-123456-1 on file.", { labelled_identifier: 1, id_digits: 1 }],
    ["a passport in a format the mask misses", "Passport No: A1234567 issued.", { labelled_identifier: 1 }],
    ["a mobile without its prefix", "Mobile # 300-123-4567 off.", { labelled_identifier: 1, id_digits: 1 }],
    ["a short telephone number", "Tel: 042-3576 ext.", { labelled_identifier: 1 }],
    ["an ID card number", "ID card No. 12345 lost.", { labelled_identifier: 1 }],
    ["an email spelled out", "email: tariq.zarvani at qalvo dot pk", { labelled_identifier: 1 }],
    ["an email without a domain", "e-mail - tariq.zarvani@qalvo", { labelled_identifier: 1 }],
    ["an Urdu CNIC label", "شناختی کارڈ نمبر: ۳۵۲۰۲-۱۲۳۴۵۶-۱ درج ہے۔", { labelled_identifier: 1, id_digits: 1 }],
    ["an Urdu mobile label", "موبائل نمبر ۳۰۰-۱۲۳-۴۵۶۷ بند ہے۔", { labelled_identifier: 1, id_digits: 1 }],
    ["an Urdu passport label", "پاسپورٹ نمبر A1234567 جاری ہوا۔", { labelled_identifier: 1 }],
    ["an Urdu email label", "ای میل: tariq at qalvo", { labelled_identifier: 1 }],
    ["an Urdu phone label", "فون نمبر ۴۲۳۵۷۶ ہے۔", { labelled_identifier: 1 }],
    // address: a residence cue, a house or street number.
    ["the audit's address", "The accused r/o House 12, Street 5, Lahore.", { address: 3 }],
    ["resident of a place", "A resident of Mohallah Qalvo Pura, Kasur.", { address: 1 }],
    ["resident of a place after locative words", "A resident of the village Kot Qalvo.", { address: 1 }],
    ["resident of a numbered place", "A resident of Chak 12.", { address: 1 }],
    ["resident of a named muhallah", "A resident of muhallah Qalvo Pura.", { address: 1 }],
    ["R/O in capitals", "Tariq R/O Qalvo Town.", { address: 1 }],
    ["an address label", "Address: 14-B, Qalvo Town.", { address: 1 }],
    ["house numbers", "H. No. 7, House # 8 and House Number 77.", { address: 3 }],
    ["street numbers", "Street No. 9, Gali 4 and Mohalla 3.", { address: 3 }],
    ["an Urdu address", "ساکن مکان نمبر ۱۲ گلی نمبر ۵ لاہور", { address: 3 }],
    ["an Urdu residence cue", "سکنہ محلہ قلوو پورہ", { address: 1 }],
    ["an Urdu address label", "پتہ: لاہور", { address: 1 }],
    // kinship_name: a parentage or marriage cue and a name.
    ["s/o", "Tariq s/o Kamran.", { kinship_name: 1 }],
    ["S/O with a lower-case name", "Tariq S/O kamran.", { kinship_name: 1 }],
    ["d/o", "Nura d/o Omer.", { kinship_name: 1 }],
    ["w/o", "Nura w/o Haris Qalbani.", { kinship_name: 1 }],
    ["son of", "the son of Kamran.", { kinship_name: 1 }],
    ["son of late", "Son of late Kamran.", { kinship_name: 1 }],
    ["son of the late", "son of the late Kamran.", { kinship_name: 1 }],
    ["son of a titled name", "son of Mr. Kamran.", { kinship_name: 1 }],
    ["daughter of (late)", "daughter of (late) Omer.", { kinship_name: 1 }],
    ["wife of", "wife of Haris.", { kinship_name: 1 }],
    ["widow of", "widow of Omer Daryani.", { kinship_name: 1 }],
    ["a title that is also a name", "son of Malik Kamran.", { kinship_name: 1 }],
    ["an Arabic-script name after an English cue", "son of کامران.", { kinship_name: 1 }],
    ["ولد", "ملزم ولد کامران", { kinship_name: 1 }],
    ["بنت", "مدعیہ بنت عمر", { kinship_name: 1 }],
    ["زوجہ", "نورہ زوجہ حارث", { kinship_name: 1 }],
    ["دختر", "نورہ دختر عمر", { kinship_name: 1 }],
    ["ولد مرحوم", "ملزم ولد مرحوم کامران", { kinship_name: 1 }],
    ["mixed cues", "Tariq s/o Kamran r/o Lahore.", { kinship_name: 1, address: 1 }],
  ])("%s", (_label, text, expected) => {
    expect(residualPII(text)).toEqual({ ...ZERO, ...expected })
  })
})

describe("residualPII: masked values do not count", () => {
  it("cues followed by mask tokens", () => {
    const text = "CNIC No. [CNIC], Mobile: [PHONE], email: [EMAIL], Passport No. [PASSPORT], s/o [PARTY], son of late [PARTY], w/o Mr. [PARTY], ولد [PARTY], r/o [PARTY]."
    expect(residualPII(text)).toEqual(ZERO)
  })

  it("the mask's own output for identifiers it recognises", () => {
    const masked = maskOutboundPII("CNIC: 35202-1234567-1, Mobile No. 0300-1234567, email: counsel@qalvo.pk, s/o Tariq Zarvani", {
      partyNames: ["Tariq Zarvani"],
    }).masked
    expect(residualPII(masked)).toEqual(ZERO)
  })
})

describe("residualPII: ordinary Pakistani legal prose produces no finding (false-positive corpus)", () => {
  it.each([
    ["an FIR with sections", "The petitioner was arrested in case FIR No. 123/2020 dated 12-05-2019 under sections 302/324/148/149 PPC at Police Station Saddar."],
    ["citations", "Reliance is placed on PLD 2019 SC 123, 2020 SCMR 456, 2019 YLR 1234 and 2018 PCr.LJ 567."],
    ["adjacent citations", "See PLD 2019 Lahore 123 2019 YLR 456 and 1999 SCMR 1234."],
    ["case numbers with a year", "Writ Petition No. 12345 of 2021 and W.P. No. 123456/2021 were heard together."],
    ["a bail petition number", "Crl. Misc. No. 1234-B/2020 was dismissed on 01.02.2021."],
    ["amounts with commas and currency", "The decretal amount of Rs. 5,000,000/- with Rs.1,500,000,000 in costs; PKR 15,00,000/- was deposited."],
    ["an amount with the /- suffix", "A sum of 1500000000/- was claimed."],
    ["an amount in a currency before it", "USD 25000000000 and Rs 1500000000 were in issue."],
    ["an Urdu amount", "مبلغ ۱۵۰۰۰۰۰۰۰۰ روپے ادا کیے گئے۔"],
    ["an amount in rupees", "The claim was 15000000000 rupees."],
    ["the son of the deceased", "The son of the deceased appeared as PW-1."],
    ["resident of Pakistan", "The petitioner is a citizen and resident of Pakistan."],
    ["residents of the area", "The residents of the area chased the accused."],
    ["wife of the accused", "The wife of the accused and the widow of the deceased deposed."],
    ["an Urdu resident of Pakistan", "درخواست گزار پاکستان کا شہری اور ساکن پاکستان ہے۔"],
    ["the Constitution", "Article 199 of the Constitution of the Islamic Republic of Pakistan, 1973."],
    ["rules and orders", "Sections 497 and 498 Cr.P.C. and Order XXXIX Rules 1 and 2 CPC."],
    ["a mobile phone in evidence", "The mobile phone was recovered from the accused, and the cell phone data was analysed."],
    ["a jail cell", "He was kept in cell No. 4 of the district jail."],
    ["an email in evidence", "The email dated 12.05.2019 was exhibited as Ex.P-3."],
    ["tax years", "The tax years 2018/2019/2020 were assessed."],
    ["a hearing time", "Hearing adjourned to 15-06-2021 at 10:30 a.m."],
    ["a revision and a suit", "Civil Revision No. 2345 of 2019 arose from Suit No. 456/2015."],
    ["an address without a colon", "The address of the learned counsel was not on record."],
    ["a house without a number", "The house of the complainant was searched."],
    ["addressed the court", "The appellant addressed the court on 3 occasions."],
    ["paragraphs and pages", "Paragraph 12 of the judgment at page 345 of the paper book."],
    ["phone records", "The phone records (Ex.P-7) were produced."],
    ["without prejudice", "This is said w/o prejudice to the above."],
    ["a narcotics recovery", "Under section 9(c) of the CNSA, 1997, the recovery was 1210 grams."],
    ["a telephone conversation", "Telephone conversation dated 01-01-2020 was relied on."],
    ["fiscal years", "between 2019-2020 and 2020-2021"],
    ["a street without a number", "The procession passed through the main street of the town."],
    ["Urdu FIR prose", "مقدمہ نمبر ۱۲۳۴/۲۰۲۰ مورخہ ۱۲-۰۵-۲۰۱۹ زیر دفعہ ۳۰۲/۳۲۴ ت پ درج ہوا۔"],
    ["an Urdu amount with commas", "مدعی نے مبلغ ۵۰,۰۰,۰۰۰ روپے ادا کیے۔"],
    ["Urdu parentage word inside another word", "ولدیت کا خانہ خالی تھا۔"],
  ])("%s", (_label, text) => {
    expect(residualPII(text)).toEqual(ZERO)
  })
})

describe("residualPII: output and bounds", () => {
  it("returns counts for every kind and nothing else, never text", () => {
    const text = "Tariq s/o Kamran r/o House 12, Office 042 3576 1234, CNIC No. 35202-123456-1"
    const r = residualPII(text)
    expect(Object.keys(r).sort()).toEqual([...RESIDUAL_KINDS].sort())
    for (const v of Object.values(r)) expect(Number.isSafeInteger(v)).toBe(true)
    const json = JSON.stringify(r)
    for (const piece of ["Kamran", "042", "3576", "35202", "House"]) expect(json).not.toContain(piece)
    expect(residualTotal(r)).toBe(r.id_digits + r.labelled_identifier + r.address + r.kinship_name)
    expect(residualTotal(residualPII("Nothing here."))).toBe(0)
  })

  it("scans 100,000 characters of adversarial input without catastrophic backtracking", () => {
    const inputs = [
      `phone${" ".repeat(99_990)}`,
      "1 ".repeat(50_000),
      "1-".repeat(50_000),
      "s/o ".repeat(25_000),
      "r/o ".repeat(25_000),
      "No. ".repeat(25_000),
      "Tel: No. - # ".repeat(7_000),
      "ولد ".repeat(25_000),
      `${"3".repeat(99_999)}x`,
    ]
    const started = Date.now()
    for (const text of inputs) {
      residualPII(text)
      maskOutboundPII(text, { partyNames: ["Tariq Zarvani Qalvo", "s o", "No"] })
    }
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
