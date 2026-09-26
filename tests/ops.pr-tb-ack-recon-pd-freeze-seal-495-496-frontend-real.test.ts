import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const CUSTODY_CHECKPOINT_ACTION =
  "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verification"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon outbound-registry seal_verifications partner-delivery receipt freeze-override seal verification on outbound registry attestation ledger (495)",
  "PR slice view: closure TB ack-recon outbound-registry seal_verifications partner-delivery receipt freeze-override seal verification on partner handoff attestation outbound registry attestation ledger (496)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("PR slice TB ack-recon partner-delivery receipt freeze-override seal verification on outbound registry attestation ledger 493/494 parents frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB outbound-registry seal_verifications lattice with GET views 495/496 and lifecycle POSTs after 493/494 block", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconOutboundRegistrySealVerificationsAckReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationView"
    )
    expect(lattice).toContain(
      "closureTbAckReconOutboundRegistrySealVerificationsAckReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationView"
    )
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain(
      'step: "PR slice action: checkpoint custody TB ack-recon outbound-registry seal_verifications partner-delivery receipt freeze-override seal verification on outbound registry attestation ledger"'
    )
    expect(lattice).toContain(`"${CUSTODY_CHECKPOINT_ACTION}"`)
    expect(lattice).toContain(
      "blocked_todo_firm:transport_stub_tb_outbound_registry_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification:ops_probe"
    )
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders PR slice 495/496 views and POSTs after 493/494 control POSTs", () => {
    const lattice = latticeSourceSlice(source)
    const control494 = lattice.indexOf(
      'step: "PR slice action: control closure TB ack-recon outbound-registry seal_verifications partner handoff attestation outbound registry attestation ledger seal"'
    )
    const view495 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view496 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const custodyCheckpoint495 = lattice.indexOf(
      'step: "PR slice action: checkpoint custody TB ack-recon outbound-registry seal_verifications partner-delivery receipt freeze-override seal verification on outbound registry attestation ledger"'
    )

    expect(control494).toBeGreaterThan(-1)
    expect(view495).toBeGreaterThan(control494)
    expect(view496).toBeGreaterThan(view495)
    expect(custodyCheckpoint495).toBeGreaterThan(view496)
  })
})
