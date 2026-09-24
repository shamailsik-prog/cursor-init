import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_RECONCILE_ACTION =
  "reconcile_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_DIGEST_ACTION =
  "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_digest"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_FINALIZATION_ACTION =
  "control_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_finalization"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_VARIANCE_DIGEST_ACTION =
  "checkpoint_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_digest"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_VARIANCE_RECONCILE_ACTION =
  "reconcile_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_VARIANCE_FINALIZATION_ACTION =
  "control_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_finalization"

const REQUIRED_LIFECYCLE_STEPS = [
  "PR slice action: reconcile custody TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment reconciliation",
  "PR slice action: checkpoint custody TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment reconciliation digest",
  "PR slice action: control custody TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment reconciliation finalization",
  "PR slice action: checkpoint closure TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment reconciliation digest",
  "PR slice action: reconcile closure TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment reconciliation",
  "PR slice action: control closure TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment reconciliation finalization",
] as const

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment reconciliation (489)",
  "PR slice view: closure TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment reconciliation (490)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB outbound-registry seal_verifications transport boundary external transport receipt acknowledgment reconciliation frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 489-490 and all six lifecycle POSTs after 487/488 acknowledgment", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    for (const step of REQUIRED_LIFECYCLE_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconOutboundRegistrySealVerificationsTransportBoundaryExternalTransportReceiptAcknowledgmentReconciliationView"
    )
    expect(lattice).toContain(
      "closureTbAckReconOutboundRegistrySealVerificationsTransportBoundaryExternalTransportReceiptAcknowledgmentReconciliationView"
    )
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_RECONCILE_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_DIGEST_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_FINALIZATION_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_VARIANCE_DIGEST_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_VARIANCE_RECONCILE_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_VARIANCE_FINALIZATION_ACTION}"`
    )
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders 489-490 views and lifecycle POSTs after 488 closure acknowledgment finalization", () => {
    const lattice = latticeSourceSlice(source)
    const closure488Finalization = lattice.indexOf(
      "PR slice action: control closure TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment finalization"
    )
    const view489 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view490 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const firstPost = lattice.indexOf(REQUIRED_LIFECYCLE_STEPS[0])

    expect(closure488Finalization).toBeGreaterThan(-1)
    expect(view489).toBeGreaterThan(closure488Finalization)
    expect(view490).toBeGreaterThan(view489)
    expect(firstPost).toBeGreaterThan(view490)
  })
})
