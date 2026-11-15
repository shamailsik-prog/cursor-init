/**
 * Q11 limitation check. The period is read from the VERIFIED section text in force
 * on the accrual date. coveringVersion (the corpus in-force rule) chooses that text.
 * No period is stored in this file. Sections 4, 12 and 14 apply only when their own
 * verified text states the exclusion. There is no court-holiday calendar in the repo.
 */
import { createHash } from "node:crypto"
import courtsSeed from "@/data/courts.json"
import { loadCourts } from "@/core/case-number-normaliser"
import {
  coveringVersion,
  SectionHistoryInconsistentError,
  versionUsable,
  type SectionVersionRow,
} from "@/services/d4-2/sectionInForce"
import { PublicError } from "@/platform/http/publicError"
import type { SpineStore, StatuteSectionVersion } from "@/platform/spine/store"

declare module "@/platform/spine/store" {
  interface StatuteSectionVersion {
    jurisdiction?: string
    reviewStatus?: "VERIFIED" | "UNVERIFIED" | "QUARANTINED"
    versionConfidence?: number | null
  }
}
import { recordAccrualLawDate } from "@/services/d1-2/relevantLawDates"
import {
  addDays,
  addUnit,
  isCalendarDate,
  limitationAlertSchedule,
  type DateUnit,
  type LimitationAlert,
} from "@/services/d4-2/limitationDates"
import { scheduleLimitationAlerts } from "@/services/d6-1/limitationAlerts"

const courts = loadCourts(courtsSeed)

/** Annex A names for the jurisdictions in data/courts.json. An unmapped code is not guessed. */
const ANNEX_JURISDICTION: Record<string, string> = {
  FEDERAL: "Federal",
  SINDH: "Sindh",
  PUNJAB: "Punjab",
  KP: "KP",
  BALOCHISTAN: "Balochistan",
  ICT: "ICT",
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  ninety: 90,
}

const RECKONING_RE = /day from which[\s\S]{0,160}?excluded/i
const MONTH_END_RE = /corresponding date does not exist[\s\S]{0,200}?last day of that month/i
const CLOSED_RE = /court is closed[\s\S]{0,200}?re-?opens/i
const COPY_RE = /time requisite for obtaining a copy/i
const WRONG_COURT_RE = /court without jurisdiction/i
const CLOSED_ROLL_LIMIT = 30

export type CourtCalendar = {
  isClosed(forumId: string, isoDate: string): boolean
}

/** The repository has no court-holiday table. Callers may pass a calendar; this stays null. */
export const REPO_COURT_CALENDAR: CourtCalendar | null = null

export type LimitationVersion = {
  sectionId: string
  jurisdiction: string
  versionNo: number
  effectiveFrom: string
  effectiveTo: string | null
  text: string
  reviewStatus: "VERIFIED" | "UNVERIFIED" | "QUARANTINED"
  versionConfidence?: number | null
}

export type ExclusionApplied = {
  section: "4" | "12" | "14"
  sectionId: string
  versionNo: number
  effect: "exclude-accrual-day" | "exclude-copy-time" | "exclude-wrong-court" | "next-open-day"
  statedIn?: "article" | "section"
  days?: number
  from?: string
  to?: string
}

export type { LimitationAlert }

export type GoverningVersion = {
  statuteId: "limitation-act-1908"
  sectionId: string
  versionNo: number
  effectiveFrom: string
  effectiveTo: string | null
  jurisdiction: string
  reviewStatus: "VERIFIED"
  textSha256: string
  periodCited: string
}

export type CourtClosedFinding =
  | { status: "NOT_ASSESSED"; reason: "no_court_calendar" }
  | { status: "CHECKED"; closed: false }
  | { status: "APPLIED"; closed: true }

