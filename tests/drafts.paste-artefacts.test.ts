// Review round 4, FP5 and FP6: harmless paste artefacts are cleaned before the charset check
// (the stored body is the cleaned, normalised one); the mixed-script rule applies per letter run.
import { describe, expect, it } from "vitest"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"

const normalised = (text: string) => {
  const check = checkDraftCharset(text)
  expect(check.ok, JSON.stringify(check)).toBe(true)
  return check.ok ? check.normalised : ""
}

describe("FP5: paste artefacts", () => {
  it("a leading BOM is stripped", () => {
    expect(normalised("﻿IN THE HIGH COURT OF SINDH AT KARACHI")).toBe("IN THE HIGH COURT OF SINDH AT KARACHI")
  })
  it("VT (Word manual line break) and FF (page break) become newlines", () => {
    expect(normalised("IN THE COURT OF\u000bCIVIL JUDGE")).toBe("IN THE COURT OF\nCIVIL JUDGE")
    expect(normalised("PRAYER\u000cIt is prayed")).toBe("PRAYER\nIt is prayed")
  })
  it("Latin ligatures (U+FB00-FB06) are expanded", () => {
    expect(normalised("The suit was ﬁled and ﬂagged; eﬀect, suﬃx, baﬄe, ﬅ, ﬆop")).toBe(
      "The suit was filed and flagged; effect, suffix, baffle, st, stop"
    )
  })
  it("a soft hyphen or ZWSP between letters of the same script is dropped; a ZWSP next to a blank too", () => {
    expect(normalised("The re­spondent failed")).toBe("The respondent failed")
    expect(normalised("The petitioner​ is aggrieved")).toBe("The petitioner is aggrieved")
    expect(normalised("مل​زم")).toBe("ملزم")
    // a reporter split this way is now read, so the gate sees it
    expect(normalised("2019 SC­MR 1234")).toBe("2019 SCMR 1234")
  })
  it("disguising uses stay refused: between digits, across scripts, a BOM mid-text, bidi, other controls", () => {
    for (const text of [
      "2019 SCMR 12​34",
      "2019 SCMR 12­34",
      "SC­2019",
      "S​س",
      "text ﻿mid",
      "a ‮x",
      "bell\u0007",
    ]) {
      expect(checkDraftCharset(text).ok, JSON.stringify(text)).toBe(false)
    }
  })
})
