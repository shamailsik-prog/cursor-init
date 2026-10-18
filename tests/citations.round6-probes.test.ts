// Review round 6 probe fn7 (secrev6/repo/tests/sr6/fn7.probe.test.ts) as a regression matrix.
import { describe, expect, it } from "vitest"
import { extractCitations, type AnalyseOptions, isUnrecognisedRef as isSuspect } from "@/services/d4-2/citations"
import { ownCaseReferenceMatcher } from "@/services/d4-1/drafts"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"

// "none": reads nothing; "blocked": suspects only; "refused": charset 422; a string: exact read
type Expect = "none" | "blocked" | "refused" | string
const shc: AnalyseOptions = { isOwnCaseReference: ownCaseReferenceMatcher({ courtId: "SHC", caseNumber: "CP 12/2019" }) }
const FN7: Array<[string, string, Expect, AnalyseOptions?]> = [
  ["SC مقدمہ + زیر دفعہ 302", "سپریم کورٹ کے مقدمہ نمبر ۱۲ بابت ۲۰۱۹ زیر دفعہ ۳۰۲ میں قرار دیا گیا", "blocked"],
  ["SC مقدمہ + تھانہ later in clause", "سپریم کورٹ کے مقدمہ نمبر ۱۲ بابت ۲۰۱۹ میں جو تھانہ صدر سے متعلق تھا قرار دیا گیا", "blocked"],
  ["LHC مقدمہ + تھانہ before", "تھانہ صدر کے حوالے سے لاہور ہائی کورٹ کے مقدمہ نمبر ۱۲ بابت ۲۰۱۹ میں قرار دیا گیا", "blocked"],
  ["control SC مقدمہ alone", "سپریم کورٹ کے مقدمہ نمبر ۱۲ بابت ۲۰۱۹ میں قرار دیا گیا", "blocked"],
  ["reported Urdu reporter in FIR clause", "تھانہ صدر کے مقدمہ میں ۲۰۱۹ ایس سی ایم آر ۱۲۳۴ پر انحصار کیا گیا", "blocked"],
  ["own SHC; 'Lahore' bare city", "The learned Lahore bench in C.P. No. 12 of 2019 held that …", "blocked", shc],
  ["own SHC; 'Islamabad' bare city", "In Islamabad C.P. No. 12 of 2019 the court held …", "blocked", shc],
  ["own SHC; 'LHC' abbreviation", "In LHC C.P. No. 12 of 2019 it was held …", "blocked", shc],
  ["own SHC; 'Supreme Court' far", "The Supreme Court of Pakistan, in its detailed judgment in C.P. No. 12 of 2019, held …", "blocked", shc],
  ["own SHC; 'apex court'", "The apex court in C.P. No. 12 of 2019 held …", "blocked", shc],
  ["own SHC; 'Honourable Supreme Court' after", "In C.P. No. 12 of 2019 the Honourable Supreme Court held …", "blocked", shc],
  ["own SHC; own court named", "This Honourable Sindh High Court in C.P. No. 12 of 2019 …", "none", shc],
  ["spelled: SCMR", "Relying on 2019 Supreme Court Monthly Review 1234.", "2019 SCMR 1234"],
  ["spelled: SCR", "Relying on 2019 Supreme Court Reports 100.", "2019 SCR 100"],
  ["spelled: hyphenated SCMR", "Relying on 2019 Supreme-Court Monthly Review 1234.", "2019 SCMR 1234"],
  ["spelled: across a line break", "Relying on 2019 Supreme Court\nMonthly Review 1234.", "2019 SCMR 1234"],
  // names outside the ruled list are not resolved (decision: only the ruled names)
  ["spelled: not a ruled name (Pakistan Law Cases)", "Relying on 2019 Pakistan Law Cases 77.", "none"],
  ["spelled: not a ruled name (Pakistan Tax Cases Law)", "Relying on 2019 Pakistan Tax Cases Law 1234.", "none"],
  ["spelled: truncated (Supreme Court Monthly)", "Relying on 2019 Supreme Court Monthly 1234.", "none"],
  ["spelled: mixed (SC Monthly Review)", "Relying on 2019 SC Monthly Review 1234.", "none"],
  ["spelled: prose mention", "Relying on the Civil Law Cases cited in 2019 by 5 judges.", "none"],
  ["spelled: MLD edition", "Relying on Monthly Law Digest 2019 edition, page 5.", "blocked"],
  ["period: numeral sentence", "Reliance is placed on 2015 SCMR 100. 5 witnesses were examined.", "2015 SCMR 100"],
  ["period: numbered next paragraph", "Reliance is placed on 2015 SCMR 100.\n5. That the respondent failed to appear.", "2015 SCMR 100"],
  ["period: enumeration", "See 2015 SCMR 100. 2. The second point is limitation.", "2015 SCMR 100"],
  ["period: days later", "See 2015 SCMR 100.  12 days later the order was passed.", "2015 SCMR 100"],
  ["period: of the", "See PLD 2010 SC 1. 3 of the 5 grounds fail.", "PLD 2010 SC 1"],
  ["symbol: × as versus", "The parties are ABC × XYZ in this matter.", "none"],
  ["symbol: ® ™", "Qalvo® PLC and PTCL™ services", "none"],
  ["symbol: №", "№ 12 of the register", "none"],
  ["symbol: ∑", "Total = PKR 5,000 ∑ of all heads", "none"],
  ["symbol: ⊤ beside SECP", "Item ⊤ SECP filing", "refused"],
  ["symbol: |", "Sales: Rs. 500 | NTN 123", "none"],
  ["symbol: ∣ beside ABC", "Clause (a) ∣ ABC", "refused"],
  ["symbol: ⋁", "AB ⋁ CD", "refused"],
  ["symbol: ⅼ", "Vs. ABC ⅼ", "none"],
]

describe("review round 6 fn7 probe matrix", () => {
  it.each(FN7)("%s", (_label, body, expected, options) => {
    const check = checkDraftCharset(body)
    if (expected === "refused") {
      expect(check.ok).toBe(false)
      return
    }
    expect(check.ok).toBe(true)
    if (!check.ok) return
    const refs = extractCitations(check.normalised, options ?? {})
    if (expected === "none") expect(refs).toEqual([])
    else if (expected === "blocked") {
      expect(refs.length).toBeGreaterThan(0)
      expect(refs.every(isSuspect), JSON.stringify(refs)).toBe(true)
    } else expect(refs).toContain(expected)
  })
})
