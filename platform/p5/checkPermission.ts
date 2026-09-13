import type { Classification } from "@/platform/p1/types"
import { rankOf, type Role, type SpineStore, type User } from "@/platform/spine/store"

export type PermissionDecision = {
  allow: boolean
  reason: string
}

export function checkPermission(
  store: SpineStore,
  userId: string,
  action: string,
  matterId?: string,
  extra?: { scope?: "own_matters" }
): PermissionDecision {
  const user = store.users.get(userId)
  if (!user) return { allow: false, reason: "no-user" }

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
  store.users.set(user.id, user)
  return user
}

export function requireClearance(user: User, classification: Classification): boolean {
  return rankOf(user.clearanceLevel) >= rankOf(classification)
}

export type { Role, User }
