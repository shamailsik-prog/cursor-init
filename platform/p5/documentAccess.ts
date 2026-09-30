import { rankOf, rankOfStoredOrMax, type DocumentRecord, type SpineStore, type User } from "@/platform/spine/store"

/**
 * Document visibility for Next routes, which do not run through Firestore rules. Mirrors
 * firestore.rules `match /documents` read so the API is never looser than the rules:
 *   matter-bound  -> member of that matter (R-2), clearance >= document classification;
 *   loose vault   -> E-18 "clerk and partner roles, clearance ≥ confidential" (plus clearance
 *                    >= document classification);
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
  if (user.role === "accounts") return false
  if (user.firmId !== doc.firmId) return false
  if (rankOf(user.clearanceLevel) < rankOfStoredOrMax(doc.classification)) return false
  if (doc.matterId) return store.members.has(store.memberKey(doc.matterId, user.id))
  return canUseLooseVault(user)
}
