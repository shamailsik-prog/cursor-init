import { describe, expect, it } from "vitest"
import { maskOutboundPII, type MaskResult } from "@/platform/p1/maskOutboundPII"
import { assertMinimised } from "@/platform/p1/providerPolicy"

/**
 * Audit finding F15 (HIGH, 2026-10-13): "The PII mask is not a comprehensive confidentiality boundary". These tests use
 * only the mask's and the policy's public API, so they run (and fail) against main's sources as well. Spec:
 * docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md (rulings 1, 2, 3 and 6).
 *
 * Every name is invented; every number is synthetic. Invisible and space characters are written as escapes.
 */

const countsOf = (r: MaskResult): Record<string, number> => Object.fromEntries(r.redactions.map((x) => [x.kind, x.count]))

describe("audit F15: the mask sees identifiers in every digit script (ruling 1)", () => {
  it("the audit's counterexample: a full-width CNIC and an Urdu-digit mobile are masked", () => {
    const r = maskOutboundPII("CNIC ３５２０２\uFF0D１２３４５６７\uFF0D１, mobile ۰۳۰۰-۱۲۳۴۵۶۷.")
    expect(r.masked).toBe("CNIC [CNIC], mobile [PHONE].")
    expect(countsOf(r)).toEqual({ cnic: 1, phone: 1, party: 0, email: 0, iban: 0, ntn: 0, passport: 0 })
  })

  it.each([
    ["a full-width plain CNIC", "id ３５２０２１２３４５６７１ end", "id [CNIC] end", "cnic"],
    ["an Arabic-Indic CNIC", "id ٣٥٢٠٢-١٢٣٤٥٦٧-١ end", "id [CNIC] end", "cnic"],
    ["an Extended Arabic-Indic (Urdu) CNIC", "id ۳۵۲۰۲-۱۲۳۴۵۶۷-۱ end", "id [CNIC] end", "cnic"],
    ["a Devanagari CNIC", "id ३५२०२-१२३४५६७-१ end", "id [CNIC] end", "cnic"],
    ["a CNIC in mathematical bold digits (surrogate pairs)", "id 𝟑𝟓𝟐𝟎𝟐-𝟏𝟐𝟑𝟒𝟓𝟔𝟕-𝟏 end", "id [CNIC] end", "cnic"],
    ["a CNIC mixing ASCII and Urdu digits", "id 35202-۱۲۳۴۵۶۷-1 end", "id [CNIC] end", "cnic"],
    ["a CNIC with en dashes", "id 35202\u20131234567\u20131 end", "id [CNIC] end", "cnic"],
    ["a CNIC with minus signs", "id 35202\u22121234567\u22121 end", "id [CNIC] end", "cnic"],
    ["a CNIC with non-breaking hyphens", "id 35202\u20111234567\u20111 end", "id [CNIC] end", "cnic"],
    ["a CNIC with small hyphen-minus", "id 35202\uFE631234567\uFE631 end", "id [CNIC] end", "cnic"],
    ["a CNIC separated by no-break spaces", "id 35202\u00A01234567\u00A01 end", "id [CNIC] end", "cnic"],
    ["a CNIC separated by ideographic spaces", "id 35202\u30001234567\u30001 end", "id [CNIC] end", "cnic"],
    ["a plain CNIC split by zero-width spaces", "id 35202\u200B12345\u200B67\u200B1 end", "id [CNIC] end", "cnic"],
    ["a plain CNIC split by a soft hyphen and a zero-width joiner", "id 3520\u00AD2123\u200D45671 end", "id [CNIC] end", "cnic"],
    // The isolate before the first digit and the pop after the last are outside the match, so they stay.
    ["a plain CNIC split by bidi controls", "id \u2066352021234\u2069\u202A5671\u202C end", "id \u2066[CNIC]\u202C end", "cnic"],
    ["a full-width +92 mobile", "call ＋９２ ３００ １２３４５６７ now", "call [PHONE] now", "phone"],
    ["an Arabic-Indic +92 mobile", "call +٩٢ ٣٠٠ ١٢٣٤٥٦٧ now", "call [PHONE] now", "phone"],
    ["an Urdu-digit mobile in brackets", "call (۰۳۰۰) ۱۲۳۴۵۶۷ now", "call [PHONE] now", "phone"],
    ["an Urdu-digit mobile split by an Arabic letter mark", "call ۰۳۰۰\u061C-۱۲۳۴۵۶۷ now", "call [PHONE] now", "phone"],
    ["a full-width email", "mail ｃｏｕｎｓｅｌ＠ｑａｌｖｏ．ｐｋ now", "mail [EMAIL] now", "email"],
    ["an IBAN with Urdu digits", "IBAN PK۳۶SCBL۰۰۰۰۰۰۱۱۲۳۴۵۶۷۰۲ now", "IBAN [IBAN] now", "iban"],
    ["a full-width NTN", "NTN １２３４５６７\uFF0D８ now", "[NTN] now", "ntn"],
    ["a passport with full-width characters", "Passport ＡＢ１２３４５６７ now", "[PASSPORT] now", "passport"],
  ])("masks %s", (_label, raw, expected, kind) => {
    const r = maskOutboundPII(raw)
    expect(r.masked).toBe(expected)
    expect(countsOf(r)[kind]).toBe(1)
  })

  it("an invisible character outside a match is kept; the ones inside it go with it", () => {
    const r = maskOutboundPII("CNIC\u200B 35202\u200B1234567\u200B1\u200F.")
    expect(r.masked).toBe("CNIC\u200B [CNIC]\u200F.")
  })

  it("every unmatched code unit of the original is kept exactly", () => {
    // Full-width letters, Urdu digits, NBSP, an em dash, bidi marks and an emoji outside any match stay as written.
    const before = "Ｑａｌｖｏ\u200B said \u00AB۵ دن\u00BB\u00A0\u2014 "
    const after = " ok \u200F۱۲ 🙂 ﬁle ①\n\tend"
    const r = maskOutboundPII(`${before}３５２０２\uFF0D１２３４５６７\uFF0D１${after}`)
    expect(r.masked).toBe(`${before}[CNIC]${after}`)
  })

  it("text with no identifier is returned unchanged, whatever its script", () => {
    const raw = "مقدمہ نمبر ۱۲۳۴/۲۰۲۰ مورخہ ۱۲-۰۵-۲۰۱۹ \u2014 PLD 2019 SC 123; Ｒｓ. ５,０００\u00A0only."
    expect(maskOutboundPII(raw).masked).toBe(raw)
  })
})

