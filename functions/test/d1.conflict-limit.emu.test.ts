import { describe, expect, it, vi } from "vitest"
import { adminDb } from "../src/admin"
import * as candidates from "../src/d1/conflict/candidates"
import * as engine from "../src/d1/conflict/engine"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, viaApi } from "./api"

/**
 * Final review I7: runConflictCheck refuses a firm already at its daily cap before it reads the
 * registry (a cheap non-transactional read of the day counter); the transactional count stays
 * authoritative. Since F37 the screen reads the registry through the candidate loader
 * (`loadScreeningRegistry`), which is wrapped (not replaced) so the real loader and engine still run.
 */

vi.mock("../src/d1/conflict/candidates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/d1/conflict/candidates")>()
  return { ...actual, loadScreeningRegistry: vi.fn(actual.loadScreeningRegistry) }
})

const FIXED = Date.parse("2026-10-07T18:00:00Z") // 23:00 in Karachi
const claims = (firmId: string) => ({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })

describe("engine exports (final review I7)", () => {
  it("no longer exports the unused loadCandidates (its linkState was always none)", () => {
    expect(Object.keys(engine)).not.toContain("loadCandidates")
  })
})

describe.skipIf(!EMULATORS)("daily cap pre-read (final review I7)", () => {
  it("at the cap → 429 daily_limit without loading the registry; below it the registry is loaded", async () => {
    const run = viaApi("runConflictCheck", { now: () => FIXED })
    const loadRegistry = vi.mocked(candidates.loadScreeningRegistry)

    const firmId = uniq("firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
    const partner = await mintIdToken(claims(firmId))
    const data = { firmId, client: { name: "A B" }, opposingParties: [{ name: "Kamran" }] }

    loadRegistry.mockClear()
    await run({ token: partner.token, data } as never)
    expect(loadRegistry).toHaveBeenCalledTimes(1)

    await adminDb().collection("counters").doc(`${firmId}_conflictday_20261007`).set({ firmId, count: 100, classification: "internal" })
    loadRegistry.mockClear()
    const refused = await apiErrorOf(run({ token: partner.token, data } as never))
    expect([refused.status, refused.code, refused.retryAfter]).toEqual([429, "daily_limit", 3600])
    expect(loadRegistry).not.toHaveBeenCalled()
    expect((await adminDb().collection("conflict_checks").where("firmId", "==", firmId).get()).size).toBe(1)
  })
})
