import { describe, expect, it } from "vitest"
import { maskOutboundPII, type MaskResult } from "@/platform/p1/maskOutboundPII"
import { detectionView } from "@/platform/p1/piiText"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import { AUDITOR_FP_CORPUS } from "./f15-r2-corpus"

/**
 * Audit F15, re-audit round 1 (FAIL 6/10): the re-auditor's attack inputs as regression rows. Spec rulings R2-1
 * (default-ignorable characters and combining marks), R2-4 (real formats the mask missed) and R2-5 (the LOW items).
 * docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md
 *
 * Every name is invented; every number is synthetic. Invisible characters are written as escapes.
 */

const countsOf = (r: MaskResult): Record<string, number> => Object.fromEntries(r.redactions.map((x) => [x.kind, x.count]))
const sep = (digits: string, s: string) => [...digits].join(s)
const CNIC = "3520212345671"
const PHONE = "03001234567"
const digitsIn = (s: string) => (s.match(/\p{Nd}/gu) ?? []).length
const minimised = (body: string, names: string[] = []) => assertMinimised({ body, metadata: { purpose: "committee-brain" } }, names)

describe("R2-1: default-ignorable characters and combining marks never hide an identifier", () => {
  it.each([
    ["CGJ U+034F between every CNIC digit", `CNIC ${sep(CNIC, "\u034F")}`, "CNIC [CNIC]"],
    ["CGJ U+034F inside a separated CNIC", "id 35202\u034F-1234567-1 end", "id [CNIC] end"],
    ["VS16 U+FE0F between every CNIC digit", `id ${sep(CNIC, "\uFE0F")} end`, "id [CNIC] end"],
    ["VS1 U+FE00 between every mobile digit", `call ${sep(PHONE, "\uFE00")} now`, "call [PHONE] now"],
    ["VS17 U+E0100 between every mobile digit", `call ${sep(PHONE, "\u{E0100}")} now`, "call [PHONE] now"],
    ["Mongolian FVS1 U+180B", `call ${sep(PHONE, "\u180B")} now`, "call [PHONE] now"],
    ["Hangul filler U+3164", `call ${sep(PHONE, "\u3164")} now`, "call [PHONE] now"],
    ["halfwidth Hangul filler U+FFA0", `call ${sep(PHONE, "\uFFA0")} now`, "call [PHONE] now"],
    ["Hangul choseong filler U+115F", `call ${sep(PHONE, "\u115F")} now`, "call [PHONE] now"],
    ["Khmer inherent vowels U+17B4 and U+17B5", `call ${sep(PHONE, "\u17B4\u17B5")} now`, "call [PHONE] now"],
    ["unassigned default-ignorable U+2065", `call ${sep(PHONE, "\u2065")} now`, "call [PHONE] now"],
    ["default-ignorable U+FFF0 and U+FFF8", `call ${sep(PHONE, "\uFFF0\uFFF8")} now`, "call [PHONE] now"],
    ["a combining acute on every CNIC digit", `id ${sep(CNIC, "\u0301")}\u0301 end`, "id [CNIC] end"],
    ["underlined digits (combining low line U+0332)", `id ${sep(CNIC, "\u0332")}\u0332 end`, "id [CNIC] end"],
    ["keycap digits (digit + VS16 + U+20E3)", `call ${[...PHONE].map((d) => `${d}\uFE0F\u20E3`).join("")} now`, "call [PHONE] now"],
  ])("%s", (_label, raw, expected) => {
    const r = maskOutboundPII(raw)
    expect(r.masked).toBe(expected)
    expect(digitsIn(r.masked)).toBe(0)
  })

  it("a mobile wrapped in interlinear annotation characters leaks no digit", () => {
    const r = maskOutboundPII(`call \uFFF9${PHONE}\uFFFAx\uFFFB now`)
    expect(digitsIn(r.masked)).toBe(0)
    expect(countsOf(r).phone).toBe(1)
  })

  it("the detection view drops default-ignorables and marks and keeps every other unit's original span", () => {
    const v = detectionView("3\u034F5\uFE0F2\u20E3\u3164-\u0332")
    expect(v.text).toBe("352-")
    expect(v.start).toEqual([0, 2, 4, 7])
    expect(v.end).toEqual([1, 3, 5, 8])
  })

  it("names written with default-ignorables or a Hangul filler for the space are masked", () => {
    for (const raw of ["Tar\u034Fiq Zarvani agreed.", "Tar\uFE0Fiq Zarvani agreed.", "Tariq\u3164Zarvani agreed.", "Tariq\u115FZarvani agreed."]) {
      expect(maskOutboundPII(raw, { partyNames: ["Tariq Zarvani"] }).masked, raw).toBe("[PARTY] agreed.")
    }
  })

  it("assertMinimised sees through them too", () => {
    expect(minimised(`Client CNIC ${sep(CNIC, "\u034F")}.`)).toBe(false)
    expect(minimised(`call ${sep(PHONE, "\uFE0F")} now`)).toBe(false)
  })
})

