import { Timestamp, type DocumentData, type DocumentReference } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import type { DraftAction } from "@/platform/p5/permissionDecision"
import { DraftCharsetError, requireSupportedDraftBody } from "@/services/d4-2/draftCharset"
import { adminDb } from "../admin"
import type { Page } from "../d1/pagination"
import { HttpError } from "../http/errors"
import type { Caller } from "../p5/auth"
import { isKnownClassification, rankOf } from "../p5/classification"
import type { Data, FirmOperation } from "../p5/common"
import { getDocumentType } from "./doctypes"
import {
  CONTROL_CHARACTER,
  checkedText,
  classifyForMatter,
  iso,
  listClearedByUpdatedAt,
  loadForCaller,
  parseTimePage,
  parseTitle,
  requireMatterAction,
  requireStillPermitted,
  strictest,
} from "./drafts"

/**
 * The D4 generation store (spec P4B-1, P4B-8, P4B-13): `startDraft`, `getGeneration` and `listGenerations` behind
 * `/api/d4/drafting/`, and what the steps built on them share (the ids, the label, the lease test, the view).
 *
 * Collections (top-level, `firmId` on every row, written by Cloud Functions in transactions, firestore.rules P4B-18):
 * - `draft_generations/{auto id}`: the brief (the advocate's facts and the generation's state), never an outline or a
 *   section. Stage `facts` at `startDraft`.
 * - `draft_outlines/{generationId}_{n}`: one immutable row per outline version, n dense from 1.
 * - `draft_sections/{generationId}_{v}_{i}`: one immutable row per stored section i of outline version v. No client
 *   reads it: the sections reach the advocate in the assembled draft, which is gated.
 *
 * What a caller sees: the permission is decided on the brief's own matter (`loadGenerationForCaller`); a brief that is
 * absent, in another firm, or above the caller's clearance is 404 `not_found`, so its existence never leaks. A POST
 * answers ids and labels, never the advocate's text (P4B-14).
 */

export const generations = () => adminDb().collection("draft_generations")
export const outlines = () => adminDb().collection("draft_outlines")
export const sectionDocs = () => adminDb().collection("draft_sections")

/** The stages of a generation (P4B-1): `startDraft` makes `facts`, assembly makes `assembled`. */
export type Stage = "facts" | "outlined" | "approved" | "drafting" | "assembled"

/** What one P1 step came to: `stored` the outline or section, `blocked` before the model, `failed` in transport, `refused` by a guardrail. */
export type StepOutcome = "stored" | "blocked" | "failed" | "refused"

/** A value the advocate fixed word for word, for one of the document type's required fields. */
export type VerbatimField = { field: string; text: string }

/** The document id of an outline version. */
export const outlineId = (generationId: string, version: number): string => `${generationId}_${version}`

/** The document id of section `section` of outline version `outlineVersion`. */
export const sectionId = (generationId: string, outlineVersion: number, section: number): string => `${generationId}_${outlineVersion}_${section}`

const badRequest = (code: string) => new HttpError(400, code)
const notFound = () => new HttpError(404, "not_found")

/** A generation id in a request: a non-empty string (anything else is a malformed request; an id that cannot exist is 404 later). */
export function parseGenerationId(value: unknown): string {
  if (typeof value !== "string" || value === "") throw badRequest("invalid_generation_id")
  return value
}

/**
 * The brief `generationId` for a caller who may take `action` on its matter: `loadDraftForCaller`'s rule, which is
 * `loadForCaller` over `draft_generations`. 404 `not_found` for an id that cannot name a brief, a brief that is absent or
 * in another firm's, and one above the caller's clearance (no existence oracle); the permission is checked on the
 * brief's matter, so a same-firm caller who is not a cleared member of that matter is refused 403 (not_member,
 * clearance, role), and a client, intern or accounts user is refused by role.
 */
