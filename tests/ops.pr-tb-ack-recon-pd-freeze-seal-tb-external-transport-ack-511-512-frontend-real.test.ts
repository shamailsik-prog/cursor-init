import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_CHECKPOINT_ACTION =
  "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment"

const TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_ACKNOWLEDGE_ACTION =
  "acknowledge_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt"

const TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_FINALIZATION_ACTION =
  "control_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_finalization"

const TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_VARIANCE_DIGEST_ACTION =
  "checkpoint_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_digest"

const TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_VARIANCE_ACKNOWLEDGE_ACTION =
  "acknowledge_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt"

const TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_VARIANCE_FINALIZATION_ACTION =
  "control_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_finalization"

const REQUIRED_LIFECYCLE_STEPS = [
  "PR slice action: checkpoint custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment on outbound registry attestation ledger",
  "PR slice action: acknowledge custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt on outbound registry attestation ledger",
  "PR slice action: control custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment finalization on outbound registry attestation ledger",
  "PR slice action: checkpoint closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment digest on partner handoff attestation outbound registry attestation ledger",
  "PR slice action: acknowledge closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt on partner handoff attestation outbound registry attestation ledger",
  "PR slice action: control closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment finalization on partner handoff attestation outbound registry attestation ledger",
] as const

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon PD freeze seal partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgments on outbound registry attestation ledger (511)",
  "PR slice view: closure TB ack-recon PD freeze seal partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgments on partner handoff attestation outbound registry attestation ledger (512)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB ack-recon PD freeze seal transport-boundary receipt reconciliation external transport receipt acknowledgment frontend_real /ops call sites (511-512)", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 511-512 and all six lifecycle POSTs after 509/510 reconciliation", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    for (const step of REQUIRED_LIFECYCLE_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconPdFreezeSeal511ExternalTransportReceiptAcknowledgmentView"
    )
    expect(lattice).toContain(
      "closureTbAckReconPdFreezeSeal512ExternalTransportReceiptAcknowledgmentView"
    )
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_CHECKPOINT_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_ACKNOWLEDGE_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_FINALIZATION_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_VARIANCE_DIGEST_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_VARIANCE_ACKNOWLEDGE_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_PD_FREEZE_SEAL_TB_RECON_EXTERNAL_TRANSPORT_VARIANCE_FINALIZATION_ACTION}"`
    )
    expect(lattice).toContain("runApiCallAllowingStatuses(")
    expect(lattice).toContain(
      "blocked_todo_firm:transport_stub_tb_ack_recon_pd_freeze_seal_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment:ops_probe"
    )
  })

  it("orders 511-512 views and lifecycle POSTs after 510 closure finalization", () => {
    const lattice = latticeSourceSlice(source)
    const closure510Finalization = lattice.lastIndexOf(
      "PR slice action: control closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation closure attestation finalization on partner handoff attestation outbound registry attestation ledger"
    )
    const view511 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view512 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const firstPost = lattice.lastIndexOf(`step: "${REQUIRED_LIFECYCLE_STEPS[0]}"`)

    expect(closure510Finalization).toBeGreaterThan(-1)
    expect(view511).toBeGreaterThan(closure510Finalization)
    expect(view512).toBeGreaterThan(view511)
    expect(firstPost).toBeGreaterThan(view512)
  })
})
