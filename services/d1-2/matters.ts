import type { Classification } from "@/platform/p1/types"
import type { SpineStore } from "@/platform/spine/store"
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
  store.members.set(store.memberKey(matterId, userId), { matterId, userId, firmId })
}

export function confirmEngagement(store: SpineStore, matterId: string, now = Date.now()) {
  const matter = store.matters.get(matterId)
  if (!matter) throw new Error("unknown matter")
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
  return [...store.matters.values()].filter((m) =>
    store.members.has(store.memberKey(m.id, userId))
  )
}
