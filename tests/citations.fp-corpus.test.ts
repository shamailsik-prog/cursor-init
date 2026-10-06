// Review round 4: the reviewer's false-positive corpora as a CI gate. 48 realistic draft passages
// go through POST /api/d4/drafts preflight; 28 paste/bilingual inputs through checkDraftCharset.
// Targets (coordinator ruling): 0% gate false positives on the 48 passages, except headings whose
// own case number is not recorded; on the 28 pastes only the intentionally refused Greek term.
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"
import { seedJudgment } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

const PASSAGES: Array<[string, string]> = [
  ["plaint heading", "IN THE COURT OF SENIOR CIVIL JUDGE, KARACHI (SOUTH)\nSuit No. 812 of 2025\nMuhammad Aslam son of Abdul Rasheed, Muslim, adult, resident of House No. 45, Block 7, Gulshan-e-Iqbal, Karachi ........ Plaintiff\nVERSUS\nM/s Engro Fertilizers PLC and others ........ Defendants"],
  ["plaint para money", "3. That on 15.03.2023 the Plaintiff paid a sum of Rs. 1,250,000/- (Rupees Twelve Lac Fifty Thousand only) to the Defendant No. 1 through Cheque No. 00412345 dated 15.03.2023 drawn on Habib Bank Limited, Saddar Branch."],
  ["plaint para company year", "4. That in 2019 Engro Fertilizers PLC entered into a supply agreement with the Plaintiff for 500 metric tons of urea at Rs. 3,850 per bag."],
  ["plaint prayer", "PRAYER\nIt is, therefore, most respectfully prayed that this Honourable Court may graciously be pleased to:\n(a) pass a decree for recovery of Rs. 2,500,000/- with markup at 12% per annum from 01.01.2024 till realisation;\n(b) grant costs of the suit;\n(c) grant any other relief deemed just and proper."],
  ["O.39 application", "APPLICATION UNDER ORDER XXXIX RULES 1 & 2 READ WITH SECTION 151 CPC\nIt is respectfully submitted that the Plaintiff has a prima facie case, the balance of convenience lies in his favour and he will suffer irreparable loss if the Defendants are not restrained from alienating Plot No. 12, Sector F-7/2, Islamabad."],
  ["CPC O.39 R.1&2 abbreviated", "The applicant seeks relief under O.39 R.1&2 CPC and S.151 CPC against the respondents."],
  ["writ heading", "IN THE ISLAMABAD HIGH COURT, ISLAMABAD\nWrit Petition No. 1234 of 2025\nCONSTITUTIONAL PETITION UNDER ARTICLE 199 OF THE CONSTITUTION OF THE ISLAMIC REPUBLIC OF PAKISTAN, 1973"],
  ["writ grounds articles", "GROUNDS\nA. That the impugned order dated 12.02.2025 is violative of Articles 4, 9, 10-A, 18 and 25 of the Constitution and is therefore without lawful authority and of no legal effect.\nB. That the respondents failed to afford the petitioner a hearing as required by Section 24-A of the General Clauses Act, 1897."],
  ["writ notification", "C. That Notification No. SO(LIT)/1-12/2024 dated 03.06.2024 issued by the Respondent No. 2 is ultra vires the Civil Servants Act, 1973 and the rules framed thereunder."],
  ["SRO reference", "D. That S.R.O. 1213(I)/2019 dated 01.10.2019 was issued under Section 8 of the Sales Tax Act, 1990 and cannot override the parent statute."],
  ["bail heading", "IN THE COURT OF SESSIONS JUDGE, LAHORE\nBail Application No. 456 of 2025\nIn FIR No. 123/2025 dated 10.01.2025 under Sections 302, 324, 34 PPC, Police Station Saddar, Lahore."],
  ["bail grounds 497", "1. That the petitioner is innocent and has been falsely implicated. The case of the petitioner falls within the ambit of further inquiry under Section 497(2) CrPC.\n2. That the petitioner is behind bars since 15.01.2025 and is no more required for investigation."],
  ["bail FIR spelled", "That FIR No. 45 of 2024 was registered at Police Station Gulberg on the complaint of one Zahid Mehmood with a delay of 3 days which is unexplained."],
  ["bail 497 + 498", "The learned trial court has wrongly declined bail under Section 497 and Section 498 CrPC vide order dated 20.02.2025."],
  ["legal notice", "LEGAL NOTICE\nUnder instructions from and on behalf of my client Mr. Imran Ali, CNIC No. 42101-1234567-1, I hereby serve upon you this legal notice that you are liable to pay Rs. 750,000/- within 15 days of receipt hereof, failing which my client shall initiate proceedings under Section 489-F PPC and Order XXXVII CPC."],
  ["legal notice company", "To: The Chief Executive Officer, Engro Fertilizers PLC, 7th Floor, The Harbour Front, Karachi. Your company's letter No. EFL/LEG/2024/118 dated 05.07.2024 has been perused."],
  ["company PLC year number", "Engro Fertilizers PLC reported revenue of Rs. 5 billion in its 2023 annual report, page 45."],
  ["company CLC", "The CLC committee of the Board met on 5 May 2024 and approved 3 resolutions."],
  ["numbered paras", "5. That the Defendant No. 2 is a necessary party.\n6. That the cause of action arose on 01.01.2024 and lastly on 15.06.2024 within the jurisdiction of this Court.\n7. That the suit is valued at Rs. 10,000,000/- for the purposes of court fee and jurisdiction."],
  ["dates mixed", "The hearing was adjourned from 5th May, 2023 to 12th June, 2023 and again to 3rd July 2023."],
  ["case list verified with pinpoints", "Reliance is placed on PLD 2010 SC 1, 2015 SCMR 100, 2018 CLC 789 (Lahore) and 2020 YLR 222."],
  ["case list pinpoint", "In 2015 SCMR 100, 105 the Honourable Supreme Court held that a mere delay is not fatal."],
  ["case list with names", "Muhammad Akram v. The State (PLD 2017 Lahore 55) and Haji Khan v. Gul Muhammad (2016 PCrLJ 44)."],
  ["case list semicolon", "See 2021 MLD 333; PLD 2010 SC 1, at page 7; and 2015 SCMR 100."],
  ["supra reference", "As held in PLD 2010 SC 1 (supra), the principle of locus poenitentiae applies."],
  ["English with Urdu terms", "The petitioner is the lawful owner of the land measuring 8 kanals 4 marlas in Khasra No. 123, Khewat No. 45, Mauza Chak 12, Tehsil and District Sheikhupura, as per the jamabandi for the year 2019-20."],
  ["Urdu terms 2", "The fard-e-malkiyat dated 12.11.2022 and the intiqal No. 4567 sanctioned in 2018 confirm the mutation in favour of the petitioner."],
  ["pure Urdu para 1", "یہ کہ مدعی نے مورخہ ۱۵ مارچ ۲۰۲۳ کو مدعا علیہ کو مبلغ بارہ لاکھ پچاس ہزار روپے ادا کیے۔"],
  ["pure Urdu para 2", "یہ کہ سال ۲۰۱۹ میں مدعی نے ۵ لاکھ روپے بطور بیعانہ ادا کیے اور بقایا رقم ۶ ماہ میں ادا کرنی تھی۔"],
  ["pure Urdu para 3", "عدالت عالیہ سے استدعا ہے کہ ضمانت بعد از گرفتاری منظور فرمائی جائے کیونکہ ملزم ۲۰۲۴ سے جیل میں ہے اور اس کا کوئی سابقہ ریکارڈ نہیں۔"],
  ["Urdu with English digits", "مقدمہ نمبر 123 سال 2024 زیر دفعہ 302 ت پ تھانہ صدر لاہور میں درج ہوا۔"],
  ["Urdu FIR", "ایف آئی آر نمبر ۴۵ بابت ۲۰۲۴ تھانہ گلبرگ میں درج کی گئی۔"],
  ["Iqbal verse", "خودی کو کر بلند اتنا کہ ہر تقدیر سے پہلے\nخدا بندے سے خود پوچھے بتا تیری رضا کیا ہے"],
  ["Faiz verse", "بول کہ لب آزاد ہیں تیرے\nبول زباں اب تک تیری ہے"],
  ["English verse quote", "As the poet said, 'Justice delayed is justice denied' — a maxim that has guided this Court since 1947."],
  ["Quranic reference", "Reference is made to Surah Al-Nisa, Ayat 58, which enjoins that trusts be rendered to those entitled to them."],
  ["vehicle and phone", "The vehicle bearing Registration No. LEA-1234 (Model 2019) was seized; contact 0300-1234567."],
  ["NTN and account", "The company's NTN is 1234567-8 and its account No. 0123-4567890-01 is maintained at MCB Bank, I.I. Chundrigar Road."],
  ["exhibits", "The documents were exhibited as Exh. P/1 to P/7 and Mark-A to Mark-D; the witness PW-3 was cross-examined on 12.09.2024."],
  ["annexures", "Copies of the sale deed dated 14.08.2015 (Annex-A), the mutation No. 789 (Annex-B) and the notice dated 2.1.2025 (Annex-C) are attached."],
  ["Act citations", "The Specific Relief Act, 1877, the Contract Act, 1872 and the Limitation Act, 1908 (Article 113) govern the present suit."],
  ["Ordinance No.", "The Ordinance No. XII of 2002 was repealed by Act No. V of 2010."],
  ["Order XLI", "This appeal under Order XLI Rule 1 CPC is filed within the period of 30 days prescribed under Article 152 of the Limitation Act."],
  ["Section 22-A", "The petition under Sections 22-A and 22-B CrPC before the Ex-Officio Justice of Peace was dismissed on 4.4.2024."],
  ["PPC sections", "The offences under Sections 420, 468 and 471 PPC are non-cognizable and bailable."],
  ["year then capital org", "In 2023 SECP issued 4 show-cause notices to the company under the Companies Act, 2017."],
  ["year then capital org 2", "Since 2020 NADRA has issued 2 CNICs to the petitioner, the second on 01.02.2022."],
  ["year then capital 3", "The 2022 PTCL bill of Rs. 4,500 was disputed."],
]

