import { createHash } from "node:crypto"
import {
  FieldPath,
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type Query,
  type Transaction,
} from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { decide, type DraftAction } from "@/platform/p5/permissionDecision"
import { DraftCharsetError, requireSupportedDraftBody, requireSupportedDraftTitle } from "@/services/d4-2/draftCharset"
import { adminDb } from "../admin"
import { isContentionAbort } from "../d1/contention"
import { decodeCursor, encodeCursor, parsePage, type Page } from "../d1/pagination"
import { HttpError } from "../http/errors"
import type { Caller } from "../p5/auth"
import { isKnownClassification, rankOf } from "../p5/classification"
import { isSafeDocId, type CallAudit, type Data, type FirmOperation } from "../p5/common"
import { requirePermission } from "../p5/permission"
import { courtAllowed, getDocumentType } from "./doctypes"
import type { GateStatus } from "./types"

/**
 * The D4-1 draft store (spec P4-4, P4-5, P4-10, P4-12): `createDraft`, `saveDraftVersion`, `restoreDraftVersion`,
 * `getDraft`, `listDrafts` and `listDraftVersions` behind `/api/d4/drafting/`.
 *
 * Collections (server-only for writes, firestore.rules P4-11):
 * - `drafts/{auto id}`: the draft and its current state, never its body.
 * - `draft_versions/{draftId}_{n}`: one immutable row per stored version, n dense from 1, body inline.
 * - `events/{draftId}_{n}_autosaved`: the `draft.autosaved` event of each stored version.
 * Every change to a draft is one transaction: the draft, the version, the event and the call's audit row.
 *
 * What a caller sees: the permission is decided on the draft's own matter (`loadDraftForCaller`); a draft that is
 * absent, in another firm, or above the caller's clearance is 404 `not_found`, so its existence never leaks.
 */

const drafts = () => adminDb().collection("drafts")
const versions = () => adminDb().collection("draft_versions")
const matters = () => adminDb().collection("matters")

/** The most a stored body may take in UTF-8 (P4-4): Firestore limits a document to 1 MiB, and an Urdu letter takes 2 bytes or 3. */
export const MAX_BODY_BYTES = 900_000

const badRequest = (code: string) => new HttpError(400, code)
const notFound = () => new HttpError(404, "not_found")

/** The lowercase hex SHA-256 of the UTF-8 text. A version's `bodySha256` is this over its body (the title is not part of it). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** The gate summary a draft holds (P4-4); null until a gate has run on its current version. */
export type GateSummary = { version: number; bodySha256: string; status: GateStatus; gatedAt: string | null; overridden: boolean }

/** A draft as the routes return it: its current state, never a body. */
export type DraftView = {
  draftId: string
  matterId: string
  documentTypeId: string
  title: string
  classification: Classification
  status: "draft" | "approved"
  currentVersion: number
  currentBodySha256: string
  locked: boolean
  masterVersion: null
  gateResult: GateSummary | null
  approvedBy?: string
  approvedAt?: string | null
  approvedVersion?: number
  createdBy: string
  createdAt: string | null
  updatedAt: string | null
}

export const iso = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null)

function gateSummary(raw: unknown): GateSummary | null {
  if (raw === null || typeof raw !== "object") return null
  const g = raw as Record<string, unknown>
  // Named fields only, so nothing else stored in the summary can reach a response.
  return {
    version: g.version as number,
    bodySha256: g.bodySha256 as string,
    status: g.status as GateStatus,
    gatedAt: iso(g.gatedAt),
    overridden: g.overridden === true,
  }
}

/** The draft document as the routes return it (P4-4 `DraftView`). */
export function draftView(draftId: string, d: DocumentData): DraftView {
  return {
    draftId,
    matterId: d.matterId,
    documentTypeId: d.documentTypeId,
    title: d.title,
    classification: d.classification,
    status: d.status,
    currentVersion: d.currentVersion,
    currentBodySha256: d.currentBodySha256,
    locked: d.locked === true,
    masterVersion: null,
    gateResult: gateSummary(d.gateResult),
    ...(d.approvedBy !== undefined ? { approvedBy: d.approvedBy } : {}),
    ...(d.approvedAt !== undefined ? { approvedAt: iso(d.approvedAt) } : {}),
    ...(d.approvedVersion !== undefined ? { approvedVersion: d.approvedVersion } : {}),
    createdBy: d.createdBy,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  }
}