describe("R2-4: real Pakistani formats are masked", () => {
  it.each([
    ["a mobile with a spaced dash", "contact him at 0300 - 1234567 today", "contact him at [PHONE] today"],
    ["a mobile grouped 4-3-4", "contact him at 0300 123 4567 today", "contact him at [PHONE] today"],
    ["a +92 mobile whose last group looks like a year", "contact him at +92 300 123 2019 today", "contact him at [PHONE] today"],
    ["a +92 mobile grouped 3-3-4", "contact him at +92 300 123 4567 today", "contact him at [PHONE] today"],
    ["a bracketed +92 prefix", "contact him at (+92) 300-1234567 today", "contact him at [PHONE] today"],
    ["a bracketed operator code after +92", "contact him at +92 (300) 1234567 today", "contact him at [PHONE] today"],
    ["a 0092 prefix", "contact him at 0092-300-1234567 today", "contact him at [PHONE] today"],
    ["a 92 prefix", "contact him at 92-300-1234567 today", "contact him at [PHONE] today"],
    ["a mobile grouped 4-3-2-2", "contact him at 0300-123-45-67 today", "contact him at [PHONE] today"],
    ["a mobile grouped 2-2-2-2-3", "contact him at 03 00 12 34 567 today", "contact him at [PHONE] today"],
    ["a mobile grouped 3-3-3-2", "contact him at 030 012 345 67 today", "contact him at [PHONE] today"],
    ["two mobiles separated by a slash", "Contact: 0300 1234567 / 0321 7654321.", "Contact: [PHONE] / [PHONE]."],
    ["an Urdu-digit mobile with a spaced dash in Urdu prose", "ان کا نمبر ۰۳۰۰ - ۱۲۳۴۵۶۷ ہے", "ان کا نمبر [PHONE] ہے"],
    ["a landline with a dash", "office 042-35761234", "office [PHONE]"],
    ["a landline with a bracketed area code", "office (042) 35761234", "office [PHONE]"],
    ["landlines with bracketed area codes after labels", "Tel (042) 35761234, fax (042) 35761235.", "Tel [PHONE], fax [PHONE]."],
    ["a seven-digit landline", "office 051-2345678 only", "office [PHONE] only"],
    ["a +92 landline", "office +92 42 35761234 only", "office [PHONE] only"],
    ["a UAN with its area code", "office 042 111 222 333", "office [PHONE]"],
    ["a bare UAN", "helpline 111-222-333 only", "helpline [PHONE] only"],
    ["NTN No.", "Tax: NTN No. 1234567-8 issued", "Tax: [NTN] issued"],
    ["N.T.N", "Tax: N.T.N 1234567-8 issued", "Tax: [NTN] issued"],
    ["N.T.N.", "Tax: N.T.N. 1234567-8 issued", "Tax: [NTN] issued"],
    ["an IBAN with dashes", "IBAN PK36-SCBL-0000-0011-2345-6702 now", "IBAN [IBAN] now"],
    ["a passport after No.", "Passport No. AB1234567 issued", "[PASSPORT] issued"],
    ["an unlabelled passport number", "travel document AB1234567 issued", "travel document [PASSPORT] issued"],
  ])("%s", (_label, raw, expected) => {
    expect(maskOutboundPII(raw).masked).toBe(expected)
  })

  it("the mask leaves every line of the re-auditor's false-positive corpus unchanged", () => {
    const changed = AUDITOR_FP_CORPUS.map(([, text]) => text).filter((text) => maskOutboundPII(text).masked !== text)
    expect(changed).toEqual([])
  })

  it.each([
    ["citations", "Reliance is placed on PLD 2019 SC 123, 2020 SCMR 456 and 2019 YLR 1234."],
    ["dates with times", "On 12.03.2021, 13.03.2021 and 14.03.2021 at 10.30 a.m. the accused was absent."],
    ["a date followed by a case number", "Order dated 03.01.2021 in Suit No. 456/2015."],
    ["amounts", "Rs. 5,000,000/- and PKR 15,00,000/- were deposited."],
    ["sections", "Under sections 302/324/148/149 PPC and 0302 of the register."],
    ["an FIR", "FIR No. 0123/2021 dated 01-02-2021 at P.S. Saddar."],
  ])("ordinary prose is not masked: %s", (_label, text) => {
    expect(maskOutboundPII(text).masked).toBe(text)
  })
})

