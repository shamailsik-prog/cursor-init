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
  if (tx) return stageAudit(row, tx)
  const ref = adminDb().collection("audit_log").doc()
  await ref.create({ ...row, occurredAt: FieldValue.serverTimestamp() })
  return ref.id
}

/**
 * Stages one audit_log row in `tx`, synchronously; returns its id. Any failure (an invalid value)
 * throws here, so the caller's transaction aborts instead of committing without its row.
 */
export function stageAudit(row: AuditRow, tx: Transaction): string {
  const ref = adminDb().collection("audit_log").doc()
  tx.create(ref, { ...row, occurredAt: FieldValue.serverTimestamp() })
  return ref.id
}