export const withinClearance = (raw: unknown, clearance: Classification): boolean => isKnownClassification(raw) && rankOf(raw) <= rankOf(clearance)

/** The document id of a stored version. */
export const versionId = (draftId: string, version: number): string => `${draftId}_${version}`

/**
 * The permission check on a matter for a draft action (matter-level: same firm, a member, cleared, role). A missing
 * matter and another firm's are both 404 `not_found`, as `getMatter`, so existence never leaks; any other refusal is
 * requirePermission's 403 (not_member, clearance, intern_channel_denied, ...); an audit failure is 503.
 */
export async function requireMatterAction(caller: Caller, action: DraftAction, matterId: string): Promise<void> {
  try {
    await requirePermission(caller, action, matterId)
  } catch (err) {
    if (err instanceof HttpError && err.status === 403 && err.code === "cross_firm") throw notFound()
    throw err
  }
}

/**
 * In a transaction that writes a draft: the caller may still take `action` on the draft's matter, decided by the shared
 * table (P4-10) over the matter and the caller's membership as read in `tx` (PR #25 review). The check before the
 * transaction can go stale while the call runs (a member removed, the matter's label raised above the caller's
 * clearance), and a transaction that read neither would commit anyway; reading both here also retries it when either
 * changes under it. A matter that is gone or another firm's is 404 `not_found`; a refusal is 403 with the table's
 * reason, as requirePermission answers (`not_member`, `clearance`, `role_not_permitted`). The matter comes back as read.
 */
export async function requireStillPermitted(tx: Transaction, caller: Caller, action: DraftAction, matterId: string): Promise<DocumentData> {
  const matter = (await tx.get(matters().doc(matterId))).data()
  if (!matter || matter.firmId !== caller.firmId) throw notFound()
  const isMember = (await tx.get(adminDb().collection("matter_members").doc(`${matterId}_${caller.uid}`))).exists
  const decision = decide(caller, action, { firmId: caller.firmId, classification: matter.classification }, isMember)
  if (!decision.allow) throw new HttpError(403, decision.reason === "partner-only" ? "partner_only" : decision.reason.replaceAll("-", "_"))
  return matter
}

/**
 * The draft `draftId` for a caller who may take `action` on its matter. 404 `not_found` for an id that cannot name a
 * draft, a draft that is absent or in another firm, and one above the caller's clearance (no existence oracle); the
 * permission is checked on the draft's matter, so a same-firm caller who is not a cleared member of that matter is
 * refused 403 (not_member, clearance, role) and a client, intern or accounts user is refused by role.
 */
export async function loadDraftForCaller(
  caller: Caller,
  draftId: string,
  action: DraftAction
): Promise<{ ref: DocumentReference; draft: DocumentData }> {
  if (!isSafeDocId(draftId)) throw notFound()
  const ref = drafts().doc(draftId)
  const draft = (await ref.get()).data()
  if (!draft || draft.firmId !== caller.firmId || typeof draft.matterId !== "string") throw notFound()
  await requireMatterAction(caller, action, draft.matterId)
  if (!withinClearance(draft.classification, caller.clearanceLevel)) throw notFound()
  return { ref, draft }
}

/**
 * Stages the `draft.autosaved` / `draft.gated` / `draft.approved` event of a draft version in `tx` (P4-12): payload
 * `{ draftId, matterId, documentTypeId, version, gateResult, masterVersion: null }`, the draft's classification, the
 * document id `<draftId>_<version>_<suffix>` (the idempotency key with its colons as underscores).
 */
export function stageDraftEvent(
  tx: Transaction,
  name: "draft.autosaved" | "draft.gated" | "draft.approved",
  suffix: string,
  draftId: string,
  version: number,
  draft: { firmId: string; matterId: string; documentTypeId: string; classification: Classification },
  gateResult: GateStatus | null
): void {
  const key = `${draftId}:${version}:${suffix}`
  tx.create(adminDb().collection("events").doc(key.replaceAll(":", "_")), {
    name,
    firmId: draft.firmId,
    payload: { draftId, matterId: draft.matterId, documentTypeId: draft.documentTypeId, version, gateResult, masterVersion: null },
    classification: draft.classification,
    occurredAt: FieldValue.serverTimestamp(),
    idempotencyKey: key,
  })
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** A draft id: a non-empty string (anything else is a malformed request; an id that cannot exist is 404 later). */
export function parseDraftId(value: unknown): string {
  if (typeof value !== "string" || value === "") throw badRequest("invalid_query")
  return value
}

/** A version number in a POST body: a JSON integer from 1 up (400 `invalid_version`). */
export function parseVersionNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw badRequest("invalid_version")
  return value
}

