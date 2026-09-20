import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("Batch D frontend_real call-site coverage in /ops UI", () => {
  it("keeps required Batch D API call paths and persistence actions wired", () => {
    const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

    expect(source).toContain('path: "/api/p5/tenancy"')
    expect(source).toContain('view: "memberships"')
    expect(source).toContain('view: "audit"')

    expect(source).toContain('path: "/api/d1/clients"')
    expect(source).toContain('path: "/api/d1/reporting"')
    expect(source).toContain('path: "/api/d2/ops-reporting"')

    expect(source).toContain('action: "confirm_engagement"')
    expect(source).toContain('action: "record_case_number"')

    expect(source).toContain('path: "/api/p1/committee-brain"')
    expect(source).toContain('step: "Persist committee brain output"')
    expect(source).toContain('step: "Hydrate committee brain output list"')
  })

  it("keeps status-tolerant helper and Batch E/F plus #70-#73 wiring reachable", () => {
    const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

    expect(source).toContain("async function runApiCallAllowingStatuses(")
    expect(source).toContain("runApiCallAllowingStatusesImpl({")

    expect(source).toContain('step: "Batch E: annexure checkpoint partner signoff"')
    expect(source).toContain('step: "Batch F: set closure SLA window config"')
    expect(source).toContain('action: "set_closure_adjudication_debt_burndown_target"')
    expect(source).toContain('action: "checkpoint_closure_settlement_post_resolution_verification"')
  })
})
