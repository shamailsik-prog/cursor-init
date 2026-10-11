import { Timestamp, type DocumentData, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { isContentionAbort } from "../d1/contention"
import { HttpError } from "../http/errors"
import type { Caller } from "../p5/auth"
import type { FirmOperation } from "../p5/common"
import { activeAuthorityStore } from "./authority"
import {
  draftView,
  loadDraftForCaller,
  parseDraftId,
  parseVersionNumber,
  sha256Hex,
  stageDraftEvent,
  versionId,
  type DraftView,
  type GateSummary,
} from "./drafts"
import { runGate } from "./gate"
import {
  GATE_SEVERITY,
  type CitationFinding,
  type CitationStatus,
  type GateEvaluation,
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
 *   approval makes), with `gateRuns`, the count of gateDraft runs of n (the `draft.gated` event ids).
 * - `draft_gate_overrides/{draftId}_{n}`: the one immutable partner override of version n, bound to its body hash.
 * The draft holds the summary of its current version's latest run (`gateResult`, P4-4) and `lastGatedVersion`, the
 * version whose result the verification report shows.
 *
 * Every status is held to its domain before it is stored or compared: a citation status outside VERIFIED, UNVERIFIED
 * and OVERRULED is UNVERIFIED, a temporal status outside OK, TEMPORAL_MISMATCH and TEMPORAL_UNAVAILABLE is
 * TEMPORAL_UNAVAILABLE ("verify manually"), and the overall status is the most severe of the runner's own and the
 * findings', so nothing outside the domain can pass as OK.
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
const MAX_JURISDICTION = 50
const MAX_USED_TEXT = 10_000
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

/**
 * The caller's temporal checks (P4-6): absent is none; otherwise an array of at most 20 objects, each with a `sectionId`
 * matching /^[A-Za-z0-9_.:-]{1,200}$/, an `asAtDate` that is a real YYYY-MM-DD date, a `jurisdiction` of 1 to 50
 * characters and a `usedText` of 1 to 10,000 characters. Anything else is 400 `invalid_temporal_checks`. Only the four
 * fields are kept: nothing else a caller sent (a status, an in-force text) reaches the gate.
 */
export function parseTemporalChecks(value: unknown): TemporalCheck[] {
  if (value === undefined) return []
  const invalid = () => new HttpError(400, "invalid_temporal_checks")
  if (!Array.isArray(value) || value.length > MAX_TEMPORAL_CHECKS) throw invalid()
  return value.map((entry: unknown): TemporalCheck => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw invalid()
    const { sectionId, asAtDate, jurisdiction, usedText } = entry as Record<string, unknown>
    if (typeof sectionId !== "string" || !SECTION_ID.test(sectionId)) throw invalid()
    if (typeof asAtDate !== "string" || !isCalendarDate(asAtDate)) throw invalid()
    if (typeof jurisdiction !== "string" || chars(jurisdiction) < 1 || chars(jurisdiction) > MAX_JURISDICTION) throw invalid()
    if (typeof usedText !== "string" || chars(usedText) < 1 || chars(usedText) > MAX_USED_TEXT) throw invalid()
    return { sectionId, asAtDate, jurisdiction, usedText }
  })
}

/** An override's reason: a string of 20 to 2,000 characters once trimmed (400 `invalid_reason`); the trimmed text is kept. */
function parseReason(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_reason")
  const reason = value.trim()
  if (chars(reason) < MIN_REASON || chars(reason) > MAX_REASON) throw new HttpError(400, "invalid_reason")
  return reason
}

// ---------------------------------------------------------------------------
// The status domain and the approval rule (pure)
// ---------------------------------------------------------------------------

const CITATION_STATUSES: readonly CitationStatus[] = ["VERIFIED", "UNVERIFIED", "OVERRULED"]
const TEMPORAL_STATUSES: readonly TemporalStatus[] = ["OK", "TEMPORAL_MISMATCH", "TEMPORAL_UNAVAILABLE"]