/** A version number in a query string: 1 to 9 digits, no sign, no leading zero (400 `invalid_version`). */
function parseVersionParam(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d{0,8}$/.test(value)) throw badRequest("invalid_version")
  return Number(value)
}

/** C0 controls (LF, CR and TAB among them), DEL and the C1 controls: a title is one line of text. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/

/**
 * A title is a string with something in it, and no control character anywhere (400 `invalid_title`): not a line break,
 * a tab, any other C0 or C1 control or DEL. It is judged as sent, before the trim and before the charset functions.
 */
export function parseTitle(value: unknown): string {
  if (typeof value !== "string") throw badRequest("invalid_title")
  if (CONTROL_CHARACTER.test(value)) throw badRequest("invalid_title")
  if (value.trim() === "") throw badRequest("invalid_title")
  return value
}

function parseBody(value: unknown): string {
  if (typeof value !== "string") throw badRequest("invalid_body")
  return value
}

/**
 * The stored form of a title and a body (P4-4): the charset layer's NFC-normalised text, or 422 with its code
 * (`unsupported_characters`, `draft_too_large`, `title_too_long`), then the 900,000 UTF-8 byte cap (422
 * `draft_too_large`). The title is trimmed; one that is nothing once normalised is 400 `invalid_title`.
 */
export function checkedText(rawTitle: string, rawBody: string): { title: string; body: string } {
  let title: string
  let body: string
  try {
    title = requireSupportedDraftTitle(rawTitle.trim()).trim()
    body = requireSupportedDraftBody(rawBody)
  } catch (err) {
    if (err instanceof DraftCharsetError) throw new HttpError(422, err.code)
    throw err
  }
  if (title === "") throw badRequest("invalid_title")
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new HttpError(422, "draft_too_large")
  return { title, body }
}

// ---------------------------------------------------------------------------
// createDraft
// ---------------------------------------------------------------------------

type CreateInput = { matterId: string; documentTypeId: string; title: string; body: string; classification: Classification | undefined }

/** The request checks, in the order the spec states them; the first failure wins. */
function parseCreateInput(data: Data): CreateInput {
  const { matterId, documentTypeId, title, body, classification } = data
  if (typeof matterId !== "string" || matterId === "") throw badRequest("matter_required")
  if (typeof documentTypeId !== "string" || documentTypeId === "") throw badRequest("invalid_document_type")
  // Only a VERIFIED type is selectable (E-15); a well-formed id that names none is 404.
  if (getDocumentType(documentTypeId) === null) throw new HttpError(404, "document_type_not_found")
  const parsedTitle = parseTitle(title)
  const parsedBody = parseBody(body)
  if (classification !== undefined && !isKnownClassification(classification)) throw badRequest("invalid_classification")
  return { matterId, documentTypeId, title: parsedTitle, body: parsedBody, classification: classification as Classification | undefined }
}

/**
 * Caller-authored free text is never rank 0 (ruling R3, N1: anyone can open a `public` matter), so a draft is at least
 * `internal`, as committeeBrain's caller-authored text is (`FREE_TEXT_FLOOR` in p1/ops.ts).
 */
const FREE_TEXT_FLOOR: Classification = "internal"

/** The strictest label by rank, never by string comparison. */
export function strictest(labels: Classification[]): Classification {
  return labels.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a))
}

/**
 * What the matter allows a new draft to be (P4-5, R3, R4): a matter whose label is unreadable fails closed (403
 * `clearance`); a closed matter takes no new draft (409 `matter_closed`: the `status` that closeMatter writes); the
 * court check (422 `court_mismatch`); then the classification: a caller label below the matter's own is 422
 * `classification_below_matter`, the result is the strictest of the matter's label, the `internal` floor and the caller's
 * label (monotonic, L17.3 #20), and the caller's clearance must reach that result (403 `clearance`). Returns the draft's
 * classification.
 */