/** Headings that carry the matter's own case number: [courtId, raw case number]. */
const OWN_CASE: Record<string, [string, string]> = {
  "plaint heading": ["DSJ_KHI", "Suit No. 812 of 2025"],
  "writ heading": ["IHC", "Writ Petition No. 1234 of 2025"],
  "bail heading": ["LHC", "Bail Application No. 456 of 2025"],
}
const VERIFIED_LISTS = new Set(["case list verified with pinpoints", "case list pinpoint", "case list with names", "case list semicolon", "supra reference"])

const PASTES: Array<[string, string]> = [
  ["PDF paste ligature fi", "The suit was ﬁled on 12.01.2024 and the written statement was ﬂagged as late."],
  ["Word soft hyphen", "The re­spondent failed to appear despite service."],
  ["BOM at start", "﻿IN THE HIGH COURT OF SINDH AT KARACHI"],
  ["ZWSP from web paste", "The petitioner​ is aggrieved by the order."],
  ["NBSP", "Rs. 1,250,000/- was paid."],
  ["narrow NBSP", "Section 497 CrPC"],
  ["Word manual line break VT", "IN THE COURT OF\u000BCIVIL JUDGE"],
  ["form feed page break", "PRAYER\u000CIt is prayed"],
  ["Urdu glued to English in parens", "ملزم نے ضمانت(bail) کی درخواست دائر کی۔"],
  ["Urdu slash English", "دفعہ/Section 497 کے تحت"],
  ["English glued to Urdu quote", "The term \"بیعانہ\"(earnest money) was paid."],
  ["Urdu ZWNJ between letters", "می‌ں نے ادا کیے"],
  ["Urdu with Arabic honorific ligature", "محمد ﷺ نے فرمایا"],
  ["Allah ligature", "ﷲ کے نام سے"],
  ["Quranic text with marks", "إِنَّ اللَّهَ يَأْمُرُكُمْ"],
  ["Rupee sign", "₨ 500 and ₹ not used"],
  ["Section sign and para", "§ 497 and ¶ 12 of the plaint"],
  ["Degree and micro", "temperature 40°C and dose 5 µg"],
  ["Name with diacritics", "Mr. José Müller and Ms. Björk appeared."],
  ["Turkish/Polish name", "Witness Şahin and Łukasz Nowak"],
  ["Greek legal term", "the doctrine of λόγος is irrelevant"],
  ["Latin maxim with æ", "Ex turpi causa non oritur actio; Æquitas sequitur legem."],
  ["Trademark symbols", "Engro® and Sona™ urea"],
  ["Emoji in WhatsApp quote", "The accused wrote on WhatsApp: \"pay now 😡\""],
  ["Bullet list", "• First ground\n• Second ground\n▪ Third ground"],
  ["Checkmark", "Documents verified ✓"],
  ["Copyright line", "© 2024 Engro Fertilizers PLC"],
  ["Ellipsis quote", "“The court… shall not”"],
]