describe("R2-5: the LOW items", () => {
  const C = CNIC
  const enclosed = (zero: string, base: number) => C.replace(/[0-9]/g, (d) => (d === "0" ? zero : String.fromCodePoint(base + Number(d) - 1)))
  it.each([
    ["negative circled dingbat digits", `id ${enclosed("⓿", 0x2776)} end`],
    ["circled sans-serif dingbat digits", `id ${enclosed("⓪", 0x2780)} end`],
    ["negative circled sans-serif dingbat digits", `id ${enclosed("⓿", 0x278a)} end`],
    ["parenthesised digits (a CNIC without a zero)", "id ⑶⑸⑵⑴⑵⑴⑵⑶⑷⑸⑹⑺⑴ end"],
    ["digits with a full stop (a CNIC without a zero)", "id ⒊⒌⒉⒈⒉⒈⒉⒊⒋⒌⒍⒎⒈ end"],
    ["double circled digits", "id ⓷⓹⓶⓵⓶⓵⓶⓷⓸⓹⓺⓻⓵ end"],
  ])("%s are digits", (_label, raw) => {
    const r = maskOutboundPII(raw)
    expect(r.masked).toBe("id [CNIC] end")
  })

  it.each([
    ["an Arabic thousands separator in an Urdu mobile", "call ۰۳۰۰٬۱۲۳۴۵۶۷ now", "call [PHONE] now"],
    ["an Arabic decimal separator in an Urdu mobile", "call ۰۳۰۰٫۱۲۳۴۵۶۷ now", "call [PHONE] now"],
    ["Arabic commas in a CNIC", "id 35202،1234567،1 end", "id [CNIC] end"],
    ["ideographic full stops in a CNIC", "id 35202。1234567。1 end", "id [CNIC] end"],
    ["full-width slashes in a CNIC", "id 35202／1234567／1 end", "id [CNIC] end"],
    ["slashes in a CNIC", "id 35202/1234567/1 end", "id [CNIC] end"],
    ["underscores in a CNIC", "id 35202_1234567_1 end", "id [CNIC] end"],
    ["a comma in a mobile", "call 0300,1234567 now", "call [PHONE] now"],
  ])("%s", (_label, raw, expected) => {
    expect(maskOutboundPII(raw).masked).toBe(expected)
  })

  it.each([
    ["a Latin diacritic in the local part", "mail nūra.qalvo@qalvo.pk now"],
    ["an Urdu local part", "mail نورا@qalvo.pk now"],
    ["an internationalised domain", "mail نورا@قلوو.پاک now"],
  ])("an email with %s is masked whole", (_label, raw) => {
    expect(maskOutboundPII(raw).masked).toBe("mail [EMAIL] now")
  })

  it.each([
    ["a Cyrillic a", "Tаriq Zarvani agreed.", ["Tariq Zarvani"]],
    ["a Greek capital omicron", "Οmer Daryani agreed.", ["Omer Daryani"]],
    ["Cyrillic o, e and p", "Оmеr Daryаni agreed.", ["Omer Daryani"]],
    ["do-chashmi he for heh goal", "نورھ agreed.", ["نورہ"]],
    ["a dot for the space", "Tariq.Zarvani agreed.", ["Tariq Zarvani"]],
    ["an underscore for the space", "Tariq_Zarvani agreed.", ["Tariq Zarvani"]],
    ["a company name without its dots", "Qalvo (Pvt) Ltd agreed.", ["Qalvo (Pvt.) Ltd."]],
    ["an honorific only in the record", "Tariq Zarvani agreed.", ["Mr. Tariq Zarvani"]],
  ])("a name written with %s is masked", (_label, raw, names) => {
    expect(maskOutboundPII(raw, { partyNames: names }).masked).toBe("[PARTY] agreed.")
  })

  it("names that match inside one NFKC expansion count once (mutant M14)", () => {
    // U+FDFA expands to a phrase containing both names; the first match blanks every unit of that code point.
    const r = maskOutboundPII("x ﷺ y", { partyNames: ["الله", "صلى"] })
    expect(r.masked).toBe("x [PARTY] y")
    expect(countsOf(r).party).toBe(1)
  })
})