export async function loadGenerationForCaller(
  caller: Caller,
  generationId: string,
  action: DraftAction
): Promise<{ ref: DocumentReference; brief: DocumentData }> {
  const { ref, data } = await loadForCaller(generations(), caller, generationId, action)
  return { ref, brief: data }
}

/**
 * The label every step after `startDraft` takes (P4B-13): the strictest of the brief's own label and its matter's
 * current one (`matter` as read in the step's transaction by requireStillPermitted), so a matter label raised after the
 * brief was written binds every later step and never falls. The step writes it back to the brief. An unreadable label
 * fails closed (403 `clearance`), and so does a result above the caller's clearance (a backstop: requireStillPermitted
 * has refused a caller not cleared for the matter's label already).
 */
export function generationLabel(caller: Caller, brief: DocumentData, matter: DocumentData): Classification {
  if (!isKnownClassification(brief.classification) || !isKnownClassification(matter.classification)) throw new HttpError(403, "clearance")
  const result = strictest([brief.classification, matter.classification])
  if (rankOf(caller.clearanceLevel) < rankOf(result)) throw new HttpError(403, "clearance")
  return result
}

// ---------------------------------------------------------------------------
// Reserved tokens (D26)
// ---------------------------------------------------------------------------

/**
 * Text the pseudonymiser and the mask use for what they take out: the indexed brackets `⟦` and `⟧`, the seven lossy
 * tokens (`[PARTY]`, `[CNIC]`, ...), and a bare token (`PARTY_1`). Caller text holding any of them would collide with a
 * token P1 places, or make every answer that echoes it a billed `rehydration_failed` (D26). It is not global, so `test`
 * carries no `lastIndex` from one text to the next.
 */
export const RESERVED_TOKEN = /[⟦⟧]|\[(?:PARTY|CNIC|PHONE|EMAIL|IBAN|NTN|PASSPORT)\]|\b(?:PARTY|CNIC|PHONE|EMAIL|IBAN|NTN|PASSPORT|VERBATIM)_\d+\b/

/** 422 `reserved_tokens` when any of the texts holds a reserved token. Judged on the stored (normalised) form of each text. */
export function refuseReservedTokens(texts: readonly string[]): void {
  if (texts.some((text) => RESERVED_TOKEN.test(text))) throw new HttpError(422, "reserved_tokens")
}

// ---------------------------------------------------------------------------
// The generation clock and its test seam (D19, D23)
// ---------------------------------------------------------------------------

/**
 * Test seam only; production code never sets it, and it is inert when `NODE_ENV` is "production". It lives here, beside
 * the lease test and the view that read its clock, and `generationRun.ts` re-exports it with `d4Now`, so the step
 * modules and this one share it with no import cycle.
 * - `wallClock` replaces `Date.now` as the clock of the lease, the pre-call budget, the write deadline and `inProgress`.
 * - `beforeCall` runs just before `callP1`; a throw from it stands in for `callP1` throwing (D27).
 * - `beforeOutcomeWrite` runs once before the outcome write's first attempt.
 * - `outcomeWriteFailures` is a queue: each outcome-write attempt takes the next error from it and throws it instead
 *   of writing. `lostCommitAnswers` is a queue too: each attempt whose transaction committed takes the next error from
 *   it and throws it, as if the commit had landed and its answer been lost.
 * - `failAssembly` makes the assembly transaction fail (Task 4).
 */
export const d4GenerationTestSeam: {
  failAssembly?: boolean
  outcomeWriteFailures?: Error[]
  lostCommitAnswers?: Error[]
  wallClock?: () => number
  beforeCall?: () => Promise<void>
  beforeOutcomeWrite?: () => Promise<void>
} = {}

/** The seam as production sees it: empty. */
export function generationSeam(): typeof d4GenerationTestSeam {
  return process.env.NODE_ENV === "production" ? {} : d4GenerationTestSeam
}

/**
 * The generation steps' clock, epoch ms: `Date.now()` unless a test sets `wallClock` (D19). Never the router's
 * `session.now`, which the emulator suites fix to a constant (D23).
 */
