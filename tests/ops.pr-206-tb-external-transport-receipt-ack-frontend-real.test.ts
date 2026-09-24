import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const TB_SEAL_VERIFICATIONS_EXTERNAL_TRANSPORT_CHECKPOINT_ACTION =
  "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment"

const REQUIRED_VIEW_STEPS = [
  "PR #206 view: custody TB seal-verifications transport boundary external transport receipt acknowledgments (475)",
  "PR #206 view: closure TB seal-verifications transport boundary external transport receipt acknowledgments (476)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("PR #206 TB external transport receipt acknowledgment frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB seal-verification lattice with GET views 475/476 and checkpoint POST", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain("custodyTbSealVerificationTransportBoundaryExternalTransportReceiptAcknowledgmentView")
    expect(lattice).toContain("closureTbSealVerificationTransportBoundaryExternalTransportReceiptAcknowledgmentView")
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain(
      'step: "PR #206 action: checkpoint custody TB seal-verifications transport boundary external transport receipt acknowledgment"'
    )
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(`action:\n            "${TB_SEAL_VERIFICATIONS_EXTERNAL_TRANSPORT_CHECKPOINT_ACTION}"`)
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders PR #206 views after reconcile POST and before lattice return", () => {
    const lattice = latticeSourceSlice(source)
    const reconcilePost = lattice.indexOf(
      'step: "PR #202 action: reconcile custody TB seal verification transport boundary receipt"'
    )
    const view475 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view476 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const checkpointPost = lattice.indexOf(
      'step: "PR #206 action: checkpoint custody TB seal-verifications transport boundary external transport receipt acknowledgment"'
    )

    expect(reconcilePost).toBeGreaterThan(-1)
    expect(view475).toBeGreaterThan(reconcilePost)
    expect(view476).toBeGreaterThan(view475)
    expect(checkpointPost).toBeGreaterThan(view476)
  })
})
