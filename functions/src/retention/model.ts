import { adminDb } from "../admin"

/**
 * Audit F42: the retention and deletion collections (spec section 4). Every one is server-only in firestore.rules and
 * holds ids, labels, codes, counts, timestamps and SHA-256 hashes, never content (spec R14). Each is inventoried in
 * infra/retention/inventory.json as class `audit_trail`: the trail of a deletion survives it.
 */

export { MATTER_TOMBSTONES as MATTER_TOMBSTONES_COLLECTION } from "@/platform/retention/tombstone"
export const DELETION_REQUESTS_COLLECTION = "deletion_requests"
export const DELETION_ACKS_COLLECTION = "deletion_acks"
export const LEGAL_HOLDS_COLLECTION = "legal_holds"
export const DELETION_EXTERNAL_REQUESTS_COLLECTION = "deletion_external_requests"
export const VAULT_OBJECT_TOMBSTONES_COLLECTION = "vault_object_tombstones"
export const RETENTION_RUNS_COLLECTION = "retention_runs"

export const requestsRef = () => adminDb().collection(DELETION_REQUESTS_COLLECTION)
export const acksRef = () => adminDb().collection(DELETION_ACKS_COLLECTION)
export const holdsRef = () => adminDb().collection(LEGAL_HOLDS_COLLECTION)

/** The P2 job types of the deletion saga (spec R7). Both are firm-level saga jobs. */
export const PREPARE_JOB_TYPE = "retention.matter.prepare"
export const PURGE_JOB_TYPE = "retention.store.purge"

export type RequestStatus = "pending_approval" | "refused" | "in_progress" | "completed"

/** What a store's acknowledgement says happened to the matter's copies in it (spec R8). */
export type AckOutcome = "purged" | "anonymised" | "retained" | "not_applicable" | "expiry" | "lock_pending" | "external_requested"

/** How the plan treats a store: decided at approval from the policy and the inventory, then fixed on the request. */
export type Treatment = "purge" | "anonymise" | "retained" | "not_applicable" | "expiry" | "lock" | "external"

/** A reason or refusal code: short, lower-case, never free text (no content enters the trail). */
export const REASON_CODE = /^[a-z][a-z0-9_]{2,63}$/

/** The refusal codes a legal hold produces (spec R9). */
export type HoldRefusal = "legal_hold_matter" | "legal_hold_policy"

/** `deletion_acks/{requestId}_{storeKey}`. */
export const ackDocId = (requestId: string, storeKey: string): string => `${requestId}_${storeKey}`