export function d4Now(): number {
  return (generationSeam().wallClock ?? Date.now)()
}

// ---------------------------------------------------------------------------
// The lease and the view
// ---------------------------------------------------------------------------

/**
 * Whether a step holds the brief: `inFlight` exists and its `leaseUntil` is after `nowMs`. A lease whose time cannot be
 * read counts as run out, so a damaged one never holds a generation for ever.
 */
export function liveLease(brief: DocumentData, nowMs: number): boolean {
  const lease: unknown = brief.inFlight
  if (lease === null || typeof lease !== "object") return false
  const until = (lease as { leaseUntil?: unknown }).leaseUntil
  return until instanceof Timestamp && until.toMillis() > nowMs
}

/** The last P1 step of a generation, as the routes return it. */
export type LastAttemptView = {
  step: "outline" | "section"
  outlineVersion: number
  section: number | null
  outcome: StepOutcome
  reason: string | null
  unsupportedRefs: string[]
  usageLogId: string | null
  traceId: string | null
  costMicroUsd: number
  at: string | null
  by: string
}

export type ApprovedOutlineView = { version: number; sha256: string; by: string; at: string | null; acknowledgedMissingFacts: number[] }

/** A brief as `getGeneration` returns it: every field, `generationId` added, times as ISO strings, `inProgress` for `inFlight`. */
export type GenerationView = {
  generationId: string
  firmId: string
  matterId: string
  documentTypeId: string
  title: string
  facts: string
  verbatim: VerbatimField[]
  partyNames: string[]
  classification: Classification
  stage: Stage
  outlineVersion: number
  approvedOutline: ApprovedOutlineView | null
  sectionCount: number | null
  sectionsStored: number
  templateId: string
  path: string | null
  model: string | null
  promptVersion: string | null
  calls: number
  costMicroUsd: number
  lastAttempt: LastAttemptView | null
  inProgress: boolean
  draftId: string | null
  createdBy: string
  createdAt: string | null
  updatedAt: string | null
}

/** A brief as `listGenerations` returns it: the view without the facts, the verbatim values, the party names and the refused references. */
export type GenerationSummary = Omit<GenerationView, "facts" | "verbatim" | "partyNames" | "lastAttempt"> & {
  lastAttempt: Omit<LastAttemptView, "unsupportedRefs"> | null
}

function lastAttemptView(raw: unknown): LastAttemptView | null {
  if (raw === null || typeof raw !== "object") return null
  const a = raw as Record<string, unknown>
  // Named fields only, so nothing else stored in the attempt can reach a response.
  return {
    step: a.step as LastAttemptView["step"],
    outlineVersion: a.outlineVersion as number,
    section: (a.section as number | null | undefined) ?? null,
    outcome: a.outcome as StepOutcome,
    reason: (a.reason as string | null | undefined) ?? null,
    unsupportedRefs: Array.isArray(a.unsupportedRefs) ? a.unsupportedRefs.filter((r): r is string => typeof r === "string") : [],
    usageLogId: (a.usageLogId as string | null | undefined) ?? null,
    traceId: (a.traceId as string | null | undefined) ?? null,
    costMicroUsd: a.costMicroUsd as number,
    at: iso(a.at),
    by: a.by as string,
  }
}

function approvedOutlineView(raw: unknown): ApprovedOutlineView | null {
  if (raw === null || typeof raw !== "object") return null
  const a = raw as Record<string, unknown>
  return {
    version: a.version as number,
    sha256: a.sha256 as string,
    by: a.by as string,
    at: iso(a.at),
    acknowledgedMissingFacts: Array.isArray(a.acknowledgedMissingFacts) ? a.acknowledgedMissingFacts.filter((n): n is number => typeof n === "number") : [],
  }
}

/**
 * The brief document as `getGeneration` returns it (P4B-8). Named fields only. The lease is never shown: `inProgress`
 * says whether a step holds the brief at `nowMs`. The refused references are shown here (D2: the brief is readable by
 * the same cleared members anyway), and only here.
 */
