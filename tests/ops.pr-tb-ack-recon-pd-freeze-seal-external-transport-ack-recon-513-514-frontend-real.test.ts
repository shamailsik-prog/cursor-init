import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const W513_RECONCILE = "reconcile_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation"
const W513_DIGEST = "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_digest"
const W513_FINAL = "control_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_finalization"
const W514_DIGEST = "checkpoint_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_digest"
const W514_RECONCILE = "reconcile_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation"
const W514_FINAL = "control_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_finalization"

const REQUIRED_LIFECYCLE_STEPS = [
  "PR slice action: reconcile custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation on outbound registry attestation ledger",
  "PR slice action: checkpoint custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation digest on outbound registry attestation ledger",
  "PR slice action: control custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation finalization on outbound registry attestation ledger",
  "PR slice action: checkpoint closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation digest on partner handoff attestation outbound registry attestation ledger",
  "PR slice action: reconcile closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation on partner handoff attestation outbound registry attestation ledger",
  "PR slice action: control closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation finalization on partner handoff attestation outbound registry attestation ledger",
] as const

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation on outbound registry attestation ledger (513)",
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation on partner handoff attestation outbound registry attestation ledger (514)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB ack-recon PD freeze seal external transport receipt acknowledgment reconciliation frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 513-514 and all six lifecycle POSTs after 511/512 acknowledgment", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    for (const step of REQUIRED_LIFECYCLE_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconPdFreezeSeal513ExternalTransportReceiptAcknowledgmentReconciliationView"
    )
    expect(lattice).toContain(
      "closureTbAckReconPdFreezeSeal514ExternalTransportReceiptAcknowledgmentReconciliationView"
    )
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(`action:\n            "${W513_RECONCILE}"`)
    expect(lattice).toContain(`action:\n            "${W513_DIGEST}"`)
    expect(lattice).toContain(`action:\n            "${W513_FINAL}"`)
    expect(lattice).toContain(`action:\n            "${W514_DIGEST}"`)
    expect(lattice).toContain(`action:\n            "${W514_RECONCILE}"`)
    expect(lattice).toContain(`action:\n            "${W514_FINAL}"`)
    expect(lattice).toContain("runApiCallAllowingStatuses(")
    expect(lattice).toContain(
      "blocked_todo_firm:transport_stub_tb_ack_recon_pd_freeze_seal_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_digest:ops_probe"
    )
  })

  it("orders 513-514 views and lifecycle POSTs after 512 closure acknowledgment finalization", () => {
    const lattice = latticeSourceSlice(source)
    const view512 = lattice.indexOf(
      "PR slice view: closure TB ack-recon PD freeze seal partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgments on partner handoff attestation outbound registry attestation ledger (512)"
    )
    const closure512Finalization = lattice.indexOf(
      "PR slice action: control closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment finalization on partner handoff attestation outbound registry attestation ledger",
      view512
    )
    const view513 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view514 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const firstPost = lattice.indexOf(REQUIRED_LIFECYCLE_STEPS[0], view513)

    expect(closure512Finalization).toBeGreaterThan(-1)
    expect(view513).toBeGreaterThan(closure512Finalization)
    expect(view514).toBeGreaterThan(view513)
    expect(firstPost).toBeGreaterThan(view514)
  })
})