afterEach(() => resetRuntimeStoreForTests())
let n = 0

async function preflight(label: string, body: string, recordOwnCase: boolean) {
  resetRuntimeStoreForTests()
  const store = getRuntimeStore()
  const own = OWN_CASE[label]
  const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: own?.[0] ?? "SHC", classification: "internal" })
  addMember(store, m.id, "associate_a", "firmA")
  if (own && recordOwnCase) expect(recordCaseNumber(store, m.id, own[1], own[0]).status).not.toBe("REJECT")
  for (const c of ["PLD 2010 SC 1", "2015 SCMR 100", "2018 CLC 789", "2020 YLR 222", "PLD 2017 Lahore 55", "2016 PCrLJ 44", "2021 MLD 333"]) seedJudgment(store, "v-" + c, c, "full", c)
  const res = await DRAFTS(
    new Request("http://127.0.0.1/api/d4/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `fafafafa-0000-4000-8000-${String(++n).padStart(12, "0")}` },
      body: JSON.stringify({ action: "preflight", actorId: "associate_a", matterId: m.id, templateId: getDocumentTypes()[0]!.id, title: "x", body, classification: "internal", citedJudgmentIds: [], temporalCitations: [] }),
    })
  )
  const json = (await res.json()) as { result?: { result?: { ok: boolean; citations: Array<{ ref: string; status: string }> } } }
  return { status: res.status, result: json.result?.result }
}

