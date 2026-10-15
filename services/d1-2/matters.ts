import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import type { Matter, SpineStore } from "@/platform/spine/store"
import { notifyAccounts } from "@/platform/p4/intimation"

export function createMatter(
  store: SpineStore,
  input: {
    firmId: string
    clientId: string
    title: string
    courtId: string
    classification: Classification
  }
) {
  if (!isClassification(input.classification)) {
    throw new PublicError("artefact write omitted classification")
  }
  const id = store.id("mat")
  store.matters.set(id, {
    id,
    firmId: input.firmId,
    clientId: input.clientId,
    title: input.title,
    courtId: input.courtId,
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "engagement_unconfirmed",
    classification: input.classification,
  })
  return store.matters.get(id)!
}

export function addMember(
  store: SpineStore,
  matterId: string,
  userId: string,
  firmId: string
) {
  const matter = store.matters.get(matterId)
  if (!matter) throw new PublicError("unknown matter")
  if (firmId !== matter.firmId) {
    throw new PublicError("cross-firm membership rejected")
  }
  const user = store.users.get(userId)
  if (!user) throw new PublicError("unknown user")
  if (user.firmId !== matter.firmId) {
    throw new PublicError("cross-firm membership rejected")
  }
  store.members.set(store.memberKey(matterId, userId), {
    matterId,
    userId,
    firmId: matter.firmId,
  })
}

/** Refused membership assignment (review R1 #6); carries a stable code and HTTP status. */
export class MembershipAssignmentError extends PublicError {
  constructor(
    readonly code: "self_assignment_forbidden" | "partner_required" | "not_member" | "assignee_role_forbidden",
    message: string
  ) {
    super(message)
    this.name = "MembershipAssignmentError"
  }
}

/**
 * R-2 "no matter access without membership, and no role is exempt": only a partner who is
 * already a member of the matter assigns another user, and nobody assigns themselves (a
 * non-member partner cannot self-assign into a matter). Initial membership of a new matter is
 * set by the matters API at creation, through the same `validateMatterAssignee` rule (the
 * creator seats themselves; the partner rule governs later assignment only). Mirrored by
 * firestore.rules matter_members create.
 *
 * Validation only, nothing cached (audit F14 R7): the matters route's add_member validates here, persists the
 * membership, and only then caches it (`cacheMember`) and audits it, so a member sync whose listing is read after the
 * membership is cached always lists it. (The former `assignMatterMember`, which cached without persisting, is removed:
 * audit F14 R8.)
 */
export function validateMatterAssignment(
  store: SpineStore,
  input: { actorId: string; matterId: string; userId: string }
): { matter: Matter; member: { matterId: string; userId: string; firmId: string } } {
  const actor = store.users.get(input.actorId)
  if (!actor) throw new PublicError("unknown actor")
  const matter = store.matters.get(input.matterId)
  if (!matter || matter.firmId !== actor.firmId) throw new PublicError("unknown matter")
  if (input.userId === actor.id) {
    throw new MembershipAssignmentError(
      "self_assignment_forbidden",
      "a user cannot assign themselves to a matter; a partner who is a member must add them"
    )
  }
  if (actor.role !== "partner") {
    throw new MembershipAssignmentError("partner_required", "only a partner assigns matter members")
  }
  if (!store.members.has(store.memberKey(input.matterId, actor.id))) {
    throw new MembershipAssignmentError("not_member", "only a member of the matter assigns its members")
  }
  validateMatterAssignee(store, matter.firmId, input.userId)
  return { matter, member: { matterId: input.matterId, userId: input.userId, firmId: matter.firmId } }
}

/**
 * Caches a membership that has been validated and persisted (audit F14 R7). Nothing here can fail after the write: the
 * checks `addMember` makes are made before it (`validateMatterAssignment`, or `validateMatterAssignee` at create).
 */
export function cacheMember(store: SpineStore, member: { matterId: string; userId: string; firmId: string }): void {
  store.members.set(store.memberKey(member.matterId, member.userId), { ...member })
}

/**
 * The assignee rule shared by matter create (`memberUserIds`) and `validateMatterAssignment`
 * (final audit F1). R2 N5: only same-firm matter staff are assigned. Clients reach their own
 * matters through matters.clientId (L8.1), and accounts is register-only (L17.6 #41). A
 * cross-firm user is reported exactly like a nonexistent one (no existence oracle).
 */
export function validateMatterAssignee(store: SpineStore, firmId: string, userId: string): void {
  const assignee = store.users.get(userId)
  if (!assignee || assignee.firmId !== firmId) throw new PublicError("unknown member user")
  if (assignee.role === "client" || assignee.role === "accounts") {
    throw new MembershipAssignmentError(
      "assignee_role_forbidden",
      "client and accounts users are not assigned to matters"
    )
  }
}

/** One `matter_member_add` audit row per seat granted (assignment and matter create alike). */
export function recordMatterMemberAdd(
  store: SpineStore,
  actorId: string,
  matter: { id: string; classification: Classification },
  userId: string
): void {
  store.audit.push({
    action: "matter_member_add",
    actorId,
    target: matter.id,
    classification: matter.classification,
    reason: `added ${userId}`,
  })
}

export function confirmEngagement(store: SpineStore, matterId: string, now = Date.now()) {
  const matter = store.matters.get(matterId)
  if (!matter) throw new PublicError("unknown matter")
  matter.status = "live"
  notifyAccounts(store, matterId, now)
}

export function listMattersForUser(store: SpineStore, userId: string) {
  const user = store.users.get(userId)
  if (!user) return []
  if (user.role === "client") {
    return [...store.matters.values()].filter(
      (m) => m.firmId === user.firmId && m.clientId === userId
    )
  }
  return [...store.matters.values()].filter(
    (m) =>
      m.firmId === user.firmId && store.members.has(store.memberKey(m.id, userId))
  )
}
