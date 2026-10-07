import { FieldValue, Timestamp, type DocumentData, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import type { Caller } from "../../p5/auth"
import { isKnownClassification, rankOf } from "../../p5/classification"
import { isSafeDocId, type Data, type FirmOperation } from "../../p5/common"
import { requirePermission } from "../../p5/permission"
import { consumeDailyConflict } from "../dailyLimit"
import { parseKeys, parseName } from "../validate"
import { discloseFor, matterIdsOf, type DisclosedCheck, type StoredCheck } from "./disclosure"
import { clientKeys, loadRegistry, runEngine } from "./engine"
import { summarise, type Hit, type Subject } from "./match"

/**
 * Module 6 conflict check operations (spec P2-3..P2-6, P2-13, P2-15, P2-17, P2-19, P2-20).
 * The full check is stored in `conflict_checks`; responses are the reader's disclosed view.
 * The API never returns a rule number (P2-19: code and tests cite PBC Rule 85 [REQUIRES VERIFICATION]).
 */

const checks = () => adminDb().collection("conflict_checks")

export const MAX_OPPOSING_PARTIES = 20

const invalid = () => new HttpError(400, "invalid_subjects")

const isObject = (v: unknown): v is Data => v !== null && typeof v === "object" && !Array.isArray(v)

/** `keys` of a subject: absent means none; otherwise an object of key strings (parseKeys). */
function parseSubjectKeys(raw: unknown) {
  if (raw === undefined || raw === null) return {}
  if (!isObject(raw)) throw invalid()
  return parseKeys(raw)
}

type ParsedClient = { kind: "ref"; clientId: string } | { kind: "named"; subject: Subject }

function parseClient(raw: unknown): ParsedClient {
  if (!isObject(raw)) throw invalid()
  if (raw.clientId !== undefined) {
    // A client reference stands alone: name and keys come from the client record.
    if (raw.name !== undefined || raw.keys !== undefined || !isSafeDocId(raw.clientId)) throw invalid()
    return { kind: "ref", clientId: raw.clientId }
  }
  return { kind: "named", subject: { role: "client", name: parseName(raw.name), keys: parseSubjectKeys(raw.keys) } }
}

function parseOpposing(raw: unknown): Subject[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OPPOSING_PARTIES) throw invalid()
  return raw.map((p): Subject => {
    if (!isObject(p)) throw invalid()
    return { role: "opposing", name: parseName(p.name), keys: parseSubjectKeys(p.keys) }
  })
}

/** The referenced client, in the caller's firm and within their clearance; otherwise invalid_subjects (existence not revealed). */
async function resolveClient(caller: Caller, clientId: string): Promise<{ subject: Subject; entityId: string | undefined }> {
  const row = (await adminDb().collection("clients").doc(clientId).get()).data()
  if (
    !row ||
    row.firmId !== caller.firmId ||
    typeof row.canonicalName !== "string" ||
    !isKnownClassification(row.classification) ||
    rankOf(row.classification) > rankOf(caller.clearanceLevel)
  ) {
    throw invalid()
  }
  const entityId = typeof row.entityId === "string" && row.entityId !== "" ? row.entityId : undefined
  return { subject: { role: "client", name: row.canonicalName, keys: clientKeys(row), clientId }, entityId }
}

/** The matters among `matterIds` the caller is a member of (matter_members/{matterId}_{uid}). */
async function memberMatters(caller: Caller, matterIds: string[]): Promise<Set<string>> {
  const safe = matterIds.filter((id) => isSafeDocId(id) && isSafeDocId(`${id}_${caller.uid}`))
  if (safe.length === 0) return new Set()
  const db = adminDb()
  const snaps = await db.getAll(...safe.map((id) => db.collection("matter_members").doc(`${id}_${caller.uid}`)))
  const out = new Set<string>()
  snaps.forEach((s, i) => {
    if (s.exists && s.data()?.firmId === caller.firmId) out.add(safe[i])
  })
  return out
}

/** A stored row in the StoredCheck shape (createdAt as ISO). */
function storedCheck(id: string, row: DocumentData): StoredCheck {
  const createdAt = row.createdAt instanceof Timestamp ? row.createdAt.toDate().toISOString() : null
  return {
    checkId: id,
    firmId: row.firmId,
    requestedBy: row.requestedBy,
    subjects: row.subjects ?? [],
    hits: row.hits ?? [],
    result: row.result,
    identityBasis: row.identityBasis,
    classification: row.classification,
    decision: row.decision,
    boundMatterId: row.boundMatterId ?? null,
    stale: row.stale === true,
    createdAt,
  }
}

