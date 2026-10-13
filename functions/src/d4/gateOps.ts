import { randomUUID } from "node:crypto"
import { Timestamp, type DocumentData, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import type { DraftAction } from "@/platform/p5/permissionDecision"
import { checkDraftCharset, cleanPasteArtefacts } from "@/services/d4-2/draftCharset"
import { adminDb } from "../admin"
import { contentionDeadline, isContentionAbort } from "../d1/contention"
import { HttpError } from "../http/errors"
import type { Caller } from "../p5/auth"
import type { FirmOperation } from "../p5/common"
import { activeAuthorityStore } from "./authority"
import {
  draftView,
  loadDraftForCaller,
  parseDraftId,
  parseVersionNumber,
  requireStillPermitted,
  sha256Hex,
  stageDraftEvent,
  versionId,
  type DraftView,
  type GateSummary,
  type ReviewChecklistEntry,
} from "./drafts"
import { getDocumentType, isLawDependent, reviewChecklistOf } from "./doctypes"
import { runGate, scopeOf } from "./gate"
import {
  GATE_SEVERITY,
  type CitationFinding,
  type CitationStatus,
  type GateEvaluation,
  type GateScope,
  type GateStatus,
  type TemporalCheck,
  type TemporalFinding,
  type TemporalStatus,
} from "./types"

/**
 * The citation gate, the partner override and the approval stand-in on Cloud Functions (spec P4-6..P4-9, P4-12):
 * `gateDraft` and `getVerificationReport` behind `/api/d4/intelligence/`, `overrideGate` and `approveDraft` behind
 * `/api/d4/drafting/`. The safety spine: no unverified or overruled authority reaches a partner's approval unflagged
 * (L1716, E-22).
 *
 * Collections (server-only, firestore.rules P4-11):
 * - `draft_gate_results/{draftId}_{n}`: the latest gate run of version n (replaced by a re-gate of n, and by the run an
 *   approval makes), with a fresh `resultId` per run (R6) and `gateRuns`, the count of gateDraft runs of n (the
 *   `draft.gated` event ids).
 * - `draft_gate_overrides/{draftId}_{n}`: the one immutable partner override of version n, bound to its body hash and
 *   to the `resultId` of the result the partner reviewed (R6). Once it exists the version is not re-gated (R5): the
 *   check set the partner cleared is frozen, and only approval runs, which reuse those checks, replace the result.
 * The draft holds the summary of its current version's latest run (`gateResult`, P4-4) and `lastGatedVersion`, the
 * version whose result the verification report shows and whose recorded checks every later gate run carries (R10).
 *
 * Every status is held to its domain before it is stored or compared: a citation status outside VERIFIED, UNVERIFIED
 * and OVERRULED is UNVERIFIED, a temporal status outside OK, TEMPORAL_MISMATCH and TEMPORAL_UNAVAILABLE is
 * TEMPORAL_UNAVAILABLE ("verify manually"), and the overall status is the most severe of the runner's own and the
 * findings', so nothing outside the domain can pass as OK. A result with no finding at all is NOT_ASSESSED (F06): it
 * assessed nothing, so it never passes as OK either; only the partner override clears it, and approving a
 * law-dependent document type also needs its review checklist with evidence (`requireReviewChecklist`).
 */

const versions = () => adminDb().collection("draft_versions")
const results = () => adminDb().collection("draft_gate_results")
const overrides = () => adminDb().collection("draft_gate_overrides")

const conflict = (code: string) => new HttpError(409, code)
const iso = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null)
/** Length in Unicode code points (an Urdu letter or an emoji is one character). */
const chars = (text: string): number => [...text].length

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** At most this many caller-supplied temporal checks per gate (P4-6). */
export const MAX_TEMPORAL_CHECKS = 20
const SECTION_ID = /^[A-Za-z0-9_.:-]{1,200}$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
/** R11: an upper-case code (PK, AJK, SINDH, FEDERAL, ...): no space, no no-break space, no lower case, nothing outside ASCII. */
const JURISDICTION = /^[A-Z0-9_.:-]{1,50}$/
const MAX_USED_TEXT = 10_000
/** The usedText of all checks together, in UTF-8 bytes (R8): bounds the stored result. */
const MAX_USED_TEXT_BYTES = 200_000
/** The most a stored gate result's findings may take, as JSON in UTF-8 (R8); Firestore limits a document to 1 MiB. */
export const MAX_RESULT_BYTES = 900_000
const MIN_REASON = 20
const MAX_REASON = 2_000

/** A real proleptic-Gregorian date written YYYY-MM-DD, from 0001-01-01 (a 30 February or a 13th month is not one). */
function isCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value)
  if (!m) return false
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  return day <= days
}

/** A check's match key, `sectionId|asAtDate|jurisdiction`: none of the three can hold `|`, so keys never collide. */
const checkKey = (c: TemporalCheck): string => `${c.sectionId}|${c.asAtDate}|${c.jurisdiction}`

/**
 * The caller's temporal checks (P4-6): absent is none; otherwise an array of at most 20 objects, each with a `sectionId`
 * matching /^[A-Za-z0-9_.:-]{1,200}$/, an `asAtDate` that is a real YYYY-MM-DD date, a `jurisdiction` matching
 * /^[A-Z0-9_.:-]{1,50}$/ (R11) and a `usedText` of 1 to 10,000 characters, no two with the same (sectionId, asAtDate,
 * jurisdiction) (a clearance of one would cover the other: the final review's PROBE-2). Anything else is 400
 * `invalid_temporal_checks`. Only the four fields are kept: nothing else a caller sent (a status, an in-force text)
 * reaches the gate.
 */
