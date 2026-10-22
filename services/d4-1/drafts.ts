import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import { rankOf, rankOfStoredOrMax, type DraftRecord, type SpineStore } from "@/platform/spine/store"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  checkTemporalConsistency,
  verifyCitations,
  type CitationFinding,
} from "@/services/d4-2/draftingIntelligence"
import { extractCitations } from "@/services/d4-2/citations"
import { requireSupportedDraftBody, requireSupportedDraftTitle } from "@/services/d4-2/draftCharset"
import courtsSeed from "@/data/courts.json"
import { loadCourts, normalise as normaliseCaseNumber } from "@/core/case-number-normaliser"

const courts = loadCourts(courtsSeed)

/** A case reference that normalises to the matter's own recorded case number is not an authority. */
// Court mentions -> the courts each one can mean (R5-4, widened by R6 F-2). Explicit names and
// apex phrases name one court; a seat city or bench names every court seated there
// (data/courts.json "seats"), so "Karachi" is consistent with both SHC and the Karachi district
// courts, while "Sukkur" excludes a Karachi district-court matter.
const COURT_NAME_MENTIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ["SC_PK", /\b(?:supreme\s+court|apex\s+court)\b|\bhon(?:'|\u2019)?ble\s+supreme\b|سپریم\s+کورٹ|عدالت\s+عظمی/iu],
  ["FSC", /\bfederal\s+shariat\s+court\b|\bFSC\b|وفاقی\s+شرعی\s+عدالت/u],
  ["LHC", /\blahore\s+high\s+court\b|\bhigh\s+court\s+of\s+(?:the\s+)?punjab\b|\bLHC\b/iu],
  ["SHC", /\bsindh\s+high\s+court\b|\bhigh\s+court\s+of\s+sindh\b|\bSHC\b/iu],
  ["IHC", /\bislamabad\s+high\s+court\b|\bIHC\b/iu],
  ["PHC", /\bpeshawar\s+high\s+court\b|\bPHC\b/iu],
  ["BHC", /\bbalochistan\s+high\s+court\b|\bhigh\s+court\s+of\s+balochistan\b|\bBHC\b/iu],
]
const SEAT_MENTIONS: ReadonlyArray<readonly [Set<string>, RegExp]> = (() => {
  const bySeat = new Map<string, Set<string>>()
  for (const court of (courtsSeed as { courts: Array<{ id: string; seats?: string[] }> }).courts) {
    for (const seat of court.seats ?? []) {
      const ids = bySeat.get(seat) ?? new Set<string>()
      ids.add(court.id)
      bySeat.set(seat, ids)
    }
  }
  return [...bySeat.entries()].map(([seat, ids]) => {
    const words = seat.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*")
    return [ids, new RegExp(`(?<![\\p{L}])${words}(?![\\p{L}])`, "iu")] as const
  })
})()
/**
 * `pattern.test`, fast for "iu" patterns with \b (SEC-1): V8 runs \b under the u+i flags about
 * 50 times slower, which made the own-case check the slowest part of a large draft. The same
 * pattern without \b (a superset) finds every candidate start; the exact pattern is then tried
 * at each, so the answer is pattern.test(text).
 */
function mentionTest(pattern: RegExp): (text: string) => boolean {
  if (!(pattern.flags.includes("i") && pattern.flags.includes("u") && pattern.source.includes("\\b"))) {
    return (text) => pattern.test(text)
  }
  const loose = new RegExp(pattern.source.replaceAll("\\b", ""), "giu")
  const exact = new RegExp(pattern.source, "iuy")
  return (text) => {
    loose.lastIndex = 0
    for (let m = loose.exec(text); m; m = loose.exec(text)) {
      exact.lastIndex = m.index
      if (exact.test(text)) return true
      loose.lastIndex = m.index + ((text.codePointAt(m.index) ?? 0) > 0xffff ? 2 : 1)
    }
    return false
  }
}
const COURT_NAME_TESTS = COURT_NAME_MENTIONS.map(([id, pattern]) => [id, mentionTest(pattern)] as const)

/** Each court mention in the text, as the set of courts it can mean. */
function courtMentions(text: string): Array<ReadonlySet<string>> {
  const named = COURT_NAME_TESTS.filter(([, test]) => test(text)).map(([id]) => new Set([id]))
  // a seat city inside an explicit court name ("Lahore High Court") adds nothing new
  const seats = SEAT_MENTIONS.filter(([, pattern]) => pattern.test(text)).map(([ids]) => ids)
  return [...named, ...seats]
}

/** Case-number text with case, dots, "No."/"Number", "of"/"/" and spacing folded away. */
function comparableCaseNumber(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\./g, " ")
    .replace(/\b(?:NO|NUMBER)\b/g, " ")
    .replace(/\s+OF\s+/g, "/")
    .replace(/[\s/]+/g, "")
}

