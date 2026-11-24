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
import { CANONICAL_MONTH_END, CANONICAL_RECKONING } from "@/services/d4-2/limitationAllowlist"
import {
  REPO_COURT_CALENDAR,
  applyLimitation,
  checkLimitation,
  type CourtCalendar,
  type LimitationVersion,
} from "@/services/d4-2/limitation"
import { addDays, addUnit } from "@/services/d4-2/limitationDates"
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

function provision(text: string): LimitationVersion[] {
  return [
    version("limitation-act-1908/article/7", text, "1908-01-01", null, 1),
    version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1),
  ]
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
      reason: "period_exceeds_engine_cap",
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
        reason: "period_ambiguous",
        deadline: null,
      })
    }
  })

  it("R3 regression keeps a single canonical period, including an ASCII compound", () => {
    expect(assessed("2020-01-01", base("Ninety days"))).toMatchObject({ status: "ASSESSED", deadline: "2020-03-31" })
    expect(assessed("2020-01-01", base("Eleven years"))).toMatchObject({ status: "ASSESSED", deadline: "2031-01-01" })
    expect(assessed("2020-01-01", base("period of three years from"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_ambiguous",
      deadline: null,
    })
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

  it("FA-Q11-PARSE-009 refuses a clause that is not on the period allowlist", () => {
    const decree = `Within one year from the date of the decree. ${RECKONING}`
    expect(assessed("2020-01-01", provision(decree)), "within").toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_ambiguous",
      deadline: null,
    })
    const withinWhich = `The period of limitation is three years within which a suit shall be instituted. ${RECKONING}`
    expect(assessed("2020-01-01", provision(withinWhich)), "within which").toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_ambiguous",
      deadline: null,
    })
    const aside: Array<{ word: string; sentence: string }> = [
      { word: "within", sentence: "The objection was taken within the grounds." },
      { word: "under", sentence: "The plaint was filed under the decree." },
      { word: "over", sentence: "The court read over the record." },
      { word: "some", sentence: "The plaint seeks some relief." },
      { word: "another", sentence: "The plaintiff filed another suit." },
      { word: "several", sentence: "The plaint raises several grounds." },
      { word: "about", sentence: "The order is about costs." },
      { word: "not less than", sentence: "The debt is not less than the claim." },
      { word: "or less", sentence: "The costs are nominal or less material." },
      { word: "not exceeding", sentence: "The narrative is not exceeding the record." },
      { word: "upto", sentence: "The note says upto the annexure." },
      { word: "up to", sentence: "The note runs up to the annexure." },
      { word: "maximum of", sentence: "State the maximum of the claim." },
      { word: "minimum of", sentence: "State the minimum of the claim." },
      { word: "at least", sentence: "Serve at least the defendant." },
      { word: "thrice", sentence: "The witness repeated the date thrice." },
      { word: "and upwards", sentence: "The column is marked and upwards." },
      { word: "or more", sentence: "The plaint adds interest or more detail." },
      { word: "not more than", sentence: "The fee is not more than the schedule." },
      { word: "less than", sentence: "The delay was less than expected." },
      { word: "more than", sentence: "The delay was more than expected." },
      { word: "at most", sentence: "Allow at most a hearing." },
      { word: "approximately", sentence: "The note says approximately the same thing." },
      { word: "twice", sentence: "The clerk checked the annexure twice." },
      { word: "or above", sentence: "The rank is counsel or above." },
      { word: "no less than", sentence: "The duty is no less than the oath." },
      { word: "no more than", sentence: "The duty is no more than the oath." },
    ]
    for (const row of aside) {
      expect(assessed("2020-01-01", base("three years", row.sentence)), row.word).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
  })

  it("FA-Q11-PARSE-009 refuses a full sentence when a bound touches the period", () => {
    const bounds = [
      "not within three years",
      "under three years",
      "over three years",
      "some three years",
      "another three years",
      "several three years",
      "about three years",
      "not less than three years",
      "three years or less",
      "not exceeding three years",
      "upto three years",
      "up to three years",
      "maximum of three years",
      "minimum of three years",
      "at least three years",
      "thrice three years",
      "three years and upwards",
      "three years or more",
      "not more than three years",
      "less than three years",
      "more than three years",
      "at most three years",
      "approximately three years",
      "twice three years",
      "three years or above",
      "no less than three years",
      "no more than three years",
      "three years and above",
      "above three years",
      "below three years",
    ]
    for (const period of bounds) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
  })

  it("FA-Q11-TEST-R5-001 rejects half, 6mos, and vi months inside the reckoning span", () => {
    for (const poison of ["half", "6mos", "vi months"]) {
      const reckoning = `In computing the period of limitation the day from which ${poison} is to be reckoned shall be excluded.`
      const text = `LIMITATION FIXTURE. The period of limitation is three years. ${reckoning}`
      expect(assessed("2020-01-01", provision(text)), poison).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("FA-Q11-ROBUST-001 caps the span and returns NOT_ASSESSED when the date would overflow", () => {
    expect(assessed("2020-01-01", base("100 years"))).toMatchObject({ status: "ASSESSED", deadline: "2120-01-01" })
    expect(assessed("2020-01-01", base("101 years"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_exceeds_engine_cap",
      deadline: null,
    })
    expect(assessed("2020-01-01", base("1200 months"))).toMatchObject({ status: "ASSESSED", deadline: "2120-01-01" })
    expect(assessed("2020-01-01", base("1201 months"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_exceeds_engine_cap",
      deadline: null,
    })
    for (const period of ["7979 years", "7980 years", "9999 years", "9999 months"]) {
      expect(() => assessed("2020-01-01", base(period)), period).not.toThrow()
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_exceeds_engine_cap",
        deadline: null,
      })
    }
    expect(() => addUnit("2020-01-01", 7979, "year", false)).not.toThrow()
    expect(addUnit("2020-01-01", 7979, "year", false)).toBe("9999-01-01")
    expect(() => addUnit("2020-01-01", 7980, "year", false)).not.toThrow()
    expect(addUnit("2020-01-01", 7980, "year", false)).toBeNull()
    expect(() => addUnit("2020-01-01", 9999, "year", false)).not.toThrow()
    expect(addUnit("2020-01-01", 9999, "year", false)).toBeNull()
  })

  it("INFO a spaced dash, dot, or tilde before a number is not a period", () => {
    for (const period of ["- 5 years", ". 5 years", "~ 5 years"]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("refuses a bound that touches the period through parentheses", () => {
    for (const period of [
      "at least (three years)",
      "(at least) three years",
      "at least ( three years )",
      "three years (or more)",
      "three years ( or more )",
      "three years, (or more)",
      "three years [or more]",
    ]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
  })

  it("reads a colon label and a parenthetical that does not bound the period", () => {
    const labelled = `LIMITATION FIXTURE. Period of limitation: three years. ${RECKONING}`
    expect(assessed("2020-01-01", provision(labelled)), "colon").toMatchObject({
      status: "ASSESSED",
      deadline: "2023-01-01",
      governing: { periodCited: "three years" },
    })
    const sentence = `LIMITATION FIXTURE. Period of limitation. Three years. ${RECKONING}`
    expect(assessed("2020-01-01", provision(sentence)), "sentence dot").toMatchObject({
      status: "ASSESSED",
      deadline: "2023-01-01",
      governing: { periodCited: "Three years" },
    })
    expect(assessed("2020-01-01", base("three years (see the schedule)")), "aside").toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_ambiguous",
      deadline: null,
    })
  })

  it("FA-Q11-PARSE-010 refuses a bound anywhere in the quantity clause", () => {
    const ambiguous = [
      "Not more than (3 years)",
      "Three years or under",
      "At least (three years)",
      "Three years (or more)",
      "three years; or more",
      "three years - or more",
      "three years: at least",
      "Three years. Or more.",
      "At least a period of three years",
      "Twice the period of three years",
      "More than the said three years",
      "Three years in all, or more",
      "more or less three years",
      "at the least three years",
      "Three years more",
      "More-than three years",
      "three years or-more",
      "Three years (at least)",
      "three years (costs) or more",
      "~ three years",
      "double three years",
      "beyond three years",
      "Three years plus",
      "no fewer than three years",
      "a further three years",
      "an additional three years",
      "extendable three years",
      "maximum period of three years",
      "minimum period of three years",
      "fewer than three years",
      "greater than three years",
      "longer than three years",
      "shorter than three years",
      "in excess of three years",
      "atleast three years",
      "approx three years",
      "kam az kam three years",
      "zyada se zyada three years",
      "taqreeban three years",
      "three years or below",
      "three years at the most",
      "three years or thereabouts",
      "three years or such",
      "three years less",
      "three years at least",
      "exceeding three years",
      "not three years",
      "three years not",
      "in, excess of three years",
      "three years or, more",
    ]
    for (const period of ambiguous) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
  })

  it("TEST-256-001 rejects at least inside the reckoning and the month-end clause", () => {
    const reckoning = "In computing the period of limitation the day from which at least is to be reckoned shall be excluded."
    expect(assessed("2020-01-01", provision(`LIMITATION FIXTURE. The period of limitation is three years. ${reckoning}`))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
    const monthEnd = "If the corresponding date does not exist, the period expires at least on the last day of that month."
    expect(assessed("2020-01-01", provision(`LIMITATION FIXTURE. The period of limitation is three years. ${monthEnd} ${RECKONING}`))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
  })

  it("TEST-256-001 rejects a bare not inside the reckoning", () => {
    const reckoning = "In computing the period of limitation the day from which it is not to be reckoned shall be excluded."
    expect(assessed("2020-01-01", provision(`LIMITATION FIXTURE. The period of limitation is three years. ${reckoning}`))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
  })

  it("TEST-256-001 refuses Cannot three years and reads a spaced opening parenthesis", () => {
    expect(assessed("2020-01-01", base("Cannot three years"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_ambiguous",
      deadline: null,
    })
    expect(assessed("2020-01-01", base("( 5 years)"))).toMatchObject({
      status: "ASSESSED",
      deadline: "2025-01-01",
      governing: { periodCited: "5 years" },
    })
  })

  it("PARSE-011 reads a comma, a colon label, and a sentence dot before a word", () => {
    expect(assessed("2020-01-01", base("For a suit, three years"))).toMatchObject({
      status: "ASSESSED",
      deadline: "2023-01-01",
      governing: { periodCited: "three years" },
    })
    expect(assessed("2020-01-01", base("Period: 5 years"))).toMatchObject({
      status: "ASSESSED",
      deadline: "2025-01-01",
      governing: { periodCited: "5 years" },
    })
    expect(assessed("2020-01-01", base("Art. Three years"))).toMatchObject({
      status: "ASSESSED",
      deadline: "2023-01-01",
      governing: { periodCited: "Three years" },
    })
  })

  it("DATE-002 refuses an accrual before 1908 or before the earliest text, whichever is later", () => {
    expect(addDays("0050-01-15", 90)).toBe("0050-04-15")
    expect(addUnit("0050-01-15", 90, "day", false)).toBe("0050-04-15")
    expect(assessed("0050-01-15", base("90 days"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "accrual_before_floor",
      deadline: null,
    })
    expect(assessed("1907-12-31", base("one day"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "accrual_before_floor",
      deadline: null,
    })
    expect(assessed("1908-01-01", base("one day"))).toMatchObject({
      status: "ASSESSED",
      deadline: "1908-01-02",
    })
    const later = [
      article("three years", "1950-01-01"),
      version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1),
    ]
    expect(assessed("1949-12-31", later)).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "accrual_before_floor",
      deadline: null,
    })
    expect(assessed("1950-01-01", later)).toMatchObject({
      status: "ASSESSED",
      deadline: "1953-01-01",
    })
    const earlier = [
      article("one day", "1800-01-01"),
      version("limitation-act-1908/section/4", SECTION_4, "1800-01-01", null, 1),
    ]
    expect(assessed("1907-12-31", earlier)).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "accrual_before_floor",
      deadline: null,
    })
    expect(assessed("1908-01-01", earlier)).toMatchObject({
      status: "ASSESSED",
      deadline: "1908-01-02",
    })
  })

  it("FA-Q11-PARSE-012 refuses a bound split off the quantity by a mark or a single newline", () => {
    const ambiguous = [
      "At least: three years",
      "Not more than: three years",
      "At least. Three years.",
      "Approx. three years",
      "Max. three years",
      "Min. three years",
      "Maximum period: three years",
      "not more\nthan three years",
      "at least\na period of three years",
      "Three years. Or more, if the Court so directs.",
      "three years\u000Bor more",
      "three years\u0085or more",
      "three years\u2028or more",
      "three years\u2029or more",
      "not\u0085more than three years",
    ]
    for (const period of ambiguous) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
  })

  it("FA-Q11-PARSE-012 still reads a label and a previous clause that does not end in a bound", () => {
    expect(assessed("2020-01-01", base("Period: 5 years"))).toMatchObject({
      status: "ASSESSED",
      deadline: "2025-01-01",
      governing: { periodCited: "5 years" },
    })
    expect(assessed("2020-01-01", base("Art. Three years"))).toMatchObject({
      status: "ASSESSED",
      deadline: "2023-01-01",
      governing: { periodCited: "Three years" },
    })
    expect(assessed("2020-01-01", base("Possession over the property: twelve years"))).toMatchObject({
      status: "ASSESSED",
      deadline: "2032-01-01",
      governing: { periodCited: "twelve years" },
    })
    const blankLine = `LIMITATION FIXTURE. The period of limitation is three years.\n\nThe court read the file. ${RECKONING}`
    expect(assessed("2020-01-01", provision(blankLine))).toMatchObject({
      status: "ASSESSED",
      deadline: "2023-01-01",
      governing: { periodCited: "three years" },
    })
    const blankLineBound = `LIMITATION FIXTURE. The period of limitation is three years\n\nThe order says or more about costs. ${RECKONING}`
    expect(assessed("2020-01-01", provision(blankLineBound)), "a later clause off the allowlist refuses").toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_ambiguous",
      deadline: null,
    })
  })

  it("FA-Q11-PARSE-013 refuses stems, comparatives, signs, homoglyphs, and roman-Urdu", () => {
    const ambiguous = [
      "Maximum three years",
      "minimum three years",
      "Upwards of three years",
      "three years \u06CC\u0627 \u0632\u06CC\u0627\u062F\u06C1",
      "three years or fewer",
      "three years or smaller",
      "three years or greater",
      "three years or lower",
      "three years or higher",
      "or any longer period of three years",
      "exceeds three years",
      "Cannot exceed three years",
      "approximate three years",
      "triple three years",
      "treble three years",
      "extensible three years",
      "give or take three years",
      "> three years",
      "three years <",
      "<= three years",
      "+ three years",
      "three years +",
      "\u00B1 three years",
      "three years \u00B1",
      "= three years",
      "\u0430bout three years",
      "kam se kam three years",
      "zyada three years",
      "ziyada three years",
      "taqriban three years",
      "lagbhag three years",
    ]
    for (const period of ambiguous) {
      expect(assessed("2020-01-01", base(period)), JSON.stringify(period)).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
  })

  it("FA-Q11-PROV-002 does not apply a negated reckoning or a negated month-end", () => {
    const negated = [
      "In computing the period of limitation the day from which such period is to be reckoned shall never be excluded.",
      "In computing the period of limitation the day from which such period is to be reckoned shan't be excluded.",
      "In computing the period of limitation the day from which such period is to be reckoned cannot be excluded.",
      "In computing the period of limitation the day from which such period is to be reckoned shall be included rather than excluded.",
    ]
    for (const reckoning of negated) {
      const text = `LIMITATION FIXTURE. The period of limitation is one day. ${reckoning}`
      expect(assessed("2020-01-01", provision(text)), reckoning).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
    const neverEnds = `LIMITATION FIXTURE. The period of limitation is one month. If the corresponding date does not exist, the period never ends on the last day of that month. ${RECKONING}`
    expect(assessed("2024-01-31", provision(neverEnds))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
  })

  it("FA-Q11-LAYOUT-001 reads a newline immediately before the quantity", () => {
    const text = `LIMITATION FIXTURE. The period of limitation is\nthree years. ${RECKONING}`
    expect(assessed("2020-01-01", provision(text))).toMatchObject({
      status: "ASSESSED",
      deadline: "2023-01-01",
      governing: { periodCited: "three years" },
    })
  })

  it("TEST-256-R2-001 refuses the bound lexemes a deletion would leak", () => {
    for (const period of [
      "around three years",
      "roughly three years",
      "nearly three years",
      "almost three years",
      "circa three years",
      "minus three years",
      "plus three years",
      "three years or so",
      "three years never more",
    ]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
    expect(addDays("0099-12-31", 1)).toBe("0100-01-01")
    expect(addUnit("0099-12-31", 1, "day", false)).toBe("0100-01-01")
  })

  it("FA-Q11-CAP-R2-001 sends a parsed integer past 9999 to the cap and leaves hundred unreadable", () => {
    for (const period of ["10000 years", "100000 years"]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_exceeds_engine_cap",
        deadline: null,
      })
    }
    expect(assessed("2020-01-01", base("one hundred years"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
    expect(assessed("2020-01-01", base("100 years"))).toMatchObject({
      status: "ASSESSED",
      deadline: "2120-01-01",
    })
  })

  it("FA-Q11-CLAIM-R3-001 refuses a reckoning the canonical sentence does not allow", () => {
    const text = "LIMITATION FIXTURE. The period of limitation is one day. In computing the period of limitation the day from which such period is to be reckoned shall hardly be excluded."
    expect(assessed("2020-01-01", provision(text))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
  })

  it("FA-Q11-PROV-003 refuses a reckoning or month-end that is not the canonical sentence", () => {
    const reckonings = [
      "In computing the period of limitation the day from which such period is to be reckoned shall in no case be excluded.",
      "In computing the period of limitation the day from which such period is to be reckoned shall be counted rather than excluded.",
      "In computing the period of limitation the day from which such period is to be reckoned shan\u2019t be excluded.",
      "No day from which such period is to be reckoned shall be excluded.",
      "In computing the period of limitation the day from which such period is to be reckoned shall be excluded. This rule shall not apply.",
      "In computing the period of limitation the day from which such period is to be reckoned shall be excluded only if the Court so directs.",
      "In computing the period of limitation the day from which such period is to be reckoned shall not be excluded.",
      "In computing the period of limitation the day from which such period is to be reckoned shall NEVER be excluded.",
      "In computing the period of limitation the day from which such period is to be reckoned will not be excluded.",
      "In computing the period of limitation the day from which such period is to be reckoned is not to be excluded.",
      "In computing the period of limitation the day from which such period is to be reckoned shall be excluded unless the court directs otherwise.",
      "In computing the period of limitation the day from which such period is to be reckoned shall be excluded except on a holiday.",
      "In computing the period of limitation the day from which such period is to be reckoned shall be excluded save where the court sits.",
      "In no case shall the day from which such period is to be reckoned be excluded.",
      "The day from which such period is to be reckoned shall hardly ever be excluded.",
      "In computing the period of limitation the day from which such period is to be reckoned shall be excluded if the plaintiff so asks.",
      "IN COMPUTING THE PERIOD OF LIMITATION THE DAY FROM WHICH SUCH PERIOD IS TO BE RECKONED SHALL NOT BE EXCLUDED.",
    ]
    for (const reckoning of reckonings) {
      const text = `LIMITATION FIXTURE. The period of limitation is one day. ${reckoning}`
      expect(assessed("2020-01-01", provision(text)), reckoning).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
    const monthEnds = [
      "If the corresponding date does not exist, the period in no case ends on the last day of that month.",
      "If the corresponding date does not exist, the period does not end on the last day of that month.",
      "If the corresponding date does not exist, the period expires on the last day of that month only if the Court so directs.",
      "If the corresponding date does not exist, the period shall not expire on the last day of that month.",
      "If the corresponding date does not exist, the period never in fact ends on the last day of that month.",
      "If the corresponding date does not exist, the period in no case expires on the last day of that month.",
      "Where the corresponding date does not exist, the period expires on the last day of that month.",
      "If the corresponding date does not exist, the suit ends on the last day of that month.",
      "If the corresponding date does not exist, the period expires on the last day of that month. This rule shall not apply.",
    ]
    for (const monthEnd of monthEnds) {
      const text = `LIMITATION FIXTURE. The period of limitation is one month. ${monthEnd} ${RECKONING}`
      expect(assessed("2024-01-31", provision(text)), monthEnd).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("FA-Q11-UDASH-001 refuses a unicode dash or minus near a quantity", () => {
    const dashes = ["\u2212", "\u2013", "\u2014", "\u2010", "\u2011", "\u2012", "\u2015", "\uFE58", "\uFE63", "\uFF0D"]
    for (const dash of dashes) {
      expect(assessed("2020-01-01", base(`${dash} 5 years`)), `dash-digit ${dash}`).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
      expect(assessed("2020-01-01", base(`three ${dash} years`)), `dash-unit ${dash}`).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
    expect(assessed("2020-01-01", base("Period \u2212 3 years"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
  })

  it("FA-Q11-PARSE-014 runs the allowlist on every adjacent clause", () => {
    for (const period of [
      "Three years. \u0410t least.",
      "Three years. \u0410.",
      "Not more than (in this case): three years.",
      "At least, in all cases: three years.",
      "Three years. Which may be more.",
      "Three years. In a fit case, longer.",
      "Approximately, for this suit: three years.",
      "Three years. See also the minimum.",
    ]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
  })

  it("FA-Q11-PARSE-013 refuses words and symbols outside the period grammar", () => {
    for (const period of [
      "extra three years",
      "further three years",
      "additional three years",
      "odd three years",
      "three years or thereabout",
      "twofold three years",
      "\u2265 three years",
      "three years \u2264",
      "\u2248 three years",
      "\uFF0B three years",
      "three years and longer",
      "tops three years",
      "at the outside three years",
      "ziada three years",
      "se kam three years",
      "tak three years",
      "\u2605 three years",
    ]) {
      expect(assessed("2020-01-01", base(period)), JSON.stringify(period)).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
  })

  it("TEST-256-R3-001 pins the denylist survivors the allowlist has to refuse", () => {
    expect(assessed("2020-01-01", base("10000 days"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_exceeds_engine_cap",
      deadline: null,
    })
    for (const period of [
      "upwards three years",
      "extend the three years",
      "estimated three years",
      "minimum period: three years",
      "three years or in a truly longer span",
    ]) {
      expect(assessed("2020-01-01", base(period)), period).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
    for (const word of ["unless", "except", "save"]) {
      const text = `LIMITATION FIXTURE. The period of limitation is one day. In computing the period of limitation the day from which such period is to be reckoned shall be excluded ${word} the court sits.`
      expect(assessed("2020-01-01", provision(text)), word).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("FA-Q11-DOT-R4-001 refuses a dot the sentence split would drop in front of a digit", () => {
    const rows = [".5 years", ".25 years", ".75 months", ". 5 years.", "..5 years"]
    for (const period of rows) {
      expect(assessed("2020-01-15", provision(`${period.endsWith(".") ? period : `${period}.`} ${RECKONING}`)), `start ${period}`).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
      expect(assessed("2020-01-15", provision(`\n\n${period.endsWith(".") ? period : `${period}.`} ${RECKONING}`)), `blank ${period}`).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
      const afterCanonical = period.endsWith(".") ? period.slice(0, -1) : period
      expect(assessed("2020-01-15", provision(`${RECKONING}\n${afterCanonical}`)), `after ${period}`).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
  })

  it("FA-Q11-OVER-R4-001 allows only the phrase possession over the property", () => {
    for (const text of [
      `LIMITATION FIXTURE. Over: three years. ${RECKONING}`,
      `LIMITATION FIXTURE. Three years. Over. ${RECKONING}`,
      `LIMITATION FIXTURE. Over; three years. ${RECKONING}`,
      `LIMITATION FIXTURE. Three years: over. ${RECKONING}`,
      `LIMITATION FIXTURE. Possession over: three years. ${RECKONING}`,
      `LIMITATION FIXTURE. The period of limitation is three years.\n\nOver. ${RECKONING}`,
    ]) {
      expect(assessed("2020-01-01", provision(text)), text).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
    expect(assessed("2020-01-01", base("Possession over the property: twelve years"))).toMatchObject({
      status: "ASSESSED",
      deadline: "2032-01-01",
      governing: { periodCited: "twelve years" },
    })
  })

  it("FA-Q11-S12-R4-001 does not apply section 12 when a later sentence says the rule shall not apply", () => {
    const versions = [
      version("limitation-act-1908/article/7", "LIMITATION FIXTURE. The period of limitation is three years.", "1908-01-01", null, 1),
      version("limitation-act-1908/section/12", `${RECKONING} This rule shall not apply to the suit.`, "1908-01-01", null, 1),
      version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1),
    ]
    expect(assessed("2020-01-01", versions)).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "reckoning_unverified",
      deadline: null,
    })
  })

  it("FA-Q11-DIGIT-R4-002 refuses a non-ASCII decimal digit anywhere in the period", () => {
    expect(assessed("2020-01-01", base("\u06F1\u06F2 (3 years)"))).toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_unreadable",
      deadline: null,
    })
  })

  it("FA-Q11-SYM-R2-001 refuses a sign beside the quantity", () => {
    for (const period of ["> three years", "three years <", "<= three years", "+ three years", "\u00B1 three years", "= three years"]) {
      expect(assessed("2020-01-01", base(period)), JSON.stringify(period)).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_ambiguous",
        deadline: null,
      })
    }
  })

  it("TEST-256-R4-001 pins more, within, a distant unicode dash, and a section 12 that is not canonical", () => {
    expect(assessed("2020-01-01", provision(`LIMITATION FIXTURE. Three years. More. ${RECKONING}`)), "more").toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_ambiguous",
      deadline: null,
    })
    expect(assessed("2020-01-01", base("within three years")), "within").toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_ambiguous",
      deadline: null,
    })
    for (const dash of ["\uFF0D", "\uFE58"]) {
      const text = `LIMITATION FIXTURE. The period of limitation is three years. ${dash}. ${RECKONING}`
      expect(assessed("2020-01-01", provision(text)), `dash ${dash}`).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
    const unverified = [
      version("limitation-act-1908/article/7", "LIMITATION FIXTURE. The period of limitation is three years.", "1908-01-01", null, 1),
      version("limitation-act-1908/section/12", "Q11 FIXTURE. The day is included.", "1908-01-01", null, 1),
      version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1),
    ]
    expect(assessed("2020-01-01", unverified), "section 12").toMatchObject({
      status: "NOT_ASSESSED",
      reason: "reckoning_unverified",
      deadline: null,
    })
  })

  it("keeps the canonical reckoning and month-end sentences byte-for-byte", () => {
    expect(CANONICAL_RECKONING).toBe(RECKONING.replace(/\.$/, "").toLowerCase())
    expect(CANONICAL_MONTH_END).toBe(MONTH_END.replace(/\.$/, "").toLowerCase())
  })

  it("FA-Q11-S12-R5-001 applies section 12 only when every sentence is canonical or a neutral heading", () => {
    const articleOnly = "LIMITATION FIXTURE. The period of limitation is three years."
    const rows = [
      `${RECKONING} Repealed.`,
      `${RECKONING} Omitted.`,
      `Sub-section (1) is omitted. ${RECKONING}`,
      `${RECKONING} This rule shall not be applicable.`,
      `${RECKONING} This rule is not applicable.`,
      `${RECKONING} This rule is inapplicable.`,
      `${RECKONING} This rule shan't apply.`,
      `${RECKONING} This rule doesn't apply.`,
      `${RECKONING} This rule shall not, however, apply.`,
      `${RECKONING} This rule does not govern.`,
      `${RECKONING} This rule is disapplied.`,
      `${RECKONING} This rule shall cease to have effect.`,
      `${RECKONING} Article 7 is outside this section.`,
      `${RECKONING} Nothing in this section applies.`,
      `${RECKONING} No exclusion for article 7.`,
      `${RECKONING} The day shall be included.`,
      `${RECKONING} Provided that the day shall be counted.`,
    ]
    const misses: string[] = []
    for (const sectionText of rows) {
      const versions = [
        version("limitation-act-1908/article/7", articleOnly, "1908-01-01", null, 1),
        version("limitation-act-1908/section/12", sectionText, "1908-01-01", null, 1),
        version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1),
      ]
      const result = assessed("2020-01-15", versions)
      if (result.status !== "NOT_ASSESSED" || result.reason !== "reckoning_unverified" || result.deadline !== null) {
        misses.push(`${JSON.stringify(sectionText)} => ${result.status} ${result.reason} ${result.deadline}`)
      }
    }
    expect(misses).toEqual([])
    const canonical = [
      version("limitation-act-1908/article/7", articleOnly, "1908-01-01", null, 1),
      version("limitation-act-1908/section/12", RECKONING, "1908-01-01", null, 1),
      version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1),
    ]
    expect(assessed("2020-01-15", canonical)).toMatchObject({
      status: "ASSESSED",
      deadline: "2023-01-15",
      exclusionsApplied: [expect.objectContaining({ section: "12", effect: "exclude-accrual-day", statedIn: "section" })],
    })
  })

  it("FA-Q11-S12-R5-002 refuses a heading that hides a character outside the allowlist", () => {
    const articleOnly = "LIMITATION FIXTURE. The period of limitation is three years."
    const rows = [
      `${RECKONING} The court \u0645\u0646\u0633\u0648\u062E.`,
      `${RECKONING} The court \u2260 the suit.`,
      `${RECKONING} The court \u216B.`,
      `${RECKONING} The court 5.`,
      `${RECKONING} The court \uFF15.`,
      `${RECKONING} The court \u2075.`,
    ]
    const misses: string[] = []
    for (const sectionText of rows) {
      const versions = [
        version("limitation-act-1908/article/7", articleOnly, "1908-01-01", null, 1),
        version("limitation-act-1908/section/12", sectionText, "1908-01-01", null, 1),
        version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1),
      ]
      const result = assessed("2020-01-15", versions)
      if (result.status !== "NOT_ASSESSED" || result.reason !== "reckoning_unverified" || result.deadline !== null) {
        misses.push(`${JSON.stringify(sectionText)} => ${result.status} ${result.reason} ${result.deadline}`)
      }
    }
    expect(misses).toEqual([])
    const heading = [
      version("limitation-act-1908/article/7", articleOnly, "1908-01-01", null, 1),
      version("limitation-act-1908/section/12", `Q11 FIXTURE. The court read the file. ${RECKONING}`, "1908-01-01", null, 1),
      version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1),
    ]
    expect(assessed("2020-01-15", heading)).toMatchObject({
      status: "ASSESSED",
      deadline: "2023-01-15",
      exclusionsApplied: [expect.objectContaining({ section: "12", effect: "exclude-accrual-day", statedIn: "section" })],
    })
  })

  it("FA-Q11-DIGIT-R5-001 refuses a letter-number in the period", () => {
    const rows = [
      "\u216B (3 years)",
      "\u217B (3 years)",
      "\u2162 (3 years)",
      "\u3007 (3 years)",
      "Three years. \u216B.",
      "Article \u216B: three years.",
    ]
    const misses: string[] = []
    for (const period of rows) {
      const result = assessed("2020-01-01", base(period))
      if (result.status !== "NOT_ASSESSED" || result.reason !== "period_unreadable" || result.deadline !== null) {
        misses.push(`${JSON.stringify(period)} => ${result.status} ${result.reason} ${result.deadline}`)
      }
    }
    expect(misses).toEqual([])
  })

  it("TEST-256-R5-001 pins the fail-open survivors N05 N10 N13 N16 N18 and N24", () => {
    for (const period of [".\u200B5 years.", ".\u20605 years.", `${RECKONING}\n.\u200B5 years`]) {
      expect(assessed("2020-01-15", provision(period)), `N05 ${JSON.stringify(period)}`).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
    for (const period of ["\u0665 (3 years)", "\uFF15 (3 years)"]) {
      expect(assessed("2020-01-01", base(period)), `N10 ${JSON.stringify(period)}`).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
    expect(assessed("2020-01-01", base("Over the property: twelve years")), "N13").toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_ambiguous",
      deadline: null,
    })
    expect(assessed("2020-01-01", base("Possession over the property twelve years")), "N16").toMatchObject({
      status: "NOT_ASSESSED",
      reason: "period_ambiguous",
      deadline: null,
    })
    const before = [
      version("limitation-act-1908/article/7", "LIMITATION FIXTURE. The period of limitation is three years.", "1908-01-01", null, 1),
      version("limitation-act-1908/section/12", `This rule shall not apply. ${RECKONING}`, "1908-01-01", null, 1),
      version("limitation-act-1908/section/4", SECTION_4, "1908-01-01", null, 1),
    ]
    expect(assessed("2020-01-15", before), "N18").toMatchObject({
      status: "NOT_ASSESSED",
      reason: "reckoning_unverified",
      deadline: null,
    })
    for (const period of ["\u2075 (3 years)", "\u00B2 (3 years)"]) {
      expect(assessed("2020-01-01", base(period)), `N24 ${JSON.stringify(period)}`).toMatchObject({
        status: "NOT_ASSESSED",
        reason: "period_unreadable",
        deadline: null,
      })
    }
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