export function parseTemporalChecks(value: unknown): TemporalCheck[] {
  if (value === undefined) return []
  const invalid = () => new HttpError(400, "invalid_temporal_checks")
  if (!Array.isArray(value) || value.length > MAX_TEMPORAL_CHECKS) throw invalid()
  const checks = value.map((entry: unknown): TemporalCheck => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw invalid()
    const { sectionId, asAtDate, jurisdiction, usedText } = entry as Record<string, unknown>
    if (typeof sectionId !== "string" || !SECTION_ID.test(sectionId)) throw invalid()
    if (typeof asAtDate !== "string" || !isCalendarDate(asAtDate)) throw invalid()
    if (typeof jurisdiction !== "string" || !JURISDICTION.test(jurisdiction)) throw invalid()
    if (typeof usedText !== "string" || chars(usedText) < 1 || chars(usedText) > MAX_USED_TEXT) throw invalid()
    return { sectionId, asAtDate, jurisdiction, usedText }
  })
  if (new Set(checks.map(checkKey)).size !== checks.length) throw invalid()
  if (checks.reduce((sum, c) => sum + Buffer.byteLength(c.usedText, "utf8"), 0) > MAX_USED_TEXT_BYTES) throw invalid()
  return checks
}

/**
 * Caller text the gate stores (R7: a usedText, an override reason; a jurisdiction that is not R11's pattern was already
 * refused with 400 `invalid_temporal_checks`) is refused with 422 `unsupported_characters` on the draft body's charset rule (checkDraftCharset: bidirectional controls, invisible
 * characters, confusables). What is stored is the text with the rule's paste artefacts removed (a zero-width space
 * inside a word, a soft hyphen), each CRLF turned into LF (a Windows paste is not a mismatch; the body rule does the
 * same), in NFC, and nothing more: no dash or digit folding, because a usedText is compared exactly (after NFC) with
 * the statute text in force, and statute text carries its em dashes.
 */
function requireSupportedText(raw: string): string {
  if (!checkDraftCharset(raw).ok) throw new HttpError(422, "unsupported_characters")
  return cleanPasteArtefacts(raw).replace(/\r\n/g, "\n").normalize("NFC")
}

/** The charset rule on each check's usedText (R7; a jurisdiction already matched R11's pattern), then the parse again on the stored form (400). */
function requireSupportedChecks(checks: readonly TemporalCheck[]): TemporalCheck[] {
  const out = checks.map((c) => ({ ...c, jurisdiction: requireSupportedText(c.jurisdiction), usedText: requireSupportedText(c.usedText) }))
  try {
    return parseTemporalChecks(out)
  } catch {
    throw new HttpError(400, "invalid_temporal_checks")
  }
}

/** An override's reason: a string of 20 to 2,000 characters once trimmed (400 `invalid_reason`); the trimmed text is kept. */
function parseReason(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_reason")
  const reason = value.trim()
  if (chars(reason) < MIN_REASON || chars(reason) > MAX_REASON) throw new HttpError(400, "invalid_reason")
  return reason
}

/** The reason as stored (R7): the charset rule (422), then the length again on the stored form (400 `invalid_reason`). */
function supportedReason(reason: string): string {
  return parseReason(requireSupportedText(reason))
}

/** The id of the gate result the partner reviewed (R6): a string (400 `invalid_result_id`). */
function parseResultId(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_result_id")
  return value
}

/** At most this many entries in a review checklist (F06); the longest seed checklist has 12 items. */
export const MAX_REVIEW_CHECKLIST_ENTRIES = 50
const MAX_CHECKLIST_ITEM = 500
/** The most evidence one checklist item may carry, in characters once trimmed (F06). */
export const MAX_CHECKLIST_EVIDENCE = 2_000

/**
 * The approval's review checklist as sent (F06): absent is none (null); otherwise an array of at most 50 entries,
 * each an object with a string `item` (1 to 500 characters) and a string `evidence` of at most 2,000 characters once
 * trimmed (one or more lines). Anything else is 400 `invalid_review_checklist`, checked with the other 400s, before
 * the permission. Only the two fields are kept. Whether the entries answer the type's checklist, and whether each
 * evidence says something, is decided after the permission (`requireReviewChecklist`, 422).
 */
export function parseReviewChecklist(value: unknown): ReviewChecklistEntry[] | null {
  if (value === undefined) return null
  const invalid = () => new HttpError(400, "invalid_review_checklist")
  if (!Array.isArray(value) || value.length > MAX_REVIEW_CHECKLIST_ENTRIES) throw invalid()
  return value.map((entry: unknown): ReviewChecklistEntry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw invalid()
    const { item, evidence } = entry as Record<string, unknown>
    if (typeof item !== "string" || chars(item) < 1 || chars(item) > MAX_CHECKLIST_ITEM) throw invalid()
    if (typeof evidence !== "string" || chars(evidence.trim()) > MAX_CHECKLIST_EVIDENCE) throw invalid()
    return { item, evidence }
  })
}

/**
 * The review checklist an approval of `documentTypeId` needs and stores (F06), or null when it needs and has none.
 * A law-dependent type (filed in a forum: `isLawDependent`) needs one; for a NON_FORUM type it is optional, but one
 * that is sent is held to the same rule. The rule: the entries name every item of the type's checklist
 * (`reviewChecklistOf`) exactly once, by exact string, in any order, and nothing else, and every evidence is something
 * once trimmed; otherwise 422 `review_checklist_incomplete`. Each evidence then passes the draft charset rule (422
 * `unsupported_characters`, R7) and is stored as the override reason is (paste artefacts removed, CRLF as LF, NFC),
 * trimmed, and checked again on that form (empty: 422 `review_checklist_incomplete`; over 2,000 characters: 400
 * `invalid_review_checklist`). The entries come back in the type's order. A draft whose type is no longer a verified
 * type cannot be checked and is not approved (404 `document_type_not_found`).
 */