export function classifyForMatter(
  caller: Caller,
  matter: DocumentData,
  documentTypeId: string,
  requested: Classification | undefined
): Classification {
  const label: unknown = matter.classification
  if (!isKnownClassification(label)) throw new HttpError(403, "clearance")
  if (matter.status === "closed") throw new HttpError(409, "matter_closed")
  const courtId = typeof matter.courtId === "string" && matter.courtId !== "" ? matter.courtId : undefined
  const type = getDocumentType(documentTypeId)
  if (type === null || !courtAllowed(type, courtId)) throw new HttpError(422, "court_mismatch")
  if (requested !== undefined && rankOf(requested) < rankOf(label)) throw new HttpError(422, "classification_below_matter")
  const result = strictest(requested === undefined ? [label, FREE_TEXT_FLOOR] : [label, FREE_TEXT_FLOOR, requested])
  if (rankOf(caller.clearanceLevel) < rankOf(result)) throw new HttpError(403, "clearance")
  return result
}

/**
 * createDraft({ matterId, documentTypeId, title, body, classification? }) → the DraftView (P4-4, P4-5). Checks the
 * request, then `draft.create` on the matter (same firm, member, cleared; partner, associate, clerk), then reads the
 * matter (404), the open, court and classification checks (a closed matter is 409 `matter_closed`; a draft is at least
 * `internal`), and the text checks. One transaction writes the draft, version 1
 * (kind `create`), the `draft.autosaved` event and the call's audit row. The matter and the caller's membership are
 * read again in the transaction (requireStillPermitted), so a label raised or a member removed in between is judged too.
 */
export const createDraftOp: FirmOperation<DraftView> = {
  auth: "firm",
  kind: "general",
  action: "draft.create",
  target: "drafts",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const input = parseCreateInput(data)
    audit.target = `matters/${input.matterId}`
    await requireMatterAction(caller, "draft.create", input.matterId)

    const matterRef = matters().doc(input.matterId)
    const matter = (await matterRef.get()).data()
    if (!matter || matter.firmId !== caller.firmId) throw notFound()
    classifyForMatter(caller, matter, input.documentTypeId, input.classification)
    const text = checkedText(input.title, input.body)

    const draftRef = drafts().doc()
    const draftId = draftRef.id
    audit.target = `drafts/${draftId}`
    const bodySha256 = sha256Hex(text.body)
    const view = await adminDb().runTransaction(async (tx) => {
      // The stamp is taken in the attempt that commits, so createdAt and updatedAt are that attempt's clock.
      const stamp = Timestamp.now()
      const current = await requireStillPermitted(tx, caller, "draft.create", input.matterId)
      const classification = classifyForMatter(caller, current, input.documentTypeId, input.classification)
      await audit.stage(tx, "allow", "ok")
      const draft = {
        firmId: caller.firmId,
        matterId: input.matterId,
        documentTypeId: input.documentTypeId,
        title: text.title,
        classification,
        status: "draft" as const,
        currentVersion: 1,
        currentBodySha256: bodySha256,
        locked: false,
        masterVersion: null,
        gateResult: null,
        createdBy: caller.uid,
        createdAt: stamp,
        updatedAt: stamp,
      }
      tx.create(draftRef, draft)
      tx.create(versions().doc(versionId(draftId, 1)), {
        firmId: caller.firmId,
        matterId: input.matterId,
        draftId,
        version: 1,
        title: text.title,
        body: text.body,
        bodySha256,
        classification,
        kind: "create",
        createdBy: caller.uid,
        createdAt: stamp,
      })
      stageDraftEvent(tx, "draft.autosaved", "autosaved", draftId, 1, draft, null)
      return draftView(draftId, draft)
    })
    audit.committed()
    return view
  },
}

// ---------------------------------------------------------------------------
// saveDraftVersion, restoreDraftVersion
// ---------------------------------------------------------------------------

export type SavedDraft = { saved: boolean; draft: DraftView }

/** Attempts at a save or restore transaction under lock contention. */
const CHANGE_TX_ATTEMPTS = 10

/**
 * The refusals a draft's current state gives an edit, locked first (P4-4): 409 `draft_locked`, then 409 `draft_changed`
 * when `baseVersion` is not the current version.
 */
function refuseStaleEdit(draft: DocumentData, baseVersion: number): void {
  if (draft.locked === true) throw new HttpError(409, "draft_locked")
  if (draft.currentVersion !== baseVersion) throw new HttpError(409, "draft_changed")
}

