import type { QueryDocumentSnapshot, Timestamp, Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { DELETION_EXTERNAL_REQUESTS_COLLECTION } from "./model"

/**
 * Audit F42 (FA-F42-R1-004, spec R24): a legal hold stops every remaining destructive step, instructions to third
 * parties included. A processor instruction (`deletion_external_requests/{requestId}_{processor}`, the summary row that
 * carries `status`; its parts carry ids only) is `pending_operator` (the operator may act on it) or `held` (a legal hold
 * on its matter stops it). Placing a hold, or a saga step that finds one, moves the matter's pending instructions to
 * `held`; releasing the hold moves them back.
 */

export type InstructionStatus = "pending_operator" | "held"

/** The matter's processor instructions in `status`, read in `tx` (a read: call it before the transaction's writes). */
export async function instructionsIn(tx: Transaction, firmId: string, matterId: string, status: InstructionStatus): Promise<QueryDocumentSnapshot[]> {
  const q = adminDb()
    .collection(DELETION_EXTERNAL_REQUESTS_COLLECTION)
    .where("firmId", "==", firmId)
    .where("matterId", "==", matterId)
    .where("status", "==", status)
  return (await tx.get(q)).docs
}

/** Moves `docs` (read by `instructionsIn`) to `to` in `tx`, stamping when. */
export function moveInstructions(tx: Transaction, docs: readonly QueryDocumentSnapshot[], to: InstructionStatus, at: Timestamp): void {
  for (const d of docs) tx.update(d.ref, { status: to, statusAt: at })
}