function requireReviewChecklist(documentTypeId: unknown, sent: readonly ReviewChecklistEntry[] | null): ReviewChecklistEntry[] | null {
  const type = typeof documentTypeId === "string" ? getDocumentType(documentTypeId) : null
  if (type === null) throw new HttpError(404, "document_type_not_found")
  if (sent === null && !isLawDependent(type)) return null
  const incomplete = () => new HttpError(422, "review_checklist_incomplete")
  if (sent === null) throw incomplete()
  const items = reviewChecklistOf(type)
  const byItem = new Map<string, string>()
  for (const entry of sent) {
    if (!items.includes(entry.item) || byItem.has(entry.item) || entry.evidence.trim() === "") throw incomplete()
    byItem.set(entry.item, entry.evidence)
  }
  if (byItem.size !== items.length) throw incomplete()
  return items.map((item) => {
    const evidence = requireSupportedText(byItem.get(item) as string).trim()
    if (evidence === "") throw incomplete()
    if (chars(evidence) > MAX_CHECKLIST_EVIDENCE) throw new HttpError(400, "invalid_review_checklist")
    return { item, evidence }
  })
}

// ---------------------------------------------------------------------------
// The status domain and the approval rule (pure)
// ---------------------------------------------------------------------------

const CITATION_STATUSES: readonly CitationStatus[] = ["VERIFIED", "UNVERIFIED", "OVERRULED"]
const TEMPORAL_STATUSES: readonly TemporalStatus[] = ["OK", "TEMPORAL_MISMATCH", "TEMPORAL_UNAVAILABLE"]