export function generationView(id: string, d: DocumentData, nowMs: number): GenerationView {
  return {
    generationId: id,
    firmId: d.firmId,
    matterId: d.matterId,
    documentTypeId: d.documentTypeId,
    title: d.title,
    facts: d.facts,
    verbatim: Array.isArray(d.verbatim) ? d.verbatim.map((v: VerbatimField) => ({ field: v.field, text: v.text })) : [],
    partyNames: Array.isArray(d.partyNames) ? [...(d.partyNames as string[])] : [],
    classification: d.classification,
    stage: d.stage,
    outlineVersion: d.outlineVersion,
    approvedOutline: approvedOutlineView(d.approvedOutline),
    sectionCount: d.sectionCount ?? null,
    sectionsStored: d.sectionsStored,
    templateId: d.templateId,
    path: d.path ?? null,
    model: d.model ?? null,
    promptVersion: d.promptVersion ?? null,
    calls: d.calls,
    costMicroUsd: d.costMicroUsd,
    lastAttempt: lastAttemptView(d.lastAttempt),
    inProgress: liveLease(d, nowMs),
    draftId: d.draftId ?? null,
    createdBy: d.createdBy,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  }
}

/** The brief as a list row: the view without `facts`, `verbatim`, `partyNames` and `lastAttempt.unsupportedRefs` (P4B-8). */
export function generationSummary(id: string, d: DocumentData, nowMs: number): GenerationSummary {
  const { facts: _facts, verbatim: _verbatim, partyNames: _partyNames, lastAttempt, ...rest } = generationView(id, d, nowMs)
  if (lastAttempt === null) return { ...rest, lastAttempt: null }
  const { unsupportedRefs: _unsupportedRefs, ...attempt } = lastAttempt
  return { ...rest, lastAttempt: attempt }
}

// ---------------------------------------------------------------------------
// startDraft
// ---------------------------------------------------------------------------

const MAX_FACTS = 100_000
const MAX_VERBATIM = 20
const MAX_VERBATIM_TEXT = 10_000
const MAX_VERBATIM_TOTAL = 50_000
const MAX_PARTY_NAMES = 50
const MAX_PARTY_NAME = 200

type StartInput = {
  matterId: string
  documentTypeId: string
  templateId: string
  title: string
  facts: string
  verbatim: VerbatimField[]
  partyNames: string[]
  classification: Classification | undefined
}

/** The facts: a string of 1 to 100,000 UTF-16 code units (D1) with something in it. */
function parseFacts(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_FACTS || value.trim() === "") throw badRequest("invalid_facts")
  return value
}

/**
 * The verbatim values: absent, or at most 20 `{ field, text }` (no other key). Each `field` is a distinct name from the
 * type's `requiredFields`; each `text` is 1 to 10,000 characters with something in it; the texts total at most 50,000.
 */
function parseVerbatim(value: unknown, requiredFields: readonly string[]): VerbatimField[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_VERBATIM) throw badRequest("invalid_verbatim")
  const seen = new Set<string>()
  const out: VerbatimField[] = []
  let total = 0
  for (const entry of value as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw badRequest("invalid_verbatim")
    const keys = Object.keys(entry)
    if (keys.length !== 2 || !keys.includes("field") || !keys.includes("text")) throw badRequest("invalid_verbatim")
    const { field, text } = entry as { field: unknown; text: unknown }
    if (typeof field !== "string" || !requiredFields.includes(field) || seen.has(field)) throw badRequest("invalid_verbatim")
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_VERBATIM_TEXT || text.trim() === "") throw badRequest("invalid_verbatim")
    total += text.length
    if (total > MAX_VERBATIM_TOTAL) throw badRequest("invalid_verbatim")
    seen.add(field)
    out.push({ field, text })
  }
  return out
}

