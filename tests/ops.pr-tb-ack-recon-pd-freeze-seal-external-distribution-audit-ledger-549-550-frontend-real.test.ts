import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation external distribution audit ledger external distribution audit ledger reconciliation closure seal verification on outbound registry attestation ledger external distribution audit ledger reconciliation outbound registry attestation ledgers external distribution audit ledger reconciliations ledger reconciliation closure seal verifications (549)",
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement seal verification on outbound registry attestation ledger partner handoff attestation acknowledgements partner handoff attestation acknowledgement seal verifications (550)",
] as const

const VIEW_548_STEP =
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement seal verification on outbound registry attestation ledger partner handoff attestation acknowledgements (548)"

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB ack-recon PD freeze seal external distribution audit ledger reconciliation + partner handoff attestation acknowledgement on outbound registry attestation ledger 549-550 frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 549-550 after 547-548 ledger reconciliation / acknowledgement views", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconPdFreezeSeal549ReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationView"
    )
    expect(lattice).toContain(
      "closureTbAckReconPdFreezeSeal550PartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementView"
    )
  })

  it("orders 549-550 views after 548 partner handoff attestation acknowledgement on outbound registry attestation ledger", () => {
    const lattice = latticeSourceSlice(source)
    const view548 = lattice.indexOf(VIEW_548_STEP)
    const view549 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view550 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])

    expect(view548).toBeGreaterThan(-1)
    expect(view549).toBeGreaterThan(view548)
    expect(view550).toBeGreaterThan(view549)
  })
})
