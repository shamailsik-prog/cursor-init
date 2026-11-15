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
import {
  hasUnicodeDash,
  isCanonicalMonthEnd,
  isCanonicalProviso,
  isCanonicalReckoning,
  NEUTRAL_WORDS,
  provisoShaped,
  QUANTITY_LABELS,
  UNICODE_DASH,
  wordsOf,
} from "@/services/d4-2/limitationAllowlist"

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
  seventy: 70,
  eighty: 80,
  ninety: 90,
}

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
  | "period_exceeds_engine_cap"
  | "accrual_before_floor"
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
  if (accrualDate < accrualFloor(facts.versions, cause.sectionId, forum.jurisdiction)) {
    return notAssessed("accrual_before_floor")
  }

  const article = inForce(facts.versions, cause.sectionId, forum.jurisdiction, accrualDate)
  if (!article.ok) return notAssessed(article.reason)
  const period = parsePeriod(article.row.text)
  if (!period.ok) return notAssessed(period.reason)

  const reckoning = reckoningSource(facts.versions, article.row, forum.jurisdiction, accrualDate)
  if (!reckoning.ok) return notAssessed(reckoning.reason)

  const clamp = normalizeSource(article.row.text).split(/[.\u0000]/).some((part) => isCanonicalMonthEnd(part))
  if (calendarOverflow(accrualDate, period.n, period.unit)) return notAssessed("period_unreadable")
  let deadline: string | null
  try {
    deadline = addUnit(accrualDate, period.n, period.unit, clamp)
  } catch {
    return notAssessed("period_unreadable")
  }
  if (deadline && !isCalendarDate(deadline)) return notAssessed("period_unreadable")
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

  let alerts: LimitationAlert[]
  try {
    alerts = limitationAlertSchedule(closed.deadline)
  } catch {
    return notAssessed("period_unreadable")
  }
  if (alerts.some((row) => !isCalendarDate(row.dueOn))) return notAssessed("period_unreadable")

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
    alerts,
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
        versionConfidence: row.versionConfidence ?? null,
      },
    ]
  })
}

/**
 * Engine floor for a year 0001–0099 that Date.UTC would mis-read, and for a text
 * that starts later. 1908-01-01 is not a finding that every article commenced that
 * day. [REQUIRES VERIFICATION] before a lawyer treats it as the Act's commencement.
 */
const ACT_FLOOR = "1908-01-01"

function accrualFloor(versions: readonly LimitationVersion[], sectionId: string, jurisdiction: string): string {
  let earliest = ""
  for (const row of versions) {
    if (row.sectionId !== sectionId || row.jurisdiction !== jurisdiction) continue
    if (!isCalendarDate(row.effectiveFrom)) continue
    if (earliest === "" || row.effectiveFrom < earliest) earliest = row.effectiveFrom
  }
  if (earliest === "" || earliest < ACT_FLOOR) return ACT_FLOOR
  return earliest
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
  if (!confidenceAllowsUse(source.versionConfidence)) return { ok: false, reason: "text_not_verified" }
  return { ok: true, row: source }
}

/** Ruling 4: only a finite number strictly above 0.5 and at most 1. Missing and non-numbers fail. */
function confidenceAllowsUse(value: unknown): boolean {
  return typeof value === "number" && versionUsable(value)
}

const TENS_WORDS = new Set(["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"])
const ONES_WORDS = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"])
/** M14: half is listed once. Both scanners read this array. */
const FRACTION_WORDS = ["dozen", "half", "quarter", "couple"]
const QUANTITY_WORDS = new Set([
  ...Object.keys(NUMBER_WORDS),
  "hundred",
  "thousand",
  "million",
  "billion",
  "trillion",
  "zero",
  "nought",
  ...FRACTION_WORDS,
])
const QUANTITY_ARTICLE_RE = new RegExp(
  `^\\s+(?:years?|months?|weeks?|days?|hours?|fortnights?|${FRACTION_WORDS.join("|")})\\b`,
  "i"
)
/** N11: fortnights? has to stay. Dropping it lets "three years or fortnights" assess. */
const UNIT_WORD_RE = /\b(fortnights?|weeks?|months?|years?|hours?|days?|mos|mths|yrs|wks|hrs|mo|yr|wk|hr)\b/gi
const FILLER_JOIN_RE = /\d(?:\p{Cf}|[\u034F\u3164\u2800])+\d|[A-Za-z](?:\p{Cf}|[\u034F\u3164\u2800])+[A-Za-z]/u
/**
 * Engine ceiling, not a Limitation Act article. 81 years and 9999 days still assess.
 * A longer span, including 10000 days, is period_exceeds_engine_cap.
 * [REQUIRES VERIFICATION] before anyone treats 100 years as the longest article
 * in the First Schedule.
 */