describe("audit F15: party names match through case, spacing and script variants (ruling 3)", () => {
  it.each([
    ["upper case and a double space", "TARIQ  ZARVANI agreed.", ["Tariq Zarvani"]],
    ["a no-break space", "tariq\u00A0zarvani agreed.", ["Tariq Zarvani"]],
    ["a line break", "Tariq\nZarvani agreed.", ["Tariq Zarvani"]],
    ["no space at all", "TariqZarvani agreed.", ["Tariq Zarvani"]],
    ["full-width letters", "Ｔａｒｉｑ Ｚａｒｖａｎｉ agreed.", ["Tariq Zarvani"]],
    ["a zero-width space inside", "Tariq Zar\u200Bvani agreed.", ["Tariq Zarvani"]],
    ["Latin diacritics in the text", "Nūra Qalvó agreed.", ["Nura Qalvo"]],
    ["Latin diacritics in the stored name", "Nura Qalvo agreed.", ["Nūra Qalvó"]],
    ["Arabic yeh for Urdu yeh", "طارق زرواني agreed.", ["طارق زروانی"]],
    ["alef maksura for Urdu yeh", "طارق زروانى agreed.", ["طارق زروانی"]],
    ["harakat on the text", "طَارِق زَرْوَانی agreed.", ["طارق زروانی"]],
    ["a tatweel", "طـارق زروانی agreed.", ["طارق زروانی"]],
    ["Arabic kaf, teh marbuta and yeh for Urdu kaf, heh goal and yeh", "نورة كلباني agreed.", ["نورہ کلبانی"]],
    ["Arabic heh for heh goal", "نوره کلبانی agreed.", ["نورہ کلبانی"]],
  ])("masks a recorded name written with %s", (_label, raw, names) => {
    const r = maskOutboundPII(raw, { partyNames: names })
    expect(r.masked).toBe("[PARTY] agreed.")
    expect(countsOf(r).party).toBe(1)
  })

  it("matches the longest name first whatever order the caller gives", () => {
    const r = maskOutboundPII("Tariq Zarvani and Tariq signed.", { partyNames: ["Tariq", "Tariq Zarvani"] })
    expect(r.masked).toBe("[PARTY] and [PARTY] signed.")
    expect(countsOf(r).party).toBe(2)
  })

  it("names that fold to the same form are matched once", () => {
    const r = maskOutboundPII("Tariq Zarvani signed.", { partyNames: ["Tariq Zarvani", "TARIQ ZARVANI", "tariq  zarvani"] })
    expect(r.masked).toBe("[PARTY] signed.")
    expect(countsOf(r).party).toBe(1)
  })

  it("a later name never matches inside an earlier match or an identifier", () => {
    const r = maskOutboundPII("Haris Qalbani, CNIC 35202-1234567-1.", { partyNames: ["Haris Qalbani", "Qalbani", "CNIC"] })
    expect(r.masked).toBe("[PARTY], [PARTY] [CNIC].")
    expect(countsOf(r)).toMatchObject({ party: 2, cnic: 1 })
  })

  it("does not invent names: unsupplied capitalised words stay (no auto-NER)", () => {
    const raw = "Kamran Qalvo met Omer Daryani."
    expect(maskOutboundPII(raw, { partyNames: ["Nura Kalbani"] }).masked).toBe(raw)
  })

  it("a name that folds to nothing is ignored", () => {
    expect(maskOutboundPII("The party agrees.", { partyNames: ["\u064B\u200B", "  "] }).masked).toBe("The party agrees.")
  })
})

