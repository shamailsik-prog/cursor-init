import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const TB_SEAL_VERIFICATION_TRANSPORT_BOUNDARY_RECONCILE_ACTION =
  "reconcile_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt"

const REQUIRED_VIEW_STEPS = [
  "PR #202 view: custody TB partner-delivery seal verification parent (463)",
  "PR #202 view: closure TB partner-delivery seal verification parent (464)",
  "PR #202 view: custody TB seal verification transport boundary receipt reconciliations (469)",
  "PR #202 view: closure TB seal verification transport boundary receipt reconciliations (470)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("PR #205 TB transport-boundary receipt reconciliation frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("chains the lattice read from Batch D views and exposes button 29", () => {
    const batchDStart = source.indexOf("async function readBatchDViews()")
    const batchDEnd = source.indexOf(`async function ${LATTICE_FN}()`)
    expect(batchDStart).toBeGreaterThan(-1)
    expect(batchDEnd).toBeGreaterThan(batchDStart)
    const batchDSource = source.slice(batchDStart, batchDEnd)
    expect(batchDSource).toContain(`await ${LATTICE_FN}()`)

    expect(source).toContain(
      "29) PR #202 ack-recon TB seal verification transport boundary receipt reconciliation"
    )
    expect(source).toContain(
      `runStep(\n                  "PR #202 TB seal verification transport boundary receipt reconciliation lattice",\n                  ${LATTICE_FN}`
    )
  })

  it("keeps GET /api/d2/ops-reporting views 463/464/469/470 wired in the lattice helper", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')

    expect(lattice).toContain("custodyTbSealVerificationView")
    expect(lattice).toContain("closureTbSealVerificationView")
    expect(lattice).toContain("custodyTbSealVerificationTransportBoundaryReconciliationView")
    expect(lattice).toContain("closureTbSealVerificationTransportBoundaryReconciliationView")

    expect(lattice).toContain(
      'partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:\n          "partner_delivery_receipt_freeze_override_seal_verification_pending"'
    )
    expect(lattice).toContain(
      'partnerDeliveryTransportBoundaryReceiptReconciliationStatus:\n          "transport_boundary_receipt_reconciliation_pending"'
    )
    expect(lattice).toContain(
      'partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:\n          "transport_boundary_receipt_reconciliation_closure_attestation_pending"'
    )
  })

  it("posts the custody TB seal verification transport boundary receipt reconcile action", () => {
    const lattice = latticeSourceSlice(source)

    expect(lattice).toContain(
      'step: "PR #202 action: reconcile custody TB seal verification transport boundary receipt"'
    )
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(`action:\n            "${TB_SEAL_VERIFICATION_TRANSPORT_BOUNDARY_RECONCILE_ACTION}"`)
    expect(lattice).toContain("runApiCallAllowingStatuses(")
    expect(lattice).toContain(
      'archivalExportTransportBoundaryReceiptReconciliationDigest:\n            "ops frontend tb seal verification transport boundary receipt reconciliation probe"'
    )
  })

  it("reads parent seal-verification views before TB reconciliation child views and reconcile POST", () => {
    const lattice = latticeSourceSlice(source)

    const view463 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view464 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    const view469 = lattice.indexOf(REQUIRED_VIEW_STEPS[2])
    const view470 = lattice.indexOf(REQUIRED_VIEW_STEPS[3])
    const reconcilePost = lattice.indexOf(
      'step: "PR #202 action: reconcile custody TB seal verification transport boundary receipt"'
    )

    expect(view463).toBeGreaterThan(-1)
    expect(view464).toBeGreaterThan(view463)
    expect(view469).toBeGreaterThan(view464)
    expect(view470).toBeGreaterThan(view469)
    expect(reconcilePost).toBeGreaterThan(view470)
  })
})
