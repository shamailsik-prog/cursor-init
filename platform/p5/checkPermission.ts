import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import { recordOperationMatter } from "@/platform/retention/operationMatters"
import { rankOf, rankOfStoredOrMax, type Role, type SpineStore, type User } from "@/platform/spine/store"
import {
  ACCOUNTS_REGISTER_ACTIONS,
  decide as decideFromTable,
  type PermissionDecision,
} from "@/platform/p5/permissionDecision"

export { ACCOUNTS_REGISTER_ACTIONS, type PermissionDecision }

/**
 * P5 permission check (Layer 18 §4.5): "returns allow/deny with reason; logs to
 * auditPrivilegeAccess". The decision is the shared table in platform/p5/permissionDecision.ts,
 * the same one the Cloud Functions checkPermission evaluates (I-3 / U-2).
 * Every decision appends exactly one `permission_check` row to the
 * spine audit log. What "fail closed" means here, precisely:
 *   - if the in-process append throws, the decision is deny `audit_unavailable`;
 *   - the durable write happens when the request ends: `withSession` persists every row the
 *     request created through the audit repository before the response is returned, and
 *     answers 503 AUDIT_UNAVAILABLE if that fails. A read therefore never returns data whose
 *     access decision was not durably audited; a write whose effect already committed still
 *     gets 503 and is logged.
 * Awaiting the durable append *before* returning allow needs an async P5 — the true fix,
 * tracked as a follow-up (checkPermission is synchronous at ~225 call sites).
 */
export function checkPermission(
  store: SpineStore,
  userId: string,
  action: string,
  matterId?: string,
  extra?: { scope?: "own_matters" }
): PermissionDecision {
  // Audit F42 (FA-F42-R1-001, spec R21): the request's idempotent claims record the matter, so a later same-key replay
  // of the stored answer is refused once the matter is tombstoned.
  if (matterId !== undefined) recordOperationMatter(matterId)
  const decision = decide(store, userId, action, matterId, extra)
  try {
    appendPermissionAudit(store, userId, action, matterId, decision)
  } catch {
    return { allow: false, reason: "audit_unavailable" }
  }
  return decision
}

function appendPermissionAudit(
  store: SpineStore,
  userId: string,
  action: string,
  matterId: string | undefined,
  decision: PermissionDecision
): void {
  const user = store.users.get(userId)
  const matter = matterId ? store.matters.get(matterId) : undefined
  const classification: Classification = matter
    ? isClassification(matter.classification)
      ? matter.classification
      : "privileged-restricted"
    : "internal"
  store.audit.push({
    id: store.id("aud"),
    // A decision with no resolvable principal is still recorded (under the matter's firm
    // when known) so the write-through never drops it for want of a firm.
    firmId: user?.firmId ?? matter?.firmId ?? "_unresolved",
    at: Date.now(),
    action: "permission_check",
    actorId: userId,
    target: matterId ?? action,
    classification,
    reason: `${decision.allow ? "allow" : "deny"}:${action}:${decision.reason}`,
  })
}

/** The shared table (platform/p5/permissionDecision.ts) over the in-memory store. */
function decide(
  store: SpineStore,
  userId: string,
  action: string,
  matterId?: string,
  extra?: { scope?: "own_matters" }
): PermissionDecision {
  const user = store.users.get(userId)
  const matter = matterId ? (store.matters.get(matterId) ?? null) : undefined
  const isMember = matterId ? store.members.has(store.memberKey(matterId, userId)) : false
  return decideFromTable(user ?? null, action, matter, isMember, extra)
}

export function seedUser(
  store: SpineStore,
  user: User
): User {
  if (!isClassification(user.clearanceLevel)) {
    throw new PublicError("artefact write omitted classification")
  }
  store.users.set(user.id, user)
  return user
}

export function requireClearance(user: User, classification: Classification): boolean {
  // `classification` comes from a stored record (e.g. matter): unreadable → max.
  return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(classification)
}

export type { Role, User }