/**
 * The label a new version of `draft` takes (final review PROBE-5): the strictest of the draft's own label and its
 * matter's current one (`matter` as read in the version's transaction by requireStillPermitted, which has already
 * refused a caller not cleared for it), so a matter label raised after the draft was created binds every later version
 * and never falls (monotonic, L17.3 #20). The draft takes it too, and so do the events, gate results and overrides that
 * follow the draft's label. A label that is unreadable fails closed (403 `clearance`), as classifyForMatter does, and
 * so does a raised label above the caller's clearance (a backstop: requireStillPermitted has refused that already).
 */
function raisedLabel(caller: Caller, draft: DocumentData, matter: DocumentData): Classification {
  if (!isKnownClassification(matter.classification)) throw new HttpError(403, "clearance")
  const result = strictest([draft.classification as Classification, matter.classification])
  if (rankOf(caller.clearanceLevel) < rankOf(result)) throw new HttpError(403, "clearance")
  return result
}

/**
 * Stores `content` as version baseVersion + 1 of the draft, in one transaction with the event and the call's audit row,
 * after re-reading the draft and deciding the caller's permission again on its matter (requireStillPermitted: a member
 * removed or a label raised since the call's first check is refused): locked (409 `draft_locked`), then `baseVersion`
 * against `currentVersion` (409 `draft_changed`), so two writers on one base give one new version and one refusal, and
 * the numbers stay dense. When the content equals the current version's (same title, same body hash) nothing is
 * written but the audit row: `{ saved: false }`. A new version is not gated, so the draft's gate summary is reset (the
 * old result stays in `draft_gate_results`). The version and the draft take `raisedLabel`. A transaction that gives up
 * under contention wrote nothing and answers `draft_changed`.
 */
async function storeVersion(
  caller: Caller,
  audit: CallAudit,
  ref: DocumentReference,
  baseVersion: number,
  kind: "save" | "restore",
  resolve: (tx: Transaction) => Promise<{ title: string; body: string; restoredFrom?: number }>
): Promise<SavedDraft> {
  const draftId = ref.id
  let out: SavedDraft
  try {
    out = await adminDb().runTransaction(
      async (tx) => {
        // The stamp is taken in the attempt that commits, so createdAt and updatedAt are that attempt's clock.
        const stamp = Timestamp.now()
        const draft = (await tx.get(ref)).data()
        if (!draft || draft.firmId !== caller.firmId || !withinClearance(draft.classification, caller.clearanceLevel)) throw notFound()
        const matter = await requireStillPermitted(tx, caller, "draft.edit", draft.matterId as string)
        refuseStaleEdit(draft, baseVersion)
        const next = await resolve(tx)
        const bodySha256 = sha256Hex(next.body)
        if (draft.title === next.title && draft.currentBodySha256 === bodySha256) {
          await audit.stage(tx, "allow", "ok")
          return { saved: false, draft: draftView(draftId, draft) }
        }
        const version = baseVersion + 1
        const classification = raisedLabel(caller, draft, matter)
        await audit.stage(tx, "allow", "ok")
        tx.create(versions().doc(versionId(draftId, version)), {
          firmId: caller.firmId,
          matterId: draft.matterId,
          draftId,
          version,
          title: next.title,
          body: next.body,
          bodySha256,
          classification,
          kind,
          ...(next.restoredFrom !== undefined ? { restoredFrom: next.restoredFrom } : {}),
          createdBy: caller.uid,
          createdAt: stamp,
        })
        const update = { title: next.title, classification, currentVersion: version, currentBodySha256: bodySha256, gateResult: null, updatedAt: stamp }
        tx.update(ref, update)
        stageDraftEvent(tx, "draft.autosaved", "autosaved", draftId, version, { ...(draft as { firmId: string; matterId: string; documentTypeId: string }), classification }, null)
        return { saved: true, draft: draftView(draftId, { ...draft, ...update }) }
      },
      { maxAttempts: CHANGE_TX_ATTEMPTS }
    )
  } catch (err) {
    // The attempts ran out against another writer on this draft: nothing was written, and the draft is changing under the caller.
    if (isContentionAbort(err)) throw new HttpError(409, "draft_changed")
    throw err
  }
  audit.committed()
  return out
}

/**
 * saveDraftVersion({ draftId, baseVersion, title, body }) → `{ saved, draft }` (P4-4). `draft.edit` on the draft's
 * matter; the text checks; a locked draft is 409 `draft_locked` and a `baseVersion` that is not the current version 409
 * `draft_changed` (both again inside the transaction). The same title and body as the current version is `saved: false`
 * with nothing written; otherwise version n + 1 (kind `save`) and `saved: true`.
 */
