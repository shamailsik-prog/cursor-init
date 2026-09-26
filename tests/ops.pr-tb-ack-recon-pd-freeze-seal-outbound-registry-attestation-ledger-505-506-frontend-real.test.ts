import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const W505_CHECKPOINT = "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger"
const W505_DIGEST = "digest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override"
const W505_SEAL = "control_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_seal"
const W506_CHECKPOINT = "checkpoint_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledger"
const W506_DIGEST = "digest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override"
const W506_SEAL = "control_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledger_seal"

const REQUIRED_LIFECYCLE_STEPS = [
  "PR slice action: checkpoint custody TB ack-recon PD freeze seal outbound registry attestation ledger",
  "PR slice action: digest custody TB ack-recon PD freeze seal outbound registry attestation ledger partner delivery receipt freeze override",
  "PR slice action: control custody TB ack-recon PD freeze seal outbound registry attestation ledger seal",
  "PR slice action: checkpoint closure TB ack-recon PD freeze seal partner handoff attestation outbound registry attestation ledger",
  "PR slice action: digest closure TB ack-recon PD freeze seal partner handoff attestation outbound registry attestation ledger partner delivery receipt freeze override",
  "PR slice action: control closure TB ack-recon PD freeze seal partner handoff attestation outbound registry attestation ledger seal",
] as const

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon PD freeze seal outbound registry attestation ledger on external distribution audit ledger (505)",
  "PR slice view: closure TB ack-recon PD freeze seal partner handoff attestation outbound registry attestation ledger (506)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB ack-recon PD freeze seal outbound registry attestation ledger 505-506 frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 505-506 and all six lifecycle POSTs after 503-504 block", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    for (const step of REQUIRED_LIFECYCLE_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain("custodyTbAckReconPdFreezeSeal505OutboundRegistryAttestationLedgerView")
    expect(lattice).toContain("closureTbAckReconPdFreezeSeal506PartnerHandoffAttestationOutboundRegistryAttestationLedgerView")
    expect(lattice).toContain(`"${W505_CHECKPOINT}"`)
    expect(lattice).toContain(`"${W505_DIGEST}"`)
    expect(lattice).toContain(`"${W505_SEAL}"`)
    expect(lattice).toContain(`"${W506_CHECKPOINT}"`)
    expect(lattice).toContain(`"${W506_DIGEST}"`)
    expect(lattice).toContain(`"${W506_SEAL}"`)
    expect(lattice).toContain("blocked_todo_firm:transport_stub_tb_ack_recon_pd_freeze_seal_outbound_registry_attestation_ledger:ops_probe")
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders 505-506 views and lifecycle POSTs after 504 partner handoff attestation finalization", () => {
    const lattice = latticeSourceSlice(source)
    const closure504Finalization = lattice.indexOf(
      "PR slice action: control closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation finalization on partner handoff attestation outbound registry attestation ledger"
    )
    const view505 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view506 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const firstPost = lattice.indexOf(REQUIRED_LIFECYCLE_STEPS[0])

    expect(closure504Finalization).toBeGreaterThan(-1)
    expect(view505).toBeGreaterThan(closure504Finalization)
    expect(view506).toBeGreaterThan(view505)
    expect(firstPost).toBeGreaterThan(view506)
  })
})
