import { Timestamp, type DocumentData, type Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { readMatterDocument } from "@/platform/d1/matterDocument"
import { MATTER_TOMBSTONES, isTombstoneFor } from "@/platform/retention/tombstone"
import { adminDb } from "../admin"
import { HttpError } from "../http/errors"
import type { Caller } from "../p5/auth"
import { isKnownClassification, rankOf } from "../p5/classification"
import { stageAudit } from "../p5/audit"
import { isSafeDocId, type CallAudit, type Data, type FirmOperation } from "../p5/common"
import { requirePermission } from "../p5/permission"
import { enqueueJob } from "../p2/enqueue"
import { RetentionConfigError, activePolicy, holdRefusal, inventory, planDeletion, type PlannedStore, type RetentionPolicy } from "./config"
import { PREPARE_JOB_TYPE, REASON_CODE, acksRef, holdsRef, requestsRef, type HoldRefusal } from "./model"

/**
 * Audit F42: the deletion protocol's routes (spec R4, R5, R9; `/api/platform/retention/*`).
 *
 * - requestMatterDeletion({ matterId, reasonCode }): a partner whose clearance reaches the matter's label opens a request.
 *   A legal hold (the matter's own, then the policy's) refuses it: the refusal is recorded on a `refused` request and in
 *   the audit log, and the answer is 200 with `status: "refused"`. One open request per matter: an in-progress one, or
 *   a pending one within its approval window, refuses a new one (409 `deletion_request_open`); a pending one past its
 *   window is expired in the same transaction (with its own audit row) and no longer blocks.
 * - approveMatterDeletion({ requestId }): a second partner (not the requester), within the approval window, approves.
 *   One transaction re-checks the holds, writes the tombstone, deletes every membership of the matter, fixes the plan on
 *   the request (`expected`, `plan`, `ackDeadlineAt`) and enqueues the saga's prepare job. Past the window the request
 *   is expired instead, recorded like a refusal: 200 with `status: "expired"`.
 * - getDeletionRequest(?requestId=): the request and its acknowledgements.
 * - placeLegalHold({ matterId, reasonCode }) / releaseLegalHold({ matterId }): any partner places a hold; a different
 *   partner releases it. A hold may be placed on a tombstoned matter, which halts its saga.
 *
 * Every retention action is partner-only firm administration in the shared P5 table; membership is not required, so
 * the routes keep working after the approval revoked it. Reason codes are short codes, never free text.
 */

const HOUR_MS = 3_600_000
const db = () => adminDb()
const matterRef = (id: string) => db().collection("matters").doc(id)
const tombRef = (id: string) => db().collection(MATTER_TOMBSTONES).doc(id)

function parseId(value: unknown, code: string): string {
  if (!isSafeDocId(value)) throw new HttpError(400, code)
  return value
}

function parseReason(value: unknown): string {
  if (typeof value !== "string" || !REASON_CODE.test(value)) throw new HttpError(400, "invalid_reason_code")
  return value
}

/** The partner's clearance must reach the label; an unreadable label is refused (fail closed). */
function requireCleared(caller: Caller, label: unknown): Classification {
  if (!isKnownClassification(label) || !isKnownClassification(caller.clearanceLevel) || rankOf(caller.clearanceLevel) < rankOf(label)) {
    throw new HttpError(403, "clearance")
  }
  return label
}

function loadPolicy(): { policy: RetentionPolicy; plan: PlannedStore[] } {
  try {
    const policy = activePolicy()
    return { policy, plan: planDeletion(policy, inventory()) }
  } catch (err) {
    if (err instanceof RetentionConfigError) throw new HttpError(503, "retention_policy_invalid")
    throw err
  }
}

const refusalOf = (code: HoldRefusal, at: Timestamp, by: string) => ({ code, at, by })

/**
 * Whether a request is pending past its approval window. Codex P2 (PR #128): such a request was once refused approval
 * yet left pending, so the open-request guard refused every new request for the matter for good. It now ends as
 * `expired`, a final status, the partner's call that finds it recording the expiry (`expiry`, refusal-shaped).
 */
function lapsed(req: DocumentData, nowMs: number, policy: RetentionPolicy): boolean {
  if (req.status !== "pending_approval") return false
  const requestedAt = req.requestedAt instanceof Timestamp ? req.requestedAt.toMillis() : 0
  return nowMs - requestedAt > policy.deletion.approvalWindowHours * HOUR_MS
}

const expiryOf = (at: Timestamp, by: string, supersededBy: string | null) => ({ status: "expired", expiry: { code: "approval_expired", at, by, supersededBy }, updatedAt: at })

/** Requests a matter may have open at once: one (this guard keeps it so); a few more are read to fail safe. */
const OPEN_SCAN = 5

/** Stages a refusal's audit row (a deny that commits a domain change: the refusal record). */
async function stageRefusalAudit(tx: Transaction, audit: CallAudit, code: HoldRefusal): Promise<void> {
  await audit.stage(tx, "deny", code, { effect: true })
}

export type RequestResult = { requestId: string; status: string; refusal: { code: string } | null; jobId?: string }

export const requestMatterDeletionOp: FirmOperation<RequestResult> = {
  auth: "firm",
  kind: "general",
  action: "retention.request_deletion",
  target: "deletion_requests",
  run: async ({ caller, now }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const matterId = parseId(data.matterId, "invalid_matter_id")
    const reasonCode = parseReason(data.reasonCode)
    audit.target = `matters/${matterId}`
    await requirePermission(caller, "retention.request_deletion")
    const { policy, plan } = loadPolicy()
    const nowMs = now ?? Date.now()
    const at = Timestamp.fromMillis(nowMs)
    const result = await db().runTransaction(async (tx) => {
      const [matterSnap, tombSnap, holdSnap] = await tx.getAll(matterRef(matterId), tombRef(matterId), holdsRef().doc(matterId))
      const open = await tx.get(
        requestsRef().where("firmId", "==", caller.firmId).where("matterId", "==", matterId).where("status", "in", ["pending_approval", "in_progress"]).limit(OPEN_SCAN)
      )
      if (isTombstoneFor(tombSnap.data(), caller.firmId, matterId)) throw new HttpError(409, "matter_deleted")
      const matter = readMatterDocument(matterSnap.data())
      if (!matter || matter.firmId !== caller.firmId) throw new HttpError(404, "not_found")
      const classification = requireCleared(caller, matter.classification)
      const expired = open.docs.filter((d) => lapsed(d.data(), nowMs, policy))
      if (expired.length < open.size) throw new HttpError(409, "deletion_request_open")
      const refusal = holdRefusal(policy, plan, holdSnap.data(), caller.firmId)
      const ref = requestsRef().doc()
      // Writes only from here. A lapsed request ends before the new one opens, each expiry with its own audit row.
      for (const d of expired) {
        const label: unknown = d.get("classification")
        tx.update(d.ref, expiryOf(at, caller.uid, ref.id))
        stageAudit({
          firmId: caller.firmId,
          actorId: caller.uid,
          action: "retention.request_expired",
          target: `deletion_requests/${d.id}`,
          classification: isKnownClassification(label) ? label : "privileged-restricted",
          decision: "deny",
          reason: "approval_expired",
        }, tx)
      }
      tx.create(ref, {
        requestId: ref.id,
        firmId: caller.firmId,
        matterId,
        classification,
        status: refusal ? "refused" : "pending_approval",
        reasonCode,
        requestedBy: caller.uid,
        requestedAt: at,
        approvedBy: null,
        approvedAt: null,
        refusal: refusal ? refusalOf(refusal, at, caller.uid) : null,
        halted: null,
        policyVersion: policy.policyVersion,
        expected: [],
        plan: {},
        acked: {},
        ackDeadlineAt: null,
        alertedAt: null,
        completedAt: null,
        updatedAt: at,
      })
      if (refusal) await stageRefusalAudit(tx, audit, refusal)
      else await audit.stage(tx, "allow", "ok")
      return { requestId: ref.id, status: refusal ? "refused" : "pending_approval", refusal: refusal ? { code: refusal } : null }
    })
    audit.committed()
    return result
  },
}

export const approveMatterDeletionOp: FirmOperation<RequestResult> = {
  auth: "firm",
  kind: "general",
  action: "retention.approve_deletion",
  target: "deletion_requests",
  run: async ({ caller, now }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const requestId = parseId(data.requestId, "invalid_request_id")
    audit.target = `deletion_requests/${requestId}`
    await requirePermission(caller, "retention.approve_deletion")
    const { policy, plan } = loadPolicy()
    const nowMs = now ?? Date.now()
    const at = Timestamp.fromMillis(nowMs)
    const result = await db().runTransaction(async (tx): Promise<RequestResult> => {
      const reqRef = requestsRef().doc(requestId)
      const req = (await tx.get(reqRef)).data()
      if (!req || req.firmId !== caller.firmId || typeof req.matterId !== "string") throw new HttpError(404, "not_found")
      const matterId = req.matterId
      const [matterSnap, tombSnap, holdSnap] = await tx.getAll(matterRef(matterId), tombRef(matterId), holdsRef().doc(matterId))
      const limit = policy.deletion.maxMembersRevokedAtApproval
      const members = await tx.get(db().collection("matter_members").where("firmId", "==", caller.firmId).where("matterId", "==", matterId).limit(limit + 1))
      if (req.status !== "pending_approval") throw new HttpError(409, "request_not_pending")
      if (req.requestedBy === caller.uid) throw new HttpError(403, "second_partner_required")
      const matter = readMatterDocument(matterSnap.data())
      requireCleared(caller, req.classification)
      if (matter) requireCleared(caller, matter.classification)
      if (lapsed(req, nowMs, policy)) {
        // Recorded like a refusal: the request ends, so it no longer holds the matter's one open request.
        tx.update(reqRef, expiryOf(at, caller.uid, null))
        await audit.stage(tx, "deny", "approval_expired", { effect: true })
        return { requestId, status: "expired", refusal: { code: "approval_expired" } }
      }
      if (isTombstoneFor(tombSnap.data(), caller.firmId, matterId)) throw new HttpError(409, "matter_deleted")
      if (!matter || matter.firmId !== caller.firmId) throw new HttpError(409, "matter_missing")
      if (members.size > limit) throw new HttpError(409, "matter_members_over_limit")
      const refusal = holdRefusal(policy, plan, holdSnap.data(), caller.firmId)
      if (refusal) {
        tx.update(reqRef, { status: "refused", refusal: refusalOf(refusal, at, caller.uid), updatedAt: at })
        await stageRefusalAudit(tx, audit, refusal)
        return { requestId, status: "refused", refusal: { code: refusal } }
      }
      // The last read: enqueue reads the job row before it creates it. Writes only after this.
      const job = await enqueueJob(
        tx,
        {
          firmId: caller.firmId,
          jobType: PREPARE_JOB_TYPE,
          classification: req.classification as Classification,
          matterId: null,
          payload: { requestId },
          idempotencyKey: `${requestId}:prepare`,
          createdBy: caller.uid,
        },
        { now: nowMs }
      )
      tx.create(tombRef(matterId), {
        firmId: caller.firmId,
        matterId,
        requestId,
        classification: req.classification,
        tombstonedAt: at,
        requestedBy: req.requestedBy,
        approvedBy: caller.uid,
        membersRevoked: members.size,
        policyVersion: policy.policyVersion,
        purgeCompletedAt: null,
      })
      for (const m of members.docs) tx.delete(m.ref)
      tx.update(reqRef, {
        status: "in_progress",
        approvedBy: caller.uid,
        approvedAt: at,
        policyVersion: policy.policyVersion,
        expected: plan.map((p) => p.key),
        plan: Object.fromEntries(plan.map((p) => [p.key, p.treatment])),
        ackDeadlineAt: Timestamp.fromMillis(nowMs + policy.deletion.ackDeadlineHours * HOUR_MS),
        groupSize: policy.deletion.storesPerPurgeJob,
        prepareJobId: job.jobId,
        updatedAt: at,
      })
      await audit.stage(tx, "allow", "ok")
      return { requestId, status: "in_progress", refusal: null, jobId: job.jobId }
    })
    audit.committed()
    return result
  },
}

type AckView = { storeId: string; outcome: string; count: number | null; idsSha256: string | null; detail: Record<string, unknown>; at: string | null }

const iso = (v: unknown): string | null => (v instanceof Timestamp ? v.toDate().toISOString() : null)

export const getDeletionRequestOp: FirmOperation<Record<string, unknown>> = {
  auth: "firm",
  kind: "general",
  action: "retention.read",
  target: "deletion_requests",
  run: async ({ caller }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const requestId = parseId(data.requestId, "invalid_request_id")
    audit.target = `deletion_requests/${requestId}`
    await requirePermission(caller, "retention.read")
    const req = (await requestsRef().doc(requestId).get()).data()
    if (!req || req.firmId !== caller.firmId) throw new HttpError(404, "not_found")
    requireCleared(caller, req.classification)
    const snap = await acksRef().where("firmId", "==", caller.firmId).where("requestId", "==", requestId).where("acknowledged", "==", true).get()
    const acks: AckView[] = snap.docs
      .map((d) => d.data())
      .map((a) => ({ storeId: a.storeId, outcome: a.outcome, count: a.count ?? null, idsSha256: a.idsSha256 ?? null, detail: (a.detail as Record<string, unknown>) ?? {}, at: iso(a.at) }))
      .sort((x, y) => (x.storeId < y.storeId ? -1 : 1))
    await audit.allow()
    return {
      requestId,
      matterId: req.matterId,
      status: req.status,
      reasonCode: req.reasonCode,
      requestedBy: req.requestedBy,
      requestedAt: iso(req.requestedAt),
      approvedBy: req.approvedBy ?? null,
      approvedAt: iso(req.approvedAt),
      refusal: req.refusal ? { code: req.refusal.code, by: req.refusal.by, at: iso(req.refusal.at) } : null,
      halted: req.halted ? { code: req.halted.code, at: iso(req.halted.at) } : null,
      policyVersion: req.policyVersion,
      expected: Array.isArray(req.expected) ? req.expected : [],
      acked: (req.acked as Record<string, string>) ?? {},
      ackDeadlineAt: iso(req.ackDeadlineAt),
      completedAt: iso(req.completedAt),
      acks,
    }
  },
}

/** Reads the matter (or its tombstone) and the hold in `tx`: the label a hold operation is judged against. */
async function holdSubject(tx: Transaction, caller: Caller, matterId: string): Promise<{ label: unknown; hold: DocumentData | undefined }> {
  const [matterSnap, tombSnap, holdSnap] = await tx.getAll(matterRef(matterId), tombRef(matterId), holdsRef().doc(matterId))
  const matter = readMatterDocument(matterSnap.data())
  const tomb = tombSnap.data()
  if (matter && matter.firmId === caller.firmId) return { label: matter.classification, hold: holdSnap.data() }
  if (isTombstoneFor(tomb, caller.firmId, matterId)) return { label: tomb?.classification, hold: holdSnap.data() }
  throw new HttpError(404, "not_found")
}

const holdView = (matterId: string, h: Record<string, unknown>) => ({
  matterId,
  active: h.active === true,
  reasonCode: h.reasonCode,
  placedBy: h.placedBy,
  placedAt: iso(h.placedAt),
  releasedBy: h.releasedBy ?? null,
  releasedAt: iso(h.releasedAt),
})

export const placeLegalHoldOp: FirmOperation<Record<string, unknown>> = {
  auth: "firm",
  kind: "general",
  action: "retention.hold.place",
  target: "legal_holds",
  run: async ({ caller, now }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const matterId = parseId(data.matterId, "invalid_matter_id")
    const reasonCode = parseReason(data.reasonCode)
    audit.target = `legal_holds/${matterId}`
    await requirePermission(caller, "retention.hold.place")
    const at = Timestamp.fromMillis(now ?? Date.now())
    const out = await db().runTransaction(async (tx) => {
      const { label, hold } = await holdSubject(tx, caller, matterId)
      requireCleared(caller, label)
      if (hold && hold.firmId === caller.firmId && hold.active === true) throw new HttpError(409, "legal_hold_exists")
      const row = { firmId: caller.firmId, matterId, active: true, reasonCode, placedBy: caller.uid, placedAt: at, releasedBy: null, releasedAt: null }
      tx.set(holdsRef().doc(matterId), row)
      await audit.stage(tx, "allow", "ok")
      return holdView(matterId, row)
    })
    audit.committed()
    return out
  },
}

export const releaseLegalHoldOp: FirmOperation<Record<string, unknown>> = {
  auth: "firm",
  kind: "general",
  action: "retention.hold.release",
  target: "legal_holds",
  run: async ({ caller, now }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const matterId = parseId(data.matterId, "invalid_matter_id")
    audit.target = `legal_holds/${matterId}`
    await requirePermission(caller, "retention.hold.release")
    const at = Timestamp.fromMillis(now ?? Date.now())
    const out = await db().runTransaction(async (tx) => {
      const { label, hold } = await holdSubject(tx, caller, matterId)
      const halted = await tx.get(requestsRef().where("firmId", "==", caller.firmId).where("matterId", "==", matterId).where("status", "==", "in_progress").limit(5))
      requireCleared(caller, label)
      if (!hold || hold.firmId !== caller.firmId || hold.active !== true) throw new HttpError(409, "no_active_hold")
      if (hold.placedBy === caller.uid) throw new HttpError(403, "second_partner_required")
      tx.update(holdsRef().doc(matterId), { active: false, releasedBy: caller.uid, releasedAt: at })
      // A saga the hold halted may resume: a partner retries its dead-lettered jobs (P3-12).
      for (const r of halted.docs) if (r.get("halted") !== null) tx.update(r.ref, { halted: null, updatedAt: at })
      await audit.stage(tx, "allow", "ok")
      return holdView(matterId, { ...hold, active: false, releasedBy: caller.uid, releasedAt: at })
    })
    audit.committed()
    return out
  },
}
