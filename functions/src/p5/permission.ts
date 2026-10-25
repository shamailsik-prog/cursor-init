import type { Classification } from "@/platform/p1/types"
import {
  decide,
  type AiAction,
  type AlertAction,
  type D1Action,
  type DocTypeAction,
  type DraftAction,
  type FirmAdminAction,
  type JobAction,
  type PermissionDecision,
  type RetentionAction,
} from "@/platform/p5/permissionDecision"
import { MATTER_TOMBSTONES, isTombstoneFor } from "@/platform/retention/tombstone"
import { adminDb } from "../admin"
import { HttpError } from "../http/errors"
import { appendAudit } from "./audit"
import type { Caller } from "./auth"
import { isKnownClassification } from "./classification"

export type { PermissionDecision }

type Evaluation = PermissionDecision & { classification: Classification }

/**
 * P5 permission check (Layer 18 §4.5) for Cloud Functions: the shared decision table
 * (platform/p5/permissionDecision.ts — the same one the Next.js checkPermission evaluates,
 * I-3 / U-2) over matters/{id} and matter_members/{matterId}_{uid} read from Firestore, with the
 * matter's tombstone (matter_tombstones/{id}, audit F42: a deleted matter is refused `matter-deleted`).
 * Fails closed: a malformed matterId denies with "invalid-matter-id", a read error denies with
 * "store-unavailable", and an action no row of the table knows denies with "unknown-action" (the
 * table's default, FA-F43-R1-P01; this file has no default of its own); every decision is audited
 * (one audit_log row: action, decision, reason), and if the audit write fails the result is deny
 * "audit_unavailable".
 */
export async function checkPermission(
  caller: Caller,
  action: string,
  matterId?: string,
  extra?: { scope?: "own_matters" }
): Promise<PermissionDecision> {
  let evaluation: Evaluation
  try {
    evaluation =
      matterId !== undefined && !isValidMatterId(matterId)
        ? { allow: false, reason: "invalid-matter-id", classification: "internal" }
        : await evaluate(caller, action, matterId, extra)
  } catch {
    evaluation = { allow: false, reason: "store-unavailable", classification: "internal" }
  }

  try {
    await appendAudit({
      firmId: caller.firmId,
      actorId: caller.uid,
      action,
      target: matterId !== undefined ? `matters/${matterId}` : `firms/${caller.firmId}`,
      classification: evaluation.classification,
      decision: evaluation.allow ? "allow" : "deny",
      reason: evaluation.reason,
    })
  } catch {
    return { allow: false, reason: "audit_unavailable" }
  }
  return { allow: evaluation.allow, reason: evaluation.reason }
}

/**
 * Authorises a firm-administration action (identity and MFA administration: partner only), a D1 action (matter-level ones take the matterId), a job action (P3-11; job.read takes an optional matterId),
 * an AI action (P3-70, P3-71, P3-66; ai.call takes the matterId), a D4 draft action (P4-10; every one takes the matterId)
 * or doctype.read (firm-level)
 * through checkPermission, so it is decided by the shared table and audited like every other
 * decision. Deny → 403 partner_only (the operations' existing error code) or 403 with the
 * table's reason (`unknown_action` for an action no row knows, FA-F43-R1-P01); an audit failure →
 * 503 audit_unavailable. The operations keep their own extra guards (self-change, clearance
 * cap, last partner).
 */
export async function requirePermission(
  caller: Caller,
  action: FirmAdminAction | D1Action | JobAction | AiAction | DraftAction | DocTypeAction | RetentionAction | AlertAction,
  matterId?: string
): Promise<void> {
  const decision = await checkPermission(caller, action, matterId)
  if (decision.allow) return
  if (decision.reason === "audit_unavailable") throw new HttpError(503, "audit_unavailable")
  throw new HttpError(403, decision.reason === "partner-only" ? "partner_only" : decision.reason.replaceAll("-", "_"))
}

/** A single Firestore document id: non-empty, no "/", not "." / "..", not reserved `__*__`. */
function isValidMatterId(id: string): boolean {
  return id !== "" && !id.includes("/") && id !== "." && id !== ".." && !/^__.*__$/.test(id)
}

async function evaluate(
  caller: Caller,
  action: string,
  matterId: string | undefined,
  extra: { scope?: "own_matters" } | undefined
): Promise<Evaluation> {
  let matter: { firmId: string; classification: unknown; deleted?: boolean } | null | undefined
  let isMember = false
  if (matterId) {
    const db = adminDb()
    // Audit F42: the matter's tombstone is read with it. A tombstone of the caller's firm refuses the matter
    // (`matter-deleted`), also once the saga has purged the matter row itself.
    const [matterSnap, tombSnap] = await Promise.all([
      db.collection("matters").doc(matterId).get(),
      db.collection(MATTER_TOMBSTONES).doc(matterId).get(),
    ])
    const data = matterSnap.data()
    const deleted = isTombstoneFor(tombSnap.data(), caller.firmId, matterId)
    matter = data
      ? { firmId: data.firmId as string, classification: data.classification, deleted }
      : deleted
        ? { firmId: caller.firmId, classification: tombSnap.data()?.classification, deleted }
        : null
    if (matter && matter.firmId === caller.firmId && !deleted) {
      isMember = (await db.collection("matter_members").doc(`${matterId}_${caller.uid}`).get()).exists
    }
  }
  const decision = decide(caller, action, matter, isMember, extra)
  // The audit row carries the matter's classification once the matter is known to be in the
  // caller's firm (an unreadable one as the highest rank), otherwise "internal".
  const classification: Classification =
    matter && matter.firmId === caller.firmId
      ? isKnownClassification(matter.classification)
        ? matter.classification
        : "privileged-restricted"
      : "internal"
  return { ...decision, classification }
}
