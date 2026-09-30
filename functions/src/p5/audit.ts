import { FieldValue } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"

export type AuditRow = {
  firmId: string
  actorId: string
  action: string
  target: string
  classification: Classification
  decision: "allow" | "deny"
  reason: string
}

/** Appends one immutable audit_log row; resolves with its id. Rejects if the write fails. */
export async function appendAudit(row: AuditRow): Promise<string> {
  const ref = adminDb().collection("audit_log").doc()
  await ref.create({ ...row, occurredAt: FieldValue.serverTimestamp() })
  return ref.id
}
