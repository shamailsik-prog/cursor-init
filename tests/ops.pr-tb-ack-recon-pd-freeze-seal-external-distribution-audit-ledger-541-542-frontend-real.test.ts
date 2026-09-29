import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const LATTICE_FN = "readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice"

const REQUIRED_VIEW_STEPS = [
  "PR slice view: custody TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation external distribution audit ledger external distribution audit ledger reconciliation closure seal verification on outbound registry attestation ledger external distribution audit ledger reconciliation (541)",
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement seal verification on outbound registry attestation ledger partner handoff attestation acknowledgement (542)",
] as const

const VIEW_538_STEP =
  "PR slice view: closure TB ack-recon partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliation external transport receipt acknowledgment reconciliation partner handoff attestation acknowledgement seal verification on outbound registry attestation ledger partner handoff attestation acknowledgement (538)"

function latticeSourceSlice(source: string): string {
  const start = source.indexOf(`async function ${LATTICE_FN}()`)
  const end = source.indexOf("return (", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("TB ack-recon PD freeze seal external distribution audit ledger reconciliation + partner handoff attestation acknowledgement on outbound registry attestation ledger 541-542 frontend_real /ops call sites", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("extends the TB lattice with GET views 541-542 after 539-540 ledger reconciliation / acknowledgement views", () => {
    const lattice = latticeSourceSlice(source)

    for (const step of REQUIRED_VIEW_STEPS) {
      expect(lattice).toContain(`step: "${step}"`)
    }

    expect(lattice).toContain(
      "custodyTbAckReconPdFreezeSeal541ReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationView"
    )
    expect(lattice).toContain(
      "closureTbAckReconPdFreezeSeal542PartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementView"
    )
  })

  it("orders 541-542 views after 540 partner handoff attestation acknowledgement on outbound registry attestation ledger", () => {
    const lattice = latticeSourceSlice(source)
    const view538 = lattice.indexOf(VIEW_538_STEP)
    const view541 = lattice.indexOf(REQUIRED_VIEW_STEPS[0])
    const view542 = lattice.indexOf(REQUIRED_VIEW_STEPS[1])

    expect(view538).toBeGreaterThan(-1)
    expect(view541).toBeGreaterThan(view538)
    expect(view542).toBeGreaterThan(view541)
  })
})
