import type { DocumentData } from "firebase-admin/firestore"
import { HttpError } from "../http/errors"
import { isSafeDocId } from "../p5/common"

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

export type SoleProvisionedAttestationDecision =
  | { kind: "not_applicable" }
  | { kind: "refused"; code: "attestation_sole_independent_provisioned_refused" }
  | { kind: "allowed"; auditReason: "sole_independent_attested_provisioned_partner" }

/**
 * FA-F42-R1-006-003-001-001: the sole independent partner attesting a partner they provisioned is either refused
 * (policy false) or explicitly allowed with a durable audit reason (policy true). Other independent partners in the
 * firm make this not the sole-independent case.
 */
export function decideSoleIndependentProvisionedAttestation(
  attesterUid: string,
  target: DocumentData | undefined,
  otherIndependentPartnerCount: number,
  allowByPolicy: boolean
): SoleProvisionedAttestationDecision {
  if (!isDirectlyProvisionedBy(attesterUid, target)) return { kind: "not_applicable" }
  if (otherIndependentPartnerCount > 0) return { kind: "not_applicable" }
  if (!allowByPolicy) return { kind: "refused", code: "attestation_sole_independent_provisioned_refused" }
  return { kind: "allowed", auditReason: "sole_independent_attested_provisioned_partner" }
}
