import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation external distribution audit ledger reconciliation closure seal verification outbound registry attestation ledger on outbound registry attestation ledger (533)",
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement seal verification outbound registry attestation ledger on partner handoff attestation outbound registry attestation ledger (534)",
] as const

const VIEW_532_STEP =
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement seal verification on partner handoff attestation outbound registry attestation ledger (532)"

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB ack-recon PD freeze seal reconciliation closure seal verification + acknowledgement seal verification outbound registry attestation ledger 533-534 frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 533-534 after 531-532 seal verification views", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconPdFreezeSeal533ReconciliationClosureSealVerificationOutboundRegistryAttestationLedgerView"
    )
    expect(lattice).toContain(
      "closureTbAckReconPdFreezeSeal534PartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgerView"
    )
  })

  it("orders 533-534 views after 532 partner handoff attestation acknowledgement seal verification", () => {
    const lattice = latticeSourceSlice(source)
    const view532 = lattice.indexOf(VIEW_532_STEP)
    const view533 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view534 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])

    expect(view532).toBeGreaterThan(-1)
    expect(view533).toBeGreaterThan(view532)
    expect(view534).toBeGreaterThan(view533)
  })
})