export function ownCaseReferenceMatcher(matter: {
  /** Audit F13: null for a matter Cloud Functions opened without a court. */
  courtId: string | null
  caseNumber: string | null
}): (raw: string, context?: OwnCaseContext) => boolean {
  // SEC-1: the citation gate asks this for every word suffix of every case reference in a
  // draft. A reference can only be the recorded number if its digits end with the recorded
  // number and year (both readings below keep digits verbatim and in order), so the rest is
  // skipped for every other reference; answers are memoised per reference text.
  let memoFor: string | null = null
  let requiredDigits = ""
  let memo = new Map<string, boolean>()
  const isRecordedNumber = (raw: string, caseNumber: string): boolean => {
    if (memoFor !== caseNumber) {
      const tail = /(\d{1,6})(?:-[A-Z])?\/(\d{4})$/.exec(caseNumber)
      requiredDigits = tail ? `${tail[1]}${tail[2]}` : caseNumber.replace(/[^0-9]/g, "")
      memo = new Map()
      memoFor = caseNumber
    }
    if (!raw.replace(/[^0-9]/g, "").endsWith(requiredDigits)) return false
    const known = memo.get(raw)
    if (known !== undefined) return known
    let same: boolean | undefined
    try {
      if (matter.courtId !== null) {
        const result = normaliseCaseNumber(raw, matter.courtId, courts)
        if (result.status !== "REJECT") same = result.canonical === caseNumber
      }
    } catch {
      // fall through to the raw comparison
    }
    // R4 FP2: the normaliser cannot parse this reference — accept it when it is written the
    // same way as the recorded number (case, dots, "No.", "of"/"/" and spacing aside).
    same ??= comparableCaseNumber(raw) === comparableCaseNumber(caseNumber)
    memo.set(raw, same)
    return same
  }
  return (raw, context) => {
    if (!matter.caseNumber) return false
    // (the number is compared first: the court mentions below only matter for the recorded one)
    if (!isRecordedNumber(raw, matter.caseNumber)) return false
    // R5-4 / R6 F-2: every court mentioned in the reference's sentence must admit the matter's court
    // ("The Supreme Court in C.P. No. 12 of 2019" is not an SHC matter's C.P. No. 12 of 2019).
    if (context) {
      const mentions = courtMentions(`${context.before} ${raw} ${context.after}`)
      // A matter with no court admits no mentioned court (fail closed, audit F13).
      if (mentions.some((ids) => matter.courtId === null || !ids.has(matter.courtId))) return false
    }
    return true
  }
}
import { getDocumentTypes } from "@/lib/foundation-data"
import type { OwnCaseContext } from "@/services/d4-2/citations"

export type TemplateSummary = {
  id: string
  name: string
  posture: string
  category: string
}

export type TemporalCitationInput = {
  sectionId: string
  offenceDate: string
  usedText: string
}

export type DraftPreflightInput = {
  actorId: string
  matterId: string
  classification: Classification
  /** Judgment ids or citation strings the caller lists; unioned with the draft body's citations. */
  citedJudgmentIds: string[]
  temporalCitations: TemporalCitationInput[]
  partnerOverride?: { partnerId: string; reason: string }
  /** Draft text; every reported citation in it is extracted and checked (Module 33). */
  draftBody?: string
  /** Draft title (R4-2): charset-checked and gated together with the body. */
  draftTitle?: string
}

/** The text the gate reads for a draft (R4-2): the normalised title, a newline, the normalised body. */
export function gatedDraftText(title: string, body: string): string {
  return title ? `${title}\n${body}` : body
}

export type DraftPreflightResult = {
  ok: boolean
  citationStatus: "OK" | "OVERRULED" | "UNVERIFIED"
  /** Per-authority Module 33 result: VERIFIED / UNVERIFIED / OVERRULED. */
  citations: CitationFinding[]
  temporal: Array<{ sectionId: string; status: "OK" | "TEMPORAL-MISMATCH" }>
  /** Set when a citation-gate block was cleared by the calling partner's recorded reason. */
  partnerOverride?: { partnerId: string; reason: string }
}

