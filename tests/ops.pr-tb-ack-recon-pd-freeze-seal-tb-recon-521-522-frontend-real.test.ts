import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const CUSTODY_RECONCILE_ACTION =
  "reconcile_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon PD freeze seal partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliations on outbound registry attestation ledger (521)",
  "PR slice view: closure TB ack-recon PD freeze seal partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliations on partner handoff attestation outbound registry attestation ledger (522)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("PR slice TB ack-recon PD freeze seal partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation 519/520 parents frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB outbound-registry seal_verifications lattice with GET views 521/522 and lifecycle POSTs after 519/520 block", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain("custodyTbAckReconPdFreezeSeal521TransportBoundaryReceiptReconciliationView")
    expect(lattice).toContain("closureTbAckReconPdFreezeSeal522TransportBoundaryReceiptReconciliationView")
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain(
      'step: "PR slice action: reconcile custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt on outbound registry attestation ledger"'
    )
    expect(lattice).toContain(`"${CUSTODY_RECONCILE_ACTION}"`)
    expect(lattice).toContain(
      "blocked_todo_firm:transport_stub_tb_ack_recon_pd_freeze_seal_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation:ops_probe"
    )
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders PR slice 521/522 views and POSTs after 519/520 control POSTs", () => {
    const lattice = latticeSourceSlice(source)
    const control520 = lattice.indexOf(
      'step: "PR slice action: control closure TB ack-recon PD freeze seal partner-delivery receipt freeze-override seal verification finalization on partner handoff attestation outbound registry attestation ledger"'
    )
    const view521 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view522 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const custodyReconcile521 = lattice.lastIndexOf(
      'step: "PR slice action: reconcile custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt on outbound registry attestation ledger"'
    )

    expect(control520).toBeGreaterThan(-1)
    expect(view521).toBeGreaterThan(control520)
    expect(view522).toBeGreaterThan(view521)
    expect(custodyReconcile521).toBeGreaterThan(view522)
  })
})