describe("review round 4 false-positive corpus (48 passages, preflight API)", () => {
  it("has 48 passages", () => expect(PASSAGES).toHaveLength(48))

  it("0% false positives with the matters' own case numbers recorded; verified case lists stay VERIFIED", async () => {
    const flagged: string[] = []
    for (const [label, body] of PASSAGES) {
      const { status, result } = await preflight(label, body, true)
      expect(status, label).toBe(200)
      if (!result?.ok) flagged.push(`${label}: ${JSON.stringify(result?.citations)}`)
      if (VERIFIED_LISTS.has(label)) {
        expect(result?.citations.length, label).toBeGreaterThan(0)
        expect(result?.citations.every((c) => c.status === "VERIFIED"), label).toBe(true)
      }
    }
    console.log(`FP corpus (own case recorded): ${flagged.length}/48 = ${((100 * flagged.length) / 48).toFixed(1)}%`)
    expect(flagged).toEqual([])
  }, 120_000)

  it("without recorded case numbers, only the three own-case headings are flagged", async () => {
    const flagged: string[] = []
    for (const [label, body] of PASSAGES) {
      const { result } = await preflight(label, body, false)
      if (!result?.ok) flagged.push(label)
    }
    console.log(`FP corpus (own case not recorded): ${flagged.length}/48 = ${((100 * flagged.length) / 48).toFixed(1)}%`)
    expect(flagged.sort()).toEqual(Object.keys(OWN_CASE).sort())
  }, 120_000)
})

describe("review round 4 paste corpus (28 inputs, charset check)", () => {
  it("has 28 inputs and refuses only the Greek term (refused by the ruling)", () => {
    expect(PASTES).toHaveLength(28)
    const refused = PASTES.filter(([, body]) => !checkDraftCharset(body).ok).map(([label]) => label)
    console.log(`paste corpus refusals: ${refused.length}/28 (${refused.join(", ")})`)
    expect(refused).toEqual(["Greek legal term"])
  })
})
