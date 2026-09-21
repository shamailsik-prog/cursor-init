import { describe, expect, it } from "vitest"
import {
  buildWorkflowOpsChainedDocumentId,
  FIRESTORE_DOCUMENT_ID_MAX_UTF8_BYTES,
} from "@/platform/persistence/workflowOpsChainedDocumentId"

describe("buildWorkflowOpsChainedDocumentId", () => {
  it("returns logical ids when under the Firestore byte cap", () => {
    const id = buildWorkflowOpsChainedDocumentId("workflow_ops_alert:mat_1", "child")
    expect(id).toBe("workflow_ops_alert:mat_1:child")
  })

  it("hashes oversized logical keys to compact stable ids", () => {
    const kind =
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification"
    const parent = "x".repeat(1800)
    const logical = `${kind}:${parent}`
    expect(Buffer.byteLength(logical, "utf8")).toBeGreaterThan(FIRESTORE_DOCUMENT_ID_MAX_UTF8_BYTES)

    const first = buildWorkflowOpsChainedDocumentId(kind, parent)
    const second = buildWorkflowOpsChainedDocumentId(kind, parent)
    expect(first).toBe(second)
    expect(first.startsWith("woa:")).toBe(true)
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(200)
  })
})
