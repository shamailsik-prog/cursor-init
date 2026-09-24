import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const CUSTODY_CHECKPOINT_ACTION =
  "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers_outbound_registry_attestation_ledger"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon outbound-registry seal_verifications ack reconciliation external distribution audit ledger outbound registry attestation ledger (493)",
  "PR slice view: closure TB ack-recon outbound-registry seal_verifications ack reconciliation partner handoff attestation outbound registry attestation ledger (494)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("PR slice TB ack-recon outbound registry attestation ledger on seal_verifications 491/492 parents frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB outbound-registry seal_verifications lattice with GET views 493/494 and lifecycle POSTs after 491/492 block", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconOutboundRegistrySealVerificationsAckReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerView"
    )
    expect(lattice).toContain(
      "closureTbAckReconOutboundRegistrySealVerificationsAckReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerView"
    )
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain(
      'step: "PR slice action: checkpoint custody TB ack-recon outbound-registry seal_verifications external distribution audit ledger outbound registry attestation ledger"'
    )
    expect(lattice).toContain(`"${CUSTODY_CHECKPOINT_ACTION}"`)
    expect(lattice).toContain("blocked_todo_firm:transport_stub_tb_outbound_registry_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger:ops_probe")
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders PR slice 493/494 views and POSTs after 491/492 control POSTs", () => {
    const lattice = latticeSourceSlice(source)
    const control492 = lattice.indexOf(
      'step: "PR slice action: control closure TB ack-recon outbound-registry seal_verifications ack reconciliation partner handoff attestation finalization"'
    )
    const view493 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view494 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const custodyCheckpoint493 = lattice.indexOf(
      'step: "PR slice action: checkpoint custody TB ack-recon outbound-registry seal_verifications external distribution audit ledger outbound registry attestation ledger"'
    )

    expect(control492).toBeGreaterThan(-1)
    expect(view493).toBeGreaterThan(control492)
    expect(view494).toBeGreaterThan(view493)
    expect(custodyCheckpoint493).toBeGreaterThan(view494)
  })
})
