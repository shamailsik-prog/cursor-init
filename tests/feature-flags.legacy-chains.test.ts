import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as opsGet, POST as opsPost } from "@/app/api/d2/ops-reporting/route"
import { GET as filingsGet, POST as filingsPost } from "@/app/api/d4/filings/route"
import {
  FLAG_REGISTRY,
  featureDisabledResponse,
  isFeatureEnabled,
} from "@/platform/flags/featureFlags"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { composeDraft } from "@/services/d4-1/drafts"
import { readFileSync } from "node:fs"
import { FEATURE_FLAGS, getDocumentTypes } from "@/lib/foundation-data"
import { resetRefusalAuditDedupeForTests } from "@/platform/flags/routeGate"

const FLAG_ENV = "SIKANDER_FLAG_LEGACY_GOVERNANCE_CHAINS"
const DISABLED = { error: "feature_disabled", flag: "LEGACY_GOVERNANCE_CHAINS" }

function post(route: typeof opsPost, path: string, body: unknown) {
  return route(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    })
  )
}

function get(route: typeof opsGet, path: string, params: Record<string, string>) {
  return route(new Request(`http://127.0.0.1${path}?${new URLSearchParams(params).toString()}`))
}

function seedDraft() {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Flag matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  const template = getDocumentTypes()[0]
  if (!template) throw new Error("missing template seed")
  const draft = composeDraft(store, {
    actorId: "associate_a",
    matterId: matter.id,
    templateId: template.id,
    title: "Draft pleading",
    body: "Draft body",
    classification: "internal",
    preflight: {
      actorId: "associate_a",
      matterId: matter.id,
      classification: "internal",
      citedJudgmentIds: [],
      temporalCitations: [],
    },
  })
  return { matterId: matter.id, draftId: draft.id }
}

async function createAndApprovePackage() {
  const { matterId, draftId } = seedDraft()
  const created = await post(filingsPost, "/api/d4/filings", {
    action: "create_package",
    actorId: "associate_a",
    matterId,
    draftId,
    classification: "internal",
    citedJudgmentIds: [],
    temporalCitations: [],
  })
  expect(created.status).toBe(200)
  const packageId = ((await created.json()) as { result: { filingPackage: { id: string } } })
    .result.filingPackage.id
  const decided = await post(filingsPost, "/api/d4/filings", {
    action: "decide_package",
    actorId: "partner_a",
    packageId,
    decision: "approve",
    reason: "Partner approved for court filing",
  })
  expect(decided.status).toBe(200)
  const decision = (await decided.json()) as { result: Record<string, unknown> }
  return { matterId, packageId, decision: decision.result }
}

beforeEach(() => {
  // This file proves the default (flag off), so it must not inherit an opt-in.
  vi.stubEnv(FLAG_ENV, undefined as unknown as string)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  resetRuntimeStoreForTests()
  resetRefusalAuditDedupeForTests()
})

describe("feature flag registry", () => {
  it("defaults CORE_ENABLED on and LEGACY_GOVERNANCE_CHAINS off", () => {
    expect(isFeatureEnabled("CORE_ENABLED")).toBe(true)
    expect(isFeatureEnabled("LEGACY_GOVERNANCE_CHAINS")).toBe(false)
    expect(isFeatureEnabled("LEGACY_GOVERNANCE_CHAINS", "firmA")).toBe(false)
  })

  it("lets SIKANDER_FLAG_<NAME> override the default", () => {
    vi.stubEnv(FLAG_ENV, "true")
    expect(isFeatureEnabled("LEGACY_GOVERNANCE_CHAINS")).toBe(true)
    vi.stubEnv(FLAG_ENV, "false")
    expect(isFeatureEnabled("LEGACY_GOVERNANCE_CHAINS")).toBe(false)
    vi.stubEnv(FLAG_ENV, "yes-please")
    expect(isFeatureEnabled("LEGACY_GOVERNANCE_CHAINS")).toBe(false)
  })

  it("parses the override case-insensitively and fails closed on anything else", () => {
    for (const on of ["TRUE", " true "]) {
      vi.stubEnv(FLAG_ENV, on)
      expect(isFeatureEnabled("LEGACY_GOVERNANCE_CHAINS"), JSON.stringify(on)).toBe(true)
    }
    for (const off of ["1", ""]) {
      vi.stubEnv(FLAG_ENV, off)
      expect(isFeatureEnabled("LEGACY_GOVERNANCE_CHAINS"), JSON.stringify(off)).toBe(false)
    }
  })

  it("agrees with the feature_flags seed DDL and foundation-data on name and default", () => {
    const ddl = readFileSync("postgres/ddl/002_platform.sql", "utf8")
    const seeded = new Map(
      [...ddl.matchAll(/\('([A-Z0-9_]+)','[^']*',(true|false),'[^']*'\)/g)].map((m) => [
        m[1],
        m[2] === "true",
      ])
    )
    expect(seeded.size).toBeGreaterThan(0)
    const listed = new Map<string, boolean>(FEATURE_FLAGS.map((f) => [f.flag, f.defaultEnabled]))
    for (const [flag, entry] of Object.entries(FLAG_REGISTRY)) {
      expect(seeded.get(flag), `${flag} in 002_platform.sql`).toBe(entry.defaultEnabled)
      expect(listed.get(flag), `${flag} in lib/foundation-data.ts`).toBe(entry.defaultEnabled)
    }
  })

  it("documents every flag with owner, spec reference and default", () => {
    expect(Object.keys(FLAG_REGISTRY).sort()).toEqual(["CORE_ENABLED", "LEGACY_D1_NEXT_WRITES", "LEGACY_GOVERNANCE_CHAINS"])
    for (const entry of Object.values(FLAG_REGISTRY)) {
      expect(entry.owner).toMatch(/\S/)
      expect(entry.specRef).toMatch(/\S/)
      expect(typeof entry.defaultEnabled).toBe("boolean")
    }
    expect(FLAG_REGISTRY.LEGACY_GOVERNANCE_CHAINS.defaultEnabled).toBe(false)
    expect(FLAG_REGISTRY.LEGACY_GOVERNANCE_CHAINS.specRef).toContain("E-24")
  })

  it("featureDisabledResponse is a 404 naming only the flag", async () => {
    const response = featureDisabledResponse("LEGACY_GOVERNANCE_CHAINS")
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual(DISABLED)
  })
})

