import { rankOf, rankOfStoredOrMax, type DocumentRecord, type SpineStore, type User } from "@/platform/spine/store"

/**
 * Document visibility for Next routes, which do not run through Firestore rules. Mirrors
 * firestore.rules `match /documents` read so the API is never looser than the rules:
 *   matter-bound  -> member of that matter (R-2), clearance >= document classification, and
 *                    clearance >= the matter's CURRENT classification (audit F14 / O-76: a matter
 *                    raised after the document was written binds it too; a matter that is missing
 *                    or another firm's denies). Routes refresh the store's matters first
 *                    (syncFirmMatters) so "current" is the persisted label, not a stale copy;
 *   loose vault   -> E-18 "clerk and partner roles, clearance ≥ confidential" (plus clearance
 *                    >= document classification), for an explicit `matterId === null` only, as the
 *                    rules' `matterId != null` test (Copilot C2). Rows reach the routes cast, not
 *                    validated, so any other value fails closed: a missing field denies (the rules
 *                    error on it), and "" or any other string names a matter that must exist;
 *   accounts      -> never (L17.6 #41 "no matter documents").
 */
export function canUseLooseVault(user: Pick<User, "role" | "clearanceLevel">): boolean {
  return (
    (user.role === "clerk" || user.role === "partner") &&
    rankOf(user.clearanceLevel) >= rankOf("confidential")
  )
}

export function canReadDocument(
  store: SpineStore,
  user: User,
  doc: Pick<DocumentRecord, "firmId" | "classification" | "matterId">
): boolean {
  // L17.6 #41 (accounts) and R2 N5 (clients read no matter documents; same as the rules).
  if (user.role === "accounts" || user.role === "client") return false
  if (user.firmId !== doc.firmId) return false
  if (rankOf(user.clearanceLevel) < rankOfStoredOrMax(doc.classification)) return false
  const matterId: unknown = doc.matterId
  if (matterId === null) return canUseLooseVault(user)
  if (typeof matterId !== "string") return false
  const matter = store.matters.get(matterId)
  if (!matter || matter.firmId !== doc.firmId) return false
  // An unreadable matter label ranks as the most restrictive (fail closed).
  if (rankOf(user.clearanceLevel) < rankOfStoredOrMax(matter.classification)) return false
  return store.members.has(store.memberKey(matterId, user.id))
}
