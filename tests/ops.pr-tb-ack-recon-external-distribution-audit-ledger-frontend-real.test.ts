import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const TB_ACK_RECON_SEAL_VERIFICATIONS_EXTERNAL_DISTRIBUTION_AUDIT_LEDGER_RECORD_ENTRY_ACTION =
  "record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_entry"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon outbound-registry seal_verifications ack reconciliation external distribution audit ledger (491)",
  "PR slice view: closure TB ack-recon outbound-registry seal_verifications ack reconciliation partner handoff attestation (492)",
] as const

const GET_VIEW_491_PARENT =
  "alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers"

const GET_VIEW_492_PARENT =
  "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations"

const GET_VIEW_493_CHILD_SUFFIX = "_outbound_registry_attestation_ledgers"
const GET_VIEW_494_CHILD_SUFFIX = "_outbound_registry_attestation_ledgers"

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("PR slice TB ack-recon external distribution audit ledger on seal_verifications reconciled parents frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB outbound-registry seal_verifications lattice with GET views 491/492 and ledger record POST after reconciliation POSTs", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconOutboundRegistrySealVerificationsAckReconciliationExternalDistributionAuditLedgerView"
    )
    expect(lattice).toContain(
      "closureTbAckReconOutboundRegistrySealVerificationsAckReconciliationPartnerHandoffAttestationView"
    )
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain(
      'step: "PR slice action: record custody TB ack-recon outbound-registry seal_verifications ack reconciliation external distribution audit ledger entry"'
    )
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_SEAL_VERIFICATIONS_EXTERNAL_DISTRIBUTION_AUDIT_LEDGER_RECORD_ENTRY_ACTION}"`
    )
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders PR slice views and ledger POST after seal_verifications ack reconciliation control POSTs", () => {
    const lattice = latticeSourceSlice(source)
    const finalizeClosure = lattice.indexOf(
      'step: "PR slice action: control closure TB ack-recon outbound-registry seal_verifications transport boundary external transport receipt acknowledgment reconciliation finalization"'
    )
    const view491 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view492 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const recordEntry = lattice.indexOf(
      'step: "PR slice action: record custody TB ack-recon outbound-registry seal_verifications ack reconciliation external distribution audit ledger entry"'
    )

    expect(finalizeClosure).toBeGreaterThan(-1)
    expect(view491).toBeGreaterThan(finalizeClosure)
    expect(view492).toBeGreaterThan(view491)
    expect(recordEntry).toBeGreaterThan(view492)
  })

  it("GET 491 /ops call site wires the parent external_distribution_audit_ledgers view (not the 493 child suffix)", () => {
    const lattice = latticeSourceSlice(source)
    expect(lattice).toContain(
      "custodyTbAckReconOutboundRegistrySealVerificationsAckReconciliationExternalDistributionAuditLedgerView"
    )
    expect(lattice).toContain(GET_VIEW_491_PARENT)
    expect(GET_VIEW_491_PARENT.endsWith(GET_VIEW_493_CHILD_SUFFIX)).toBe(false)
    expect(lattice).toContain(
      "transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus"
    )
  })

  it("GET 492 /ops call site wires the parent partner_handoff_attestations view (not the 494 child suffix)", () => {
    const lattice = latticeSourceSlice(source)
    expect(lattice).toContain(`view: closureTbAckReconOutboundRegistrySealVerificationsAckReconciliationPartnerHandoffAttestationView`)
    expect(lattice).toContain(GET_VIEW_492_PARENT)
    expect(GET_VIEW_492_PARENT.endsWith(GET_VIEW_494_CHILD_SUFFIX)).toBe(false)
    expect(lattice).toContain(
      `ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus`
    )
  })
})