const SPAN_LIMIT_YEARS = 100
type NumberToken = { start: number; end: number; value: number | null; raw: string }

/**
 * A period is assessed only when every sentence is on the allowlist: the canonical
 * reckoning, the canonical month-end, a neutral label clause, or one quantity
 * clause. The quantity clause is optional label words, one English cardinal or
 * digit run, and one day, month, or year. Anything else is period_ambiguous, or
 * period_unreadable when the sentence was trying to be a proviso or a unicode
 * dash appears anywhere in the provision. A count above the engine ceiling is
 * period_exceeds_engine_cap. A single newline is a space. A blank line splits.
 */
function normalizeSource(text: string): string {
  let out = text.replace(/\p{Cf}/gu, "").replace(/\r\n?/g, "\n")
  out = out.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u0060\u00B4]/g, "'")
  out = out.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
  out = out.replace(/[\u2028\u2029\u0085\u000B]/g, "\n")
  while (/\n[ \t]*\n/.test(out)) out = out.replace(/\n[ \t]*\n/g, "\u0000")
  out = out.replace(/\n/g, " ")
  return out.replace(/[^\S\n\u0000]+/gu, " ")
}

function parsePeriod(
  text: string
):
  | { ok: true; n: number; unit: DateUnit; cited: string }
  | { ok: false; reason: "period_unreadable" | "period_ambiguous" | "period_exceeds_engine_cap" } {
  if (/\p{No}/u.test(text)) return { ok: false, reason: "period_unreadable" }
  if (FILLER_JOIN_RE.test(text)) return { ok: false, reason: "period_unreadable" }
  const normalized = normalizeSource(text)
  if (hasUnicodeDash(normalized)) return { ok: false, reason: "period_unreadable" }
  const sentences = normalized.split(/[.\u0000]/)
  for (const sentence of sentences) {
    if (sentence.trim() === "") continue
    if (provisoShaped(sentence) && !isCanonicalProviso(sentence)) return { ok: false, reason: "period_unreadable" }
  }
  const scan = sentences
    .filter((sentence) => sentence.trim() !== "" && !isCanonicalProviso(sentence))
    .join(". ")
    .replace(/[^\S\n]+/gu, " ")
  const numbers = numberTokens(scan)
  UNIT_WORD_RE.lastIndex = 0
  const units = [...scan.matchAll(UNIT_WORD_RE)]
  if (numbers.length !== 1 || units.length !== 1) return { ok: false, reason: "period_unreadable" }
  const number = numbers[0]
  const unitMatch = units[0]
  if (!number || unitMatch.index === undefined) return { ok: false, reason: "period_unreadable" }
  const unitEnd = unitMatch.index + (unitMatch[0]?.length ?? 0)
  if (scan.slice(number.end, unitMatch.index) !== " ") return { ok: false, reason: "period_unreadable" }
  if (badNeighbour(scan, number.start, number.end) || spacedMark(scan, number.start)) {
    return { ok: false, reason: "period_unreadable" }
  }
  const previous = /([A-Za-z]+)$/.exec(scan.slice(0, number.start).trimEnd())?.[1]?.toLowerCase()
  const extras = quantityExtras(scan, number.start, unitEnd)
  if (
    extras.length === 1 &&
    (extras[0] === "and" || extras[0] === "or" || extras[0] === "to") &&
    previous === extras[0]
  ) {
    return { ok: false, reason: "period_unreadable" }
  }
  if (outsideAllowlist(scan, number.start, unitEnd)) return { ok: false, reason: "period_ambiguous" }
  const unit = canonicalUnit(unitMatch[1] ?? "")
  if (!unit || number.value === null || !Number.isSafeInteger(number.value) || number.value < 1) {
    return { ok: false, reason: "period_unreadable" }
  }
  if (!spanAllowed(number.value, unit)) return { ok: false, reason: "period_exceeds_engine_cap" }
  return { ok: true, n: number.value, unit, cited: `${number.raw} ${unitMatch[1]}` }
}

