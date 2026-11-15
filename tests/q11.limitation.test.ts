/**
 * Q11 limitation engine. Periods come only from VERIFIED text in force on the
 * accrual date. Fixture sentences below are parser fixtures. They are not the
 * gazetted Limitation Act, and they are not a supported-article table.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { loadCourts } from "@/core/case-number-normaliser"
import courtsSeed from "@/data/courts.json"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { scheduleLimitationAlerts } from "@/services/d6-1/limitationAlerts"
import {
  REPO_COURT_CALENDAR,
  applyLimitation,
  checkLimitation,
  type CourtCalendar,
  type LimitationVersion,
} from "@/services/d4-2/limitation"
import { coveringVersion, type SectionVersionRow } from "@/services/d4-2/sectionInForce"
import { AuthorityUnavailableError } from "@/functions/src/d4/authorityErrors"
import { coveringVersion as corpusCoveringVersion } from "@/functions/src/d4/corpusAuthorityStore"
import { listCourtOpsQueue } from "@/services/d2-2/courtOps"
import { seedUser } from "@/platform/p5/checkPermission"
import { newStore } from "@/platform/spine/store"

const ROOT = path.resolve(__dirname, "..")
const RECKONING =
  "In computing the period of limitation the day from which such period is to be reckoned shall be excluded."
const MONTH_END =
  "If the corresponding date does not exist, the period expires on the last day of that month."
const SECTION_4 =
  "Q11 FIXTURE. Where the period expires on a day when the court is closed, the suit may be instituted on the day the court re-opens."
const SECTION_12_COPY =
  "Q11 FIXTURE. Exclude the time requisite for obtaining a copy of the decree."
const SECTION_14 =
  "Q11 FIXTURE. Exclude the time spent prosecuting the claim in a court without jurisdiction."

const OPEN: CourtCalendar = { isClosed: () => false }

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function version(
  sectionId: string,
  text: string,
  from: string,
  to: string | null,
  versionNo: number,
  overrides: Partial<LimitationVersion> = {}
): LimitationVersion {
  return {
    sectionId,
    jurisdiction: "Punjab",
    versionNo,
    effectiveFrom: from,
    effectiveTo: to,
    text,
    reviewStatus: "VERIFIED",
    versionConfidence: 0.9,
    ...overrides,
  }
}

function articleText(period: string, extra = ""): string {
  // No digit in the label: the period reader counts every digit run in the provision.
  return `LIMITATION FIXTURE. The period of limitation is ${period}. ${RECKONING}${extra ? ` ${extra}` : ""}`
}

function article(
  period: string,
  from = "1908-01-01",
  to: string | null = null,
  versionNo = 1,
  extra = "",
  overrides: Partial<LimitationVersion> = {}
): LimitationVersion {
  const text = articleText(period, extra)
  return version("limitation-act-1908/article/7", text, from, to, versionNo, overrides)
}

function base(period = "three years", extra = ""): LimitationVersion[] {
  return [article(period, "1908-01-01", null, 1, extra), version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1)]
}

function assessed(
  accrualDate: string,
  versions: LimitationVersion[],
  extras: Partial<Parameters<typeof checkLimitation>[0]> = {}
) {
  return checkLimitation({
    article: "7",
    accrualDate,
    filingForum: "LHC",
    versions,
    calendar: OPEN,
    ...extras,
  })
}

describe("Q11 checkLimitation", () => {
  it("uses the version in force before an amendment and the later version after it", () => {
    const before = articleText("three years")
    const after = articleText("one year")
    const versions = [
      version("limitation-act-1908/article/7", before, "1908-01-01", "2010-06-15", 1),
      version("limitation-act-1908/article/7", after, "2010-06-15", null, 2),
      version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1),
    ]
    const early = assessed("2010-06-14", versions)
    const late = assessed("2010-06-15", versions)
    expect(early.status).toBe("ASSESSED")
    expect(late.status).toBe("ASSESSED")
    if (early.status !== "ASSESSED" || late.status !== "ASSESSED") return
    expect(early.deadline).toBe("2013-06-14")
    expect(late.deadline).toBe("2011-06-15")
    expect(early.governing.versionNo).toBe(1)
    expect(late.governing.versionNo).toBe(2)
    expect(early.governing.textSha256).toBe(sha(before))
    expect(late.governing.textSha256).toBe(sha(after))
    expect(early.governing.effectiveTo).toBe("2010-06-15")
    expect(late.governing.effectiveFrom).toBe("2010-06-15")
    expect(early.governing.sectionId).toBe("limitation-act-1908/article/7")
    expect(early.deadline).not.toBe(late.deadline)
  })

  it("counts a leap day and the day after a non-leap February", () => {
    const leap = assessed("2024-02-28", base("one day"))
    const ordinary = assessed("2023-02-28", base("one day"))
    expect(leap.status).toBe("ASSESSED")
    expect(ordinary.status).toBe("ASSESSED")
    if (leap.status !== "ASSESSED" || ordinary.status !== "ASSESSED") return
    expect(leap.deadline).toBe("2024-02-29")
    expect(ordinary.deadline).toBe("2023-03-01")
  })

  it("leaves a missing anniversary NOT_ASSESSED unless the verified text states the last day of the month", () => {
    const silent = assessed("2024-01-31", base("one month"))
    const leapClamp = assessed("2024-01-31", base("one month", MONTH_END))
    const ordinaryClamp = assessed("2023-01-31", base("one month", MONTH_END))
    const feb30 = assessed("2024-01-30", base("one month", MONTH_END))
    const anniversary = assessed("2020-02-29", base("one year"))
    const anniversaryClamp = assessed("2020-02-29", base("one year", MONTH_END))
    const exists = assessed("2024-01-15", base("one month"))
    expect(silent).toMatchObject({ status: "NOT_ASSESSED", reason: "anniversary_does_not_exist", deadline: null })
    expect(anniversary).toMatchObject({ status: "NOT_ASSESSED", reason: "anniversary_does_not_exist", deadline: null })
    expect(leapClamp.status).toBe("ASSESSED")
    expect(ordinaryClamp.status).toBe("ASSESSED")
    expect(feb30.status).toBe("ASSESSED")
    expect(anniversaryClamp.status).toBe("ASSESSED")
    expect(exists.status).toBe("ASSESSED")
    if (
      leapClamp.status !== "ASSESSED" ||
      ordinaryClamp.status !== "ASSESSED" ||
      feb30.status !== "ASSESSED" ||
      anniversaryClamp.status !== "ASSESSED" ||
      exists.status !== "ASSESSED"
    ) {
      return
    }
    expect(leapClamp.deadline).toBe("2024-02-29")
    expect(anniversaryClamp.deadline).toBe("2021-02-28")
    expect(ordinaryClamp.deadline).toBe("2023-02-28")
    expect(feb30.deadline).toBe("2024-02-29")
    expect(exists.deadline).toBe("2024-02-15")
  })

  it("excludes the accrual day by adding the stated period, for a day count", () => {
    const result = assessed("2024-01-01", base("thirty days"))
    expect(result.status).toBe("ASSESSED")
    if (result.status !== "ASSESSED") return
    expect(result.deadline).toBe("2024-01-31")
    expect(result.exclusionsApplied).toEqual([
      expect.objectContaining({ section: "12", effect: "exclude-accrual-day", statedIn: "article" }),
    ])
  })

  it("reads the reckoning sentence from verified section 12 when the article does not state it", () => {
    const text = "LIMITATION FIXTURE. The period of limitation is three years."
    const versions = [
      version("limitation-act-1908/article/7", text, "1908-01-01", null, 1),
      version("limitation-act-1908/section/12", `Q11 FIXTURE. ${RECKONING}`, "1908-01-01", null, 1),
    ]
    const result = assessed("2020-01-01", versions)
    expect(result.status).toBe("ASSESSED")
    if (result.status !== "ASSESSED") return
    expect(result.deadline).toBe("2023-01-01")
    expect(result.exclusionsApplied).toEqual([
      expect.objectContaining({ section: "12", effect: "exclude-accrual-day", statedIn: "section", versionNo: 1 }),
    ])
  })

  it("does not guess a period, a forum, or an unverified text", () => {
    expect(assessed("2020-01-01", [])).toMatchObject({ status: "NOT_ASSESSED", reason: "no_history", deadline: null, alerts: [] })
    expect(checkLimitation({ article: "breach of contract", accrualDate: "2020-01-01", filingForum: "LHC", versions: base(), calendar: OPEN })).toMatchObject({ status: "NOT_ASSESSED", reason: "unknown_article" })
    expect(checkLimitation({ article: "113", accrualDate: "2020-01-01", filingForum: "LHC", versions: [], calendar: OPEN })).toMatchObject({ status: "NOT_ASSESSED", reason: "no_history" })
    expect(checkLimitation({ article: "", accrualDate: "2020-01-01", filingForum: "LHC", versions: base(), calendar: OPEN })).toMatchObject({ status: "NOT_ASSESSED", reason: "missing_inputs" })
    expect(checkLimitation({ article: "7", accrualDate: null, filingForum: "LHC", versions: base(), calendar: OPEN })).toMatchObject({ status: "NOT_ASSESSED", reason: "missing_inputs" })
    expect(checkLimitation({ article: "7", accrualDate: "2024-02-30", filingForum: "LHC", versions: base(), calendar: OPEN })).toMatchObject({ status: "NOT_ASSESSED", reason: "missing_inputs" })
    expect(checkLimitation({ article: "7", accrualDate: "2020-01-01", filingForum: "", versions: base(), calendar: OPEN })).toMatchObject({ status: "NOT_ASSESSED", reason: "missing_inputs" })
    expect(checkLimitation({ article: "7", accrualDate: "2020-01-01", filingForum: "NOT_A_COURT", versions: base(), calendar: OPEN })).toMatchObject({ status: "NOT_ASSESSED", reason: "unknown_forum" })
    expect(assessed("2020-01-01", [article("three years", "1908-01-01", null, 1, "", { reviewStatus: "UNVERIFIED" })])).toMatchObject({ status: "NOT_ASSESSED", reason: "text_not_verified" })
    expect(assessed("2020-01-01", [article("three years", "1908-01-01", null, 1, "", { reviewStatus: "QUARANTINED" })])).toMatchObject({ status: "NOT_ASSESSED", reason: "text_not_verified" })
    expect(assessed("2020-01-01", [article("three years", "1908-01-01", null, 1, "", { versionConfidence: 0.5 })])).toMatchObject({ status: "NOT_ASSESSED", reason: "text_not_verified" })
    expect(assessed("2020-01-01", base("three years or one year"))).toMatchObject({ status: "NOT_ASSESSED", reason: "period_unreadable", deadline: null })
    expect(assessed("2020-01-01", base("twenty one days"))).toMatchObject({ status: "ASSESSED", deadline: "2020-01-22" })
    expect(assessed("2020-01-01", base("one hundred and twenty years"))).toMatchObject({ status: "NOT_ASSESSED", reason: "period_unreadable", deadline: null })
    expect(assessed("2020-01-01", base("twenty days"))).toMatchObject({ status: "ASSESSED", deadline: "2020-01-21" })
    expect(assessed("2020-01-01", [version("limitation-act-1908/article/7", "Q11 FIXTURE. No period is stated in this text.", "1908-01-01", null, 1)])).toMatchObject({ status: "NOT_ASSESSED", reason: "period_unreadable" })
    const sindh = [article("three years", "1908-01-01", null, 1, "", { jurisdiction: "Sindh" })]
    expect(assessed("2020-01-01", sindh)).toMatchObject({ status: "NOT_ASSESSED", reason: "no_history" })
    const usable = assessed("2020-01-01", [article("three years", "1908-01-01", null, 1, "", { versionConfidence: 0.51 })])
    expect(usable.status).toBe("ASSESSED")
  })

  it("FA-Q11-PARSE-001 reads a tens-and-ones compound and rejects a second period phrase", () => {
    expect(assessed("2020-01-01", base("Seventy one years"))).toMatchObject({ status: "ASSESSED", deadline: "2091-01-01" })
    expect(assessed("2020-01-01", base("Eighty one years"))).toMatchObject({ status: "ASSESSED", deadline: "2101-01-01" })
    for (const period of [
      "Seventy years. The schedule also says thirty days",
      "three years or one year",
    ]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("FA-Q11-PARSE-002 rejects decimals and fractions, and reads a compound split only by space", () => {
    expect(assessed("2020-01-01", base("Twenty\none years"))).toMatchObject({ status: "ASSESSED", deadline: "2041-01-01" })
    expect(assessed("2020-01-01", base("Twenty\u00A0one years"))).toMatchObject({ status: "ASSESSED", deadline: "2041-01-01" })
    for (const period of ["2.5 years", "1 1/2 years"]) {
      expect(assessed("2020-01-01", base(period)), JSON.stringify(period)).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("FA-Q11-PARSE-004 rejects dashes, Arabic separators, and fillers next to a number", () => {
    const joiners = ["\u2013", "\u2014", "\u2010", "\u2011", "\u2212", "_", "\u034F", "\u3164", "\u2800"]
    const periods = [
      ...joiners.map((joiner) => `Twenty${joiner}one years`),
      `Thirty\u2013one years`,
      "2\u060C5 years",
      "2\u066B5 years",
      "2;5 years",
      "2:5 years",
      "2\u20135 years",
      "1\u066C500 days",
      "1'500 days",
      "1\u2019500 days",
    ]
    for (const period of periods) {
      expect(assessed("2020-01-01", base(period)), JSON.stringify(period)).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("FA-Q11-PARSE-005 rejects a second quantity, an abbreviation, or an extra unit", () => {
    for (const period of [
      "One or two years",
      "Two to five years",
      "Three or five years",
      "2 to 5 years",
      "Three years and a half",
      "Three years and a quarter",
      "One year and a half",
      "Three years and six weeks",
      "Three years or six weeks",
      "Three years and some months",
      "a couple of months",
      "6 mos",
      "six mths",
      "Ninety days and twelve hours",
    ]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("TEST-R3-001 rejects two fortnights and keeps fortnights in the unit list", () => {
    expect(assessed("2020-01-01", base("Three years or two fortnights"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
    expect(assessed("2020-01-01", base("three years or fortnights"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
  })

  it("INFO digits joined only by a stripped format character stay unreadable", () => {
    expect(assessed("2020-01-01", base("1\u200B500 days"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
  })

  it("FA-Q11-PARSE-006 rejects superscript and subscript digits", () => {
    for (const period of ["3\u00B9 years", "90\u00B2 days", "3\u2081 years", "3\u00B2 years"]) {
      expect(assessed("2020-01-01", base(period)), JSON.stringify(period)).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("FA-Q11-PARSE-007 rejects a number or unit hidden inside a proviso", () => {
    const reckoning =
      "LIMITATION FIXTURE. The period of limitation is three years. In computing the period of limitation the day from which the period of six months is to be reckoned shall be excluded."
    const monthEnd =
      "If the corresponding date does not exist, add thirty days, the period expires on the last day of that month."
    expect(assessed("2020-01-01", base("three years").map((row, index) => (index === 0 ? { ...row, text: reckoning } : row)))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
    expect(assessed("2020-01-01", base("one month", monthEnd))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
  })

  it("FA-Q11-PARSE-008 allows only a space or an opening parenthesis before a number", () => {
    for (const period of [".5 years", "~5 years", "+5 years", "#5 years", "$5 years", "@5 years", "*5 years", "/5 years"]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
    expect(assessed("2020-01-01", base("(5 years)"))).toMatchObject({ status: "ASSESSED", deadline: "2025-01-01" })
    expect(assessed("2020-01-01", base("(three years)"))).toMatchObject({ status: "ASSESSED", deadline: "2023-01-01" })
  })

  it("TEST-R4-001 pins the gap, neighbour, to, half, and range checks", () => {
    for (const period of ["three of years", "years three from"]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
    for (const period of ["\u00A75 years", "\u00A7 5 years", "5\u00A7 years"]) {
      expect(assessed("2020-01-01", base(period)), JSON.stringify(period)).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
    for (const period of ["to five years", "to 5 years"]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
    expect(assessed("2020-01-01", base("half a year"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
    expect(assessed("2020-01-01", base("10000 years"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
    expect(assessed("2020-01-01", base("0 years"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
    expect(assessed("2020-01-01", base("9999 days"))).toMatchObject({ status: "ASSESSED", deadline: "2047-05-18" })
    expect(assessed("2020-01-01", base("1 year"))).toMatchObject({ status: "ASSESSED", deadline: "2021-01-01" })
  })

  it("INFO a qualifier is not the plain period", () => {
    for (const period of ["three years or more", "at least three years", "twice three years", "five years or more", "at least 5 years"]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("R3 regression keeps a single canonical period, including an ASCII compound", () => {
    expect(assessed("2020-01-01", base("Ninety days"))).toMatchObject({ status: "ASSESSED", deadline: "2020-03-31" })
    expect(assessed("2020-01-01", base("Eleven years"))).toMatchObject({ status: "ASSESSED", deadline: "2031-01-01" })
    expect(assessed("2020-01-01", base("period of three years from"))).toMatchObject({ status: "ASSESSED", deadline: "2023-01-01" })
    expect(assessed("2020-01-01", base("Ninety\u00A0days"))).toMatchObject({ status: "ASSESSED", deadline: "2020-03-31" })
    expect(assessed("2020-01-01", base("Ninety\r\ndays"))).toMatchObject({ status: "ASSESSED", deadline: "2020-03-31" })
    expect(assessed("2020-01-01", base("Twenty-one years"))).toMatchObject({ status: "ASSESSED", deadline: "2041-01-01" })
    expect(assessed("2020-01-01", base("twenty one days"))).toMatchObject({ status: "ASSESSED", deadline: "2020-01-22" })
  })

  it("CONF-001 rejects a null version confidence", () => {
    expect(
      assessed("2020-01-01", [article("three years", "1908-01-01", null, 1, "", { versionConfidence: null })])
    ).toMatchObject({ status: "NOT_ASSESSED", reason: "text_not_verified", deadline: null })
  })

  it("FA-Q11-PARSE-001-R2 rejects a year and months joined by and", () => {
    for (const period of ["One year and six months", "Three years and six months"]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("P6 a number word after and is not a period when the lookbehind guard is removed", () => {
    expect(assessed("2020-01-01", base("and twenty years"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
  })

  it("FA-Q11-PARSE-002-R2 rejects separated digits and format-character splits", () => {
    for (const period of [
      "2,5 years",
      "2 . 5 years",
      "2\u00B75 years",
      "1,500 days",
      "1 500 days",
      "3 1 years",
      "Twenty\u00ADone years",
      "Twenty\u200Bone years",
      "Twenty\u200Done years",
      "Twenty\u2060one years",
    ]) {
      expect(assessed("2020-01-01", base(period)), JSON.stringify(period)).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("PARSE-003 rejects a second period expression, a fortnight, or an ordinal month", () => {
    for (const period of [
      "Three years; a year after the accrual",
      "Three years or a fortnight",
      "Three years in the twelfth month",
    ]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("CONF-001 rejects a missing or non-numeric version confidence", () => {
    const bad: unknown[] = [undefined, "0.9", "abc", true, {}]
    for (const value of bad) {
      const row = article("three years")
      Object.assign(row, { versionConfidence: value })
      expect(assessed("2020-01-01", [row]), JSON.stringify(value)).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "text_not_verified",
        deadline: null,
      })
    }
    const store = newStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "Q11 confidence",
      courtId: "LHC",
      classification: "internal",
    })
    const stored = article("three years")
    delete stored.versionConfidence
    store.sectionVersions.push({ ...stored })
    expect(
      applyLimitation(store, { matterId: matter.id, article: "7", accrualDate: "2020-01-01", filingForum: "LHC", calendar: OPEN })
    ).toMatchObject({ status: "NOT_ASSESSED", reason: "text_not_verified", deadline: null })
    expect(store.followUps).toHaveLength(0)
  })

  it("DATE-001 refuses an accrual date after today", () => {
    const accrual = `${new Date().getUTCFullYear() + 1}-01-01`
    expect(assessed(accrual, base())).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "accrual_in_future",
      deadline: null,
      governing: null,
      alerts: [],
    })
  })

  it("D2 assesses an accrual on today's UTC date and refuses tomorrow", () => {
    const now = new Date()
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    const iso = (date: Date) =>
      `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
    expect(assessed(iso(today), base()).status).toBe("ASSESSED")
    expect(assessed(iso(tomorrow), base())).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "accrual_in_future",
      deadline: null,
    })
  })

  it("does not pick a text when the version history overlaps", () => {
    const versions = [
      article("three years", "1908-01-01", "2011-01-01", 1),
      article("one year", "2010-01-01", null, 2),
    ]
    expect(assessed("2010-06-01", versions)).toMatchObject({ status: "NOT_ASSESSED", reason: "version_inconsistent", deadline: null })
  })

  it("refuses a pleaded exclusion the verified text does not support", () => {
    const copy = assessed("2020-01-01", base(), { pleaded: { copyDays: 12 } })
    const wrong = assessed("2020-01-01", base(), { pleaded: { wrongCourtDays: 14 } })
    expect(copy).toMatchObject({ status: "NOT_ASSESSED", reason: "exclusion_unsupported", deadline: null })
    expect(wrong).toMatchObject({ status: "NOT_ASSESSED", reason: "exclusion_unsupported", deadline: null })
  })

  it("adds copy time and time in a court without jurisdiction only from verified sections 12 and 14", () => {
    const versions = [
      ...base(),
      version("limitation-act-1908/section/12", SECTION_12_COPY, "1908-01-01", null, 1),
      version("limitation-act-1908/section/14", SECTION_14, "1908-01-01", null, 1),
    ]
    const copy = assessed("2020-01-01", versions, { pleaded: { copyDays: 12 } })
    const both = assessed("2020-01-01", versions, { pleaded: { copyDays: 12, wrongCourtDays: 5 } })
    expect(copy.status).toBe("ASSESSED")
    expect(both.status).toBe("ASSESSED")
    if (copy.status !== "ASSESSED" || both.status !== "ASSESSED") return
    expect(copy.deadline).toBe("2023-01-13")
    expect(both.deadline).toBe("2023-01-18")
    expect(copy.exclusionsApplied).toEqual(
      expect.arrayContaining([expect.objectContaining({ section: "12", effect: "exclude-copy-time", days: 12 })])
    )
    expect(both.exclusionsApplied).toEqual(
      expect.arrayContaining([expect.objectContaining({ section: "14", effect: "exclude-wrong-court", days: 5 })])
    )
  })

  it("does not shift for a closed court when the repository has no calendar", () => {
    expect(REPO_COURT_CALENDAR).toBeNull()
    const result = checkLimitation({
      article: "Article 7",
      accrualDate: "2020-01-01",
      filingForum: "LHC",
      versions: base(),
      calendar: null,
    })
    expect(result.status).toBe("ASSESSED")
    if (result.status !== "ASSESSED") return
    expect(result.deadline).toBe("2023-01-01")
    expect(result.courtClosed).toEqual({ status: "NOT_ASSESSED", reason: "no_court_calendar" })
    expect(result.exclusionsApplied.some((row) => row.section === "4")).toBe(false)
    expect(result.alerts.map((row) => [row.daysBefore, row.dueOn])).toEqual([
      [90, "2022-10-03"],
      [30, "2022-12-02"],
      [7, "2022-12-25"],
    ])
  })

  it("moves the deadline to the next open day only when a calendar and verified section 4 both say so", () => {
    const closedOnExpiry: CourtCalendar = { isClosed: (_forum, day) => day === "2024-02-29" || day === "2024-03-01" }
    const shifted = assessed("2024-02-28", base("one day"), { calendar: closedOnExpiry })
    const noText = assessed("2024-02-28", [article("one day")], { calendar: closedOnExpiry })
    const openDay = assessed("2024-02-28", [article("one day")], { calendar: OPEN })
    expect(shifted.status).toBe("ASSESSED")
    if (shifted.status !== "ASSESSED") return
    expect(shifted.deadline).toBe("2024-03-02")
    expect(shifted.exclusionsApplied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: "4", effect: "next-open-day", from: "2024-02-29", to: "2024-03-02" }),
      ])
    )
    expect(noText).toMatchObject({ status: "NOT_ASSESSED", reason: "court_closed_rule_unverified", deadline: null })
    expect(openDay.status).toBe("ASSESSED")
    if (openDay.status !== "ASSESSED") return
    expect(openDay.deadline).toBe("2024-02-29")
    expect(openDay.courtClosed).toEqual({ status: "CHECKED", closed: false })
  })

  it("stops a closed-court roll that does not find an open day", () => {
    const alwaysClosed: CourtCalendar = { isClosed: () => true }
    expect(assessed("2024-02-28", base("one day"), { calendar: alwaysClosed })).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "court_closed_unresolved",
      deadline: null,
    })
  })
})

describe("Q11 diary alerts and relevant law dates", () => {
  function matterStore() {
    const store = newStore()
    seedUser(store, { id: "clerk1", firmId: "firmA", role: "clerk", clearanceLevel: "internal" })
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "Q11 fixture",
      courtId: "LHC",
      classification: "internal",
    })
    addMember(store, matter.id, "clerk1", "firmA")
    for (const row of base()) store.sectionVersions.push({ ...row })
    return { store, matter }
  }

  it("schedules 90, 30 and 7 day diary rows through the court-ops follow-up queue and does not deliver them", () => {
    const { store, matter } = matterStore()
    const first = applyLimitation(store, {
      matterId: matter.id,
      article: "7",
      accrualDate: "2021-06-01",
      filingForum: "LHC",
      calendar: OPEN,
    })
    const second = applyLimitation(store, {
      matterId: matter.id,
      article: "7",
      accrualDate: "2021-06-01",
      filingForum: "LHC",
      calendar: OPEN,
    })
    expect(first.status).toBe("ASSESSED")
    expect(second.status).toBe("ASSESSED")
    if (first.status !== "ASSESSED") return
    expect(first.deadline).toBe("2024-06-01")
    expect(first.alerts.map((row) => [row.daysBefore, row.dueOn])).toEqual([
      [90, "2024-03-03"],
      [30, "2024-05-02"],
      [7, "2024-05-25"],
    ])
    const alerts = store.followUps.filter((row) => row.kind === "limitation_alert")
    expect(alerts).toHaveLength(3)
    expect(alerts.map((row) => row.daysBefore).sort((a, b) => (b ?? 0) - (a ?? 0))).toEqual([90, 30, 7])
    expect(alerts.every((row) => row.delivery === "none" && row.status === "open")).toBe(true)
    expect(matter.relevant_law_dates).toEqual([
      { name: "accrual", date: "2021-06-01", article: "7", forum: "LHC" },
    ])
    const queue = listCourtOpsQueue(store, "clerk1", { matterId: matter.id, limit: 10, cursor: 0 })
    expect(queue.items.filter((item) => item.kind === "limitation_alert")).toHaveLength(3)
    expect(queue.items.every((item) => !("channel" in item) && !item.detail.toLowerCase().includes("sent"))).toBe(true)
  })

  it("does not write dates or alerts when the check is NOT_ASSESSED, and resolves a superseded diary", () => {
    const { store, matter } = matterStore()
    const refused = applyLimitation(store, {
      matterId: matter.id,
      article: "113",
      accrualDate: "2021-06-01",
      filingForum: "LHC",
      calendar: OPEN,
    })
    expect(refused.status).toBe("NOT_ASSESSED")
    expect(store.followUps).toHaveLength(0)
    expect(matter.relevant_law_dates).toBeUndefined()

    applyLimitation(store, {
      matterId: matter.id,
      article: "7",
      accrualDate: "2021-06-01",
      filingForum: "LHC",
      calendar: OPEN,
    })
    store.sectionVersions.length = 0
    store.sectionVersions.push(
      article("one year"),
      version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1)
    )
    applyLimitation(store, {
      matterId: matter.id,
      article: "7",
      accrualDate: "2021-06-01",
      filingForum: "LHC",
      calendar: OPEN,
    })
    const open = store.followUps.filter((row) => row.kind === "limitation_alert" && row.status !== "resolved")
    const resolved = store.followUps.filter((row) => row.kind === "limitation_alert" && row.status === "resolved")
    expect(open.map((row) => row.deadline)).toEqual(["2022-06-01", "2022-06-01", "2022-06-01"])
    expect(resolved).toHaveLength(3)
    expect(resolved.every((row) => row.deadline === "2024-06-01" && row.resolvedBy === "limitation-engine")).toBe(true)

    store.sectionVersions.length = 0
    for (const row of base()) store.sectionVersions.push({ ...row })
    applyLimitation(store, {
      matterId: matter.id,
      article: "7",
      accrualDate: "2021-06-01",
      filingForum: "LHC",
      calendar: OPEN,
    })
    const restored = store.followUps.filter((row) => row.kind === "limitation_alert" && row.status !== "resolved")
    expect(restored.map((row) => row.deadline)).toEqual(["2024-06-01", "2024-06-01", "2024-06-01"])
    expect(listCourtOpsQueue(store, "clerk1", { matterId: matter.id, limit: 10, cursor: 0 }).items).toHaveLength(3)
  })

  it("keeps another article's open alerts when this article is assessed", () => {
    const { store, matter } = matterStore()
    store.sectionVersions.push(version("limitation-act-1908/article/113", articleText("one year"), "1908-01-01", null, 1))
    applyLimitation(store, {
      matterId: matter.id,
      article: "7",
      accrualDate: "2021-06-01",
      filingForum: "LHC",
      calendar: OPEN,
    })
    applyLimitation(store, {
      matterId: matter.id,
      article: "113",
      accrualDate: "2021-06-01",
      filingForum: "LHC",
      calendar: OPEN,
    })
    const open = store.followUps.filter((row) => row.kind === "limitation_alert" && row.status !== "resolved")
    expect(open.filter((row) => row.article === "7").map((row) => row.deadline)).toEqual([
      "2024-06-01",
      "2024-06-01",
      "2024-06-01",
    ])
    expect(open.filter((row) => row.article === "113").map((row) => row.deadline)).toEqual([
      "2022-06-01",
      "2022-06-01",
      "2022-06-01",
    ])
    expect(listCourtOpsQueue(store, "clerk1", { matterId: matter.id, limit: 10, cursor: 0 }).items).toHaveLength(6)
  })

  it("refuses a filing forum that is not the matter's court", () => {
    const { store, matter } = matterStore()
    const result = applyLimitation(store, {
      matterId: matter.id,
      article: "7",
      accrualDate: "2021-06-01",
      filingForum: "SHC",
      calendar: OPEN,
    })
    expect(result).toMatchObject({ status: "NOT_ASSESSED", reason: "forum_mismatch" })
    expect(store.followUps).toHaveLength(0)
  })

  it("creates no second row when the diary helper is called twice for the same deadline", () => {
    const store = newStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "Q11",
      courtId: "LHC",
      classification: "internal",
    })
    const input = { firmId: "firmA", matterId: matter.id, courtId: "LHC", forum: "LHC", deadline: "2024-06-01", article: "7" }
    scheduleLimitationAlerts(store, input)
    scheduleLimitationAlerts(store, input)
    expect(store.followUps.filter((row) => row.kind === "limitation_alert")).toHaveLength(3)
    const kept = store.followUps.find((row) => row.daysBefore === 90)
    if (!kept) throw new Error("missing 90-day alert")
    kept.status = "resolved"
    kept.resolvedBy = "clerk1"
    kept.resolvedAt = 1
    scheduleLimitationAlerts(store, { ...input, deadline: "2025-01-01" })
    scheduleLimitationAlerts(store, input)
    expect(kept.status).toBe("resolved")
    expect(kept.resolvedBy).toBe("clerk1")
    const reopened = store.followUps.filter(
      (row) => row.article === "7" && row.deadline === "2024-06-01" && row.status !== "resolved"
    )
    expect(reopened.map((row) => row.daysBefore).sort((a, b) => (b ?? 0) - (a ?? 0))).toEqual([30, 7])
  })

  it("ALERT-001 includes the forum in the diary alert key", () => {
    const store = newStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "Q11",
      courtId: "LHC",
      classification: "internal",
    })
    const shared = { firmId: "firmA", matterId: matter.id, deadline: "2024-06-01", article: "7" }
    scheduleLimitationAlerts(store, { ...shared, courtId: "LHC", forum: "LHC" })
    scheduleLimitationAlerts(store, { ...shared, courtId: "SHC", forum: "SHC" })
    const open = store.followUps.filter((row) => row.kind === "limitation_alert" && row.status !== "resolved")
    expect(open).toHaveLength(6)
    expect(open.filter((row) => row.forum === "LHC").map((row) => row.id)).toEqual([
      `limalert_${matter.id}_LHC_7_2024-06-01_d90`,
      `limalert_${matter.id}_LHC_7_2024-06-01_d30`,
      `limalert_${matter.id}_LHC_7_2024-06-01_d7`,
    ])
    expect(open.filter((row) => row.forum === "SHC").map((row) => row.id)).toEqual([
      `limalert_${matter.id}_SHC_7_2024-06-01_d90`,
      `limalert_${matter.id}_SHC_7_2024-06-01_d30`,
      `limalert_${matter.id}_SHC_7_2024-06-01_d7`,
    ])
    scheduleLimitationAlerts(store, { ...shared, courtId: "LHC", forum: "LHC", deadline: "2025-01-01" })
    const stillOpen = store.followUps.filter((row) => row.kind === "limitation_alert" && row.status !== "resolved")
    expect(stillOpen.filter((row) => row.forum === "SHC")).toHaveLength(3)
    expect(stillOpen.filter((row) => row.forum === "LHC").every((row) => row.deadline === "2025-01-01")).toBe(true)
  })
})

describe("Q11 in-force version rule", () => {
  it("keeps the corpus rule: from <= date < to, and a broken history selects nothing", () => {
    const v = (versionNo: number, effectiveFrom: string, effectiveTo: string | null): SectionVersionRow => ({
      versionNo,
      effectiveFrom,
      effectiveTo,
      text: `v${versionNo}`,
      versionConfidence: 0.9,
    })
    const rows = [v(1, "2099-01-01", "2099-07-01"), v(2, "2099-07-01", null)]
    expect(coveringVersion(rows, "2098-12-31")).toBeNull()
    expect(coveringVersion(rows, "2099-01-01")?.versionNo).toBe(1)
    expect(coveringVersion(rows, "2099-06-30")?.versionNo).toBe(1)
    expect(coveringVersion(rows, "2099-07-01")?.versionNo).toBe(2)
    expect(coveringVersion([v(1, "2099-01-01", "2099-03-01")], "2099-03-01")).toBeNull()
    expect(() => coveringVersion([v(1, "2099-01-01", "2099-08-01"), v(2, "2099-07-01", null)], "2099-07-15")).toThrow(
      /section_history_inconsistent/
    )
    expect(() => corpusCoveringVersion([v(1, "2099-07-01", "2099-01-01")], "2099-07-15")).toThrow(AuthorityUnavailableError)
    try {
      corpusCoveringVersion([v(1, "2099-07-01", "2099-01-01")], "2099-07-15")
    } catch (err) {
      expect((err as AuthorityUnavailableError).reason).toBe("inconsistent")
    }
  })
})

describe("Q11 supported-article fixture", () => {
  it("lists only periods whose text is already in the repo, and the repo currently has none", () => {
    const table = JSON.parse(readFileSync(path.join(ROOT, "data/limitation/supported-articles.json"), "utf8")) as {
      articles: Array<{ article: string; periodCited: string; sourcePath: string; sourceSnippet: string }>
      exclusions: { "4": string; "12": string; "14": string }
    }
    expect(table.articles).toEqual([])
    expect(table.exclusions).toEqual({ "4": "NOT_ASSESSED", "12": "NOT_ASSESSED", "14": "NOT_ASSESSED" })
    for (const row of table.articles) {
      const source = readFileSync(path.join(ROOT, row.sourcePath), "utf8")
      expect(source).toContain(row.sourceSnippet)
      expect(row.sourceSnippet).toContain(row.periodCited)
    }
    const found = scanRepoArticleTexts()
    const listed = new Set(table.articles.map((row) => row.sourcePath))
    expect(found.filter((file) => !listed.has(file))).toEqual([])
  })

  it("does not hard-code a Limitation Act period in the engine", () => {
    const src = readFileSync(path.join(ROOT, "services/d4-2/limitation.ts"), "utf8")
    expect(src).not.toMatch(/113[\s\S]{0,40}(?:three years|3 years)/i)
    expect(src).not.toMatch(/period(?:Years|Months|Days)\s*=\s*\d+/)
  })

  it("ships no court-holiday calendar", () => {
    expect(REPO_COURT_CALENDAR).toBeNull()
    expect(holidayFiles()).toEqual([])
    expect(loadCourts(courtsSeed).LHC?.jurisdiction).toBe("PUNJAB")
  })
})

function holidayFiles(): string[] {
  const hits: string[] = []
  walk(path.join(ROOT, "data"), (file) => {
    if (/holiday|court-calendar|closed-day/i.test(path.basename(file))) hits.push(file)
  })
  return hits
}

function scanRepoArticleTexts(): string[] {
  const roots = [
    path.join(ROOT, "data/limitation"),
    path.join(ROOT, "corpus_service/tests/fixtures"),
    path.join(ROOT, "corpus_service/scraper/templates"),
  ]
  const hits: string[] = []
  for (const root of roots) {
    walk(root, (file) => {
      if (file.endsWith("supported-articles.json")) return
      const text = readFileSync(file, "utf8")
      if (/limitation act/i.test(text) && /article\s+\d+/i.test(text) && /\b(?:day|days|month|months|year|years)\b/i.test(text)) {
        hits.push(path.relative(ROOT, file))
      }
    })
  }
  return hits
}

function walk(dir: string, onFile: (file: string) => void): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const full = path.join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) walk(full, onFile)
    else onFile(full)
  }
}