export const saveDraftVersionOp: FirmOperation<SavedDraft> = {
  auth: "firm",
  kind: "general",
  action: "draft.edit",
  target: "drafts",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const draftId = parseDraftId(data.draftId)
    const baseVersion = parseVersionNumber(data.baseVersion)
    const title = parseTitle(data.title)
    const body = parseBody(data.body)
    audit.target = `drafts/${draftId}`
    const { ref, draft } = await loadDraftForCaller(caller, draftId, "draft.edit")
    refuseStaleEdit(draft, baseVersion)
    const text = checkedText(title, body)
    return storeVersion(caller, audit, ref, baseVersion, "save", async () => text)
  },
}

/**
 * restoreDraftVersion({ draftId, baseVersion, fromVersion }) → `{ saved, draft }` (P4-4). As a save, with the title and
 * body of `fromVersion` of this draft (404 `version_not_found`), stored as a new version (kind `restore`, `restoredFrom`).
 * Restoring content equal to the current version's is `saved: false`.
 */
export const restoreDraftVersionOp: FirmOperation<SavedDraft> = {
  auth: "firm",
  kind: "general",
  action: "draft.edit",
  target: "drafts",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const draftId = parseDraftId(data.draftId)
    const baseVersion = parseVersionNumber(data.baseVersion)
    const fromVersion = parseVersionNumber(data.fromVersion)
    audit.target = `drafts/${draftId}`
    const { ref, draft } = await loadDraftForCaller(caller, draftId, "draft.edit")
    refuseStaleEdit(draft, baseVersion)
    return storeVersion(caller, audit, ref, baseVersion, "restore", async (tx) => {
      const row = (await tx.get(versions().doc(versionId(draftId, fromVersion)))).data()
      if (!row || row.firmId !== caller.firmId || row.draftId !== draftId || typeof row.title !== "string" || typeof row.body !== "string") {
        throw new HttpError(404, "version_not_found")
      }
      return { title: row.title, body: row.body, restoredFrom: fromVersion }
    })
  },
}

// ---------------------------------------------------------------------------
// getDraft
// ---------------------------------------------------------------------------

export type DraftRead = DraftView & { version: number; body: string }

/**
 * getDraft(?draftId=&version=) → the DraftView with the title and body of the requested version (default: the current
 * one) and its number (P4-4). `draft.read` on the draft's matter; a version the draft does not have is 404
 * `version_not_found`, a malformed one 400 `invalid_version`.
 */
export const getDraftOp: FirmOperation<DraftRead> = {
  auth: "firm",
  kind: "general",
  action: "draft.read",
  target: "drafts",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const draftId = parseDraftId(data.draftId)
    const requested = data.version === undefined ? undefined : parseVersionParam(data.version)
    audit.target = `drafts/${draftId}`
    const { draft } = await loadDraftForCaller(caller, draftId, "draft.read")
    const version = requested ?? draft.currentVersion
    const row = typeof version === "number" ? (await versions().doc(versionId(draftId, version)).get()).data() : undefined
    if (!row || row.firmId !== caller.firmId || row.draftId !== draftId) throw new HttpError(404, "version_not_found")
    await audit.allow()
    return { ...draftView(draftId, draft), version: row.version, title: row.title, body: row.body }
  },
}

// ---------------------------------------------------------------------------
// listDrafts, listDraftVersions
// ---------------------------------------------------------------------------

const SCAN_BATCH = 100

/**
 * The `updatedAt` cursor of listDrafts: `<seconds>.<nanos>` in decimal digits, exactly two parts, and the draft id
 * (400 `invalid_cursor`). Extra or empty parts, a sign or an exponent are refused, not read as a moved boundary.
 */
export function parseTimeCursor(cursor: string): { updatedAt: Timestamp; id: string } {
  const { sortKey, id } = decodeCursor(cursor)
  const parts = /^(\d{1,12})\.(\d{1,9})$/.exec(sortKey)
  if (!parts || !isSafeDocId(id)) throw badRequest("invalid_cursor")
  const [seconds, nanos] = [Number(parts[1]), Number(parts[2])]
  try {
    return { updatedAt: new Timestamp(seconds, nanos), id }
  } catch {
    // Seconds outside the Timestamp range.
    throw badRequest("invalid_cursor")
  }
}