const inDomain = <T extends string>(domain: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (domain as readonly string[]).includes(value)

/** An evaluation as it may arrive: a run's, or a stored result's (whose `scope`, if any, is never trusted). */
type EvaluationInput = Omit<GateEvaluation, "scope"> & { scope?: unknown }

/**
 * A gate evaluation held to its domain (see the module comment), with each finding rebuilt from its named fields. The
 * overall status never falls below the runner's own: it is the most severe of that status (UNVERIFIED if outside the
 * domain) and the findings' statuses. The scope is derived from the findings (F06); with no finding at all the status
 * is at least NOT_ASSESSED, so a result stored before F06 (status OK, no findings, no scope) never reads as OK.
 */
export function normaliseEvaluation(e: EvaluationInput): GateEvaluation {
  const citations: CitationFinding[] = e.citations.map((c) => ({
    ref: c.ref,
    judgmentId: c.judgmentId ?? null,
    status: inDomain(CITATION_STATUSES, c.status) ? c.status : "UNVERIFIED",
  }))
  const temporal: TemporalFinding[] = e.temporal.map((t) => ({
    sectionId: t.sectionId,
    asAtDate: t.asAtDate,
    jurisdiction: t.jurisdiction,
    usedText: t.usedText,
    status: inDomain(TEMPORAL_STATUSES, t.status) ? t.status : "TEMPORAL_UNAVAILABLE",
    inForceText: t.inForceText ?? null,
  }))
  const scope = scopeOf(citations, temporal)
  const present = new Set<GateStatus>([inDomain(GATE_SEVERITY, e.status) ? e.status : "UNVERIFIED"])
  for (const c of citations) present.add(c.status === "VERIFIED" ? "OK" : c.status)
  for (const t of temporal) present.add(t.status)
  if (!scope.assessed) present.add("NOT_ASSESSED")
  return { status: GATE_SEVERITY.find((s) => present.has(s)) ?? "UNVERIFIED", citations, temporal, scope }
}

/** The one item an override clears for a NOT_ASSESSED result (F06): the scope nothing assessed. */
export const NOT_ASSESSED_SCOPE_ITEM = Object.freeze({ kind: "scope", status: "NOT_ASSESSED" } as const)

/** One item an override cleared, with the status it had when the partner cleared it (P4-7; the scope item, F06). */
export type ClearedItem =
  | { kind: "citation"; ref: string; status: CitationStatus }
  | { kind: "temporal"; sectionId: string; asAtDate: string; jurisdiction: string; status: TemporalStatus }
  | { kind: "scope"; status: "NOT_ASSESSED" }

/**
 * Every non-OK item of a (normalised) evaluation: each citation that is not VERIFIED and each check that is not OK;
 * for a NOT_ASSESSED evaluation, which has neither, the one scope item (F06). A status that is not OK with nothing to
 * name (an UNVERIFIED with no finding) has no item, so it can never be cleared.
 */
export function clearedItemsOf(e: GateEvaluation): ClearedItem[] {
  const items: ClearedItem[] = []
  for (const c of e.citations) if (c.status !== "VERIFIED") items.push({ kind: "citation", ref: c.ref, status: c.status })
  for (const t of e.temporal) {
    if (t.status !== "OK") items.push({ kind: "temporal", sectionId: t.sectionId, asAtDate: t.asAtDate, jurisdiction: t.jurisdiction, status: t.status })
  }
  if (e.status === "NOT_ASSESSED" && !e.scope.assessed) items.push({ ...NOT_ASSESSED_SCOPE_ITEM })
  return items
}

/**
 * The match key of a non-OK item (P4-8): `citation|<ref>|<status>`, `temporal|<sectionId>|<asAtDate>|<jurisdiction>|<status>`
 * or `scope|NOT_ASSESSED` (F06). The keys cannot collide: each starts with its kind, a status never contains `|`, nor
 * does a section id or a date, so the last segment is the status and the free-text field (the ref, the jurisdiction)
 * is what lies between the fixed ones. An item that is not well formed, or whose kind or status is outside the domain,
 * has no key and so clears nothing (fails closed).
 */
function matchKey(item: unknown): string | null {
  if (item === null || typeof item !== "object") return null
  const i = item as Record<string, unknown>
  if (i.kind === "scope" && i.status === "NOT_ASSESSED") return "scope|NOT_ASSESSED"
  if (i.kind === "citation" && typeof i.ref === "string" && inDomain(CITATION_STATUSES, i.status) && i.status !== "VERIFIED") {
    return `citation|${i.ref}|${i.status}`
  }
  if (
    i.kind === "temporal" &&
    typeof i.sectionId === "string" &&
    typeof i.asAtDate === "string" &&
    typeof i.jurisdiction === "string" &&
    inDomain(TEMPORAL_STATUSES, i.status) &&
    i.status !== "OK"
  ) {
    return `temporal|${i.sectionId}|${i.asAtDate}|${i.jurisdiction}|${i.status}`
  }
  return null
}

/**
 * Whether a version may be approved on a fresh evaluation (P4-8): it passes when the evaluation is OK, or when the
 * override bound to this body hash cleared every non-OK item with the same status (a cleared UNVERIFIED that is now
 * OVERRULED is not cleared). A NOT_ASSESSED evaluation passes only on an override that cleared the not-assessed scope
 * (F06). A non-OK evaluation with no non-OK item to name cannot be cleared. `overrideUsed` is true only when the
 * override was needed and carried the approval.
 */
export function approvalPasses(
  fresh: EvaluationInput,
  override: { bodySha256?: unknown; cleared?: unknown } | null,
  bodySha256: string
): { pass: boolean; overrideUsed: boolean } {
  const e = normaliseEvaluation(fresh)
  if (e.status === "OK") return { pass: true, overrideUsed: false }
  if (!override || override.bodySha256 !== bodySha256 || !Array.isArray(override.cleared)) return { pass: false, overrideUsed: false }
  const cleared = new Set(override.cleared.map(matchKey).filter((k): k is string => k !== null))
  const needed = clearedItemsOf(e).map(matchKey)
  const pass = needed.length > 0 && needed.every((k) => k !== null && cleared.has(k))
  return { pass, overrideUsed: pass }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** A gate run as the routes return it (P4-6 `GateResult`). */
export type GateResultView = {
  draftId: string
  version: number
  bodySha256: string
  status: GateStatus
  citations: CitationFinding[]
  temporal: TemporalFinding[]
  /** What the run assessed (F06), derived from the findings: `assessed: false` is a NOT_ASSESSED result. */
  scope: GateScope
  gatedBy: string
  gatedAt: string | null
  /** This run's id (R6): an override names the result its partner reviewed. */
  resultId: string | null
}

/** A partner override as the routes return it (P4-7), without its firm and matter ids. */
export type OverrideView = {
  draftId: string
  version: number
  bodySha256: string
  resultId: string | null
  by: string
  at: string | null
  reason: string
  cleared: ClearedItem[]
}

const idOf = (value: unknown): string | null => (typeof value === "string" ? value : null)

const storedEvaluation = (d: DocumentData): GateEvaluation =>
  normaliseEvaluation({
    status: d.status,
    citations: Array.isArray(d.citations) ? d.citations : [],
    temporal: Array.isArray(d.temporal) ? d.temporal : [],
  })

function resultView(d: DocumentData): GateResultView {
  const e = storedEvaluation(d)
  return {
    draftId: d.draftId,
    version: d.version,
    bodySha256: d.bodySha256,
    status: e.status,
    citations: e.citations,
    temporal: e.temporal,
    scope: e.scope,
    gatedBy: d.gatedBy,
    gatedAt: iso(d.gatedAt),
    resultId: idOf(d.resultId),
  }
}

/** A stored cleared item by its named fields only. */
function clearedView(item: unknown): ClearedItem[] {
  if (matchKey(item) === null) return []
  const i = item as Record<string, string>
  if (i.kind === "scope") return [{ ...NOT_ASSESSED_SCOPE_ITEM }]
  return i.kind === "citation"
    ? [{ kind: "citation", ref: i.ref, status: i.status as CitationStatus }]
    : [{ kind: "temporal", sectionId: i.sectionId, asAtDate: i.asAtDate, jurisdiction: i.jurisdiction, status: i.status as TemporalStatus }]
}

function overrideView(d: DocumentData): OverrideView {
  const cleared = Array.isArray(d.cleared) ? d.cleared.flatMap(clearedView) : []
  return { draftId: d.draftId, version: d.version, bodySha256: d.bodySha256, resultId: idOf(d.resultId), by: d.by, at: iso(d.at), reason: d.reason, cleared }
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

type DraftRecord = { firmId: string; matterId: string; documentTypeId: string; classification: Classification }

/** Attempts at a gate, override or approval transaction under lock contention, per round. */
const DECISION_TX_ATTEMPTS = 10
/** Rounds of a decision's transaction: a round that gave up under contention is run again, re-reading everything. */
const DECISION_TX_ROUNDS = 3

/**
 * Runs a decision's transaction. A round that gives up under lock contention wrote nothing; the next round re-reads
 * the draft, the result and the override, so a caller who lost a race gets the answer the winner's commit gives
 * (`already_overridden`, `draft_locked`), not a timing artefact. The SDK does not retry every abort itself: the
 * emulator's lock timeout can close the transaction (see isContentionAbort). Once the rounds or the contention
 * deadline run out, the draft is changing under the caller: 409 `draft_changed`.
 */
async function inTransaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
  const pastDeadline = contentionDeadline()
  for (let round = 1; ; round++) {
    try {
      return await adminDb().runTransaction(body, { maxAttempts: DECISION_TX_ATTEMPTS })
    } catch (err) {
      if (!isContentionAbort(err)) throw err
      if (round >= DECISION_TX_ROUNDS || pastDeadline()) throw conflict("draft_changed")
    }
  }
}

/** The findings of a run must fit a stored result (R8): 422 `gate_result_too_large` otherwise, before anything is written. */
function requireStorable(e: GateEvaluation): void {
  if (Buffer.byteLength(JSON.stringify({ citations: e.citations, temporal: e.temporal }), "utf8") > MAX_RESULT_BYTES) {
    throw new HttpError(422, "gate_result_too_large")
  }
}

/** A version that has an override is not re-gated (R5): 409 `already_overridden`. */
function refuseOverridden(exists: boolean): void {
  if (exists) throw conflict("already_overridden")
}

/** The refusals a draft's state gives a decision on `version`, locked first: 409 `draft_locked`, then 409 `draft_changed`. */
function refuseStale(draft: DocumentData, version: number): void {
  if (draft.locked === true) throw conflict("draft_locked")
  if (draft.currentVersion !== version) throw conflict("draft_changed")
}

/**
 * The draft re-read in a transaction: still the caller's firm's (404), the caller still permitted `action` on its matter
 * (requireStillPermitted: the gate ran between the first check and this transaction, PR #25 review), then
 * `refuseStale`, then still the body that was read.
 */
async function rereadDraft(tx: Transaction, ref: DocumentReference, caller: Caller, action: DraftAction, version: number, bodySha256: string): Promise<DocumentData> {
  const draft = (await tx.get(ref)).data()
  if (!draft || draft.firmId !== caller.firmId) throw new HttpError(404, "not_found")
  await requireStillPermitted(tx, caller, action, draft.matterId as string)
  refuseStale(draft, version)
  if (draft.currentBodySha256 !== bodySha256) throw conflict("draft_changed")
  return draft
}

/**
 * The stored title and body of `version` and the hash of that body, which must be the draft's current hash (409
 * `draft_changed` otherwise). A version the draft does not have is 404 `version_not_found`.
 */
async function loadVersionText(caller: Caller, draftId: string, version: number, draft: DocumentData): Promise<{ title: string; body: string; bodySha256: string }> {
  const row = (await versions().doc(versionId(draftId, version)).get()).data()
  if (!row || row.firmId !== caller.firmId || row.draftId !== draftId || typeof row.title !== "string" || typeof row.body !== "string") {
    throw new HttpError(404, "version_not_found")
  }
  const bodySha256 = sha256Hex(row.body)
  if (bodySha256 !== draft.currentBodySha256) throw conflict("draft_changed")
  return { title: row.title, body: row.body, bodySha256 }
}

/** The result document of one gate run (P4-6), with the draft's firm, matter and classification. */
function resultDocument(
  draft: DocumentData,
  draftId: string,
  version: number,
  bodySha256: string,
  e: GateEvaluation,
  gatedBy: string,
  gatedAt: Timestamp,
  gateRuns: number
): DocumentData {
  // Every write of a result is a new run with a new id (R6), whether gateDraft or an approval wrote it.
  return {
    resultId: randomUUID(),
    firmId: draft.firmId,
    matterId: draft.matterId,
    draftId,
    version,
    bodySha256,
    classification: draft.classification,
    status: e.status,
    citations: e.citations,
    temporal: e.temporal,
    // What the run assessed (F06). Recorded for the reader; every read derives it again from the findings.
    scope: e.scope,
    gatedBy,
    gatedAt,
    gateRuns,
  }
}

/** The draft's gate summary (P4-4) for a run, with that run's id (R6). */
const summaryOf = (version: number, bodySha256: string, status: GateStatus, gatedAt: unknown, overridden: boolean, resultId: unknown) => ({
  version,
  bodySha256,
  status,
  gatedAt,
  overridden,
  resultId: idOf(resultId),
})

// ---------------------------------------------------------------------------
// gateDraft
// ---------------------------------------------------------------------------

/** The draft's `lastGatedVersion` (written with every result: a gate run, an approval run), or null when it has none. */
function lastGatedVersionOf(draft: DocumentData): number | null {
  const v: unknown = draft.lastGatedVersion
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : null
}

/** The checks a gate run carries (R10), and which stored result they came from, so the transaction can see it unchanged. */
type Carried = { last: number | null; resultId: string | null; checks: TemporalCheck[] }

/**
 * The temporal checks recorded on the draft's most recent stored gate result, of any version (R10): the result of its
 * `lastGatedVersion`, read without a query. Only a draft with no `lastGatedVersion` field carries none (drafts created
 * before R10 have no results: nothing was deployed). A field that is not a version number, a result that is absent
 * (a retention job or a manual clean-up removed it) or not this draft's, and a result whose record is not well formed
 * (`recordedChecks`) are 409 `not_gated`, so no recorded check is ever dropped silently.
 */
async function carriedChecks(caller: Caller, draftId: string, draft: DocumentData): Promise<Carried> {
  const last = lastGatedVersionOf(draft)
  if (last === null) {
    if (draft.lastGatedVersion !== undefined) throw conflict("not_gated")
    return { last, resultId: null, checks: [] }
  }
  const stored = (await results().doc(versionId(draftId, last)).get()).data()
  if (!stored || stored.firmId !== caller.firmId || stored.draftId !== draftId) throw conflict("not_gated")
  return { last, resultId: idOf(stored.resultId), checks: recordedChecks(stored) }
}

/**
 * The check set of a gate run (R10): the carried checks, in their recorded order, each replaced by the caller's check
 * on the same (sectionId, asAtDate, jurisdiction) (the caller's usedText wins), then the caller's checks on new keys,
 * in the caller's order. A carried check never leaves the set: a partner override clears its status on its version
 * only, and the next version re-checks it. The caps hold for the merged set (at most 20 checks, 200,000 bytes of
 * usedText: 400 `invalid_temporal_checks`).
 */
function mergeChecks(carried: readonly TemporalCheck[], fromCaller: readonly TemporalCheck[]): TemporalCheck[] {
  const callers = new Map(fromCaller.map((c) => [checkKey(c), c]))
  const recorded = new Set(carried.map(checkKey))
  return parseTemporalChecks([...carried.map((c) => callers.get(checkKey(c)) ?? c), ...fromCaller.filter((c) => !recorded.has(checkKey(c)))])
}

/** In the gate's transaction: the draft's latest stored result is still the one the carried checks came from (409 `draft_changed`). */
async function requireCarriedUnchanged(tx: Transaction, draft: DocumentData, draftId: string, carried: Carried): Promise<void> {
  if (lastGatedVersionOf(draft) !== carried.last) throw conflict("draft_changed")
  if (carried.last === null) return
  const now = (await tx.get(results().doc(versionId(draftId, carried.last)))).data()
  if (idOf(now?.resultId) !== carried.resultId) throw conflict("draft_changed")
}

/**
 * gateDraft({ draftId, version, temporalChecks? }) → the GateResult (P4-6). Checks the request (400 `invalid_version`,
 * `invalid_temporal_checks`), then `draft.gate` on the draft's matter; a locked draft is 409 `draft_locked` (an approved
 * draft is not re-gated) and a version that is not the current one 409 `draft_changed`; a version with an override is
 * 409 `already_overridden` (R5: the checks its partner cleared are frozen). Then the charset rule on each check's
 * usedText (422 `unsupported_characters`, R7; a jurisdiction outside R11's pattern was already 400). The run's checks are the caller's merged with those
 * recorded on the draft's most recent stored result (R10, `mergeChecks`: a check, once recorded, is re-checked on every
 * later run and version; a missing or malformed carried result is 409 `not_gated`; the merged caps are 400
 * `invalid_temporal_checks`, the one 400 decided after the permission, because it needs the draft's recorded checks). The gate runs on the stored version's
 * title and body against the active authority store; it reports and never edits the text. Findings over 900,000 bytes
 * are 422 `gate_result_too_large` (R8). One transaction, which checks the lock, the version, the override and the
 * carried result again (409 `draft_changed` if another run replaced it), sets the version's result with a fresh
 * `resultId` (replacing an earlier run of that version), the draft's summary (`overridden: false`) and
 * `lastGatedVersion`, the `draft.gated` event `<draftId>_<version>_gated_<n>` (n = this version's gate run count, from
 * 1) and the audit row.
 */
export const gateDraftOp: FirmOperation<GateResultView> = {
  auth: "firm",
  kind: "general",
  action: "draft.gate",
  target: "drafts",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const draftId = parseDraftId(data.draftId)
    const version = parseVersionNumber(data.version)
    const temporalChecks = parseTemporalChecks(data.temporalChecks)
    audit.target = `drafts/${draftId}`
    const { ref, draft } = await loadDraftForCaller(caller, draftId, "draft.gate")
    refuseStale(draft, version)
    const resultRef = results().doc(versionId(draftId, version))
    const overrideRef = overrides().doc(versionId(draftId, version))
    refuseOverridden((await overrideRef.get()).exists)
    const fromCaller = requireSupportedChecks(temporalChecks)
    const carried = await carriedChecks(caller, draftId, draft)
    const checks = mergeChecks(carried.checks, fromCaller)
    const text = await loadVersionText(caller, draftId, version, draft)
    const evaluation = normaliseEvaluation(await runGate({ title: text.title, body: text.body, temporalChecks: checks }, activeAuthorityStore()))
    requireStorable(evaluation)

    const view = await inTransaction(async (tx) => {
      // The stamp is taken in the attempt that commits.
      const gatedAt = Timestamp.now()
      const current = await rereadDraft(tx, ref, caller, "draft.gate", version, text.bodySha256)
      await requireCarriedUnchanged(tx, current, draftId, carried)
      const prior = (await tx.get(resultRef)).data()
      refuseOverridden((await tx.get(overrideRef)).exists)
      const gateRuns = (typeof prior?.gateRuns === "number" ? prior.gateRuns : 0) + 1
      await audit.stage(tx, "allow", "ok")
      const doc = resultDocument(current, draftId, version, text.bodySha256, evaluation, caller.uid, gatedAt, gateRuns)
      tx.set(resultRef, doc)
      tx.update(ref, { gateResult: summaryOf(version, text.bodySha256, evaluation.status, gatedAt, false, doc.resultId), lastGatedVersion: version, updatedAt: gatedAt })
      stageDraftEvent(tx, "draft.gated", `gated_${gateRuns}`, draftId, version, current as DraftRecord, evaluation.status)
      return resultView(doc)
    })
    audit.committed()
    return view
  },
}

// ---------------------------------------------------------------------------
// getVerificationReport
// ---------------------------------------------------------------------------

export type VerificationReport = { gateResult: GateResultView | null; override: OverrideView | null; current: boolean }

/**
 * getVerificationReport(?draftId=) → `{ gateResult, override, current }` (P4-6, P4-7): the latest gate result of the
 * draft (its last gated version, which after a save is no longer the current one), the override of that version if
 * any, and whether that result is for the draft's current version and body. `draft.read` on the draft's matter.
 */
export const getVerificationReportOp: FirmOperation<VerificationReport> = {
  auth: "firm",
  kind: "general",
  action: "draft.read",
  target: "drafts",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const draftId = parseDraftId(data.draftId)
    audit.target = `drafts/${draftId}`
    const { draft } = await loadDraftForCaller(caller, draftId, "draft.read")
    const last: unknown = draft.lastGatedVersion ?? draft.gateResult?.version
    let gateResult: GateResultView | null = null
    let override: OverrideView | null = null
    if (typeof last === "number" && Number.isSafeInteger(last) && last >= 1) {
      const [r, o] = await adminDb().getAll(results().doc(versionId(draftId, last)), overrides().doc(versionId(draftId, last)))
      const rd = r.data()
      if (rd && rd.firmId === caller.firmId && rd.draftId === draftId) {
        gateResult = resultView(rd)
        const od = o.data()
        if (od && od.firmId === caller.firmId && od.draftId === draftId) override = overrideView(od)
      }
    }
    await audit.allow()
    const current = gateResult !== null && gateResult.version === draft.currentVersion && gateResult.bodySha256 === draft.currentBodySha256
    return { gateResult, override, current }
  },
}

