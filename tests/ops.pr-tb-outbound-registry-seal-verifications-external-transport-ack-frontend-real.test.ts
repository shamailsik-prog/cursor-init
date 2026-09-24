import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_CHECKPOINT_ACTION =
  "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACKNOWLEDGE_ACTION =
  "acknowledge_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_FINALIZATION_ACTION =
  "control_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_finalization"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_DIGEST_ACTION =
  "checkpoint_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_digest"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_VARIANCE_ACKNOWLEDGE_ACTION =
  "acknowledge_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_VARIANCE_FINALIZATION_ACTION =
  "control_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_finalization"

const REQUIRED_LIFECYCLE_STEPS = [
  "PR slice action: checkpoint custody TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment",
  "PR slice action: acknowledge custody TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt",
  "PR slice action: control custody TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment finalization",
  "PR slice action: checkpoint closure TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment digest",
  "PR slice action: acknowledge closure TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt",
  "PR slice action: control closure TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment finalization",
] as const

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgments (487)",
  "PR slice view: closure TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgments (488)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB outbound-registry seal_verifications transport boundary external transport receipt acknowledgment frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 487-488 and all six lifecycle POSTs after 485/486 reconciliation", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    for (const step of REQUIRED_LIFECYCLE_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconOutboundRegistrySealVerificationsTransportBoundaryExternalTransportReceiptAcknowledgmentView"
    )
    expect(lattice).toContain(
      "closureTbAckReconOutboundRegistrySealVerificationsTransportBoundaryExternalTransportReceiptAcknowledgmentView"
    )
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_CHECKPOINT_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACKNOWLEDGE_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_FINALIZATION_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_DIGEST_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_VARIANCE_ACKNOWLEDGE_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_VARIANCE_FINALIZATION_ACTION}"`
    )
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders 487-488 views and lifecycle POSTs after 486 closure finalization", () => {
    const lattice = latticeSourceSlice(source)
    const closure486Finalization = lattice.indexOf(
      "PR slice action: control closure TB ack-recon outbound-registry seal verification transport boundary receipt reconciliation closure attestation finalization"
    )
    const view487 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view488 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const firstPost = lattice.indexOf(REQUIRED_LIFECYCLE_STEPS[0])

    expect(closure486Finalization).toBeGreaterThan(-1)
    expect(view487).toBeGreaterThan(closure486Finalization)
    expect(view488).toBeGreaterThan(view487)
    expect(firstPost).toBeGreaterThan(view488)
  })
})
