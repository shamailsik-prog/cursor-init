import type { DocumentData } from "firebase-admin/firestore"
import { HttpError } from "../http/errors"
import { isSafeDocId } from "../p5/common"
import { PARTNER_LINEAGE_MAX_DEPTH, partnerLineageParents } from "./partnerLineage"

/**
 * Audit FA-F42-R1-006-003-001: whether a partner counts as an independent partner for deletion
 * (outside lineage). Founders and legacy fixtures without provisioning parents are independent;
 * `createFirmUser` partners stay dependent until server attestation sets `independentPartner`.
 */
export function isIndependentPartner(user: DocumentData | undefined): boolean {
  if (!user || user.role !== "partner" || user.active === false) return false
  if (user.independentPartner === true) return true
  if (user.independentPartner === false) return false
  // Pre-register docs: no explicit flag — independent only when not provisioned under another user.
  const createdBy = user.createdBy
  const grantedBy = user.partnerGrantedBy
  const provisioned =
    (typeof createdBy === "string" && isSafeDocId(createdBy)) ||
    (typeof grantedBy === "string" && isSafeDocId(grantedBy))
  return !provisioned
}

/**
 * Refuses when either partner attested the other (`partnerAttestedBy`), symmetrically with the
 * direct `createdBy` / `partnerGrantedBy` checks in deletion approval.
 */
export function refusePartnerAttestationLinks(
  ids: { approver: string; requester: string },
  approver: DocumentData | undefined,
  requester: DocumentData | undefined
): void {
  if (ids.requester === "") return
  const approverAttestedBy = approver?.partnerAttestedBy
  const requesterAttestedBy = requester?.partnerAttestedBy
  if (typeof approverAttestedBy === "string" && approverAttestedBy === ids.requester) {
    throw new HttpError(403, "approver_attested_by_requester")
  }
  if (typeof requesterAttestedBy === "string" && requesterAttestedBy === ids.approver) {
    throw new HttpError(403, "requester_attested_by_approver")
  }
}

export function requireIndependentPartnerRegistration(
  user: DocumentData | undefined,
  side: "approver" | "requester"
): void {
  if (!isIndependentPartner(user)) {
    throw new HttpError(403, side === "approver" ? "approver_not_independent" : "requester_not_independent")
  }
}

/** Whether `target` was created or made partner directly by `provisionerUid`. */
export function isDirectlyProvisionedBy(provisionerUid: string, target: DocumentData | undefined): boolean {
  if (!target) return false
  const createdBy = target.createdBy
  const grantedBy = target.partnerGrantedBy
  return (
    (typeof createdBy === "string" && isSafeDocId(createdBy) && createdBy === provisionerUid) ||
    (typeof grantedBy === "string" && isSafeDocId(grantedBy) && grantedBy === provisionerUid)
  )
}

/** Whether `user` sits under `ancestorUid` on the provisioning graph (`createdBy` / `partnerGrantedBy`). */
export function isLineageDescendantOf(
  ancestorUid: string,
  user: DocumentData | undefined,
  loadUser: (uid: string) => DocumentData | undefined,
  maxDepth = PARTNER_LINEAGE_MAX_DEPTH
): boolean {
  if (!user || !isSafeDocId(ancestorUid)) return false
  const seen = new Set<string>()
  let frontier = partnerLineageParents(user)
  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth >= maxDepth) return false
    const next: string[] = []
    for (const uid of frontier) {
      if (seen.has(uid)) continue
      seen.add(uid)
      if (uid === ancestorUid) return true
      for (const p of partnerLineageParents(loadUser(uid))) {
        if (!seen.has(p)) next.push(p)
      }
    }
    frontier = next
  }
  return false
}

/**
 * FA-F42-R1-006-003-001-001-001: partners the attester provisioned, attested, or holds in their provisioning subtree
 * must not inflate `otherIndependentPartnerCount` for the sole-provisioned attestation decision.
 */
export function excludeFromOtherIndependentCountForSoleAttestation(
  attesterUid: string,
  peer: DocumentData | undefined,
  loadPeer: (uid: string) => DocumentData | undefined
): boolean {
  if (!peer) return true
  if (isDirectlyProvisionedBy(attesterUid, peer)) return true
  const attestedBy = peer.partnerAttestedBy
  if (typeof attestedBy === "string" && isSafeDocId(attestedBy) && attestedBy === attesterUid) return true
  return isLineageDescendantOf(attesterUid, peer, loadPeer)
}

export function countOtherIndependentPartnersForSoleProvisionedAttestation(
  attesterUid: string,
  activePartners: ReadonlyArray<{ id: string; data: DocumentData }>
): number {
  const loadPeer = (uid: string) => activePartners.find((p) => p.id === uid)?.data
  let count = 0
  for (const partner of activePartners) {
    if (partner.id === attesterUid) continue
    if (!isIndependentPartner(partner.data)) continue
    if (excludeFromOtherIndependentCountForSoleAttestation(attesterUid, partner.data, loadPeer)) continue
    count++
  }
  return count
}

export type PartnerUserDocLoader = (uid: string) => DocumentData | undefined

export type SoleProvisionedAttestationDecision =
  | { kind: "not_applicable" }
  | { kind: "refused"; code: "attestation_sole_independent_provisioned_refused" }
  | { kind: "allowed"; auditReason: "sole_independent_attested_provisioned_partner" }

/** Target is directly or transitively provisioned under `attesterUid` (006-003-001-001 / 006-003-001-001-001). */
export function isAttesterProvisionedAttestationTarget(
  attesterUid: string,
  target: DocumentData | undefined,
  loadUser: PartnerUserDocLoader
): boolean {
  return (
    isDirectlyProvisionedBy(attesterUid, target) || isLineageDescendantOf(attesterUid, target, loadUser)
  )
}

/**
 * FA-F42-R1-006-003-001-001: the sole independent partner attesting a partner they provisioned is either refused
 * (policy false) or explicitly allowed with a durable audit reason (policy true). Other independent partners in the
 * firm make this not the sole-independent case (006-003-001-001-001: count excludes attester puppets).
 */
export function decideSoleIndependentProvisionedAttestation(
  attesterUid: string,
  target: DocumentData | undefined,
  otherIndependentPartnerCount: number,
  allowByPolicy: boolean,
  loadUser: PartnerUserDocLoader = () => undefined
): SoleProvisionedAttestationDecision {
  if (!isAttesterProvisionedAttestationTarget(attesterUid, target, loadUser)) return { kind: "not_applicable" }
  if (otherIndependentPartnerCount > 0) return { kind: "not_applicable" }
  if (!allowByPolicy) return { kind: "refused", code: "attestation_sole_independent_provisioned_refused" }
  return { kind: "allowed", auditReason: "sole_independent_attested_provisioned_partner" }
}