// ---------------------------------------------------------------------------
// overrideGate
// ---------------------------------------------------------------------------

export type OverrideResult = { override: OverrideView; draft: DraftView }

/**
 * overrideGate({ draftId, version, resultId, reason }) → `{ override, draft }` (P4-7). Checks the request (400
 * `invalid_version`; `invalid_reason`: 20 to 2,000 characters once trimmed; `invalid_result_id`: not a string), then
 * `draft.override` on the draft's matter (a partner who is a member: R-2, no role exempt), then the charset rule on
 * the reason (422 `unsupported_characters`, R7). In one transaction: a locked draft is 409 `draft_locked`; a version
 * that is not the current one 409 `draft_changed`; no stored result for it (or one for another body) 409 `not_gated`;
 * a stored result that is not the one the partner reviewed (another `resultId`) 409 `gate_result_changed` (R6); an OK
 * result 409 `nothing_to_override`; an existing override 409 `already_overridden`. Otherwise it creates the immutable
 * override `{ firmId, matterId, draftId, version, bodySha256, resultId, classification, by, at, reason, cleared }`
 * (`classification` is the draft's label; `by` is the authenticated caller, never a body field; `cleared` lists every
 * non-OK item of the reviewed result with its status, and for a NOT_ASSESSED result the one scope item
 * `{ kind: "scope", status: "NOT_ASSESSED" }`: the partner's explicit approval of prose nothing assessed, F06; a stored
 * result with no findings reads as NOT_ASSESSED whatever status it states), sets the summary's `overridden: true` and writes the audit row
 * (`draft.gate_override`, targeting the override document). No event.
 */
