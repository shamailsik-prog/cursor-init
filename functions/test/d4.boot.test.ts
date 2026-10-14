import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The D4 routes boot like the rest of the router (L18 §9.1 rule 4): every layer flag off, no network. D4 has no layer
// flag in Cloud Functions (like P1, P3-60), so nothing of it can be switched off at boot. The flags are the ones
// d1.boot.test.ts sets.
const LAYER_FLAGS = ["CORE_ENABLED", "LEGACY_GOVERNANCE_CHAINS", "L17_2_ENABLED"]

/** The twelve D4 routes (P4-10): eight under /api/d4/drafting, four under /api/d4/intelligence, every one kind general. */
const D4_ROUTES = [
  "POST /api/d4/drafting/createDraft general",
  "POST /api/d4/drafting/saveDraftVersion general",
  "POST /api/d4/drafting/restoreDraftVersion general",
  "GET /api/d4/drafting/getDraft general",
  "GET /api/d4/drafting/listDrafts general",
  "GET /api/d4/drafting/listDraftVersions general",
  "POST /api/d4/drafting/overrideGate general",
  "POST /api/d4/drafting/approveDraft general",
  "GET /api/d4/intelligence/listDocumentTypes general",
  "GET /api/d4/intelligence/getTypeProfile general",
  "POST /api/d4/intelligence/gateDraft general",
  "GET /api/d4/intelligence/getVerificationReport general",
]

describe("D4 boot (P4-3, P4-10)", () => {
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

  it("the entry point exports api, and the router built with every layer flag off serves exactly the twelve D4 routes, each kind general", async () => {
    // Loaded after the flags are off, so a flag read at module load or route building would show here.
    vi.resetModules()
    const index = await import("../src/index")
    expect(typeof index.api).toBe("function")
    const { ROUTES, createRouter } = await import("../src/http/router")
    expect(() => createRouter(ROUTES)).not.toThrow()
    const d4 = ROUTES.filter((r) => r.path.startsWith("/api/d4/")).map((r) => `${r.method} ${r.path} ${r.kind}`)
    expect(d4.sort()).toEqual([...D4_ROUTES].sort())
  })

  it("the production authority store is EMPTY_AUTHORITY_STORE: a fresh load of the gate's modules runs on it", async () => {
    vi.resetModules()
    const authority = await import("../src/d4/authority")
    await import("../src/d4/gateOps")
    expect(authority.activeAuthorityStore()).toBe(authority.EMPTY_AUTHORITY_STORE)
    expect(Object.isFrozen(authority.EMPTY_AUTHORITY_STORE)).toBe(true)
  })

  it("firestore.indexes.json exempts the stored text and findings from single-field indexing", () => {
    const indexes = JSON.parse(readFileSync(path.resolve(__dirname, "../../firestore.indexes.json"), "utf8")) as {
      fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; indexes: unknown[] }>
    }
    const exempt = indexes.fieldOverrides.filter((o) => Array.isArray(o.indexes) && o.indexes.length === 0).map((o) => `${o.collectionGroup}.${o.fieldPath}`)
    for (const field of ["draft_versions.body", "draft_gate_results.citations", "draft_gate_results.temporal", "draft_gate_overrides.cleared", "draft_gate_overrides.reason", "drafts.reviewChecklist"]) {
      expect(exempt).toContain(field)
    }
  })
})

