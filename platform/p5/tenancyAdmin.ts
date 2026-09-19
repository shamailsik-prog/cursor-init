import { isClassification, type Classification } from "@/platform/p1/types"
import { rankOf, type Role, type SpineStore, type User } from "@/platform/spine/store"

function requirePartnerInFirm(store: SpineStore, actorId: string, firmId: string): User {
  const actor = store.users.get(actorId)
  if (!actor) throw new Error("unknown actor")
  if (actor.firmId !== firmId) throw new Error("cross-firm actor denied")
  if (actor.role !== "partner") throw new Error("partner role required")
  return actor
}

export function buildSessionContext(
  store: SpineStore,
  userId: string,
  firmId?: string
): {
  user: User
  firmId: string
  accessibleMatterIds: string[]
} {
  const user = store.users.get(userId)
  if (!user) throw new Error("unknown user")
  if (firmId && firmId !== user.firmId) throw new Error("firm scope mismatch")
  const accessibleMatterIds =
    user.role === "client"
      ? [...store.matters.values()]
          .filter((matter) => matter.firmId === user.firmId && matter.clientId === user.id)
          .map((matter) => matter.id)
      : [...store.members.values()]
          .filter((member) => member.userId === user.id && member.firmId === user.firmId)
          .map((member) => member.matterId)
  return {
    user,
    firmId: user.firmId,
    accessibleMatterIds: [...new Set(accessibleMatterIds)].sort(),
  }
}

export function listFirmUsers(
  store: SpineStore,
  actorId: string,
  firmId: string,
  limit: number,
  cursor: number
): {
  items: Array<{
    id: string
    role: Role
    clearanceLevel: Classification
  }>
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const users = [...store.users.values()]
    .filter((user) => user.firmId === firmId)
    .sort((a, b) => a.id.localeCompare(b.id))
  const page = users.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < users.length ? String(cursor + page.length) : null
  return {
    items: page.map((user) => ({
      id: user.id,
      role: user.role,
      clearanceLevel: user.clearanceLevel,
    })),
    total: users.length,
    nextCursor,
  }
}

export function listFirmMemberships(
  store: SpineStore,
  actorId: string,
  firmId: string,
  matterId: string | undefined,
  limit: number,
  cursor: number
): {
  items: Array<{ matterId: string; userId: string; firmId: string }>
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const memberships = [...store.members.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) => (matterId ? row.matterId === matterId : true))
    .sort((a, b) =>
      a.matterId === b.matterId
        ? a.userId.localeCompare(b.userId)
        : a.matterId.localeCompare(b.matterId)
    )
  const page = memberships.slice(cursor, cursor + limit)
  const nextCursor =
    cursor + page.length < memberships.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: memberships.length,
    nextCursor,
  }
}

export function listFirmAudit(
  store: SpineStore,
  actorId: string,
  firmId: string,
  limit: number,
  cursor: number
): {
  items: Array<{
    id: string
    action: string
    actorId: string
    target: string
    classification: Classification
    reason?: string
    at: number
  }>
  total: number
  nextCursor: string | null
} {
  const actor = requirePartnerInFirm(store, actorId, firmId)
  const rows = store.audit
    .filter((entry) => entry.firmId === firmId)
    .filter((entry) => rankOf(entry.classification) <= rankOf(actor.clearanceLevel))
    .map((entry) => ({
      id: entry.id ?? "",
      action: entry.action,
      actorId: entry.actorId,
      target: entry.target,
      classification: entry.classification,
      reason: entry.reason,
      at: entry.at ?? 0,
    }))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: rows.length,
    nextCursor,
  }
}

export function updateUserRole(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    targetUserId: string
    nextRole: Role
    nextClearance: Classification
    reason?: string
  }
): { user: User; auditEntry: NonNullable<SpineStore["audit"][number]> } {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const target = store.users.get(input.targetUserId)
  if (!target) throw new Error("unknown target user")
  if (target.firmId !== input.firmId) throw new Error("cross-firm target denied")
  if (!isClassification(input.nextClearance)) {
    throw new Error("nextClearance must be a rank-0–4 label")
  }
  if (input.nextRole === "partner" && target.role !== "partner") {
    throw new Error("partner promotion is blocked in this surface")
  }
  if (rankOf(input.nextClearance) > rankOf(actor.clearanceLevel)) {
    throw new Error("cannot assign clearance above actor level")
  }
  if (input.nextRole === "client" && rankOf(input.nextClearance) > rankOf("internal")) {
    throw new Error("client clearance may not exceed internal")
  }
  target.role = input.nextRole
  target.clearanceLevel = input.nextClearance
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_update_role",
    actorId: actor.id,
    target: target.id,
    classification: target.clearanceLevel,
    reason: input.reason,
    at: Date.now(),
  } as const
  store.audit.push(auditEntry)
  return { user: target, auditEntry }
}