export const overrideGateOp: FirmOperation<OverrideResult> = {
  auth: "firm",
  kind: "general",
  action: "draft.gate_override",
  target: "draft_gate_overrides",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const draftId = parseDraftId(data.draftId)
    const version = parseVersionNumber(data.version)
    const parsedReason = parseReason(data.reason)
    const resultId = parseResultId(data.resultId)
    audit.target = `draft_gate_overrides/${versionId(draftId, version)}`
    const { ref, draft } = await loadDraftForCaller(caller, draftId, "draft.override")
    refuseStale(draft, version)
    const reason = supportedReason(parsedReason)

    const resultRef = results().doc(versionId(draftId, version))
    const overrideRef = overrides().doc(versionId(draftId, version))
    const out = await inTransaction(async (tx) => {
      const at = Timestamp.now()
      const current = (await tx.get(ref)).data()
      if (!current || current.firmId !== caller.firmId) throw new HttpError(404, "not_found")
      await requireStillPermitted(tx, caller, "draft.override", current.matterId as string)
      refuseStale(current, version)
      const stored = (await tx.get(resultRef)).data()
      if (!stored || stored.firmId !== caller.firmId || stored.draftId !== draftId || stored.version !== version || stored.bodySha256 !== current.currentBodySha256) {
        throw conflict("not_gated")
      }
      // The partner reviewed one run; a re-gate or an approval run since then may show other statuses (R6).
      if (stored.resultId !== resultId) throw conflict("gate_result_changed")
      const evaluation = storedEvaluation(stored)
      if (evaluation.status === "OK") throw conflict("nothing_to_override")
      if ((await tx.get(overrideRef)).exists) throw conflict("already_overridden")
      await audit.stage(tx, "allow", "ok")
      const doc = {
        firmId: current.firmId,
        matterId: current.matterId,
        draftId,
        version,
        bodySha256: stored.bodySha256,
        resultId,
        // The reason is the partner's free text about the matter: it carries the draft's label, as results and events do.
        classification: current.classification,
        by: caller.uid,
        at,
        reason,
        cleared: clearedItemsOf(evaluation),
      }
      tx.create(overrideRef, doc)
      const summary = summaryOf(version, stored.bodySha256, evaluation.status, stored.gatedAt, approvalPasses(evaluation, doc, stored.bodySha256).overrideUsed, resultId)
      tx.update(ref, { gateResult: summary, lastGatedVersion: version, updatedAt: at })
      return { override: overrideView(doc), draft: draftView(draftId, { ...current, gateResult: summary, lastGatedVersion: version, updatedAt: at }) }
    })
    audit.committed()
    return out
  },
}

