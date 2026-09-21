import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("Batch F #60-#69 frontend_real sequencing guard", () => {
  it("escalates disputes before any explicit resolve fallback", () => {
    const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")
    const start = source.indexOf("async function runBatch6069GovernanceLattice()")
    const end = source.indexOf("async function runBatchEActionLattice()")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const latticeSource = source.slice(start, end)

    const escalateIndex = latticeSource.indexOf('action: "escalate_closure_dispute_to_panel"')
    const resolveIndex = latticeSource.indexOf('action: "resolve_closure_attestation_dispute"')
    expect(escalateIndex).toBeGreaterThan(-1)
    expect(resolveIndex).toBeGreaterThan(escalateIndex)
  })

  it("activates rebalance throttle before throttle release execution", () => {
    const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")
    const start = source.indexOf("async function runBatch6069GovernanceLattice()")
    const end = source.indexOf("async function runBatchEActionLattice()")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const latticeSource = source.slice(start, end)

    const markThrottleIndex = latticeSource.indexOf(
      'step: "Mark closure rebalance throttle active (#67 lattice)"'
    )
    const releaseThrottleIndex = latticeSource.indexOf(
      'step: "Execute closure rebalance throttle release (#67 lattice)"'
    )
    expect(markThrottleIndex).toBeGreaterThan(-1)
    expect(releaseThrottleIndex).toBeGreaterThan(markThrottleIndex)

    const throttleActivationSlice = latticeSource.slice(markThrottleIndex, releaseThrottleIndex)
    expect(throttleActivationSlice).toContain('action: "rebalance_closure_enforcement_queue"')
    expect(throttleActivationSlice).toContain('status: "throttle_active"')
  })
})
