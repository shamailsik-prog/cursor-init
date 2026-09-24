import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_RECONCILE_ACTION =
  "reconcile_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt"

const TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_CLOSURE_DIGEST_ACTION =
  "checkpoint_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_closure_attestation_digest"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon outbound-registry partner-delivery freeze-override seal verification (483)",
  "PR slice view: closure TB ack-recon outbound-registry partner-delivery freeze-override seal verification (484)",
  "PR slice view: custody TB ack-recon outbound-registry seal verification transport boundary receipt reconciliations (485)",
  "PR slice view: closure TB ack-recon outbound-registry seal verification transport boundary receipt reconciliations (486)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB outbound-registry seal verification transport boundary receipt reconciliation frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 483-486 and reconcile POST after seal checkpoint", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconOutboundRegistrySealVerificationTransportBoundaryReceiptReconciliationView"
    )
    expect(lattice).toContain(
      "closureTbAckReconOutboundRegistrySealVerificationTransportBoundaryReceiptReconciliationView"
    )
    expect(lattice).toContain('method: "GET"')
    expect(lattice).toContain('path: "/api/d2/ops-reporting"')
    expect(lattice).toContain(
      'step: "PR slice action: reconcile custody TB ack-recon outbound-registry seal verification transport boundary receipt"'
    )
    expect(lattice).toContain(
      'step: "PR slice action: checkpoint closure TB ack-recon outbound-registry seal verification transport boundary receipt reconciliation closure attestation digest"'
    )
    expect(lattice).toContain('method: "POST"')
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_RECONCILE_ACTION}"`
    )
    expect(lattice).toContain(
      `action:\n            "${TB_ACK_RECON_OUTBOUND_REGISTRY_SEAL_VERIFICATIONS_TRANSPORT_BOUNDARY_CLOSURE_DIGEST_ACTION}"`
    )
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders 485/486 views and reconcile POST after outbound-registry seal verification POSTs", () => {
    const lattice = latticeSourceSlice(source)
    const sealCheckpoint = lattice.indexOf(
      'step: "PR slice action: checkpoint custody TB ack-recon partner-delivery freeze-override seal verification"'
    )
    const sealControl = lattice.indexOf(
      'step: "PR slice action: control closure TB ack-recon outbound-registry attestation ledger seal"'
    )
    const view485 = lattice.indexOf(REQUIRED_VIEW_STEPS[2])
    const view486 = lattice.indexOf(REQUIRED_VIEW_STEPS[3])
    const reconcile = lattice.indexOf(
      'step: "PR slice action: reconcile custody TB ack-recon outbound-registry seal verification transport boundary receipt"'
    )

    expect(sealCheckpoint).toBeGreaterThan(-1)
    expect(sealControl).toBeGreaterThan(sealCheckpoint)
    expect(view485).toBeGreaterThan(sealControl)
    expect(view486).toBeGreaterThan(view485)
    expect(reconcile).toBeGreaterThan(view486)
  })
})