/** Firestore rejects `undefined`; a JSON round trip drops undefined fields (all values are JSON-safe). */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * runConflictCheck({ client: { clientId } | { name, keys? }, opposingParties: [{ name, keys? }] (1-20) })
 * → the caller's disclosed view of the new check. Screens every subject against the firm's clients
 * and opposing parties; one transaction counts the check against the firm's Karachi-day cap
 * (429 daily_limit), writes `conflict_checks`, a `conflict_events` `decided` row, the
 * `conflict.decided` event and the call's audit row.
 */
export const runConflictCheckOp: FirmOperation<DisclosedCheck> = {
  auth: "firm",
  kind: "p1",
  action: "conflict.run",
  target: "conflict_checks",
  run: async ({ caller, now: clock }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "conflict.run")
    const now = new Date(clock ?? Date.now())

    const client = parseClient(data.client)
    const opposing = parseOpposing(data.opposingParties)
    const resolved = client.kind === "ref" ? await resolveClient(caller, client.clientId) : { subject: client.subject, entityId: undefined }
    const subjects: Subject[] = [resolved.subject, ...opposing]
    const subjectEntityIds = [resolved.entityId, ...opposing.map(() => undefined)]

    const registry = await loadRegistry(caller.firmId, now)
    const { hits, result, identityBasis, classification } = runEngine(registry, subjects, subjectEntityIds)
    const decision = result === "CLEAR" ? "cleared" : "pending"

    const db = adminDb()
    const ref = checks().doc()
    audit.target = `conflict_checks/${ref.id}`
    const row = plain({
      firmId: caller.firmId,
      requestedBy: caller.uid,
      subjects,
      hits,
      result,
      identityBasis,
      classification,
      decision,
      boundMatterId: null,
      stale: false,
    })
    await db.runTransaction(async (tx) => {
      await consumeDailyConflict(caller.firmId, now, tx)
      await audit.stage(tx, "allow", "ok")
      tx.create(ref, { ...row, createdAt: FieldValue.serverTimestamp() })
      tx.create(db.collection("conflict_events").doc(), {
        firmId: caller.firmId,
        checkId: ref.id,
        kind: "decided",
        actorId: caller.uid,
        detail: { result, identityBasis, hitCount: hits.length },
        classification,
        createdAt: FieldValue.serverTimestamp(),
      })
      // P2-20: `conflict.decided` in the events collection (no outbox exists in functions/; plan fallback, L8148).
      tx.create(db.collection("events").doc(`${ref.id}_decided`), {
        name: "conflict.decided",
        firmId: caller.firmId,
        payload: { checkId: ref.id, result, identityBasis },
        classification,
        occurredAt: FieldValue.serverTimestamp(),
        idempotencyKey: `${ref.id}:decided`,
      })
    })
    audit.committed()

    const stored = storedCheck(ref.id, { ...row, createdAt: Timestamp.fromDate(now) })
    return discloseFor(caller, stored, await memberMatters(caller, matterIdsOf(stored)))
  },
}

/**
 * getConflictResult(?checkId=) → the check as the reader may see it. Readable by its requester
 * or a partner of the same firm; anyone else, another firm or a missing id → 404 not_found.
 */
export const getConflictResultOp: FirmOperation<DisclosedCheck> = {
  auth: "firm",
  kind: "general",
  action: "conflict.read_result",
  target: "conflict_checks",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "conflict.run")
    const checkId = data.checkId
    if (!isSafeDocId(checkId)) throw new HttpError(400, "invalid_query")
    audit.target = `conflict_checks/${checkId}`
    const row = (await checks().doc(checkId).get()).data()
    if (!row || row.firmId !== caller.firmId || (row.requestedBy !== caller.uid && caller.role !== "partner")) {
      throw new HttpError(404, "not_found")
    }
    const stored = storedCheck(checkId, row)
    const members = await memberMatters(caller, matterIdsOf(stored))
    await audit.allow()
    return discloseFor(caller, stored, members)
  },
}

export const MIN_REVIEW_NOTE = 20
export const MIN_WAIVER_NOTE = 50

