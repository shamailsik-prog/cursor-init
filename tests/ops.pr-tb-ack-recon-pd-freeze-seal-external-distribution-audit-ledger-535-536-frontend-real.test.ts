import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation external distribution audit ledger external distribution audit ledger reconciliation on outbound registry attestation ledger external distribution audit ledger reconciliation (535)",
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement on outbound registry attestation ledger partner handoff attestation acknowledgement (536)",
] as const

const VIEW_534_STEP =
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement seal verification outbound registry attestation ledger on partner handoff attestation outbound registry attestation ledger (534)"

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB ack-recon PD freeze seal external distribution audit ledger reconciliation + partner handoff attestation acknowledgement on outbound registry attestation ledger 535-536 frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 535-536 after 533-534 outbound registry attestation ledger views", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconPdFreezeSeal535OutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationView"
    )
    expect(lattice).toContain(
      "closureTbAckReconPdFreezeSeal536OutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementView"
    )
  })

  it("orders 535-536 views after 534 partner handoff attestation acknowledgement seal verification outbound registry attestation ledger", () => {
    const lattice = latticeSourceSlice(source)
    const view534 = lattice.indexOf(VIEW_534_STEP)
    const view535 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view536 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])

    expect(view534).toBeGreaterThan(-1)
    expect(view535).toBeGreaterThan(view534)
    expect(view536).toBeGreaterThan(view535)
  })
})
