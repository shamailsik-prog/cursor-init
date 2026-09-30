import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import { rankOf, rankOfStoredOrMax, type Role, type SpineStore, type User } from "@/platform/spine/store"

export type PermissionDecision = {
  allow: boolean
  reason: string
}

/** The only actions the accounts role may take (L17.6: getIntimationRegister, recordAccountsEntry). */
export const ACCOUNTS_REGISTER_ACTIONS: ReadonlySet<string> = new Set([
  "intimation_register",
  "record_accounts_entry",
])

/**
 * P5 permission check (Layer 18 §4.5): "returns allow/deny with reason; logs to
 * auditPrivilegeAccess". Every decision appends exactly one `permission_check` row to the
 * spine audit log — the log the audit repository appends to and that routes write through
 * with persistAuditEntriesSince. If that append fails the decision is deny
 * `audit_unavailable` (fail closed): an unaudited allow is never returned.
 */
export function checkPermission(
  store: SpineStore,
  userId: string,
  action: string,
  matterId?: string,
  extra?: { scope?: "own_matters" }
): PermissionDecision {
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

function decide(
  store: SpineStore,
  userId: string,
  action: string,
  matterId?: string,
  extra?: { scope?: "own_matters" }
): PermissionDecision {
  const user = store.users.get(userId)
  if (!user) return { allow: false, reason: "no-user" }

  // L17.6 #41: "The accounts role is defined in L4.7 with read access to the intimation
  // register only — no matter documents." Membership does not widen it.
  if (user.role === "accounts") {
    if (!ACCOUNTS_REGISTER_ACTIONS.has(action)) {
      return { allow: false, reason: "accounts-register-only" }
    }
    if (matterId) {
      const matter = store.matters.get(matterId)
      if (!matter || matter.firmId !== user.firmId) return { allow: false, reason: "cross-firm" }
    }
    return { allow: true, reason: "accounts-register" }
  }

  if (user.role === "intern" && (action === "research" || action === "draft")) {
    return { allow: false, reason: "intern-channel-denied" }
  }

  if (extra?.scope === "own_matters" || user.role === "client") {
    if (action === "research" || action === "draft") {
      return { allow: false, reason: "client-channel-denied" }
    }
    if (action === "list_matters") {
      return { allow: true, reason: "client-own-matters" }
    }
  }

  if (action === "list_matters") {
    return { allow: true, reason: "ok" }
  }

  if (matterId) {
    const matter = store.matters.get(matterId)
    if (!matter || matter.firmId !== user.firmId) {
      return { allow: false, reason: "cross-firm" }
    }
    if (!store.members.has(store.memberKey(matterId, userId))) {
      return { allow: false, reason: "not-member" }
    }
    if (!requireClearance(user, matter.classification)) {
      return { allow: false, reason: "clearance" }
    }
  }

  if (action === "research" && user.role === "client") {
    return { allow: false, reason: "client-research-denied" }
  }

  return { allow: true, reason: "ok" }
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
