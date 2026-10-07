import { checkPermission } from "@/platform/p5/checkPermission"
import { rankOf, rankOfStoredOrMax, type SpineStore, type User } from "@/platform/spine/store"
import type { Classification } from "@/platform/p1/types"

/**
 * Review round 2, N6: filing-escalation closure rows are per-owner digests whose packageIds
 * span several matters (and carry free-text notes). R-2: a row is visible only to a partner who
 * may access *every* referenced package's matter and is cleared for each package — never to
 * someone who can see just one of them. A row with no packages is partner-only.
 */
export function closureRowVisible(
  store: SpineStore,
  user: Pick<User, "id" | "role" | "clearanceLevel">,
  packageIds: readonly string[],
  lookup: (packageId: string) => { matterId: string; classification: Classification } | undefined
): boolean {
  if (user.role !== "partner") return false
  return packageIds.every((packageId) => {
    const filingPackage = lookup(packageId)
    if (!filingPackage) return false
    if (!checkPermission(store, user.id, "draft", filingPackage.matterId).allow) return false
    return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(filingPackage.classification)
  })
}