export type NotAssessedReason =
  | "missing_inputs"
  | "unknown_article"
  | "unknown_forum"
  | "forum_jurisdiction_unmapped"
  | "forum_mismatch"
  | "no_history"
  | "text_not_verified"
  | "period_unreadable"
  | "period_ambiguous"
  | "accrual_in_future"
  | "reckoning_unverified"
  | "anniversary_does_not_exist"
  | "exclusion_unsupported"
  | "version_inconsistent"
  | "court_closed_rule_unverified"
  | "court_closed_unresolved"

export type LimitationResult =
  | {
      status: "ASSESSED"
      reason: null
      deadline: string
      governing: GoverningVersion
      exclusionsApplied: ExclusionApplied[]
      alerts: LimitationAlert[]
      courtClosed: CourtClosedFinding
    }
  | {
      status: "NOT_ASSESSED"
      reason: NotAssessedReason
      deadline: null
      governing: null
      exclusionsApplied: []
      alerts: []
      courtClosed: null
    }

export type LimitationFacts = {
  article: string | null | undefined
  accrualDate: string | null | undefined
  filingForum: string | null | undefined
  versions: readonly LimitationVersion[]
  calendar?: CourtCalendar | null
  pleaded?: { copyDays?: number; wrongCourtDays?: number }
}

const notAssessed = (reason: NotAssessedReason): LimitationResult => ({
  status: "NOT_ASSESSED",
  reason,
  deadline: null,
  governing: null,
  exclusionsApplied: [],
  alerts: [],
  courtClosed: null,
})

export function checkLimitation(facts: LimitationFacts): LimitationResult {
  if (blank(facts.article) || blank(facts.accrualDate) || blank(facts.filingForum)) return notAssessed("missing_inputs")
  const accrualDate = facts.accrualDate.trim()
  if (!isCalendarDate(accrualDate)) return notAssessed("missing_inputs")
  if (accrualDate > utcToday()) return notAssessed("accrual_in_future")
  const forum = resolveForum(facts.filingForum.trim())
  if (!forum.ok) return notAssessed(forum.reason)
  const cause = parseCause(facts.article)
  if (!cause) return notAssessed("unknown_article")

  const article = inForce(facts.versions, cause.sectionId, forum.jurisdiction, accrualDate)
  if (!article.ok) return notAssessed(article.reason)
  const period = parsePeriod(article.row.text)
  if (!period.ok) return notAssessed(period.reason)

  const reckoning = reckoningSource(facts.versions, article.row, forum.jurisdiction, accrualDate)
  if (!reckoning.ok) return notAssessed(reckoning.reason)

  const clamp = MONTH_END_RE.test(article.row.text)
  let deadline = addUnit(accrualDate, period.n, period.unit, clamp)
  if (!deadline) return notAssessed("anniversary_does_not_exist")

  const exclusions: ExclusionApplied[] = [
    {
      section: "12",
      sectionId: reckoning.sectionId,
      versionNo: reckoning.versionNo,
      effect: "exclude-accrual-day",
      statedIn: reckoning.statedIn,
    },
  ]

  const pleaded = readPleaded(facts.pleaded)
  if (pleaded === "bad") return notAssessed("missing_inputs")
  if (pleaded.copyDays !== null) {
    const added = applyDayExclusion(facts.versions, "12", forum.jurisdiction, accrualDate, COPY_RE, deadline, pleaded.copyDays, "exclude-copy-time")
    if (!added.ok) return notAssessed(added.reason)
    deadline = added.deadline
    exclusions.push(added.exclusion)
  }
  if (pleaded.wrongCourtDays !== null) {
    const added = applyDayExclusion(facts.versions, "14", forum.jurisdiction, accrualDate, WRONG_COURT_RE, deadline, pleaded.wrongCourtDays, "exclude-wrong-court")
    if (!added.ok) return notAssessed(added.reason)
    deadline = added.deadline
    exclusions.push(added.exclusion)
  }

  const calendar = facts.calendar === undefined ? REPO_COURT_CALENDAR : facts.calendar
  const closed = applyCourtClosed(facts.versions, forum.courtId, forum.jurisdiction, accrualDate, deadline, calendar)
  if (!closed.ok) return notAssessed(closed.reason)
  if (closed.exclusion) exclusions.push(closed.exclusion)

  return {
    status: "ASSESSED",
    reason: null,
    deadline: closed.deadline,
    governing: {
      statuteId: "limitation-act-1908",
      sectionId: article.row.sectionId,
      versionNo: article.row.versionNo,
      effectiveFrom: article.row.effectiveFrom,
      effectiveTo: article.row.effectiveTo,
      jurisdiction: article.row.jurisdiction,
      reviewStatus: "VERIFIED",
      textSha256: createHash("sha256").update(article.row.text, "utf8").digest("hex"),
      periodCited: period.cited,
    },
    exclusionsApplied: exclusions,
    alerts: limitationAlertSchedule(closed.deadline),
    courtClosed: closed.finding,
  }
}

