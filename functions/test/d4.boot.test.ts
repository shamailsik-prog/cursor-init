import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The D4 routes boot like the rest of the router (L18 §9.1 rule 4): every layer flag off, no network. D4 has no layer
// flag in Cloud Functions (like P1, P3-60), so nothing of it can be switched off at boot. The flags are the ones
// d1.boot.test.ts sets.
const LAYER_FLAGS = ["CORE_ENABLED", "LEGACY_GOVERNANCE_CHAINS", "L17_2_ENABLED"]

/** The twelve Phase 4a D4 routes (P4-10): eight under /api/d4/drafting, four under /api/d4/intelligence, every one kind general. */
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

/**
 * The Phase 4b generation routes (P4B-1), all under /api/d4/drafting. Each task that adds a route appends it here:
 * `generateOutline` and `generateDraft` are kind p1 and every other one is kind general.
 */
const D4_GENERATION_ROUTES = [
  "POST /api/d4/drafting/startDraft general",
  "GET /api/d4/drafting/getGeneration general",
  "GET /api/d4/drafting/listGenerations general",
]

/** The last path segment of a "METHOD /path kind" route line. */
const nameOf = (line: string): string => line.split(" ")[1]!.split("/").pop()!

/** Sets every layer flag off for a test, and restores what was there. */
function layerFlagsOff(): void {
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
}

describe("D4 boot (P4-3, P4-10)", () => {
  layerFlagsOff()

  it("the entry point exports api, and the router built with every layer flag off serves the twelve Phase 4a D4 routes unchanged, each kind general", async () => {
    // Loaded after the flags are off, so a flag read at module load or route building would show here.
    vi.resetModules()
    const index = await import("../src/index")
    expect(typeof index.api).toBe("function")
    const { ROUTES, createRouter } = await import("../src/http/router")
    expect(() => createRouter(ROUTES)).not.toThrow()
    const names = new Set(D4_ROUTES.map(nameOf))
    const d4 = ROUTES.filter((r) => r.path.startsWith("/api/d4/") && names.has(r.path.split("/").pop()!)).map((r) => `${r.method} ${r.path} ${r.kind}`)
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
    for (const field of ["draft_versions.body", "draft_gate_results.citations", "draft_gate_results.temporal", "draft_gate_overrides.cleared", "draft_gate_overrides.reason"]) {
      expect(exempt).toContain(field)
    }
  })
})

describe("D4 generation boot (P4B-9, P4B-22)", () => {
  layerFlagsOff()

  it("the router built with every layer flag off serves exactly the Phase 4a and 4b D4 routes; generateOutline and generateDraft are kind p1 and every other one general", async () => {
    vi.resetModules()
    const { ROUTES, createRouter } = await import("../src/http/router")
    expect(() => createRouter(ROUTES)).not.toThrow()
    const d4 = ROUTES.filter((r) => r.path.startsWith("/api/d4/")).map((r) => `${r.method} ${r.path} ${r.kind}`)
    expect(d4.sort()).toEqual([...D4_ROUTES, ...D4_GENERATION_ROUTES].sort())
  })

  it("the production template store is EMPTY_TEMPLATE_STORE: a fresh load of the generation modules runs on it", async () => {
    vi.resetModules()
    const t = await import("../src/d4/templates")
    await import("../src/d4/generations")
    expect(t.activeTemplateStore()).toBe(t.EMPTY_TEMPLATE_STORE)
    expect(Object.isFrozen(t.EMPTY_TEMPLATE_STORE)).toBe(true)
  })

  it("firestore.indexes.json indexes draft_generations by firm, matter and updatedAt, and exempts the generation text from single-field indexing", () => {
    const indexes = JSON.parse(readFileSync(path.resolve(__dirname, "../../firestore.indexes.json"), "utf8")) as {
      indexes: Array<{ collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string; order: string }> }>
      fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; indexes: unknown[] }>
    }
    const exempt = indexes.fieldOverrides.filter((o) => Array.isArray(o.indexes) && o.indexes.length === 0).map((o) => `${o.collectionGroup}.${o.fieldPath}`)
    for (const f of ["draft_generations.facts", "draft_generations.verbatim", "draft_generations.partyNames", "draft_outlines.sections", "draft_outlines.missingFacts", "draft_sections.text"]) {
      expect(exempt).toContain(f)
    }
    const composite = (group: string): string[] => {
      const rows = indexes.indexes.filter((i) => i.collectionGroup === group)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.queryScope).toBe("COLLECTION")
      return rows[0]!.fields.map((f) => `${f.fieldPath} ${f.order}`)
    }
    expect(composite("draft_generations")).toEqual(["firmId ASCENDING", "matterId ASCENDING", "updatedAt DESCENDING", "__name__ DESCENDING"])
  })
})
