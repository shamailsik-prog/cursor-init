// Review round 4 (review-secgaps-r4.md): security findings R4-1, R4-3 and the false-positive fixes.
import { describe, expect, it } from "vitest"
import { newStore } from "@/platform/spine/store"
import { extractCitations } from "@/services/d4-2/citations"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"
import { seedJudgment, seedTreatment, verifyCitations } from "@/services/d4-2/draftingIntelligence"

const isSuspect = (ref: string) => ref.startsWith("UNRECOGNISED: ")

function overruledStore() {
  const store = newStore()
  seedJudgment(store, "j-larger", "Larger", "larger", "2025 SCMR 999")
  seedJudgment(store, "j-over", "Over", "single", "2019 SCMR 1234")
  seedTreatment(store, "j-larger", "j-over", "overruled", "larger")
  for (const d of ["2019 SCMR 1", "2019 SCMR 12", "2019 SCMR 123", "2019 SCMR 34", "2019 SCMR 1204"]) seedJudgment(store, "d-" + d, d, "full", d)
  return store
}

describe("R4-1 (charset): a non-ASCII symbol or punctuation mark between two letters of a Latin token is refused", () => {
  it.each(["∁", "⊂", "¢", "©", "\u{1f172}", "®", "•", "·", "‽", "∴"])("2019 S%sMR 1234", (ch) => {
    const check = checkDraftCharset(`Relying on 2019 S${ch}MR 1234.`)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.violations.some((v) => /between two letters/.test(v.reason))).toBe(true)
  })
  it("ordinary intra-word punctuation stays allowed (' ’ - – . & /), and symbols outside words too", () => {
    for (const text of [
      "The respondent’s counsel didn't appear",
      "Gulshan-e-Iqbal and Gulshan–e–Iqbal",
      "M/s Engro and AT&T and U.S.A.",
      "Engro® and Sona™ urea; © 2024 Engro",
      "temperature 40°C, § 497 and ¶ 12",
    ]) {
      expect(checkDraftCharset(text).ok, text).toBe(true)
    }
  })
})

describe("R4-1 (gate): a token one edit away from a reporter, next to year/page numbers, is UNVERIFIED", () => {
  it.each([
    "Relying on 2019 SCNR 1234.",
    "Relying on 2019 SXCMR 1234.",
    "Relying on 2019 SMR 1234.",
    "Relying on 2019 S∁MR 1234.",
    "Relying on 2019 S©MR 1234.",
    "Relying on PLQ 2019 SC 123.",
    "Relying on 2019 PCrLX 44.",
  ])("%j", (text) => {
    const refs = extractCitations(text)
    expect(refs.length, text).toBeGreaterThan(0)
    const res = verifyCitations(overruledStore(), refs)
    expect(res.status).not.toBe("OK")
    expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
  })
  it("ordinary words and organisations next to numbers are not suspects", () => {
    for (const text of [
      "the old 2019 rule had 5 parts",
      "In 2023 SECP issued 4 show-cause notices",
      "Since 2020 NADRA has issued 2 CNICs",
      "In 2018 PTI won 116 seats",
      "In 2019 CID filed 5 reports",
    ]) {
      expect(extractCitations(text), text).toEqual([])
    }
  })
})
