/**
 * Feature flags and the route gate's refusal audit, P1 classification and
 * provider-policy guards, and the audit / runtime-repository persistence
 * helpers, unit level. Written against the surviving mutants of
 * `npm run mutation` (docs/audits/mutation-report.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtime = vi.hoisted(() => ({
  store: null as unknown as import("@/platform/spine/store").SpineStore,
  appended: [] as Record<string, unknown>[],
}))
vi.mock("@/platform/spine/runtimeStore", () => ({ getRuntimeStore: () => runtime.store }))

import { FLAG_REGISTRY, isFeatureEnabled, type FeatureFlag } from "@/platform/flags/featureFlags"
import { gateByFlag, isFilingsCoreRequest, resetRefusalAuditDedupeForTests } from "@/platform/flags/routeGate"
import type { HandlerSession } from "@/platform/http/withSession"
import { classificationRank, type Classification } from "@/platform/p1/types"
import { providerAllowedFor, setProviderConfigForTests, type ProviderId } from "@/platform/p1/providerPolicy"
import { AuditAppendConflictError, auditRowsEqual } from "@/platform/persistence/auditAppendConflictError"
import { syncFirmAudit } from "@/platform/persistence/auditSync"
import { normalizeAuditEntryInPlace } from "@/platform/persistence/auditWriteThrough"
import { isAuditRowPersisted, markAuditRowPersisted } from "@/platform/audit/requestAudit"
import {
  PersistenceConfigurationError,
  getRuntimeRepositories,
  setFirestorePersistenceForTests,
} from "@/platform/persistence/runtimeRepositories"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import { newStore, type AuditEntry } from "@/platform/spine/store"

beforeEach(() => {
  runtime.store = newStore()
  resetRefusalAuditDedupeForTests()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  setFirestorePersistenceForTests(null)
})

describe("feature flags", () => {
  it("every registry entry names what it is, who owns it and where it is specified", () => {
    for (const [flag, entry] of Object.entries(FLAG_REGISTRY)) {
      for (const field of ["description", "owner", "specRef"] as const) {
        expect(entry[field].trim(), `${flag}.${field}`).not.toBe("")
      }
    }
    // The frozen-chains description is the record of what the flag freezes (Erratum E-24).
    expect(FLAG_REGISTRY.LEGACY_GOVERNANCE_CHAINS.description).toMatch(/^Frozen out-of-spec chains: .*ops-reporting/)
    expect(FLAG_REGISTRY.LEGACY_GOVERNANCE_CHAINS.description).toMatch(/\/api\/d4\/filings view and action except/)
    expect(FLAG_REGISTRY.LEGACY_GOVERNANCE_CHAINS.description).toMatch(/create_package, decide_package, the package list/)
    expect(FLAG_REGISTRY.LEGACY_GOVERNANCE_CHAINS.description).toMatch(/writes no dispatch-queue or annexure row$/)
  })

  it("an env override of false (any case, padded) turns a default-on flag off", () => {
    vi.stubEnv("SIKANDER_FLAG_CORE_ENABLED", " FALSE ")
    expect(isFeatureEnabled("CORE_ENABLED")).toBe(false)
    vi.stubEnv("SIKANDER_FLAG_CORE_ENABLED", "no")
    expect(isFeatureEnabled("CORE_ENABLED")).toBe(true)
  })
})

describe("gateByFlag refusal audit", () => {
  const FLAG: FeatureFlag = "LEGACY_GOVERNANCE_CHAINS"
  const session: HandlerSession = {
    userId: "u1",
    firmId: "firmA",
    role: "partner",
    clearance: "internal",
    mode: "firebase",
  }
  const handler = vi.fn(async () => new Response("live"))
  const gated = gateByFlag(FLAG, handler)
  const call = (s: HandlerSession | null = session) => gated(new Request("http://x/api/d2/ops-reporting?view=a"), s)

  beforeEach(() => {
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "memory")
    vi.stubEnv(`SIKANDER_FLAG_${FLAG}`, "false")
    handler.mockClear()
  })

  it("answers 404 feature_disabled and audits the refusal as an internal row with an aud_ id", async () => {
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "feature_disabled", flag: FLAG })
    expect(handler).not.toHaveBeenCalled()
    expect(runtime.store.audit).toHaveLength(1)
    expect(runtime.store.audit[0]).toMatchObject({
      firmId: "firmA",
      actorId: "u1",
      action: "feature_disabled",
      target: "GET /api/d2/ops-reporting",
      classification: "internal",
      reason: FLAG,
    })
    expect(runtime.store.audit[0].id).toMatch(/^aud_/)
  })

  it("audits once per minute per caller and route, and again once the minute has passed", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    await call()
    vi.setSystemTime(69_999)
    await call()
    expect(runtime.store.audit).toHaveLength(1)
    vi.setSystemTime(70_000)
    await call()
    expect(runtime.store.audit).toHaveLength(2)
  })

  it("refuses a caller with no resolvable identity without auditing or crashing", async () => {
    const res = await call(null)
    expect(res.status).toBe(404)
    expect(runtime.store.audit).toHaveLength(0)
  })
})

describe("isFilingsCoreRequest", () => {
  const post = (body: string) => new Request("http://x/api/d4/filings", { method: "POST", body })

  it("treats an empty, missing or non-string action as core (the handler's validation answers)", async () => {
    for (const body of ['{"action":""}', "{}", '{"action":5}', "null", "not json"]) {
      expect(await isFilingsCoreRequest(post(body)), body).toBe(true)
    }
  })

  it("freezes a declared non-core action", async () => {
    expect(await isFilingsCoreRequest(post('{"action":"dispatch"}'))).toBe(false)
    expect(await isFilingsCoreRequest(post('{"action":"create_package"}'))).toBe(true)
  })
})

describe("P1 guards", () => {
  it("classificationRank refuses an unknown label with a fixed message", () => {
    expect(() => classificationRank("secret" as Classification)).toThrow("unknown classification label")
  })

  it("names the refusal for an unconfigured provider", () => {
    expect(providerAllowedFor("mystery" as ProviderId, "public")).toEqual({
      allowed: false,
      reason: "L18 §4.6: provider is not configured in P1",
    })
  })

  it("refuses the provider-table override under NODE_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(() => setProviderConfigForTests({ openai: { dpaExecuted: true, inRegion: true } })).toThrow(
      "setProviderConfigForTests is test-only"
    )
    vi.stubEnv("NODE_ENV", "test")
    expect(providerAllowedFor("openai", "confidential").allowed).toBe(false)
  })
})

describe("audit row helpers", () => {
  it("AuditAppendConflictError names the row and its kind", () => {
    const err = new AuditAppendConflictError("aud_1")
    expect(err).toMatchObject({ name: "AuditAppendConflictError", code: "audit_append_conflict", auditId: "aud_1" })
    expect(err.message).toBe("audit entry aud_1 already exists; the audit log is append-only")
  })

  it("auditRowsEqual ignores key order (nested too) and undefined fields, but not shape or values", () => {
    expect(auditRowsEqual({ a: 1, b: { c: 2, d: [1, { e: 1, f: 2 }] } }, { b: { d: [1, { f: 2, e: 1 }], c: 2 }, a: 1 })).toBe(
      true
    )
    expect(auditRowsEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(auditRowsEqual([1], { 0: 1 })).toBe(false)
    expect(auditRowsEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(auditRowsEqual({ a: "1" }, { a: 1 })).toBe(false)
    expect(auditRowsEqual(null, {})).toBe(false)
  })

  it("syncFirmAudit replaces that firm's persisted rows with the repository's, keeping rows still owed", async () => {
    // Adapted after review R2 N2 / final audit F8: the log is replaced in place (store.audit is
    // read-only), and this firm's local rows that are not persisted yet stay (their request's
    // flush or the retry queue still owes them), unless the repository already has that id.
    const store = newStore()
    const row = (id: string, firmId: string) => ({ id, firmId, action: "x", actorId: "u", at: 1 }) as AuditEntry
    const a1 = row("a1", "firmA")
    markAuditRowPersisted(a1)
    const local = row("a2", "firmA")
    const dup = row("a3", "firmA")
    const log = store.audit
    store.audit.replaceAll([a1, row("b1", "firmB"), local, dup])
    const fromRepo = [row("a9", "firmA"), row("a3", "firmA")]
    const repos = { audit: { listByFirm: async (firm: string) => (firm === "firmA" ? fromRepo : []) } }
    await syncFirmAudit(store, repos as unknown as SpineRepositories, "firmA")
    expect(store.audit.map((r) => r.id)).toEqual(["b1", "a2", "a9", "a3"])
    expect(store.audit[3]).toBe(fromRepo[1])
    expect(store.audit).toBe(log)
    expect(fromRepo.every(isAuditRowPersisted)).toBe(true)
    expect(isAuditRowPersisted(local)).toBe(false)
  })

  it("normalizeAuditEntryInPlace fills id/firm/at on the row itself, keeps given values, and refuses a row with no firm", () => {
    // Adapted after final audit F8: persistAuditEntriesSince (an index walk over store.audit,
    // which also skipped holes) is removed; the end-of-request flush normalises each of the
    // request's own rows by object with normalizeAuditEntryInPlace, so that is what is targeted.
    const store = newStore()
    store.users.set("u1", { id: "u1", firmId: "firmA", role: "partner", clearanceLevel: "internal" })
    const fill = { action: "fill", actorId: "u1" } as unknown as AuditEntry
    const before = Date.now()
    expect(normalizeAuditEntryInPlace(store, fill)).toBe(fill)
    expect(fill).toMatchObject({ firmId: "firmA", action: "fill" })
    expect(fill.id).toMatch(/^aud_/)
    expect(fill.at).toBeGreaterThanOrEqual(before)
    expect(fill.at).toBeLessThanOrEqual(Date.now())

    const given = { id: "keep", firmId: "firmB", action: "given", actorId: "u1", at: 42 } as AuditEntry
    normalizeAuditEntryInPlace(store, given)
    expect(given).toEqual({ id: "keep", firmId: "firmB", action: "given", actorId: "u1", at: 42 })

    const orphan = { action: "orphan", actorId: "nobody" } as unknown as AuditEntry
    expect(() => normalizeAuditEntryInPlace(store, orphan)).toThrow("unable to resolve audit firm for action orphan")
  })
})

describe("runtime repositories configuration errors", () => {
  const store = () => newStore()

  it("memory in production is refused with an explanation, unless explicitly allowed", async () => {
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "memory")
    vi.stubEnv("NODE_ENV", "production")
    const err = await getRuntimeRepositories(store()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PersistenceConfigurationError)
    expect(err).toMatchObject({ name: "PersistenceConfigurationError" })
    expect((err as Error).message).toBe(
      "SIKANDER_PERSISTENCE_MODE=memory is non-durable (data is lost on restart) and is refused " +
        "when NODE_ENV=production. Set SIKANDER_ALLOW_MEMORY_IN_PRODUCTION=true to opt in deliberately."
    )
  })

  it("an unset mode outside the test runner says how to opt in", async () => {
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "")
    vi.stubEnv("VITEST", "")
    await expect(getRuntimeRepositories(store())).rejects.toThrow(
      "SIKANDER_PERSISTENCE_MODE is not set. Set SIKANDER_PERSISTENCE_MODE=memory explicitly for " +
        "non-durable local development; there is no silent in-memory default."
    )
  })

  it("firestore mode without a database refuses, and with one returns Firestore repositories", async () => {
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    await expect(getRuntimeRepositories(store())).rejects.toThrow(
      "SIKANDER_PERSISTENCE_MODE=firestore but no Firestore database is configured. " +
        "Production Firestore persistence (firebase-admin with firm service-account " +
        "credentials) is not wired yet — TODO(firm); only the test-injected emulator database " +
        "is supported. Refusing to fall back to in-memory storage."
    )
    setFirestorePersistenceForTests({ collection: () => ({}) })
    const repos = await getRuntimeRepositories(store())
    expect(typeof repos.matters.get).toBe("function")
  })

  it("an unknown mode is refused by name, never treated as firestore", async () => {
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "Postgres")
    setFirestorePersistenceForTests({ collection: () => ({}) })
    await expect(getRuntimeRepositories(store())).rejects.toThrow(
      'Unknown SIKANDER_PERSISTENCE_MODE "Postgres"; expected "memory" or "firestore".'
    )
  })
})