/**
 * listDrafts(?matterId=&limit=&cursor=) → `{ items, nextCursor }` (P4-4): the matter's drafts the caller is cleared
 * for, newest first (updatedAt desc, then id desc), as DraftViews (no body). A matter is required (400
 * `matter_required`); `draft.read` is checked on it (another firm's or a missing matter is 404).
 */
export const listDraftsOp: FirmOperation<Page<DraftView>> = {
  auth: "firm",
  kind: "general",
  action: "draft.read",
  target: "drafts",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const matterId = data.matterId
    if (typeof matterId !== "string" || matterId === "") throw badRequest("matter_required")
    const { limit, cursor } = parsePage(data)
    let after = cursor === null ? null : parseTimeCursor(cursor)
    audit.target = `matters/${matterId}`
    await requireMatterAction(caller, "draft.read", matterId)

    const items: Array<{ id: string; row: DocumentData }> = []
    let more = false
    for (;;) {
      let q: Query = drafts()
        .where("firmId", "==", caller.firmId)
        .where("matterId", "==", matterId)
        .orderBy("updatedAt", "desc")
        .orderBy(FieldPath.documentId(), "desc")
      if (after) q = q.startAfter(after.updatedAt, after.id)
      const snap = await q.limit(SCAN_BATCH).get()
      for (const doc of snap.docs) {
        if (!withinClearance(doc.data().classification, caller.clearanceLevel)) continue
        if (items.length === limit) {
          more = true
          break
        }
        items.push({ id: doc.id, row: doc.data() })
      }
      if (more || snap.size < SCAN_BATCH) break
      const last = snap.docs[snap.docs.length - 1]
      after = { updatedAt: last.data().updatedAt as Timestamp, id: last.id }
    }

    await audit.allow()
    const last = items[items.length - 1]
    const lastStamp = last?.row.updatedAt as Timestamp | undefined
    return {
      items: items.map(({ id, row }) => draftView(id, row)),
      nextCursor: more && last && lastStamp ? encodeCursor(`${lastStamp.seconds}.${lastStamp.nanoseconds}`, last.id) : null,
    }
  },
}

/** One row of listDraftVersions (P4-4): metadata only, no title and no body. */
export type VersionMeta = { version: number; bodySha256: string; kind: string; restoredFrom?: number; createdBy: string; createdAt: string | null }

/** The `version` cursor of listDraftVersions: the last version listed (400 `invalid_cursor`). */
function parseVersionCursor(cursor: string): number {
  const { sortKey } = decodeCursor(cursor)
  if (!/^[1-9]\d{0,15}$/.test(sortKey)) throw badRequest("invalid_cursor")
  return Number(sortKey)
}

/**
 * listDraftVersions(?draftId=&limit=&cursor=) → `{ items, nextCursor }` (P4-4): the draft's stored versions, newest
 * first, as `{ version, bodySha256, kind, restoredFrom?, createdBy, createdAt }`. The query selects those fields, so no
 * body is read. `draft.read` on the draft's matter.
 */
export const listDraftVersionsOp: FirmOperation<Page<VersionMeta>> = {
  auth: "firm",
  kind: "general",
  action: "draft.read",
  target: "drafts",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const draftId = parseDraftId(data.draftId)
    const { limit, cursor } = parsePage(data)
    const after = cursor === null ? null : parseVersionCursor(cursor)
    audit.target = `drafts/${draftId}`
    await loadDraftForCaller(caller, draftId, "draft.read")

    let q: Query = versions()
      .where("firmId", "==", caller.firmId)
      .where("draftId", "==", draftId)
      .orderBy("version", "desc")
      .select("version", "bodySha256", "kind", "restoredFrom", "createdBy", "createdAt")
    if (after !== null) q = q.startAfter(after)
    const snap = await q.limit(limit + 1).get()
    const more = snap.size > limit
    const rows = snap.docs.slice(0, limit)

    await audit.allow()
    const last = rows[rows.length - 1]
    return {
      items: rows.map((doc): VersionMeta => {
        const d = doc.data()
        return {
          version: d.version,
          bodySha256: d.bodySha256,
          kind: d.kind,
          ...(d.restoredFrom !== undefined ? { restoredFrom: d.restoredFrom } : {}),
          createdBy: d.createdBy,
          createdAt: iso(d.createdAt),
        }
      }),
      nextCursor: more && last ? encodeCursor(String(last.data().version), last.id) : null,
    }
  },
}
