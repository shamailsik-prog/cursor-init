import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const TB_SEAL_VERIFICATIONS_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_RECONCILE_ACTION =
  "reconcile_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation"

const REQUIRED_VIEW_STEPS = [
  "PR #213 view: custody TB seal-verifications transport boundary external transport receipt acknowledgment reconciliation (477)",
  "PR #213 view: closure TB seal-verifications transport boundary external transport receipt acknowledgment reconciliation (478)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("PR #213 TB external transport receipt acknowledgment reconciliation frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB seal-verification lattice with GET views 477/478 and waiver reconcile POST", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbSealVerificationTransportBoundaryExternalTransportReceiptAcknowledgmentReconciliationView"
    )
    expect(lattice).toContain(
      "closureTbSealVerificationTransportBoundaryExternalTransportReceiptAcknowledgmentReconciliationView"
    )
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain(
      'step: "PR #213 action: reconcile custody TB seal-verifications transport boundary external transport receipt acknowledgment reconciliation"'
    )
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(
      `action:\n            "${TB_SEAL_VERIFICATIONS_EXTERNAL_TRANSPORT_ACK_RECONCILIATION_RECONCILE_ACTION}"`
    )
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders PR #213 views after PR #206 checkpoint POST and reconcile POST before lattice return", () => {
    const lattice = latticeSourceSlice(source)
    const checkpointPost = lattice.indexOf(
      'step: "PR #206 action: checkpoint custody TB seal-verifications transport boundary external transport receipt acknowledgment"'
    )
    const view477 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view478 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const reconcilePost = lattice.indexOf(
      'step: "PR #213 action: reconcile custody TB seal-verifications transport boundary external transport receipt acknowledgment reconciliation"'
    )

    expect(checkpointPost).toBeGreaterThan(-1)
    expect(view477).toBeGreaterThan(checkpointPost)
    expect(view478).toBeGreaterThan(view477)
    expect(reconcilePost).toBeGreaterThan(view478)
  })
})