describe("F05 authority store selection (plan Task 8, D8, D16)", () => {
  const READER_ENV = ["SIKANDER_CORPUS_READER_URL", "SIKANDER_CORPUS_MAX_STALENESS_HOURS", "SIKANDER_CORPUS_READER_CA"] as const
  const saved: Record<string, string | undefined> = {}
  // A loopback URL nothing listens on: selection builds the store, it never connects. The password is a fixture.
  const LOOPBACK = `postgres://reader:fixture-${Math.random().toString(36).slice(2)}@127.0.0.1:1/corpus`

  beforeEach(async () => {
    for (const k of READER_ENV) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    vi.resetModules()
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    const authority = await import("../src/d4/authority")
    authority.setAuthorityStoreForTests(null)
    await authority.resetCorpusAuthorityStoreForTests()
    for (const k of READER_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("with a valid loopback config the active store is a PgAuthorityStore, memoised per config", async () => {
    const authority = await import("../src/d4/authority")
    const { PgAuthorityStore } = await import("../src/d4/corpusAuthorityStore")
    process.env.SIKANDER_CORPUS_READER_URL = LOOPBACK
    process.env.SIKANDER_CORPUS_MAX_STALENESS_HOURS = "24"
    const first = authority.activeAuthorityStore()
    expect(first).toBeInstanceOf(PgAuthorityStore)
    expect(authority.activeAuthorityStore()).toBe(first)
    // Another configuration (a rotated password) is another store; the earlier one is ended.
    const end = vi.spyOn(first as InstanceType<typeof PgAuthorityStore>, "end")
    process.env.SIKANDER_CORPUS_READER_URL = LOOPBACK.replace("reader:", "reader2:")
    const second = authority.activeAuthorityStore()
    expect(second).toBeInstanceOf(PgAuthorityStore)
    expect(second).not.toBe(first)
    expect(end).toHaveBeenCalledTimes(1)
    expect(authority.activeAuthorityStore()).toBe(second)
  })

  it("an invalid config falls back to the empty store and logs d4.authority_not_configured once per reason", async () => {
    const { logger } = await import("firebase-functions")
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const authority = await import("../src/d4/authority")
    process.env.SIKANDER_CORPUS_READER_URL = LOOPBACK
    process.env.SIKANDER_CORPUS_MAX_STALENESS_HOURS = "0"
    for (let i = 0; i < 3; i += 1) expect(authority.activeAuthorityStore()).toBe(authority.EMPTY_AUTHORITY_STORE)
    delete process.env.SIKANDER_CORPUS_READER_URL
    for (let i = 0; i < 3; i += 1) expect(authority.activeAuthorityStore()).toBe(authority.EMPTY_AUTHORITY_STORE)
    expect(warn.mock.calls).toEqual([
      ["d4.authority_not_configured", { reason: "invalid_staleness" }],
      ["d4.authority_not_configured", { reason: "missing" }],
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fixture-")
  })

  it("in production a plaintext URL is the empty store", async () => {
    const { logger } = await import("firebase-functions")
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const authority = await import("../src/d4/authority")
    process.env.SIKANDER_CORPUS_READER_URL = LOOPBACK
    process.env.SIKANDER_CORPUS_MAX_STALENESS_HOURS = "24"
    vi.stubEnv("NODE_ENV", "production")
    expect(authority.activeAuthorityStore()).toBe(authority.EMPTY_AUTHORITY_STORE)
    expect(warn.mock.calls).toEqual([["d4.authority_not_configured", { reason: "tls_required" }]])
  })

  it("a test store wins over the environment", async () => {
    const authority = await import("../src/d4/authority")
    process.env.SIKANDER_CORPUS_READER_URL = LOOPBACK
    process.env.SIKANDER_CORPUS_MAX_STALENESS_HOURS = "24"
    const mine = new authority.InMemoryAuthorityStore()
    authority.setAuthorityStoreForTests(mine)
    expect(authority.activeAuthorityStore()).toBe(mine)
    authority.setAuthorityStoreForTests(null)
    expect(authority.activeAuthorityStore()).not.toBe(mine)
  })

  it("resetCorpusAuthorityStoreForTests refuses in production", async () => {
    const authority = await import("../src/d4/authority")
    vi.stubEnv("NODE_ENV", "production")
    await expect(authority.resetCorpusAuthorityStoreForTests()).rejects.toThrow("resetCorpusAuthorityStoreForTests is test-only")
  })
})