export function applyLimitation(
  store: SpineStore,
  input: {
    matterId: string
    article: string | null
    accrualDate: string | null
    filingForum: string | null
    calendar?: CourtCalendar | null
    pleaded?: { copyDays?: number; wrongCourtDays?: number }
  }
): LimitationResult {
  const matter = store.matters.get(input.matterId)
  if (!matter) throw new PublicError("unknown matter")
  if (matter.courtId && input.filingForum && input.filingForum.trim() !== "" && matter.courtId !== input.filingForum.trim()) {
    return notAssessed("forum_mismatch")
  }
  const result = checkLimitation({
    article: input.article,
    accrualDate: input.accrualDate,
    filingForum: input.filingForum,
    versions: versionsFromStore(store.sectionVersions),
    calendar: input.calendar,
    pleaded: input.pleaded,
  })
  if (result.status !== "ASSESSED") return result
  const cause = parseCause(input.article ?? "")
  recordAccrualLawDate(store, matter.id, {
    date: (input.accrualDate ?? "").trim(),
    article: cause?.token ?? (input.article ?? "").trim(),
    forum: input.filingForum!.trim(),
  })
  scheduleLimitationAlerts(store, {
    firmId: matter.firmId,
    matterId: matter.id,
    courtId: matter.courtId ?? input.filingForum!.trim(),
    forum: input.filingForum!.trim(),
    deadline: result.deadline,
    article: cause?.token ?? (input.article ?? "").trim(),
  })
  return result
}

function versionsFromStore(rows: readonly StatuteSectionVersion[]): LimitationVersion[] {
  return rows.flatMap((row) => {
    if (!row.jurisdiction) return []
    return [
      {
        sectionId: row.sectionId,
        jurisdiction: row.jurisdiction,
        versionNo: row.versionNo,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        text: row.text,
        reviewStatus: row.reviewStatus ?? "UNVERIFIED",
        versionConfidence: row.versionConfidence,
      },
    ]
  })
}

function blank(value: string | null | undefined): value is null | undefined | "" {
  return value == null || value.trim() === ""
}

function resolveForum(
  forumId: string
): { ok: true; courtId: string; jurisdiction: string } | { ok: false; reason: "unknown_forum" | "forum_jurisdiction_unmapped" } {
  const court = courts[forumId]
  if (!court) return { ok: false, reason: "unknown_forum" }
  const jurisdiction = ANNEX_JURISDICTION[court.jurisdiction]
  if (!jurisdiction) return { ok: false, reason: "forum_jurisdiction_unmapped" }
  return { ok: true, courtId: court.id, jurisdiction }
}

function parseCause(raw: string): { token: string; sectionId: string } | null {
  const text = raw.trim().replace(/\.$/, "")
  const article = /^(?:article|art\.?)\s+(\d{1,3}[a-z]?)$/i.exec(text)
  const section = /^(?:section|sec\.?|s\.?)\s*(\d{1,3}[a-z]?)$/i.exec(text)
  const bare = /^(\d{1,3}[a-z]?)$/i.exec(text)
  const num = article?.[1] ?? section?.[1] ?? bare?.[1]
  if (!num) return null
  const kind = section && !article ? "section" : "article"
  const token = num.toLowerCase()
  return { token, sectionId: `limitation-act-1908/${kind}/${token}` }
}