describe("LEGACY_GOVERNANCE_CHAINS off (default)", () => {
  it("freezes every ops-reporting GET view", async () => {
    const cases: Array<Record<string, string>> = [
      { actorId: "partner_a", limit: "10", cursor: "0" },
      { actorId: "partner_a", view: "alert_waiver_expiry_disputes", limit: "10", cursor: "0" },
    ]
    for (const params of cases) {
      const response = await get(opsGet, "/api/d2/ops-reporting", params)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual(DISABLED)
    }
  })

  it("freezes every ops-reporting POST action", async () => {
    const response = await post(opsPost, "/api/d2/ops-reporting", {
      action: "acknowledge_workflow_ops_alert_digest",
      actorId: "partner_a",
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual(DISABLED)
  })

  it("freezes filings views and actions outside the core package path", async () => {
    const { packageId } = await createAndApprovePackage()
    for (const view of ["escalation_owner_rota", "dispatch", "annexures", "package"]) {
      const response = await get(filingsGet, "/api/d4/filings", {
        view,
        userId: "partner_a",
        limit: "10",
        cursor: "0",
      })
      expect(response.status, view).toBe(404)
      expect(await response.json()).toEqual(DISABLED)
    }
    const assign = await post(filingsPost, "/api/d4/filings", {
      action: "assign_primary_owner",
      actorId: "partner_a",
      packageId,
      primaryOwnerId: "partner_a",
      activeWindowHours: 12,
      note: "Partner assigned as primary escalation owner",
    })
    expect(assign.status).toBe(404)
    expect(await assign.json()).toEqual(DISABLED)
  })

  it("keeps the core package path: create_package, decide_package and the package list", async () => {
    const { matterId, packageId } = await createAndApprovePackage()
    const cases: Array<Record<string, string>> = [
      { userId: "associate_a", matterId, limit: "10", cursor: "0" },
      { userId: "associate_a", view: "packages", readiness: "ready", limit: "10", cursor: "0" },
    ]
    for (const params of cases) {
      const response = await get(filingsGet, "/api/d4/filings", params)
      expect(response.status).toBe(200)
      const json = (await response.json()) as { items: Array<{ id: string }> }
      expect(json.items.some((row) => row.id === packageId)).toBe(true)
    }
  })

  it("keeps the partner-override citation path on create_package", async () => {
    // fix/sec-gaps binds the override to the authenticated caller: the overriding partner
    // makes the call. An associate naming a partner is refused, frozen or not.
    const { matterId, draftId } = seedDraft()
    const body = {
      action: "create_package",
      matterId,
      draftId,
      classification: "internal",
      citedJudgmentIds: [],
      temporalCitations: [],
      partnerOverride: { partnerId: "partner_a", reason: "override for test" },
    }
    const byAssociate = await post(filingsPost, "/api/d4/filings", { ...body, actorId: "associate_a" })
    expect(byAssociate.status).toBe(403)
    expect(((await byAssociate.json()) as { code?: string }).code).toBe("OVERRIDE_FORBIDDEN")
    const response = await post(filingsPost, "/api/d4/filings", { ...body, actorId: "partner_a" })
    expect(response.status).toBe(200)
  })

  it("records an audit entry for the refused call without touching chain data", async () => {
    const store = getRuntimeStore()
    const before = store.audit.length
    const response = await get(opsGet, "/api/d2/ops-reporting", {
      actorId: "partner_a",
      view: "alert_waiver_expiry_disputes",
    })
    expect(response.status).toBe(404)
    const added = store.audit.slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      action: "feature_disabled",
      actorId: "partner_a",
      firmId: "firmA",
      reason: "LEGACY_GOVERNANCE_CHAINS",
      target: "GET /api/d2/ops-reporting",
    })
  })

  it("collapses repeated refusals to one audit row per user, route and flag per minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-06T10:00:00Z"))
    const store = getRuntimeStore()
    const before = store.audit.length
    const refused = () =>
      get(opsGet, "/api/d2/ops-reporting", { actorId: "partner_a", view: "alert_waiver_expiry_disputes" })
    expect((await refused()).status).toBe(404)
    expect((await refused()).status).toBe(404)
    // A different route is a different key.
    const filings = await get(filingsGet, "/api/d4/filings", { userId: "partner_a", view: "dispatch" })
    expect(filings.status).toBe(404)
    expect(store.audit.slice(before).map((row) => row.target)).toEqual([
      "GET /api/d2/ops-reporting",
      "GET /api/d4/filings",
    ])
    vi.setSystemTime(new Date("2026-10-06T10:01:00.001Z"))
    expect((await refused()).status).toBe(404)
    expect(store.audit.slice(before)).toHaveLength(3)
  })

  it("does not suppress the next refusal's audit row when the audit write fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-06T11:00:00Z"))
    const store = getRuntimeStore()
    const before = store.audit.length
    const refused = () =>
      get(opsGet, "/api/d2/ops-reporting", { actorId: "partner_a", view: "alert_waiver_expiry_disputes" })
    // An unknown persistence mode makes the repository lookup, and so the audit write, fail.
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "broken-for-test")
    expect((await refused()).status).toBe(503)
    expect(store.audit.slice(before)).toHaveLength(0)
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "memory")
    expect((await refused()).status).toBe(404)
    expect(store.audit.slice(before).map((row) => row.action)).toEqual(["feature_disabled"])
  })

  it("approval stops at filing readiness: no dispatch-queue or annexure rows or fields", async () => {
    const { packageId, decision } = await createAndApprovePackage()
    const store = getRuntimeStore()
    expect((decision.filingPackage as { status: string }).status).toBe("approved")
    expect((decision.packetArtifact as { readiness: string }).readiness).toBe("ready")
    expect(decision).not.toHaveProperty("dispatchQueue")
    expect(decision).not.toHaveProperty("annexure")
    expect([...store.filingDispatchQueue.values()].some((r) => r.packageId === packageId)).toBe(false)
    expect([...store.filingAnnexures.values()].some((r) => r.packageId === packageId)).toBe(false)
  })

  it("still lets the route's own validation answer a POST with no action", async () => {
    const response = await post(filingsPost, "/api/d4/filings", { actorId: "partner_a" })
    expect(response.status).toBe(400)
  })
})

