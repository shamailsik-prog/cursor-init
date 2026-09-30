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

export function checkPermission(
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