const inDomain = <T extends string>(domain: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (domain as readonly string[]).includes(value)

/**
 * A gate evaluation held to its domain (see the module comment), with each finding rebuilt from its named fields. The
 * overall status never falls below the runner's own: it is the most severe of that status (UNVERIFIED if outside the
 * domain) and the findings' statuses.
 */
export function normaliseEvaluation(e: GateEvaluation): GateEvaluation {
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
  const present = new Set<GateStatus>([inDomain(GATE_SEVERITY, e.status) ? e.status : "UNVERIFIED"])
  for (const c of citations) present.add(c.status === "VERIFIED" ? "OK" : c.status)
  for (const t of temporal) present.add(t.status)
  return { status: GATE_SEVERITY.find((s) => present.has(s)) ?? "UNVERIFIED", citations, temporal }
}

/** One item an override cleared, with the status it had when the partner cleared it (P4-7). */
export type ClearedItem =
  | { kind: "citation"; ref: string; status: CitationStatus }
  | { kind: "temporal"; sectionId: string; asAtDate: string; jurisdiction: string; status: TemporalStatus }

/** Every non-OK item of a (normalised) evaluation: each citation that is not VERIFIED and each check that is not OK. */
export function clearedItemsOf(e: GateEvaluation): ClearedItem[] {
  const items: ClearedItem[] = []
  for (const c of e.citations) if (c.status !== "VERIFIED") items.push({ kind: "citation", ref: c.ref, status: c.status })
  for (const t of e.temporal) {
    if (t.status !== "OK") items.push({ kind: "temporal", sectionId: t.sectionId, asAtDate: t.asAtDate, jurisdiction: t.jurisdiction, status: t.status })
  }
  return items
}

/**
 * The match key of a non-OK item (P4-8): `citation|<ref>|<status>` or `temporal|<sectionId>|<asAtDate>|<jurisdiction>|<status>`.
 * The keys cannot collide: a status never contains `|`, nor does a section id or a date, so the last segment is the
 * status and the free-text field (the ref, the jurisdiction) is what lies between the fixed ones. An item that is not
 * well formed, or whose kind or status is outside the domain, has no key and so clears nothing (fails closed).
 */
function matchKey(item: unknown): string | null {
  if (item === null || typeof item !== "object") return null
  const i = item as Record<string, unknown>
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
 * OVERRULED is not cleared). A non-OK evaluation with no non-OK item to name cannot be cleared. `overrideUsed` is true
 * only when the override was needed and carried the approval.
 */
export function approvalPasses(
  fresh: GateEvaluation,
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
  gatedBy: string
  gatedAt: string | null
}

/** A partner override as the routes return it (P4-7), without its firm and matter ids. */
export type OverrideView = { draftId: string; version: number; bodySha256: string; by: string; at: string | null; reason: string; cleared: ClearedItem[] }

const storedEvaluation = (d: DocumentData): GateEvaluation =>
  normaliseEvaluation({
    status: d.status,
    citations: Array.isArray(d.citations) ? d.citations : [],
    temporal: Array.isArray(d.temporal) ? d.temporal : [],
  })

function resultView(d: DocumentData): GateResultView {
  const e = storedEvaluation(d)
  return { draftId: d.draftId, version: d.version, bodySha256: d.bodySha256, status: e.status, citations: e.citations, temporal: e.temporal, gatedBy: d.gatedBy, gatedAt: iso(d.gatedAt) }
}

/** A stored cleared item by its named fields only. */
function clearedView(item: unknown): ClearedItem[] {
  if (matchKey(item) === null) return []
  const i = item as Record<string, string>
  return i.kind === "citation"
    ? [{ kind: "citation", ref: i.ref, status: i.status as CitationStatus }]
    : [{ kind: "temporal", sectionId: i.sectionId, asAtDate: i.asAtDate, jurisdiction: i.jurisdiction, status: i.status as TemporalStatus }]
}

function overrideView(d: DocumentData): OverrideView {
  const cleared = Array.isArray(d.cleared) ? d.cleared.flatMap(clearedView) : []
  return { draftId: d.draftId, version: d.version, bodySha256: d.bodySha256, by: d.by, at: iso(d.at), reason: d.reason, cleared }
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

type DraftRecord = { firmId: string; matterId: string; documentTypeId: string; classification: Classification }

/** Attempts at a gate, override or approval transaction under lock contention. */
const DECISION_TX_ATTEMPTS = 10

/** Runs a decision's transaction; one that gives up under contention wrote nothing and the draft is changing: 409 `draft_changed`. */
async function inTransaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
  try {
    return await adminDb().runTransaction(body, { maxAttempts: DECISION_TX_ATTEMPTS })
  } catch (err) {
    if (isContentionAbort(err)) throw conflict("draft_changed")
    throw err
  }
}

/** The refusals a draft's state gives a decision on `version`, locked first: 409 `draft_locked`, then 409 `draft_changed`. */
function refuseStale(draft: DocumentData, version: number): void {
  if (draft.locked === true) throw conflict("draft_locked")
  if (draft.currentVersion !== version) throw conflict("draft_changed")
}

/** The draft re-read in a transaction: still the caller's firm's (404), then `refuseStale`, then still the body that was read. */
async function rereadDraft(tx: Transaction, ref: DocumentReference, caller: Caller, version: number, bodySha256: string): Promise<DocumentData> {
  const draft = (await tx.get(ref)).data()
  if (!draft || draft.firmId !== caller.firmId) throw new HttpError(404, "not_found")
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
  return {
    firmId: draft.firmId,
    matterId: draft.matterId,
    draftId,
    version,
    bodySha256,
    classification: draft.classification,
    status: e.status,
    citations: e.citations,
    temporal: e.temporal,
    gatedBy,
    gatedAt,
    gateRuns,
  }
}

/** The draft's gate summary (P4-4) for a run. */
const summaryOf = (version: number, bodySha256: string, status: GateStatus, gatedAt: unknown, overridden: boolean) => ({ version, bodySha256, status, gatedAt, overridden })

// ---------------------------------------------------------------------------
// gateDraft
// ---------------------------------------------------------------------------

/**
 * gateDraft({ draftId, version, temporalChecks? }) → the GateResult (P4-6). Checks the request (400 `invalid_version`,
 * `invalid_temporal_checks`), then `draft.gate` on the draft's matter; a locked draft is 409 `draft_locked` (an approved
 * draft is not re-gated) and a version that is not the current one 409 `draft_changed`. The gate runs on the stored
 * version's title and body against the active authority store; it reports and never edits the text. One transaction,
 * which checks the lock and the version again, sets the version's result (replacing an earlier run of that version),
 * the draft's summary (`overridden` only while the override on file for this version and hash clears this result), the
 * `draft.gated` event `<draftId>_<version>_gated_<n>` (n = this version's gate run count) and the audit row.
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
    const text = await loadVersionText(caller, draftId, version, draft)
    const evaluation = normaliseEvaluation(await runGate({ title: text.title, body: text.body, temporalChecks }, activeAuthorityStore()))

    const resultRef = results().doc(versionId(draftId, version))
    const overrideRef = overrides().doc(versionId(draftId, version))
    const view = await inTransaction(async (tx) => {
      // The stamp is taken in the attempt that commits.
      const gatedAt = Timestamp.now()
      const current = await rereadDraft(tx, ref, caller, version, text.bodySha256)
      const prior = (await tx.get(resultRef)).data()
      const override = (await tx.get(overrideRef)).data() ?? null
      const gateRuns = (typeof prior?.gateRuns === "number" ? prior.gateRuns : 0) + 1
      const overridden = approvalPasses(evaluation, override, text.bodySha256).overrideUsed
      await audit.stage(tx, "allow", "ok")
      const doc = resultDocument(current, draftId, version, text.bodySha256, evaluation, caller.uid, gatedAt, gateRuns)
      tx.set(resultRef, doc)
      tx.update(ref, { gateResult: summaryOf(version, text.bodySha256, evaluation.status, gatedAt, overridden), lastGatedVersion: version, updatedAt: gatedAt })
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
 * overrideGate({ draftId, version, reason }) → `{ override, draft }` (P4-7). Checks the request (400 `invalid_version`,
 * `invalid_reason`: 20 to 2,000 characters once trimmed), then `draft.override` on the draft's matter (a partner who is
 * a member: R-2, no role exempt). In one transaction: a locked draft is 409 `draft_locked`; a version that is not the
 * current one 409 `draft_changed`; no stored result for it (or one for another body) 409 `not_gated`; an OK result 409
 * `nothing_to_override`; an existing override 409 `already_overridden`. Otherwise it creates the immutable override
 * `{ firmId, matterId, draftId, version, bodySha256, by, at, reason, cleared }` (`by` is the authenticated caller, never
 * a body field; `cleared` lists every non-OK item of the stored result with its status), sets the summary's
 * `overridden: true` and writes the audit row (`draft.gate_override`, targeting the override document). No event.
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
    const reason = parseReason(data.reason)
    audit.target = `draft_gate_overrides/${versionId(draftId, version)}`
    const { ref, draft } = await loadDraftForCaller(caller, draftId, "draft.override")
    refuseStale(draft, version)

    const resultRef = results().doc(versionId(draftId, version))
    const overrideRef = overrides().doc(versionId(draftId, version))
    const out = await inTransaction(async (tx) => {
      const at = Timestamp.now()
      const current = (await tx.get(ref)).data()
      if (!current || current.firmId !== caller.firmId) throw new HttpError(404, "not_found")
      refuseStale(current, version)
      const stored = (await tx.get(resultRef)).data()
      if (!stored || stored.firmId !== caller.firmId || stored.draftId !== draftId || stored.version !== version || stored.bodySha256 !== current.currentBodySha256) {
        throw conflict("not_gated")
      }
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
        by: caller.uid,
        at,
        reason,
        cleared: clearedItemsOf(evaluation),
      }
      tx.create(overrideRef, doc)
      const summary = summaryOf(version, stored.bodySha256, evaluation.status, stored.gatedAt, approvalPasses(evaluation, doc, stored.bodySha256).overrideUsed)
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

export type ApprovalResult = { draft: DraftView; gateResult: GateResultView }

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
 * approveDraft({ draftId, version }) → `{ draft, gateResult }` (P4-8). `draft.approve` on the draft's matter (a partner
 * who is a member); a locked draft is 409 `draft_locked`, a version that is not the current one 409 `draft_changed`, and
 * a version with no stored result (or a summary that is null or for another version) 409 `not_gated`. It re-runs the
 * gate on that version with the temporal checks recorded in its result, against the authority store as it is now, and
 * passes when the fresh result is OK or the override bound to this version and hash cleared every non-OK item with the
 * same status (`approvalPasses`). One transaction, which re-reads the draft (lock, version, summary) and refuses with
 * 409 `draft_changed` if the stored result changed since it was read, stores the fresh result and summary, then:
 * - on a pass, sets `status: "approved"`, `locked: true`, `approvedBy` (the caller), `approvedAt`, `approvedVersion`,
 *   writes the `draft.approved` event `<draftId>_<version>_approved` and the allow row;
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
    audit.target = `drafts/${draftId}`
    const { ref, draft } = await loadDraftForCaller(caller, draftId, "draft.approve")
    refuseStale(draft, version)
    requireGatedSummary(draft, version)

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

    const outcome = await inTransaction(async (tx) => {
      const at = Timestamp.now()
      const current = await rereadDraft(tx, ref, caller, version, text.bodySha256)
      requireGatedSummary(current, version)
      // A re-gate (other checks) or another approval's run landed since the result was read: decide again on the new one.
      const now = await tx.get(resultRef)
      if (!now.exists || !now.updateTime || !read.updateTime || !now.updateTime.isEqual(read.updateTime)) throw conflict("draft_changed")
      const override = (await tx.get(overrideRef)).data() ?? null
      const decision = approvalPasses(fresh, override, text.bodySha256)
      const prior = now.data() as DocumentData
      const doc = resultDocument(current, draftId, version, text.bodySha256, fresh, caller.uid, at, typeof prior.gateRuns === "number" ? prior.gateRuns : 1)
      const summary = summaryOf(version, text.bodySha256, fresh.status, at, decision.overrideUsed)
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
        gateResult: summary,
        lastGatedVersion: version,
        updatedAt: at,
      }
      tx.update(ref, update)
      stageDraftEvent(tx, "draft.approved", "approved", draftId, version, current as DraftRecord, fresh.status)
      return { pass: true as const, view: { draft: draftView(draftId, { ...current, ...update }), gateResult: resultView(doc) } }
    })
    audit.committed()
    if (!outcome.pass) throw conflict("gate_blocked")
    return outcome.view
  },
}
