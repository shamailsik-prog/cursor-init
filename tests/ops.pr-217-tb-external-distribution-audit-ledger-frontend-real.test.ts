import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const TB_ACK_RECON_EXTERNAL_DISTRIBUTION_AUDIT_LEDGER_RECORD_ENTRY_ACTION =
  "record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_entry"

const REQUIRED_VIEW_STEPS = [
  "PR #217 view: custody TB seal-verifications ack reconciliation external distribution audit ledger (479)",
  "PR #217 view: closure TB seal-verifications ack reconciliation partner handoff attestation (480)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("PR #217 TB external distribution audit ledger on reconciled ack chain frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB seal-verification lattice with GET views 479/480 and ledger record POST after PR #213 reconcile", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbSealVerificationAckReconciliationExternalDistributionAuditLedgerView"
    )
    expect(lattice).toContain("closureTbSealVerificationAckReconciliationPartnerHandoffAttestationView")
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain(
      'step: "PR #217 action: record custody TB seal-verifications ack reconciliation external distribution audit ledger entry"'
    )
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_EXTERNAL_DISTRIBUTION_AUDIT_LEDGER_RECORD_ENTRY_ACTION}"`
    )
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders PR #217 views and ledger POST after PR #213 reconcile POST", () => {
    const lattice = latticeSourceSlice(source)
    const reconcile213 = lattice.indexOf(
      'step: "PR #213 action: reconcile custody TB seal-verifications transport boundary external transport receipt acknowledgment reconciliation"'
    )
    const view479 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view480 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const recordEntry = lattice.indexOf(
      'step: "PR #217 action: record custody TB seal-verifications ack reconciliation external distribution audit ledger entry"'
    )

    expect(reconcile213).toBeGreaterThan(-1)
    expect(view479).toBeGreaterThan(reconcile213)
    expect(view480).toBeGreaterThan(view479)
    expect(recordEntry).toBeGreaterThan(view480)
  })
})