export function listTemplateCatalog(query: string): TemplateSummary[] {
  const normalizedQuery = query.toLowerCase()
  return getDocumentTypes()
    .map((type) => ({
      id: type.id,
      name: type.name,
      posture: type.posture,
      category: type.category,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((item) => {
      if (!normalizedQuery) return true
      return (
        item.id.toLowerCase().includes(normalizedQuery) ||
        item.name.toLowerCase().includes(normalizedQuery) ||
        item.posture.toLowerCase().includes(normalizedQuery)
      )
    })
}

export function listTemplates(
  query: string,
  limit: number,
  cursor: number
): { items: TemplateSummary[]; total: number; nextCursor: string | null } {
  const all = listTemplateCatalog(query)
  const items = all.slice(cursor, cursor + limit)
  const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
  return { items, total: all.length, nextCursor }
}

export function runDraftPreflight(
  store: SpineStore,
  input: DraftPreflightInput,
  options: { recordOverride?: boolean } = {}
): DraftPreflightResult {
  if (!isClassification(input.classification)) {
    throw new PublicError("classification must be a rank-0–4 label")
  }
  const actor = store.users.get(input.actorId)
  if (!actor) throw new PublicError("unknown actor")
  const matter = store.matters.get(input.matterId)
  if (!matter) throw new PublicError("unknown matter")
  const permission = checkPermission(store, input.actorId, "draft", input.matterId)
  if (!permission.allow) throw new PublicError(`permission denied: ${permission.reason}`)
  if (rankOf(input.classification) < rankOfStoredOrMax(matter.classification)) {
    throw new PublicError("draft classification cannot be lower than matter classification")
  }

  // Review round 3: refuse (422 unsupported_characters) any body containing characters that can
  // disguise text; analyse the normalised body (NFC, ASCII digits/dashes).
  const body = input.draftBody === undefined ? "" : requireSupportedDraftBody(input.draftBody)
  // R4-2: the title is court-facing text too — same refusal, same gate.
  const title = input.draftTitle === undefined ? "" : requireSupportedDraftTitle(input.draftTitle)
  const caller = { actorId: input.actorId, firmId: matter.firmId }
  // Module 33: the gate checks union(extracted from the body, caller-listed), never only the latter.
  const refs = [
    ...extractCitations(gatedDraftText(title, body), { isOwnCaseReference: ownCaseReferenceMatcher(matter) }),
    ...(input.citedJudgmentIds ?? []),
  ]
  const citation = verifyCitations(store, refs, input.partnerOverride, caller)
  const citationStatus = citation.status
  const overrideApplied =
    citation.overridden && input.partnerOverride
      ? { partnerId: input.partnerOverride.partnerId, reason: input.partnerOverride.reason.trim() }
      : undefined
  // Only committing steps record the override (review R1 #7): compose and package creation
  // (the approval-routing step) pass recordOverride; a preflight dry run does not.
  if (overrideApplied && options.recordOverride === true) {
    store.audit.push({
      action: "citation_gate_override",
      actorId: input.actorId,
      target: input.matterId,
      classification: isClassification(matter.classification) ? matter.classification : "privileged-restricted",
      reason: overrideApplied.reason,
      overriddenAuthorities: citation.findings
        .filter((f) => f.status !== "VERIFIED")
        .map((f) => `${f.ref}:${f.status}`),
    })
  }
  const temporal = input.temporalCitations.map((row) => {
    const gate = checkTemporalConsistency(
      store,
      row.sectionId,
      row.offenceDate,
      row.usedText
    )
    return {
      sectionId: row.sectionId,
      status: gate.status === "TEMPORAL-MISMATCH" ? ("TEMPORAL-MISMATCH" as const) : ("OK" as const),
    }
  })
  const temporalBlocked = temporal.some((row) => row.status !== "OK")
  const citationBlocked = citationStatus !== "OK"

  return {
    ok: !citationBlocked && !temporalBlocked,
    citationStatus,
    citations: citation.findings,
    temporal,
    ...(overrideApplied ? { partnerOverride: overrideApplied } : {}),
  }
}

export function composeDraft(
  store: SpineStore,
  input: {
    actorId: string
    matterId: string
    templateId: string
    title: string
    body: string
    classification: Classification
    preflight: DraftPreflightInput
  }
): DraftRecord {
  const templateExists = getDocumentTypes().some((type) => type.id === input.templateId)
  if (!templateExists) throw new PublicError("unknown templateId")
  // The stored body is exactly the analysed body: refused if it has disguising characters,
  // otherwise normalised (NFC, ASCII digits/dashes) before the gate reads it and it is saved.
  const body = requireSupportedDraftBody(input.body)
  const title = requireSupportedDraftTitle(input.title)
  // The gate always reads the title and body being saved, whatever the caller put in preflight.
  const gate = runDraftPreflight(store, { ...input.preflight, draftBody: body, draftTitle: title }, { recordOverride: true })
  if (!gate.ok) {
    throw new PublicError("preflight blocked drafting")
  }
  const matter = store.matters.get(input.matterId)
  if (!matter) throw new PublicError("unknown matter")
  const draft: DraftRecord = {
    id: store.id("drf"),
    firmId: matter.firmId,
    matterId: input.matterId,
    templateId: input.templateId,
    title,
    body,
    classification: input.classification,
    createdBy: input.actorId,
    createdAt: Date.now(),
    status: "draft",
  }
  store.drafts.set(draft.id, draft)
  return draft
}
