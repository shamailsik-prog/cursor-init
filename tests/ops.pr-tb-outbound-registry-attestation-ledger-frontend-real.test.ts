import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const TB_ACK_RECON_OUTBOUND_REGISTRY_PARTNER_HANDOFF_REGISTER_ACTION =
  "register_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_outbound_registry"

const TB_ACK_RECON_OUTBOUND_REGISTRY_ATTESTATION_LEDGER_REGISTER_ACTION =
  "register_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_outbound_registry"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon outbound-registry partner handoff attestation (481)",
  "PR slice view: closure TB ack-recon outbound registry attestation ledger (482)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB outbound registry attestation ledger on PR #217 parents frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB seal-verification lattice with GET views 481/482 and outbound-registry register POSTs after PR #217 ledger entry", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain("custodyTbAckReconExternalDistributionAuditLedgerPartnerHandoffAttestationView")
    expect(lattice).toContain("closureTbAckReconPartnerHandoffOutboundRegistryAttestationLedgerView")
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain(
      'step: "PR slice action: register custody TB ack-recon outbound-registry partner handoff attestation"'
    )
    expect(lattice).toContain(
      'step: "PR slice action: register closure TB ack-recon outbound registry attestation ledger"'
    )
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_PARTNER_HANDOFF_REGISTER_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_ATTESTATION_LEDGER_REGISTER_ACTION}"`
    )
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders outbound-registry views and POSTs after PR #217 external distribution audit ledger record entry", () => {
    const lattice = latticeSourceSlice(source)
    const record217 = lattice.indexOf(
      'step: "PR #217 action: record custody TB seal-verifications ack reconciliation external distribution audit ledger entry"'
    )
    const view481 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view482 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const registerCustody = lattice.indexOf(
      'step: "PR slice action: register custody TB ack-recon outbound-registry partner handoff attestation"'
    )
    const registerClosure = lattice.indexOf(
      'step: "PR slice action: register closure TB ack-recon outbound registry attestation ledger"'
    )

    expect(record217).toBeGreaterThan(-1)
    expect(view481).toBeGreaterThan(record217)
    expect(view482).toBeGreaterThan(view481)
    expect(registerCustody).toBeGreaterThan(view482)
    expect(registerClosure).toBeGreaterThan(registerCustody)
  })
})
