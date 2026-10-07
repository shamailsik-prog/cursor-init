import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ROUTES, createRouter } from "../src/http/router"

// L18 §9.1 rule 4: the core boots with every layer disabled. Flags resolve from
// SIKANDER_FLAG_<NAME> (platform/flags/featureFlags.ts); L17_2_ENABLED is read by the conflict engine.
const LAYER_FLAGS = ["CORE_ENABLED", "LEGACY_GOVERNANCE_CHAINS", "L17_2_ENABLED"]
const D1_PATHS = [
  "/api/d1/client/setFirmNumbering",
  "/api/d1/client/registerClient",
  "/api/d1/client/getClient",
  "/api/d1/client/listClients",
  "/api/d1/conflict/runConflictCheck",
  "/api/d1/conflict/getConflictResult",
  "/api/d1/conflict/resolveReviewItem",
  "/api/d1/conflict/recordPartnerWaiver",
  "/api/d1/conflict/getConflictTrail",
  "/api/d1/matter/openMatter",
  "/api/d1/matter/getMatter",
  "/api/d1/matter/listMatters",
  "/api/d1/matter/advanceStage",
  "/api/d1/matter/closeMatter",
]

describe("boot with every layer flag off (G-4)", () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const f of LAYER_FLAGS) {
      saved[f] = process.env[`SIKANDER_FLAG_${f}`]
      process.env[`SIKANDER_FLAG_${f}`] = "false"
    }
  })
  afterEach(() => {
    for (const f of LAYER_FLAGS) {
      if (saved[f] === undefined) delete process.env[`SIKANDER_FLAG_${f}`]
      else process.env[`SIKANDER_FLAG_${f}`] = saved[f]
    }
  })

  it("builds the router and registers every D1 route", () => {
    expect(() => createRouter(ROUTES)).not.toThrow()
    const paths = ROUTES.map((r) => r.path)
    for (const p of D1_PATHS) expect(paths).toContain(p)
    expect(paths.filter((p) => p.startsWith("/api/d1/"))).toHaveLength(D1_PATHS.length)
  })
})