describe("LEGACY_GOVERNANCE_CHAINS on", () => {
  it("approval still seeds the dispatch queue and annexure and returns them", async () => {
    vi.stubEnv(FLAG_ENV, "true")
    const { packageId, decision } = await createAndApprovePackage()
    const store = getRuntimeStore()
    expect(decision.dispatchQueue).toMatchObject({ packageId })
    expect(decision.annexure).toMatchObject({ packageId })
    expect([...store.filingDispatchQueue.values()].some((r) => r.packageId === packageId)).toBe(true)
    expect([...store.filingAnnexures.values()].some((r) => r.packageId === packageId)).toBe(true)
  })

  it("restores the frozen views and actions", async () => {
    vi.stubEnv(FLAG_ENV, "true")
    const { packageId } = await createAndApprovePackage()
    const rota = await get(filingsGet, "/api/d4/filings", {
      view: "escalation_owner_rota",
      userId: "partner_a",
      limit: "10",
      cursor: "0",
    })
    expect(rota.status).toBe(200)
    const assign = await post(filingsPost, "/api/d4/filings", {
      action: "assign_primary_owner",
      actorId: "partner_a",
      packageId,
      primaryOwnerId: "partner_a",
      activeWindowHours: 12,
      note: "Partner assigned as primary escalation owner",
    })
    expect(assign.status).toBe(200)
    const ops = await get(opsGet, "/api/d2/ops-reporting", {
      actorId: "partner_a",
      limit: "10",
      cursor: "0",
    })
    expect(ops.status).not.toBe(404)
  })
})
