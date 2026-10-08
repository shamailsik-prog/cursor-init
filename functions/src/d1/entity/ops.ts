import { FieldValue, Timestamp, type DocumentData, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import type { Caller } from "../../p5/auth"
import { isSafeDocId, type CallAudit, type Data, type FirmOperation } from "../../p5/common"
import { knownOrHighest } from "../conflict/engine"
import { bumpRegistryVersion } from "../registryVersion"
import { DETERMINISTIC_KEY_SCORE, effectiveLinkState } from "./linkState"
import { readPair, type Pair } from "./pair"
import { gate } from "./read"
import { entityKeys, type EntityKeys } from "./summary"

/**
 * The decision routes of the L17.2 entity review (spec P2-24..P2-28, P2-34, P2-35, P2-39):
 * confirmMerge, disputeLink, rejectLink. Each takes `{ linkId, note }` (any row of the pair) and
 * decides the whole entity pair in one transaction: permission → L17.2 gate → body → transaction
 * (readPair: the 404 gate) → state checks → writes of EVERY key row of the pair + the call's audit
 * row. State codes are decided only after the 404 gate, so they are no existence oracle. Rows keep
 * one classification across the pair: the pair label (max of rows, entities, clients), never lower.
 */

/** Every decision note is at least this long after trim (P2-35). */
export const MIN_ENTITY_NOTE = 20

export type DecisionResult = {
  pairId: string
  linkIds: string[]
  state: "confirmed" | "rejected" | "candidate"
  disputed: boolean
  mergeEventId: string | null
  classification: string
}

type Body = { linkId: string; note: string }

/** `{ linkId, note }`: linkId a safe doc id and note a string (400 invalid_query); note ≥ 20 chars after trim (400 note_too_short). */
function parseBody(data: Data): Body {
  const { linkId, note } = data
  if (!isSafeDocId(linkId) || typeof note !== "string") throw new HttpError(400, "invalid_query")
  const trimmed = note.trim()
  if (trimmed.length < MIN_ENTITY_NOTE) throw new HttpError(400, "note_too_short")
  return { linkId, note: trimmed }
}

const notCandidate = (pair: Pair) => pair.rows.some((r) => r.data.state !== "candidate")
const anyDisputed = (pair: Pair) => pair.rows.some((r) => r.data.disputed === true)
const linkIdsOf = (pair: Pair) => pair.rows.map((r) => r.ref.id).sort()

type Decide = (tx: Transaction, pair: Pair, actor: { by: string; role: Caller["role"]; at: Timestamp; note: string }) => DecisionResult

/**
 * Shared run: the gate, the body, then one transaction that reads the pair and lets `decide`
 * check the state and stage the writes; the audit row is staged in the same transaction.
 */
async function runDecision(
  action: "entity.confirm" | "entity.dispute" | "entity.reject",
  caller: Caller,
  clock: number | undefined,
  data: Data,
  audit: CallAudit,
  decide: Decide
): Promise<DecisionResult> {
  audit.firmId = caller.firmId
  audit.target = `firms/${caller.firmId}`
  await gate(caller, action)
  const { linkId, note } = parseBody(data)
  audit.target = `entity_links/${linkId}`
  const at = Timestamp.fromMillis(clock ?? Date.now())
  const result = await adminDb().runTransaction(async (tx) => {
    const pair = await readPair(tx, caller, linkId)
    const out = decide(tx, pair, { by: caller.uid, role: caller.role, at, note })
    // Every decision changes the pair's effective link state, which the conflict screen reads.
    bumpRegistryVersion(tx, caller.firmId)
    await audit.stage(tx, "allow", "ok")
    return out
  })
  audit.committed()
  return result
}

const ENTITY_FIELD = { cnic: "cnic", ntn: "ntn", secp: "secpNumber", phone: "phone" } as const

type EntitySnap = { entityId: string; canonicalName: string; cnic?: string; ntn?: string; secpNumber?: string; phone?: string; classification: string }

/** The pre-merge snapshot of an entity (P2-24): its name, keys and label. */
function snapOf(entityId: string, row: DocumentData): EntitySnap {
  const keys = entityKeys(row)
  const snap: EntitySnap = { entityId, canonicalName: typeof row.canonicalName === "string" ? row.canonicalName : "", classification: knownOrHighest(row.classification) }
  for (const [key, field] of Object.entries(ENTITY_FIELD) as Array<[keyof EntityKeys, keyof EntitySnap]>) {
    const value = keys[key]
    if (value !== undefined) (snap as Record<string, unknown>)[field] = value
  }
  return snap
}

/**
 * The prior effective state of a pair being confirmed: `disputed` if any row is disputed, else
 * `auto_confirmed` if every row has auto-confirmed, else `candidate`.
 */
function priorStateOf(pair: Pair, nowMs: number): "candidate" | "auto_confirmed" | "disputed" {
  if (anyDisputed(pair)) return "disputed"
  return pair.rows.every((r) => effectiveLinkState(r.data, nowMs, true) === "auto_confirmed") ? "auto_confirmed" : "candidate"
}

/**
 * confirmMerge({ linkId, note }) → DecisionResult (P2-24, P2-26, P2-27). Every row of the pair must
 * be a candidate (409 link_not_candidate); a disputed pair is partner-only (403 role_not_permitted,
 * decided here because the permission table cannot see link state). Writes one immutable
 * `merge_events` row (who, when, evidence with the matched key values, score, priorState, the
 * pre-merge snapshot of both entities), sets every row confirmed with its `confirmation`
 * (`disputed` / `dispute` kept as they are), and emits `entity.confirmed`.
 */
export const confirmMergeOp: FirmOperation<DecisionResult> = {
  auth: "firm",
  kind: "general",
  action: "entity.confirm",
  target: "entity_links",
  run: async ({ caller, now: clock }, data, audit) =>
    runDecision("entity.confirm", caller, clock, data, audit, (tx, pair, actor) => {
      if (notCandidate(pair)) throw new HttpError(409, "link_not_candidate")
      const disputed = anyDisputed(pair)
      if (disputed && caller.role !== "partner") throw new HttpError(403, "role_not_permitted")

      const db = adminDb()
      const mergeRef = db.collection("merge_events").doc()
      const keys = [...new Set(pair.rows.map((r) => String(r.data.key)))].sort()
      const leftKeys = entityKeys(pair.left)
      const keyValues: Record<string, string> = {}
      for (const key of keys) {
        const value = leftKeys[key as keyof EntityKeys]
        if (value !== undefined) keyValues[key] = value
      }
      const linkIds = linkIdsOf(pair)
      tx.create(mergeRef, {
        firmId: caller.firmId,
        kind: "link_confirmed",
        leftId: pair.a,
        rightId: pair.b,
        pairId: pair.pairId,
        linkIds,
        keys,
        evidence: { note: actor.note, keyValues },
        score: DETERMINISTIC_KEY_SCORE,
        basis: "deterministic_key",
        priorState: priorStateOf(pair, actor.at.toMillis()),
        actorId: actor.by,
        actorRole: actor.role,
        confirmedAt: actor.at,
        createdAt: FieldValue.serverTimestamp(),
        snapshot: { left: snapOf(pair.a, pair.left), right: snapOf(pair.b, pair.right) },
        reverted: false,
        classification: pair.label,
      })
      const confirmation = { by: actor.by, role: actor.role, at: actor.at, note: actor.note, mergeEventId: mergeRef.id }
      for (const r of pair.rows) tx.update(r.ref, { state: "confirmed", confirmation, classification: pair.label })
      tx.create(db.collection("events").doc(`${mergeRef.id}_confirmed`), {
        name: "entity.confirmed",
        firmId: caller.firmId,
        payload: { entityIds: [pair.a, pair.b], mergeEventId: mergeRef.id, score: DETERMINISTIC_KEY_SCORE },
        classification: pair.label,
        occurredAt: FieldValue.serverTimestamp(),
        idempotencyKey: `${mergeRef.id}:confirmed`,
      })
      return { pairId: pair.pairId, linkIds, state: "confirmed", disputed, mergeEventId: mergeRef.id, classification: pair.label }
    }),
}

/**
 * disputeLink({ linkId, note }) → DecisionResult (P2-26, P2-28). Every row must be a candidate
 * (409 link_not_candidate) and not yet disputed (409 already_disputed); allowed after day 30 (a
 * late dispute re-opens an auto-confirmed pair). Sets `disputed: true` and `dispute` on every row.
 * No event (P2-33).
 */
export const disputeLinkOp: FirmOperation<DecisionResult> = {
  auth: "firm",
  kind: "general",
  action: "entity.dispute",
  target: "entity_links",
  run: async ({ caller, now: clock }, data, audit) =>
    runDecision("entity.dispute", caller, clock, data, audit, (tx, pair, actor) => {
      if (notCandidate(pair)) throw new HttpError(409, "link_not_candidate")
      if (anyDisputed(pair)) throw new HttpError(409, "already_disputed")
      const dispute = { by: actor.by, role: actor.role, at: actor.at, note: actor.note }
      for (const r of pair.rows) tx.update(r.ref, { disputed: true, dispute, classification: pair.label })
      return { pairId: pair.pairId, linkIds: linkIdsOf(pair), state: "candidate", disputed: true, mergeEventId: null, classification: pair.label }
    }),
}

/**
 * rejectLink({ linkId, note }) → DecisionResult (P2-26, P2-27; partner only by the permission
 * table). Every row must be a candidate (409 link_not_candidate), disputed or not; sets
 * `state: "rejected"` and `rejection` on every row. Terminal in 2b-A. No event (P2-33).
 */
export const rejectLinkOp: FirmOperation<DecisionResult> = {
  auth: "firm",
  kind: "general",
  action: "entity.reject",
  target: "entity_links",
  run: async ({ caller, now: clock }, data, audit) =>
    runDecision("entity.reject", caller, clock, data, audit, (tx, pair, actor) => {
      if (notCandidate(pair)) throw new HttpError(409, "link_not_candidate")
      const rejection = { by: actor.by, role: actor.role, at: actor.at, note: actor.note }
      for (const r of pair.rows) tx.update(r.ref, { state: "rejected", rejection, classification: pair.label })
      return { pairId: pair.pairId, linkIds: linkIdsOf(pair), state: "rejected", disputed: anyDisputed(pair), mergeEventId: null, classification: pair.label }
    }),
}