/** The hit types that cross sides (a client who is also the opposing party, or the reverse). */
const ROLE_CROSSING = new Set(["direct_adverse", "former_client", "adverse_history"])

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

/**
 * The read gate shared with getConflictResult, then clearance. Another firm's or a missing check,
 * or one the caller neither requested nor (as a partner) may read, is 404 not_found; a caller
 * cleared below the check's classification (an unknown label fails closed) is 403
 * exceeds_own_clearance. Runs before any state check, so state codes are no oracle.
 */
function gateCheck(caller: Caller, checkId: string, row: DocumentData | undefined): StoredCheck {
  if (!row || row.firmId !== caller.firmId || (row.requestedBy !== caller.uid && caller.role !== "partner")) {
    throw new HttpError(404, "not_found")
  }
  const check = storedCheck(checkId, row)
  if (!isKnownClassification(check.classification) || rankOf(check.classification) > rankOf(caller.clearanceLevel)) {
    throw new HttpError(403, "exceeds_own_clearance")
  }
  return check
}

/** The gated check, read inside `tx`. */
async function readCheck(tx: Transaction, caller: Caller, checkId: string): Promise<StoredCheck> {
  return gateCheck(caller, checkId, (await tx.get(checks().doc(checkId))).data())
}

/** The decided check as the caller may see it, once the transaction has committed. */
async function disclosed(caller: Caller, check: StoredCheck): Promise<DisclosedCheck> {
  return discloseFor(caller, check, await memberMatters(caller, matterIdsOf(check)))
}

function trailRow(caller: Caller, check: StoredCheck, kind: "review_resolved" | "waived", detail: Record<string, unknown>) {
  return {
    firmId: caller.firmId,
    checkId: check.checkId,
    kind,
    actorId: caller.uid,
    detail,
    classification: check.classification,
    createdAt: FieldValue.serverTimestamp(),
  }
}

/**
 * resolveReviewItem({ checkId, hitIndex, resolution: "different_person" | "same_person", note })
 * (P2-7). A hit still awaiting review is resolved by a partner or associate: `different_person`
 * → outcome NONE; `same_person` → FLAG with confirmed identity when the hit crosses sides, NONE
 * when it is an informational same-role hit. The result is recomputed with the match.ts
 * precedence; the check is cleared when it becomes CLEAR. Returns the disclosed check.
 */
export const resolveReviewItemOp: FirmOperation<DisclosedCheck> = {
  auth: "firm",
  kind: "general",
  action: "conflict.resolve_review",
  target: "conflict_checks",
  run: async ({ caller, now: clock }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "conflict.resolve_review")
    const checkId = data.checkId
    const { hitIndex, resolution } = data
    if (!isSafeDocId(checkId) || typeof hitIndex !== "number" || !Number.isInteger(hitIndex) || hitIndex < 0) {
      throw new HttpError(400, "invalid_query")
    }
    if (resolution !== "different_person" && resolution !== "same_person") throw new HttpError(400, "invalid_query")
    const note = text(data.note)
    audit.target = `conflict_checks/${checkId}`
    const at = new Date(clock ?? Date.now()).toISOString()

    const db = adminDb()
    const updated = await db.runTransaction(async (tx): Promise<StoredCheck> => {
      const check = await readCheck(tx, caller, checkId)
      if (check.boundMatterId !== null) throw new HttpError(409, "check_already_bound")
      const hit = check.hits[hitIndex]
      if (!hit || hit.outcome !== "POSSIBLE_CANDIDATE_REVIEW" || hit.review !== undefined) throw new HttpError(409, "not_review_item")
      if (note.length < MIN_REVIEW_NOTE) throw new HttpError(400, "note_too_short")

      const outcome: Hit["outcome"] = resolution === "same_person" && ROLE_CROSSING.has(hit.type) ? "FLAG" : "NONE"
      const resolved: Hit = {
        ...hit,
        outcome,
        ...(outcome === "FLAG" ? { identityBasis: "confirmed_identity" as const } : {}),
        review: { resolution, by: caller.uid, note, at },
      }
      const hits = check.hits.map((h, i) => (i === hitIndex ? resolved : h))
      const { result, identityBasis } = summarise(hits)
      const decision = result === "CLEAR" ? "cleared" : "pending"

      await audit.stage(tx, "allow", "ok")
      tx.update(checks().doc(checkId), plain({ hits, result, identityBasis, decision }))
      tx.create(db.collection("conflict_events").doc(), trailRow(caller, check, "review_resolved", { hitIndex, resolution, note, result, identityBasis }))
      return { ...check, hits, result, identityBasis, decision }
    })
    audit.committed()
    return disclosed(caller, updated)
  },
}

