import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon PD freeze seal partner-delivery receipt freeze-override seal verification on outbound registry attestation ledger (507)",
  "PR slice view: closure TB ack-recon PD freeze seal partner-delivery receipt freeze-override seal verification on partner handoff attestation outbound registry attestation ledger (508)",
] as const

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB ack-recon PD freeze seal partner-delivery receipt freeze-override seal verification 507-508 frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 507-508 and lifecycle POSTs after 506 block", () => {
    const lattice = latticeSourceSlice(source)
    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }
    expect(lattice).toContain("custodyTbAckReconPdFreezeSeal507PartnerDeliveryReceiptFreezeOverrideSealVerificationView")
    expect(lattice).toContain("closureTbAckReconPdFreezeSeal508PartnerDeliveryReceiptFreezeOverrideSealVerificationView")
    expect(lattice).toContain("blocked_todo_firm:transport_stub_tb_ack_recon_pd_freeze_seal_partner_delivery_receipt_freeze_override_seal_verification:ops_probe")
    expect(lattice).toContain("runApiCallAllowingStatuses(")
  })

  it("orders 507-508 views and lifecycle POSTs after 506 control POST", () => {
    const lattice = latticeSourceSlice(source)
    const closure506Seal = lattice.indexOf(
      'step: "PR slice action: control closure TB ack-recon PD freeze seal partner handoff attestation outbound registry attestation ledger seal"'
    )
    const view507 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view508 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])
    expect(closure506Seal).toBeGreaterThan(-1)
    expect(view507).toBeGreaterThan(closure506Seal)
    expect(view508).toBeGreaterThan(view507)
  })
})
