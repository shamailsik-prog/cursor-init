import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const TB_ACK_RECON_ATTEST_OUTBOUND_REGISTRY_PARTNER_HANDOFF_ACTION =
  "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff"

const TB_ACK_RECON_OUTBOUND_REGISTRY_FREEZE_OVERRIDE_CHECKPOINT_ACTION =
  "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_outbound_registry_freeze_override"

const TB_ACK_RECON_PARTNER_DELIVERY_FREEZE_OVERRIDE_SEAL_CHECKPOINT_ACTION =
  "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification"

const TB_ACK_RECON_PARTNER_DELIVERY_FREEZE_OVERRIDE_DIGEST_ACTION =
  "digest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_partner_delivery_receipt_freeze_override"

const TB_ACK_RECON_OUTBOUND_REGISTRY_ATTESTATION_LEDGER_SEAL_CONTROL_ACTION =
  "control_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_outbound_registry_attestation_ledger_seal"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon outbound-registry partner-delivery freeze-override seal verification (483)",
  "PR slice view: closure TB ack-recon outbound-registry partner-delivery freeze-override seal verification (484)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB partner-delivery freeze-override seal verification on PR #219 parents frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 483/484 and seal-verification POSTs after outbound-registry register", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconOutboundRegistryPartnerDeliveryFreezeOverrideSealVerificationView"
    )
    expect(lattice).toContain(
      "closureTbAckReconOutboundRegistryPartnerDeliveryFreezeOverrideSealVerificationView"
    )
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain(
      'step: "PR slice action: attest custody TB ack-recon outbound-registry partner handoff"'
    )
    expect(lattice).toContain(
      'step: "PR slice action: checkpoint custody TB ack-recon outbound-registry freeze override"'
    )
    expect(lattice).toContain(
      'step: "PR slice action: checkpoint custody TB ack-recon partner-delivery freeze-override seal verification"'
    )
    expect(lattice).toContain(
      'step: "PR slice action: digest closure TB ack-recon partner-delivery freeze override"'
    )
    expect(lattice).toContain(
      'step: "PR slice action: control closure TB ack-recon outbound-registry attestation ledger seal"'
    )
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_ATTEST_OUTBOUND_REGISTRY_PARTNER_HANDOFF_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_FREEZE_OVERRIDE_CHECKPOINT_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_PARTNER_DELIVERY_FREEZE_OVERRIDE_SEAL_CHECKPOINT_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_PARTNER_DELIVERY_FREEZE_OVERRIDE_DIGEST_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_ATTESTATION_LEDGER_SEAL_CONTROL_ACTION}"`
    )
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders seal-verification views and POSTs after outbound-registry attestation ledger register", () => {
    const lattice = latticeSourceSlice(source)
    const registerClosure = lattice.indexOf(
      'step: "PR slice action: register closure TB ack-recon outbound registry attestation ledger"'
    )
    const view483 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view484 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const attestHandoff = lattice.indexOf(
      'step: "PR slice action: attest custody TB ack-recon outbound-registry partner handoff"'
    )
    const sealCheckpoint = lattice.indexOf(
      'step: "PR slice action: checkpoint custody TB ack-recon partner-delivery freeze-override seal verification"'
    )
    const sealControl = lattice.indexOf(
      'step: "PR slice action: control closure TB ack-recon outbound-registry attestation ledger seal"'
    )

    expect(registerClosure).toBeGreaterThan(-1)
    expect(view483).toBeGreaterThan(registerClosure)
    expect(view484).toBeGreaterThan(view483)
    expect(attestHandoff).toBeGreaterThan(view484)
    expect(sealCheckpoint).toBeGreaterThan(attestHandoff)
    expect(sealControl).toBeGreaterThan(sealCheckpoint)
  })
})