type InForce = { ok: true; row: LimitationVersion } | { ok: false; reason: "no_history" | "text_not_verified" | "version_inconsistent" }

function inForce(versions: readonly LimitationVersion[], sectionId: string, jurisdiction: string, asAt: string): InForce {
  const rows = versions
    .filter((row) => row.sectionId === sectionId && row.jurisdiction === jurisdiction)
    .slice()
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.versionNo - b.versionNo)
  if (rows.length === 0) return { ok: false, reason: "no_history" }
  const shaped: SectionVersionRow[] = rows.map((row) => ({
    versionNo: row.versionNo,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    text: row.text,
    versionConfidence: typeof row.versionConfidence === "number" ? row.versionConfidence : null,
  }))
  let hit: SectionVersionRow | null
  try {
    hit = coveringVersion(shaped, asAt)
  } catch (err) {
    if (err instanceof SectionHistoryInconsistentError) return { ok: false, reason: "version_inconsistent" }
    throw err
  }
  if (!hit) return { ok: false, reason: "no_history" }
  const source = rows.find((row) => row.versionNo === hit.versionNo && row.effectiveFrom === hit.effectiveFrom)
  if (!source || source.reviewStatus !== "VERIFIED") return { ok: false, reason: "text_not_verified" }
  if (source.versionConfidence === null || (typeof source.versionConfidence === "number" && !versionUsable(source.versionConfidence))) {
    return { ok: false, reason: "text_not_verified" }
  }
  return { ok: true, row: source }
}

const NUMBER_WORD =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|zero|nought|dozen|half|quarter"
const PERIOD_PHRASE_RE = new RegExp(
  `(?<![A-Za-z0-9./-])(?<!\\b(?:and|${NUMBER_WORD})[ \\t])(\\d{1,4}(?!\\d)|(?:${NUMBER_WORD})(?:[ \\t-]+(?:and|${NUMBER_WORD}))*)[ \\t]+(days|day|months|month|years|year)(?![A-Za-z])`,
  "gi"
)
const DECIMAL_PERIOD_RE = /\d+\.\d+\s*(?:days|day|months|month|years|year)\b/i
const FRACTION_PERIOD_RE = /\d+\s*\/\s*\d+\s*(?:days|day|months|month|years|year)\b/i

function parsePeriod(
  text: string
): { ok: true; n: number; unit: DateUnit; cited: string } | { ok: false; reason: "period_unreadable" | "period_ambiguous" } {
  const normalized = text.replace(/\s+/gu, " ")
  if (DECIMAL_PERIOD_RE.test(normalized) || FRACTION_PERIOD_RE.test(normalized)) return { ok: false, reason: "period_unreadable" }
  const phrases = [...normalized.matchAll(PERIOD_PHRASE_RE)]
  if (phrases.length !== 1) return { ok: false, reason: "period_unreadable" }
  const head = phrases[0][1].toLowerCase()
  if (head.includes("-") || head.includes(" ")) return { ok: false, reason: "period_unreadable" }
  const n = /^\d+$/.test(head) ? Number(head) : NUMBER_WORDS[head]
  if (n === undefined || !Number.isInteger(n) || n < 1 || n > 9999) return { ok: false, reason: "period_unreadable" }
  const word = phrases[0][2].toLowerCase()
  const unit: DateUnit = word.startsWith("day") ? "day" : word.startsWith("month") ? "month" : "year"
  return { ok: true, n, unit, cited: phrases[0][0] }
}

function utcToday(): string {
  const now = new Date()
  const month = String(now.getUTCMonth() + 1).padStart(2, "0")
  const day = String(now.getUTCDate()).padStart(2, "0")
  return `${now.getUTCFullYear()}-${month}-${day}`
}

