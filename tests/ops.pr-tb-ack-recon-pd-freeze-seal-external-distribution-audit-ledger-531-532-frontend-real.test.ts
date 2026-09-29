import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const W503_CHECKPOINT =
  "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger"
const W503_RECORD =
  "record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_entry"
const W503_FINAL =
  "control_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_finalization"
const W504_REGISTER =
  "register_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_outbound_registry"
const W504_ATTEST =
  "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff"
const W504_FINAL =
  "control_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestation_finalization"

const REQUIRED_LIFECYCLE_STEPS_DISABLED = [
  "PR slice action: checkpoint custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation external distribution audit ledger digest on outbound registry attestation ledger",
  "PR slice action: record custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation external distribution audit ledger entry on outbound registry attestation ledger",
  "PR slice action: control custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation external distribution audit ledger finalization on outbound registry attestation ledger",
  "PR slice action: register closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff outbound registry on partner handoff attestation outbound registry attestation ledger",
  "PR slice action: attest closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff on partner handoff attestation outbound registry attestation ledger",
  "PR slice action: control closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation finalization on partner handoff attestation outbound registry attestation ledger",
] as const

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation external distribution audit ledger reconciliation closure seal verification on outbound registry attestation ledger (531)",
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement seal verification on partner handoff attestation outbound registry attestation ledger (532)",
] as const

const VIEW_530_STEP =
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement on partner handoff attestation outbound registry attestation ledger (530)"

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB ack-recon PD freeze seal external distribution audit ledger reconciliation + partner handoff attestation acknowledgement 531-532 frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 531-532 and all six lifecycle POSTs after 513-514 acknowledgment reconciliation", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    for (const step of REQUIRED_LIFECYCLE_STEPS_DISABLED) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain("custodyTbAckReconPdFreezeSeal531ExternalDistributionAuditLedgerReconciliationClosureSealVerificationView")
    expect(lattice).toContain("closureTbAckReconPdFreezeSeal532PartnerHandoffAttestationAcknowledgementSealVerificationView")
    expect(lattice).toContain(`action:\n            "${W503_CHECKPOINT}"`)
    expect(lattice).toContain(`action:\n            "${W503_RECORD}"`)
    expect(lattice).toContain(`action:\n            "${W503_FINAL}"`)
    expect(lattice).toContain(`action:\n            "${W504_REGISTER}"`)
    expect(lattice).toContain(`action:\n            "${W504_ATTEST}"`)
    expect(lattice).toContain(`action:\n            "${W504_FINAL}"`)
    expect(lattice).toContain("runApiCallAllowingStatuses(")
    expect(lattice).toContain(
      "blocked_todo_firm:transport_stub_tb_outbound_registry_seal_verifications_ack_reconciliation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_digest:ops_probe"
    )
    expect(lattice).toContain("blocked_todo_firm:transport_stub_partner_handoff_registry:ops_probe")
  })

  it("orders 531-532 views and lifecycle POSTs after 530 partner handoff attestation acknowledgement", () => {
    const lattice = latticeSourceSlice(source)
    const view530 = lattice.indexOf(VIEW_530_STEP)
    const view531 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view532 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const firstPost = lattice.lastIndexOf(REQUIRED_LIFECYCLE_STEPS_DISABLED[0])

    expect(view530).toBeGreaterThan(-1)
    expect(view531).toBeGreaterThan(view530)
    expect(view532).toBeGreaterThan(view531)
    expect(firstPost).toBeGreaterThan(view532)
  })
})
