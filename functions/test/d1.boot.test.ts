import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ROUTES, createRouter } from "../src/http/router"

// L18 §9.1 rule 4: the core boots with every layer disabled. The flags that exist are the registry
// in platform/flags/featureFlags.ts (CORE_ENABLED, LEGACY_GOVERNANCE_CHAINS; env SIKANDER_FLAG_<NAME>)
// and L17_2_ENABLED, which the conflict engine reads from the same env prefix at run time. Router
// construction reads none of them today, so this proves the entry point loads and registers every
// D1 route with all of them off, and will catch a flag read added to module load or route building.
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
  "/api/d1/entity/listReviewQueue",
  "/api/d1/entity/getEntity",
  "/api/d1/entity/listAliases",
  "/api/d1/entity/confirmMerge",
  "/api/d1/entity/disputeLink",
  "/api/d1/entity/rejectLink",
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

  it("loads the real entry point (src/index) with every flag off: api is exported", async () => {
    vi.resetModules()
    const index = await import("../src/index")
    expect(typeof index.api).toBe("function")
    expect(typeof index.health).toBe("function")
  })

  it("builds the router and registers every D1 route", () => {
    expect(() => createRouter(ROUTES)).not.toThrow()
    const paths = ROUTES.map((r) => r.path)
    for (const p of D1_PATHS) expect(paths).toContain(p)
    expect(paths.filter((p) => p.startsWith("/api/d1/"))).toHaveLength(D1_PATHS.length)
  })
})