// ---------------------------------------------------------------------------
// approveDraft
// ---------------------------------------------------------------------------

/** The approval (P4-8), with the review checklist it stored (F06; null when the type needs none and none was sent). */
export type ApprovalResult = { draft: DraftView; gateResult: GateResultView; reviewChecklist: ReviewChecklistEntry[] | null }

/** The draft's summary must be for `version` and its current body; a null summary or one for another version is 409 `not_gated`. */
function requireGatedSummary(draft: DocumentData, version: number): void {
  const s = draft.gateResult as GateSummary | null | undefined
  if (!s || typeof s !== "object" || s.version !== version || s.bodySha256 !== draft.currentBodySha256) throw conflict("not_gated")
}

/** The temporal checks a stored result recorded (P4-8), revalidated; a result whose record is not well formed was never a valid gate (409 `not_gated`). */
function recordedChecks(stored: DocumentData): TemporalCheck[] {
  if (!Array.isArray(stored.temporal)) throw conflict("not_gated")
  try {
    return parseTemporalChecks(stored.temporal)
  } catch {
    throw conflict("not_gated")
  }
}

/**
 * approveDraft({ draftId, version, resultId, reviewChecklist? }) → `{ draft, gateResult, reviewChecklist }` (P4-8,
 * F06). Checks the request (400 `invalid_version`; `invalid_result_id`: not a string, R9; `invalid_review_checklist`:
 * `parseReviewChecklist`), then `draft.approve` on the draft's matter (a partner who is a member); a locked draft is
 * 409 `draft_locked`, a version that is not the current one 409 `draft_changed`, and a version with no stored result
 * (or a summary that is null or for another version) 409 `not_gated`. Then the review checklist (F06,
 * `requireReviewChecklist`): a law-dependent type needs every item of its checklist with evidence (422
 * `review_checklist_incomplete`), whatever the gate says. It re-runs the gate on that version with the temporal checks
 * recorded in its result, against the authority store as it is now, and passes when the fresh result is OK or the
 * override bound to this version and hash cleared every non-OK item with the same status (`approvalPasses`; a
 * NOT_ASSESSED result needs the override's not-assessed scope item, F06). The fresh run decides, never a stored status:
 * a stored OK with no findings is NOT_ASSESSED again here. Findings over 900,000 bytes are 422
 * `gate_result_too_large` (R8), with nothing stored. One transaction, which re-reads the draft (lock, version,
 * summary), refuses with 409 `draft_changed` if the stored result changed since it was read and with 409
 * `gate_result_changed` if the stored result is not the one the partner reviewed (R9: another `resultId`, so a re-gate
 * without a check cannot drop a block the partner was shown), stores the fresh result (with a fresh `resultId`) and
 * summary, then:
 * - on a pass, sets `status: "approved"`, `locked: true`, `approvedBy` (the caller), `approvedAt`, `approvedVersion`
 *   and, when there is one, `reviewChecklist` (the entries in the type's order, with their evidence), writes the
 *   `draft.approved` event `<draftId>_<version>_approved` and the allow row;
 * - otherwise writes the deny row (`gate_blocked`), and the call answers 409 `gate_blocked` once that has committed, so
 *   getVerificationReport shows the fresh findings (ruling R1: the router carries no error details).
 * The approval's run is not a gateDraft run: it keeps the version's run count and writes no `draft.gated` event.
 */