/**
 * recordPartnerWaiver({ checkId, note, clientConsent, consentReference }) (P2-8). A partner
 * waives a FLAG check once: no review item open, note of at least 50 characters, the client's
 * consent and its reference, and a clearance that covers the check. Immutable; the check
 * becomes cleared and `conflict.waived` is emitted. Returns the disclosed check.
 */
export const recordPartnerWaiverOp: FirmOperation<DisclosedCheck> = {
  auth: "firm",
  kind: "general",
  action: "conflict.waive",
  target: "conflict_checks",
  run: async ({ caller, now: clock }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "conflict.waive")
    const checkId = data.checkId
    if (!isSafeDocId(checkId)) throw new HttpError(400, "invalid_query")
    const note = text(data.note)
    const consentReference = text(data.consentReference)
    audit.target = `conflict_checks/${checkId}`
    const at = new Date(clock ?? Date.now()).toISOString()

    const db = adminDb()
    const updated = await db.runTransaction(async (tx): Promise<StoredCheck> => {
      const ref = checks().doc(checkId)
      const row = (await tx.get(ref)).data()
      const check = gateCheck(caller, checkId, row)
      if (check.boundMatterId !== null) throw new HttpError(409, "check_already_bound")
      if (row?.waiver !== undefined) throw new HttpError(409, "already_waived")
      if (check.result !== "FLAG") throw new HttpError(409, "not_waivable")
      if (check.hits.some((h) => h.outcome === "POSSIBLE_CANDIDATE_REVIEW" && h.review === undefined)) throw new HttpError(409, "review_pending")
      if (note.length < MIN_WAIVER_NOTE) throw new HttpError(400, "note_too_short")
      if (data.clientConsent !== true || consentReference === "") throw new HttpError(400, "consent_required")

      await audit.stage(tx, "allow", "ok")
      tx.update(ref, { waiver: { partnerId: caller.uid, note, clientConsent: true, consentReference, at }, decision: "cleared" })
      tx.create(db.collection("conflict_events").doc(), trailRow(caller, check, "waived", { partnerId: caller.uid, requestedBy: check.requestedBy, consentReference }))
      tx.create(db.collection("events").doc(`${checkId}_waived`), {
        name: "conflict.waived",
        firmId: caller.firmId,
        payload: { checkId, partnerId: caller.uid },
        classification: check.classification,
        occurredAt: FieldValue.serverTimestamp(),
        idempotencyKey: `${checkId}:waived`,
      })
      return { ...check, decision: "cleared" }
    })
    audit.committed()
    return disclosed(caller, updated)
  },
}

type TrailItem = { kind: string; actorId: string; detail: unknown; createdAt: string | null }

/**
 * getConflictTrail(?checkId=) (P2-8, P2-14) → the check's `conflict_events` rows, oldest first.
 * Same read gate as getConflictResult (requester or partner of the firm, else 404 not_found),
 * then clearance at least the check's classification (403 exceeds_own_clearance).
 */
export const getConflictTrailOp: FirmOperation<{ items: TrailItem[]; nextCursor: null }> = {
  auth: "firm",
  kind: "general",
  action: "conflict.read_trail",
  target: "conflict_checks",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "conflict.read_trail")
    const checkId = data.checkId
    if (!isSafeDocId(checkId)) throw new HttpError(400, "invalid_query")
    audit.target = `conflict_checks/${checkId}`
    const row = (await checks().doc(checkId).get()).data()
    gateCheck(caller, checkId, row)

    const snap = await adminDb().collection("conflict_events").where("firmId", "==", caller.firmId).where("checkId", "==", checkId).get()
    const millis = (d: DocumentData) => (d.createdAt instanceof Timestamp ? d.createdAt.toMillis() : 0)
    const items = snap.docs
      .map((d) => d.data())
      .sort((a, b) => millis(a) - millis(b))
      .map((d): TrailItem => ({
        kind: d.kind,
        actorId: d.actorId,
        detail: d.detail,
        createdAt: d.createdAt instanceof Timestamp ? d.createdAt.toDate().toISOString() : null,
      }))
    await audit.allow()
    return { items, nextCursor: null }
  },
}
