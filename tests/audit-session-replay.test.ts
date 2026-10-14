import { execSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { bindRouteRepos } from "@/platform/persistence/forFirm"
import { createMemoryRepositories } from "@/platform/persistence/spineRepositories"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"

function routeWouldReturnUnknownSessionReference(input: {
  existingReference: { firmId: string; userId: string } | null
  requestedUserId?: string
  requestedFirmId?: string
}): boolean {
  const { existingReference, requestedUserId, requestedFirmId } = input
  return (
    !existingReference ||
    (requestedUserId !== undefined && requestedUserId !== existingReference.userId) ||
    (requestedFirmId !== undefined && requestedFirmId !== existingReference.firmId)
  )
}

describe("tenancy session replay guard", () => {
  it("getForSessionReplay is only referenced from the p5 tenancy route (plus adapters)", () => {
    const out = execSync('git grep -l "getForSessionReplay" -- "*.ts" "*.tsx"', {
      cwd: process.cwd(),
      encoding: "utf8",
    })
    const hits = out.trim().split("\n").filter(Boolean)
    const allowed = new Set([
      "app/api/p5/tenancy/route.ts",
      "platform/persistence/spineRepositories.ts",
      "platform/persistence/firestoreSpineRepositories.ts",
      "platform/persistence/forFirm.ts",
      "tests/audit-session-replay.test.ts",
    ])
    for (const file of hits) {
      expect(allowed.has(file)).toBe(true)
    }
    expect(hits).toContain("app/api/p5/tenancy/route.ts")
  })

  it("firm-bound proxy blocks getForSessionReplay", () => {
    const repos = bindRouteRepos(createMemoryRepositories(getRuntimeStore()), "firmA")
    expect(() => repos.tenancySessionReferences.getForSessionReplay("ref_1")).toThrow(
      /not available on firm-bound/
    )
  })

  it("replaying another firm's sessionReferenceId is indistinguishable from not-found at the route gate", async () => {
    const store = getRuntimeStore()
    const repos = createMemoryRepositories(store)
    store.tenancySessionReferences.set("ref_other", {
      id: "ref_other",
      firmId: "firmB",
      userId: "user_b",
      roleSnapshot: "partner",
      clearanceSnapshot: "internal",
      parentSessionReferenceId: null,
      lineageRootSessionReferenceId: "ref_other",
      lineageDepth: 0,
      authBoundary: "runtime_local",
      externalSessionId: null,
      delegatedBoundaryComparedSessionReferenceId: null,
      delegatedBoundaryReconciliationStatus: "aligned",
      delegatedBoundaryDivergenceReasons: [],
      delegatedBoundaryReconciledAt: null,
      delegatedBoundaryReconciledBy: null,
      issuedAt: 1,
      lastSeenAt: 1,
      expiresAt: 9_999_999_999,
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
      privilegedBoundaryDriftedAt: null,
      privilegedBoundaryDriftedBy: null,
      privilegedBoundaryDriftReason: null,
    })
    const replayed = await repos.tenancySessionReferences.getForSessionReplay("ref_other")
    expect(replayed?.firmId).toBe("firmB")
    expect(
      routeWouldReturnUnknownSessionReference({
        existingReference: replayed,
        requestedFirmId: "firmA",
      })
    ).toBe(true)
    expect(await repos.tenancySessionReferences.get("ref_other", "firmA")).toBeNull()
  })
})