/** The party names: absent, or at most 50 strings, each 1 to 200 characters after trimming, with no control character as sent. */
function parsePartyNames(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_PARTY_NAMES) throw badRequest("invalid_party_names")
  const out: string[] = []
  for (const name of value as unknown[]) {
    if (typeof name !== "string" || CONTROL_CHARACTER.test(name)) throw badRequest("invalid_party_names")
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > MAX_PARTY_NAME) throw badRequest("invalid_party_names")
    out.push(trimmed)
  }
  return out
}

/** The request checks, in the order the spec states them; the first failure wins. */
function parseStartInput(data: Data): StartInput {
  const { matterId, documentTypeId, title, facts, verbatim, partyNames, classification } = data
  if (typeof matterId !== "string" || matterId === "") throw badRequest("matter_required")
  if (typeof documentTypeId !== "string" || documentTypeId === "") throw badRequest("invalid_document_type")
  // Only a VERIFIED type is selectable (E-15); a well-formed id that names none is 404.
  const type = getDocumentType(documentTypeId)
  if (type === null) throw new HttpError(404, "document_type_not_found")
  const parsedTitle = parseTitle(title)
  const parsedFacts = parseFacts(facts)
  const parsedVerbatim = parseVerbatim(verbatim, type.requiredFields)
  const parsedNames = parsePartyNames(partyNames)
  if (classification !== undefined && !isKnownClassification(classification)) throw badRequest("invalid_classification")
  return {
    matterId,
    documentTypeId,
    templateId: type.templateId,
    title: parsedTitle,
    facts: parsedFacts,
    verbatim: parsedVerbatim,
    partyNames: parsedNames,
    classification: classification as Classification | undefined,
  }
}

/** The charset rule's normalised form of a short text (422 `unsupported_characters`); text that is nothing once normalised is refused too. */
function charsetChecked(text: string): string {
  let normalised: string
  try {
    normalised = requireSupportedDraftBody(text)
  } catch (err) {
    if (err instanceof DraftCharsetError) throw new HttpError(422, err.code)
    throw err
  }
  if (normalised.trim() === "") throw new HttpError(422, "unsupported_characters")
  return normalised
}

/**
 * The text rules (D15, D26), after the permission so they give no oracle: the title and the facts as a draft's are
 * checked (`checkedText`), the verbatim texts and the party names pass the charset rule, and all of them, in their stored
 * form, are refused when they hold a reserved token. Returns what is stored.
 */
function checkedGenerationText(input: StartInput): { title: string; facts: string; verbatim: VerbatimField[]; partyNames: string[] } {
  const { title, body } = checkedText(input.title, input.facts)
  if (body.trim() === "") throw new HttpError(422, "unsupported_characters")
  const verbatim = input.verbatim.map(({ field, text }) => ({ field, text: charsetChecked(text) }))
  const partyNames = input.partyNames.map((name) => charsetChecked(name).trim())
  refuseReservedTokens([title, body, ...verbatim.map((v) => v.text), ...partyNames])
  return { title, facts: body, verbatim, partyNames }
}

/**
 * startDraft({ matterId, documentTypeId, title, facts, verbatim?, partyNames?, classification? }) →
 * `{ generationId, stage, classification, outlineVersion }` (P4B-1). Checks the request (400, field by field), then
 * `draft.create` on the matter (same firm, member, cleared; partner, associate, clerk), reads the matter (404), the open,
 * court and classification checks (`classifyForMatter`: 409 `matter_closed`, 422 `court_mismatch`, 422
 * `classification_below_matter`, 403 `clearance`), and the text rules. One transaction decides the permission and the
 * label again on the matter as read there (a label raised or a member removed in between is judged too), stages the
 * call's audit row and creates the brief at stage `facts`. The answer holds ids and labels, never the advocate's text.
 */