describe("audit F15: assertMinimised is an independent check (ruling 6)", () => {
  const req = (body: string, purpose = "committee-brain") => ({ body, metadata: { purpose } })

  it.each([
    ["a clean masked body", req("[PARTY] asks about bail; CNIC [CNIC], mobile [PHONE]."), ["Tariq Zarvani"], true],
    ["ordinary legal prose", req("In PLD 2019 SC 123 and 2020 SCMR 456, under sections 302/324/148/149 PPC, dated 12-05-2019, Rs. 5,000,000/-; the son of the deceased deposed."), [], true],
    ["masked values after identity cues", req("CNIC No. [CNIC], Mobile: [PHONE], s/o [PARTY], son of late [PARTY], ولد [PARTY]."), [], true],
    ["an ASCII CNIC the mask would still match", req("CNIC 42101-1234567-1"), [], false],
    ["a full-width CNIC in the body", req("CNIC ３５２０２\uFF0D１２３４５６７\uFF0D１"), [], false],
    ["an Urdu-digit mobile in the purpose", req("[PARTY] asks.", "call ۰۳۰۰-۱۲۳۴۵۶۷"), [], false],
    ["a recorded name written in upper case with two spaces", req("TARIQ  ZARVANI asks."), ["Tariq Zarvani"], false],
    ["an address the mask has no rule for", req("The accused r/o House 12, Street 5, Lahore."), [], false],
    ["a parentage clause", req("The accused s/o Kamran was arrested."), [], false],
    ["an Urdu parentage clause", req("ملزم ولد کامران گرفتار ہوا۔"), [], false],
    ["a landline the mask has no rule for", req("Office 042 3576 1234."), [], false],
    ["a labelled passport number the mask's format misses", req("Passport No. A1234567."), [], false],
  ])("%s", (_label, request, names, expected) => {
    expect(assertMinimised(request as never, names as string[])).toBe(expected)
  })
})