function reckoningSource(
  versions: readonly LimitationVersion[],
  article: LimitationVersion,
  jurisdiction: string,
  asAt: string
): { ok: true; sectionId: string; versionNo: number; statedIn: "article" | "section" } | { ok: false; reason: NotAssessedReason } {
  if (RECKONING_RE.test(article.text)) {
    return { ok: true, sectionId: article.sectionId, versionNo: article.versionNo, statedIn: "article" }
  }
  const section = inForce(versions, "limitation-act-1908/section/12", jurisdiction, asAt)
  if (!section.ok) return { ok: false, reason: section.reason === "no_history" ? "reckoning_unverified" : section.reason }
  if (!RECKONING_RE.test(section.row.text)) return { ok: false, reason: "reckoning_unverified" }
  return { ok: true, sectionId: section.row.sectionId, versionNo: section.row.versionNo, statedIn: "section" }
}

function readPleaded(pleaded: LimitationFacts["pleaded"]): { copyDays: number | null; wrongCourtDays: number | null } | "bad" {
  const copyDays = readDays(pleaded?.copyDays)
  const wrongCourtDays = readDays(pleaded?.wrongCourtDays)
  if (copyDays === "bad" || wrongCourtDays === "bad") return "bad"
  return { copyDays, wrongCourtDays }
}

function readDays(value: number | undefined): number | null | "bad" {
  if (value === undefined) return null
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3650) return "bad"
  return value
}

function applyDayExclusion(
  versions: readonly LimitationVersion[],
  section: "12" | "14",
  jurisdiction: string,
  asAt: string,
  phrase: RegExp,
  deadline: string,
  days: number,
  effect: "exclude-copy-time" | "exclude-wrong-court"
): { ok: true; deadline: string; exclusion: ExclusionApplied } | { ok: false; reason: NotAssessedReason } {
  const row = inForce(versions, `limitation-act-1908/section/${section}`, jurisdiction, asAt)
  if (!row.ok) return { ok: false, reason: row.reason === "no_history" ? "exclusion_unsupported" : row.reason }
  if (!phrase.test(row.row.text)) return { ok: false, reason: "exclusion_unsupported" }
  return {
    ok: true,
    deadline: addDays(deadline, days),
    exclusion: {
      section,
      sectionId: row.row.sectionId,
      versionNo: row.row.versionNo,
      effect,
      statedIn: "section",
      days,
    },
  }
}

function applyCourtClosed(
  versions: readonly LimitationVersion[],
  forumId: string,
  jurisdiction: string,
  asAt: string,
  deadline: string,
  calendar: CourtCalendar | null
): { ok: true; deadline: string; finding: CourtClosedFinding; exclusion: ExclusionApplied | null } | { ok: false; reason: NotAssessedReason } {
  if (!calendar) {
    return { ok: true, deadline, finding: { status: "NOT_ASSESSED", reason: "no_court_calendar" }, exclusion: null }
  }
  if (!calendar.isClosed(forumId, deadline)) {
    return { ok: true, deadline, finding: { status: "CHECKED", closed: false }, exclusion: null }
  }
  const section = inForce(versions, "limitation-act-1908/section/4", jurisdiction, asAt)
  if (!section.ok || !CLOSED_RE.test(section.row.text)) return { ok: false, reason: "court_closed_rule_unverified" }
  let cursor = deadline
  let steps = 0
  while (calendar.isClosed(forumId, cursor)) {
    if (steps >= CLOSED_ROLL_LIMIT) return { ok: false, reason: "court_closed_unresolved" }
    cursor = addDays(cursor, 1)
    steps += 1
  }
  return {
    ok: true,
    deadline: cursor,
    finding: { status: "APPLIED", closed: true },
    exclusion: {
      section: "4",
      sectionId: section.row.sectionId,
      versionNo: section.row.versionNo,
      effect: "next-open-day",
      statedIn: "section",
      from: deadline,
      to: cursor,
    },
  }
}
