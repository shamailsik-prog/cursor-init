import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation external distribution audit ledger external distribution audit ledger reconciliation closure seal verification on outbound registry attestation ledger external distribution audit ledger reconciliation outbound registry attestation ledgers external distribution audit ledger reconciliations (543)",
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement seal verification on outbound registry attestation ledger partner handoff attestation acknowledgements (544)",
] as const

const VIEW_542_STEP =
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement seal verification on outbound registry attestation ledger partner handoff attestation acknowledgement (542)"

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB ack-recon PD freeze seal external distribution audit ledger reconciliation + partner handoff attestation acknowledgement on outbound registry attestation ledger 543-544 frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 543-544 after 541-542 ledger reconciliation / acknowledgement views", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconPdFreezeSeal543ReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationView"
    )
    expect(lattice).toContain(
      "closureTbAckReconPdFreezeSeal544PartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementView"
    )
  })

  it("orders 543-544 views after 542 partner handoff attestation acknowledgement on outbound registry attestation ledger", () => {
    const lattice = latticeSourceSlice(source)
    const view542 = lattice.indexOf(VIEW_542_STEP)
    const view543 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view544 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])

    expect(view542).toBeGreaterThan(-1)
    expect(view543).toBeGreaterThan(view542)
    expect(view544).toBeGreaterThan(view543)
  })
})