export const approveDraftOp: FirmOperation<ApprovalResult> = {
  auth: "firm",
  kind: "general",
  action: "draft.approve",
  target: "drafts",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const draftId = parseDraftId(data.draftId)
    const version = parseVersionNumber(data.version)
    const resultId = parseResultId(data.resultId)
    const sentChecklist = parseReviewChecklist(data.reviewChecklist)
    audit.target = `drafts/${draftId}`
    const { ref, draft } = await loadDraftForCaller(caller, draftId, "draft.approve")
    refuseStale(draft, version)
    requireGatedSummary(draft, version)
    const reviewChecklist = requireReviewChecklist(draft.documentTypeId, sentChecklist)

    const resultRef = results().doc(versionId(draftId, version))
    const overrideRef = overrides().doc(versionId(draftId, version))
    const read = await resultRef.get()
    const stored = read.data()
    if (!stored || stored.firmId !== caller.firmId || stored.draftId !== draftId || stored.version !== version || stored.bodySha256 !== draft.currentBodySha256) {
      throw conflict("not_gated")
    }
    const temporalChecks = recordedChecks(stored)
    const text = await loadVersionText(caller, draftId, version, draft)
    const fresh = normaliseEvaluation(await runGate({ title: text.title, body: text.body, temporalChecks }, activeAuthorityStore()))
    requireStorable(fresh)

    const outcome = await inTransaction(async (tx) => {
      const at = Timestamp.now()
      const current = await rereadDraft(tx, ref, caller, "draft.approve", version, text.bodySha256)
      requireGatedSummary(current, version)
      // A re-gate (other checks) or another approval's run landed since the result was read: decide again on the new one.
      const now = await tx.get(resultRef)
      if (!now.exists || !now.updateTime || !read.updateTime || !now.updateTime.isEqual(read.updateTime)) throw conflict("draft_changed")
      const prior = now.data() as DocumentData
      // The partner approves the run they reviewed (R9, as R6): a re-gate since then may have dropped what was shown.
      if (prior.resultId !== resultId) throw conflict("gate_result_changed")
      const override = (await tx.get(overrideRef)).data() ?? null
      const decision = approvalPasses(fresh, override, text.bodySha256)
      const doc = resultDocument(current, draftId, version, text.bodySha256, fresh, caller.uid, at, typeof prior.gateRuns === "number" ? prior.gateRuns : 1)
      const summary = summaryOf(version, text.bodySha256, fresh.status, at, decision.overrideUsed, doc.resultId)
      tx.set(resultRef, doc)
      if (!decision.pass) {
        await audit.stage(tx, "deny", "gate_blocked")
        tx.update(ref, { gateResult: summary, lastGatedVersion: version, updatedAt: at })
        return { pass: false as const }
      }
      await audit.stage(tx, "allow", "ok")
      const update = {
        status: "approved" as const,
        locked: true,
        approvedBy: caller.uid,
        approvedAt: at,
        approvedVersion: version,
        // The partner's review of a law-dependent document (F06), with the evidence for each item of its type's checklist.
        ...(reviewChecklist ? { reviewChecklist } : {}),
        gateResult: summary,
        lastGatedVersion: version,
        updatedAt: at,
      }
      tx.update(ref, update)
      stageDraftEvent(tx, "draft.approved", "approved", draftId, version, current as DraftRecord, fresh.status)
      return { pass: true as const, view: { draft: draftView(draftId, { ...current, ...update }), gateResult: resultView(doc), reviewChecklist } }
    })
    audit.committed()
    if (!outcome.pass) throw conflict("gate_blocked")
    return outcome.view
  },
}
