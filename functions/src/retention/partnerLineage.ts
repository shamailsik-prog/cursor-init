import type { DocumentData } from "firebase-admin/firestore"
import { isSafeDocId } from "../p5/common"
import { HttpError } from "../http/errors"

/** Max hops along `createdBy` / `partnerGrantedBy` toward the founder (fail closed beyond this). */
export const PARTNER_LINEAGE_MAX_DEPTH = 32

export type PartnerUserLoader = (uid: string) => Promise<DocumentData | undefined>

/** Parent uids on the provisioning graph (account creator and partner grantor). */
export function partnerLineageParents(user: DocumentData | undefined): string[] {
  const out: string[] = []
  const createdBy = user?.createdBy
  const grantedBy = user?.partnerGrantedBy
  if (typeof createdBy === "string" && isSafeDocId(createdBy)) out.push(createdBy)
  if (typeof grantedBy === "string" && isSafeDocId(grantedBy) && grantedBy !== createdBy) out.push(grantedBy)
  return out
}

/**
 * Every ancestor of `startUid` along `createdBy` and `partnerGrantedBy`, depth-capped. `null` on cycle or depth
 * overflow (fail closed).
 */
export async function partnerLineageAncestors(
  startUid: string,
  load: PartnerUserLoader,
  maxDepth = PARTNER_LINEAGE_MAX_DEPTH
): Promise<Set<string> | null> {
  if (!isSafeDocId(startUid)) return null
  const ancestors = new Set<string>()
  const seen = new Set<string>([startUid])
  let frontier = partnerLineageParents(await load(startUid))
  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth >= maxDepth) return null
    const next: string[] = []
    for (const uid of frontier) {
      if (seen.has(uid)) return null
      seen.add(uid)
      ancestors.add(uid)
      for (const p of partnerLineageParents(await load(uid))) {
        if (seen.has(p)) return null
        if (!ancestors.has(p)) next.push(p)
      }
    }
    frontier = next
  }
  return ancestors
}

/** True when both ancestor sets share at least one provisioning parent (sibling or cousin under the same founder). */
export function partnerLineageSharesProvisioningAncestor(approverAncestors: Set<string>, requesterAncestors: Set<string>): boolean {
  for (const uid of approverAncestors) {
    if (requesterAncestors.has(uid)) return true
  }
  return false
}

/**
 * Audit F42 (FA-F42-R1-006-001): refuse when either partner is an ancestor of the other on the provisioning graph
 * (transitive `createdBy` / `partnerGrantedBy`). One-hop cases remain the caller's direct checks for specific codes.
 *
 * Audit F42 (FA-F42-R1-006-003): refuse when both partners share any common provisioning ancestor (including the same
 * direct `createdBy` / `partnerGrantedBy`), so puppet siblings minted by one founder cannot approve each other.
 */
export async function refusePartnerLineage(
  ids: { approver: string; requester: string },
  load: PartnerUserLoader
): Promise<void> {
  if (ids.requester === "") return
  const [approverAncestors, requesterAncestors] = await Promise.all([
    partnerLineageAncestors(ids.approver, load),
    partnerLineageAncestors(ids.requester, load),
  ])
  if (approverAncestors === null) throw new HttpError(403, "approver_lineage_unknown")
  if (requesterAncestors === null) throw new HttpError(403, "requester_lineage_unknown")
  if (approverAncestors.has(ids.requester)) throw new HttpError(403, "approver_lineage_of_requester")
  if (requesterAncestors.has(ids.approver)) throw new HttpError(403, "requester_lineage_of_approver")
  if (partnerLineageSharesProvisioningAncestor(approverAncestors, requesterAncestors)) {
    throw new HttpError(403, "partners_shared_provisioning_ancestor")
  }
}

export const partnerLineageInternals = {
  partnerLineageParents,
  partnerLineageAncestors,
  partnerLineageSharesProvisioningAncestor,
  refusePartnerLineage,
}