export const startDraftOp: FirmOperation<{ generationId: string; stage: Stage; classification: Classification; outlineVersion: number }> = {
  auth: "firm",
  kind: "general",
  action: "draft.create",
  target: "draft_generations",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const input = parseStartInput(data)
    audit.target = `matters/${input.matterId}`
    await requireMatterAction(caller, "draft.create", input.matterId)

    const matter = (await adminDb().collection("matters").doc(input.matterId).get()).data()
    if (!matter || matter.firmId !== caller.firmId) throw notFound()
    classifyForMatter(caller, matter, input.documentTypeId, input.classification)
    const text = checkedGenerationText(input)

    const briefRef = generations().doc()
    const generationId = briefRef.id
    audit.target = `draft_generations/${generationId}`
    const out = await adminDb().runTransaction(async (tx) => {
      // The stamp is taken in the attempt that commits, so createdAt and updatedAt are that attempt's clock.
      const stamp = Timestamp.now()
      const current = await requireStillPermitted(tx, caller, "draft.create", input.matterId)
      const classification = classifyForMatter(caller, current, input.documentTypeId, input.classification)
      await audit.stage(tx, "allow", "ok")
      tx.create(briefRef, {
        firmId: caller.firmId,
        matterId: input.matterId,
        documentTypeId: input.documentTypeId,
        title: text.title,
        facts: text.facts,
        verbatim: text.verbatim,
        partyNames: text.partyNames,
        classification,
        stage: "facts" as Stage,
        outlineVersion: 0,
        approvedOutline: null,
        sectionCount: null,
        sectionsStored: 0,
        templateId: input.templateId,
        path: null,
        model: null,
        promptVersion: null,
        calls: 0,
        costMicroUsd: 0,
        lastAttempt: null,
        inFlight: null,
        draftId: null,
        createdBy: caller.uid,
        createdAt: stamp,
        updatedAt: stamp,
      })
      return { generationId, stage: "facts" as Stage, classification, outlineVersion: 0 }
    })
    audit.committed()
    return out
  },
}

// ---------------------------------------------------------------------------
// getGeneration
// ---------------------------------------------------------------------------

/**
 * getGeneration(?generationId=) → the brief as a `GenerationView` (P4B-8): every field, with the lease shown as
 * `inProgress`. `draft.read` on the brief's matter; a brief the caller cannot see is 404 `not_found`.
 */
export const getGenerationOp: FirmOperation<GenerationView> = {
  auth: "firm",
  kind: "general",
  action: "draft.read",
  target: "draft_generations",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const generationId = parseGenerationId(data.generationId)
    audit.target = `draft_generations/${generationId}`
    const { brief } = await loadGenerationForCaller(caller, generationId, "draft.read")
    await audit.allow()
    return generationView(generationId, brief, d4Now())
  },
}

// ---------------------------------------------------------------------------
// listGenerations
// ---------------------------------------------------------------------------

/**
 * listGenerations(?matterId=&limit=&cursor=) → `{ items, nextCursor }` (P4B-8), as listDrafts does it
 * (`listClearedByUpdatedAt` over `draft_generations`): the matter's briefs the caller is cleared for, newest first
 * (updatedAt desc, then id desc), as `GenerationSummary` rows. A matter is required (400 `matter_required`);
 * `draft.read` is checked on it (another firm's or a missing matter is 404). The cursor is `<seconds>.<nanos>` of the
 * last row's `updatedAt` and its id (400 `invalid_cursor`).
 */
export const listGenerationsOp: FirmOperation<Page<GenerationSummary>> = {
  auth: "firm",
  kind: "general",
  action: "draft.read",
  target: "draft_generations",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const matterId = data.matterId
    if (typeof matterId !== "string" || matterId === "") throw badRequest("matter_required")
    const page = parseTimePage(data)
    audit.target = `matters/${matterId}`
    await requireMatterAction(caller, "draft.read", matterId)

    const nowMs = d4Now()
    const out = await listClearedByUpdatedAt(generations(), caller, matterId, page, (id, row) => generationSummary(id, row, nowMs))
    await audit.allow()
    return out
  },
}