function spanAllowed(n: number, unit: DateUnit): boolean {
  if (unit === "year") return n <= SPAN_LIMIT_YEARS
  if (unit === "month") return n <= SPAN_LIMIT_YEARS * 12
  return n <= 9999
}

function calendarOverflow(iso: string, n: number, unit: DateUnit): boolean {
  const year = Number(iso.slice(0, 4))
  const month = Number(iso.slice(5, 7))
  const day = Number(iso.slice(8, 10))
  try {
    if (unit === "day") {
      const utc = Date.UTC(year, month - 1, day + n)
      if (!Number.isFinite(utc)) return true
      const end = new Date(utc).getUTCFullYear()
      return !Number.isInteger(end) || end < 1 || end > 9999
    }
    const months = unit === "year" ? n * 12 : n
    const end = year + Math.floor((month - 1 + months) / 12)
    return !Number.isInteger(end) || end < 1 || end > 9999
  } catch {
    return true
  }
}

function splitClauses(text: string): { start: number; end: number }[] {
  const clauses: { start: number; end: number }[] = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? ""
    if (ch === "." || ch === ";" || ch === ":" || ch === "\u0000") {
      clauses.push({ start, end: i })
      start = i + 1
    }
  }
  clauses.push({ start, end: text.length })
  return clauses
}

function quantityExtras(text: string, numberStart: number, unitEnd: number): string[] {
  const clauses = splitClauses(text)
  const index = clauses.findIndex((clause) => numberStart >= clause.start && numberStart < clause.end)
  const clause = index < 0 ? undefined : clauses[index]
  if (!clause) return ["missing"]
  return [...wordsOf(text.slice(clause.start, numberStart)), ...wordsOf(text.slice(unitEnd, clause.end))].filter(
    (word) => !QUANTITY_LABELS.has(word)
  )
}

function outsideAllowlist(text: string, numberStart: number, unitEnd: number): boolean {
  const clauses = splitClauses(text)
  const index = clauses.findIndex((clause) => numberStart >= clause.start && numberStart < clause.end)
  if (index < 0) return true
  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i]
    if (!clause) return true
    const slice = text.slice(clause.start, clause.end)
    if (clauseForbidden(slice)) return true
    const words = i === index
      ? [...wordsOf(text.slice(clause.start, numberStart)), ...wordsOf(text.slice(unitEnd, clause.end))]
      : wordsOf(slice)
    const allowed = i === index ? QUANTITY_LABELS : NEUTRAL_WORDS
    if (words.some((word) => !allowed.has(word))) return true
  }
  return false
}

function clauseForbidden(clause: string): boolean {
  if (/\p{S}/u.test(clause) || /[<>+=~]/.test(clause)) return true
  for (const char of clause) {
    if (char.charCodeAt(0) > 127 && /\p{L}/u.test(char)) return true
  }
  return false
}

function textHasCanonicalReckoning(text: string): boolean {
  return normalizeSource(text).split(/[.\u0000]/).some((part) => isCanonicalReckoning(part))
}

function isSymbolCode(code: number): boolean {
  return /\p{S}/u.test(String.fromCodePoint(code))
}

function isDashCode(code: number): boolean {
  return UNICODE_DASH.test(String.fromCodePoint(code))
}

function spacedMark(text: string, start: number): boolean {
  if (start < 2 || text[start - 1] !== " ") return false
  const mark = text[start - 2] ?? ""
  return (mark === "-" || mark === "." || mark === "~") && isDigit(text[start] ?? "")
}

function numberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = []
  let i = 0
  while (i < text.length) {
    const word = readWord(text, i)
    if (word) {
      const lower = word.toLowerCase()
      const compound = compoundToken(text, i, word, lower)
      if (compound) {
        tokens.push(compound)
        i = compound.end
        continue
      }
      if ((lower === "a" || lower === "an") && quantityArticle(text, i + word.length)) {
        tokens.push({ start: i, end: i + word.length, value: 1, raw: word })
        i += word.length
        continue
      }
      if (QUANTITY_WORDS.has(lower)) {
        tokens.push({ start: i, end: i + word.length, value: NUMBER_WORDS[lower] ?? null, raw: word })
        i += word.length
        continue
      }
      i += word.length
      continue
    }
    if (isDigit(text[i] ?? "")) {
      let end = i + 1
      while (end < text.length && isDigit(text[end] ?? "")) end += 1
      const raw = text.slice(i, end)
      tokens.push({ start: i, end, value: Number(raw), raw })
      i = end
      continue
    }
    i += 1
  }
  return tokens
}

function compoundToken(text: string, start: number, word: string, lower: string): NumberToken | null {
  if (!TENS_WORDS.has(lower)) return null
  const joiner = text[start + word.length]
  if (joiner !== "-" && joiner !== " ") return null
  const ones = readWord(text, start + word.length + 1)
  if (!ones || !ONES_WORDS.has(ones.toLowerCase())) return null
  const tens = NUMBER_WORDS[lower]
  const onesValue = NUMBER_WORDS[ones.toLowerCase()]
  if (tens === undefined || onesValue === undefined) return null
  const end = start + word.length + 1 + ones.length
  return { start, end, value: tens + onesValue, raw: text.slice(start, end) }
}

function quantityArticle(text: string, after: number): boolean {
  return QUANTITY_ARTICLE_RE.test(text.slice(after))
}

function badNeighbour(text: string, start: number, end: number): boolean {
  const before = start === 0 ? "" : (text[start - 1] ?? "")
  const after = end >= text.length ? "" : (text[end] ?? "")
  if (after !== " ") return true
  if (before !== "" && before !== " " && before !== "(") return true
  for (const index of [start - 1, start - 2, end, end + 1]) {
    if (index < 0 || index >= text.length) continue
    const code = text.codePointAt(index) ?? 0
    if (code > 0x7e && !isSymbolCode(code) && !isDashCode(code)) return true
  }
  return false
}

function canonicalUnit(word: string): DateUnit | null {
  const lower = word.toLowerCase()
  if (lower === "day" || lower === "days") return "day"
  if (lower === "month" || lower === "months") return "month"
  if (lower === "year" || lower === "years") return "year"
  return null
}

function readWord(text: string, index: number): string | null {
  if (!isLetter(text[index] ?? "")) return null
  if (index > 0 && isLetter(text[index - 1] ?? "")) return null
  let end = index + 1
  while (end < text.length && isLetter(text[end] ?? "")) end += 1
  return text.slice(index, end)
}

function isLetter(ch: string): boolean {
  return /[A-Za-z]/.test(ch)
}

function isDigit(ch: string): boolean {
  return /[0-9]/.test(ch)
}

function shiftDays(iso: string, days: number): string | null {
  try {
    const next = addDays(iso, days)
    return isCalendarDate(next) ? next : null
  } catch {
    return null
  }
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
  if (textHasCanonicalReckoning(article.text)) {
    return { ok: true, sectionId: article.sectionId, versionNo: article.versionNo, statedIn: "article" }
  }
  const section = inForce(versions, "limitation-act-1908/section/12", jurisdiction, asAt)
  if (!section.ok) return { ok: false, reason: section.reason === "no_history" ? "reckoning_unverified" : section.reason }
  if (!textHasCanonicalReckoning(section.row.text)) return { ok: false, reason: "reckoning_unverified" }
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
  const shifted = shiftDays(deadline, days)
  if (!shifted) return { ok: false, reason: "period_unreadable" }
  return {
    ok: true,
    deadline: shifted,
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
    const next = shiftDays(cursor, 1)
    if (!next) return { ok: false, reason: "period_unreadable" }
    cursor = next
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
