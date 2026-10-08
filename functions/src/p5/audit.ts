import { FieldValue, type Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"

export type AuditRow = {
  firmId: string
  actorId: string
  /** The user a system actor acts for (P3-18: a job's creator, a uid or "system"). */
  onBehalfOf?: string
  action: string
  target: string
  classification: Classification
  decision: "allow" | "deny"
  reason: string
}

/**
 * Appends one immutable audit_log row; resolves with its id. Rejects if the write fails.
 * With `tx`, the row is written as part of that transaction (committed atomically with it).
 */
export async function appendAudit(row: AuditRow, tx?: Transaction): Promise<string> {
  const ref = adminDb().collection("audit_log").doc()
  const data = { ...row, occurredAt: FieldValue.serverTimestamp() }
  if (tx) tx.create(ref, data)
  else await ref.create(data)
  return ref.id
}
