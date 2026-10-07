import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Disable-every-layer boot test (L18 §9.1 rule 4; §10 G-4 / G-5): with every
 * non-core feature flag off, every route module imports, every core route
 * answers a valid session and minimal valid input without a 5xx, and every
 * frozen route answers 404 feature_disabled (Erratum E-24).
 */

const verifyIdToken = vi.fn()

vi.mock("firebase-admin/app", () => ({
  getApps: () => [],
  initializeApp: () => ({ name: "test-app" }),
  applicationDefault: () => ({}),
}))
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken }),
}))

import { FLAG_REGISTRY, isFeatureEnabled, type FeatureFlag } from "@/platform/flags/featureFlags"
import { resetRefusalAuditDedupeForTests } from "@/platform/flags/routeGate"
import { resetSessionStateForTests } from "@/platform/p5/session"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { composeDraft } from "@/services/d4-1/drafts"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { getDocumentTypes } from "@/lib/foundation-data"
import {
  OPS_GET_VIEWS,
  OPS_NOT_IMPLEMENTED_ACTIONS,
  OPS_POST_ACTIONS,
} from "@/app/api/d2/ops-reporting/dispatch"

const TOKENS: Record<string, Record<string, unknown>> = {
  "token-partner-a": { uid: "partner_a", firmId: "firmA", role: "partner", clearanceLevel: "privileged-restricted" },
  "token-associate-a": { uid: "associate_a", firmId: "firmA", role: "associate", clearanceLevel: "privileged" },
}

const NON_CORE_FLAGS = (Object.keys(FLAG_REGISTRY) as FeatureFlag[]).filter(
  (flag) => flag !== "CORE_ENABLED"
)

type Handler = (request: Request) => Promise<Response>
type RouteModule = Partial<Record<"GET" | "POST", Handler>>

const root = path.resolve(__dirname, "..")

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...routeFiles(full))
    else if (/^route\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const ROUTE_FILES = routeFiles(path.join(root, "app/api")).map((f) =>
  path.relative(root, f).split(path.sep).join("/")
)

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const

// Absolute paths keep Vite's dynamic-import analysis out of it (no import warnings).
async function importRoute(file: string): Promise<Record<string, unknown>> {
  return (await import(/* @vite-ignore */ path.join(root, file))) as Record<string, unknown>
}

async function load(route: string): Promise<RouteModule> {
  return (await importRoute(`app/api/${route}/route.ts`)) as RouteModule
}

/** Every exported (route, method) pair, as "<route> <METHOD>" with route relative to app/api. */
async function exportedPairs(): Promise<Set<string>> {
  const pairs = new Set<string>()
  for (const file of ROUTE_FILES) {
    const mod = await importRoute(file)
    const route = file.replace(/^app\/api\//, "").replace(/\/route\.tsx?$/, "")
    for (const m of METHODS) if (typeof mod[m] === "function") pairs.add(`${route} ${m}`)
  }
  return pairs
}

function authed(
  url: string,
  init: { method?: "GET" | "POST"; body?: unknown; token?: string } = {}
): Request {
  const { method = "GET", body, token = "token-partner-a" } = init
  const headers = new Headers({ Authorization: `Bearer ${token}`, "X-Firm-Id": "firmA" })
  if (method === "POST") {
    headers.set("Content-Type", "application/json")
    headers.set("Idempotency-Key", crypto.randomUUID())
  }
  return new Request(`http://127.0.0.1${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function call(
  route: string,
  method: "GET" | "POST",
  init: { query?: Record<string, string>; body?: unknown; token?: string } = {}
) {
  const handler = (await load(route))[method]
  if (!handler) throw new Error(`${route} has no ${method}`)
  const query = init.query ? `?${new URLSearchParams(init.query).toString()}` : ""
  const response = await handler(
    authed(`/api/${route}${query}`, { method, body: init.body, token: init.token })
  )
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // non-JSON body: keep the text
  }
  return { status: response.status, body }
}

function seedMatterAndDraft() {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Boot matter",
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
    title: "Boot draft",
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
  const doc = uploadDocument(store, {
    firmId: "firmA",
    matterId: matter.id,
    bytes: Buffer.from("%PDF-boot-workflow%"),
    sourceChannel: "web",
    classification: "internal",
    idempotencyKey: crypto.randomUUID(),
  })
  return { matterId: matter.id, draftId: draft.id, documentId: doc.docId }
}

beforeEach(() => {
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
  vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
  vi.stubEnv("FIREBASE_PROJECT_ID", "demo-sikander")
  for (const flag of NON_CORE_FLAGS) vi.stubEnv(`SIKANDER_FLAG_${flag}`, "false")
  verifyIdToken.mockReset()
  verifyIdToken.mockImplementation(async (token: string) => {
    const decoded = TOKENS[token]
    if (!decoded) throw new Error("Firebase ID token has invalid signature")
    return decoded
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
  resetRefusalAuditDedupeForTests()
})

type CallInit = { query?: Record<string, string>; body?: unknown; token?: string }
type Ctx = { matterId: string; draftId: string; documentId: string }
type CoreCall = { route: string; method: "GET" | "POST"; init: (ctx: Ctx) => CallInit; expect?: number }

const page = { limit: "10", cursor: "0" }

/** One call per core (route, method); bodies follow the /ops console's own calls. */
const CORE_CALLS: CoreCall[] = [
  { route: "g0/monitor", method: "GET", init: () => ({}), expect: 200 },
  { route: "g0/normalise", method: "POST", init: () => ({ body: { actorId: "partner_a", raw: "CP 1234", courtId: "SHC" } }), expect: 200 },
  { route: "d1/matters", method: "GET", init: () => ({ query: { ...page } }), expect: 200 },
  {
    route: "d1/matters",
    method: "POST",
    init: () => ({
      body: {
        action: "create",
        firmId: "firmA",
        clientId: "client_a",
        title: "Boot-created matter",
        courtId: "SHC",
        classification: "internal",
      },
    }),
    expect: 200,
  },
  { route: "d1/clients", method: "GET", init: () => ({ query: { ...page } }), expect: 200 },
  {
    route: "d1/clients",
    method: "POST",
    init: () => ({
      body: {
        action: "create",
        firmId: "firmA",
        canonicalName: "Boot Client",
        cnic: "4220112345671",
        phone: "+923001112345",
        classification: "internal",
      },
    }),
    expect: 200,
  },
  { route: "d1/documents", method: "GET", init: ({ matterId }) => ({ query: { matterId, ...page } }), expect: 200 },
  {
    route: "d1/documents",
    method: "POST",
    init: ({ matterId }) => ({
      body: {
        action: "ingest",
        firmId: "firmA",
        matterId,
        contentBase64: Buffer.from("%PDF-boot% all layers disabled").toString("base64"),
        sourceChannel: "web",
        classification: "internal",
      },
    }),
    expect: 200,
  },
  {
    route: "d1/document-workflow",
    method: "GET",
    init: ({ matterId }) => ({ query: { matterId, ...page } }),
    expect: 200,
  },
  {
    route: "d1/document-workflow",
    method: "POST",
    init: ({ documentId }) => ({ body: { action: "transition", documentId, nextStatus: "processing" } }),
    expect: 200,
  },
  { route: "d1/reporting", method: "GET", init: () => ({ query: { ...page } }), expect: 200 },
  {
    route: "d1/reporting",
    method: "POST",
    init: ({ matterId }) => ({
      body: { action: "record_matter_report_export", matterId, exportFormat: "csv", exportScope: "summary" },
    }),
    expect: 200,
  },
  { route: "d2/court-ops", method: "GET", init: () => ({ query: { ...page } }), expect: 200 },
  {
    route: "d2/court-ops",
    method: "POST",
    init: () => ({ body: { action: "whatsapp_command", command: "/matters" } }),
    expect: 200,
  },
  { route: "d4/drafts", method: "GET", init: ({ matterId }) => ({ query: { matterId, ...page } }), expect: 200 },
  {
    route: "d4/drafts",
    method: "POST",
    init: ({ matterId }) => ({
      token: "token-associate-a",
      body: {
        action: "preflight",
        matterId,
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
    }),
    expect: 200,
  },
  { route: "p1/committee-brain", method: "GET", init: () => ({ query: { ...page } }), expect: 200 },
  {
    route: "p1/committee-brain",
    method: "POST",
    init: ({ matterId }) => ({
      body: {
        matterId,
        body: "Summarise operator-risk posture for this matter.",
        classification: "internal",
        purpose: "ops-audit",
        partyNames: ["Client A"],
      },
    }),
    expect: 200,
  },
  {
    route: "p5/tenancy",
    method: "GET",
    init: () => ({ query: { view: "memberships", firmId: "firmA", ...page } }),
    expect: 200,
  },
  {
    route: "p5/tenancy",
    method: "POST",
    init: () => ({
      body: {
        action: "update_role",
        firmId: "firmA",
        targetUserId: "clerk_a",
        nextRole: "clerk",
        nextClearance: "internal",
        reason: "boot test role confirmation",
      },
    }),
    // Re-audit N-3: retired (identity is written only by Cloud Functions); the route still boots.
    expect: 409,
  },
  { route: "d4/filings", method: "GET", init: () => ({ query: { ...page } }), expect: 200 },
  { route: "d4/filings", method: "GET", init: () => ({ query: { view: "packages", ...page } }), expect: 200 },
]

/** Literals the filings handler dispatches on, read from its source (it may only export methods). */
function filingsLiterals(): { views: string[]; actions: string[] } {
  const source = readFileSync(path.join(root, "app/api/d4/filings/route.ts"), "utf8")
  const parser = source.slice(source.indexOf("function parseFilingsView("))
  const body = parser.slice(0, parser.indexOf("\n}\n"))
  const views = [...new Set([...body.matchAll(/value === "([a-z_]+)"/g)].map((m) => m[1]!))]
  const actions = [...new Set([...source.matchAll(/parsed\.action === "([a-z_]+)"/g)].map((m) => m[1]!))]
  return { views, actions }
}

const FILINGS = filingsLiterals()
const FILINGS_CORE_ACTION_NAMES = ["create_package", "decide_package"]

/** Every frozen view and action: all of ops-reporting, and filings except the core package path. */
const FROZEN_CALLS: Array<{ route: string; method: "GET" | "POST"; init: CallInit }> = [
  { route: "d2/ops-reporting", method: "GET", init: { query: { ...page } } },
  ...OPS_GET_VIEWS.map((view) => ({
    route: "d2/ops-reporting",
    method: "GET" as const,
    init: { query: { view, ...page } },
  })),
  ...[...OPS_POST_ACTIONS, ...OPS_NOT_IMPLEMENTED_ACTIONS].map((action) => ({
    route: "d2/ops-reporting",
    method: "POST" as const,
    init: { body: { action } },
  })),
  ...FILINGS.views
    .filter((view) => view !== "packages")
    .map((view) => ({ route: "d4/filings", method: "GET" as const, init: { query: { view, ...page } } })),
  ...FILINGS.actions
    .filter((action) => !FILINGS_CORE_ACTION_NAMES.includes(action))
    .map((action) => ({ route: "d4/filings", method: "POST" as const, init: { body: { action, packageId: "pkg_x" } } })),
]

const DISABLED = { error: "feature_disabled", flag: "LEGACY_GOVERNANCE_CHAINS" }

describe("boot with every non-core layer disabled", () => {
  it("enumerates the frozen filings surface from the handler", () => {
    // Every view branch in the handler is one the parser accepts, and vice versa.
    const source = readFileSync(path.join(root, "app/api/d4/filings/route.ts"), "utf8")
    const branches = new Set([...source.matchAll(/view === "([a-z_]+)"/g)].map((m) => m[1]!))
    expect([...branches].sort()).toEqual([...FILINGS.views].sort())
    expect(FILINGS.views.length).toBeGreaterThan(40)
    expect(FILINGS.actions.length).toBeGreaterThan(100)
    for (const core of FILINGS_CORE_ACTION_NAMES) expect(FILINGS.actions).toContain(core)
  })

  it("has every non-core flag off and core on", () => {
    expect(NON_CORE_FLAGS.length).toBeGreaterThan(0)
    for (const flag of NON_CORE_FLAGS) expect(isFeatureEnabled(flag), flag).toBe(false)
    expect(isFeatureEnabled("CORE_ENABLED")).toBe(true)
  })

  it("imports every route module", { timeout: 120_000 }, async () => {
    expect(ROUTE_FILES.length).toBeGreaterThan(0)
    for (const file of ROUTE_FILES) {
      const mod = await importRoute(file)
      expect(METHODS.filter((m) => typeof mod[m] === "function").length, file).toBeGreaterThan(0)
    }
  })

  it("calls or freezes exactly every exported (route, method) pair", { timeout: 120_000 }, async () => {
    const covered = new Set([
      ...CORE_CALLS.map((c) => `${c.route} ${c.method}`),
      ...FROZEN_CALLS.map((c) => `${c.route} ${c.method}`),
    ])
    expect([...covered].sort()).toEqual([...(await exportedPairs())].sort())
  })

  it("answers every core route with a valid session and minimal input, no 5xx", { timeout: 120_000 }, async () => {
    const ctx = seedMatterAndDraft()
    for (const c of CORE_CALLS) {
      const init = c.init(ctx)
      const res = await call(c.route, c.method, init)
      const label = `${c.method} /api/${c.route} ${JSON.stringify(init.query ?? init.body ?? {})}`
      expect(res.status, `${label} -> ${JSON.stringify(res.body)}`).toBeLessThan(500)
      expect(res.body, label).not.toMatchObject({ error: "feature_disabled" })
      if (c.expect !== undefined) expect(res.status, `${label} -> ${JSON.stringify(res.body)}`).toBe(c.expect)
    }
    const { matterId, draftId } = ctx

    // The core filing path end to end: create (citation gate) then partner decision.
    const created = await call("d4/filings", "POST", {
      token: "token-associate-a",
      body: {
        action: "create_package",
        matterId,
        draftId,
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const packageId = (created.body as { result: { filingPackage: { id: string } } }).result
      .filingPackage.id
    const decided = await call("d4/filings", "POST", {
      body: {
        action: "decide_package",
        packageId,
        decision: "approve",
        reason: "Partner approved for court filing",
      },
    })
    expect(decided.status, JSON.stringify(decided.body)).toBe(200)
  })

  it("answers every frozen view and action with 404 feature_disabled", { timeout: 120_000 }, async () => {
    expect(FROZEN_CALLS.length).toBeGreaterThan(400)
    for (const c of FROZEN_CALLS) {
      const res = await call(c.route, c.method, c.init)
      const label = `${c.method} /api/${c.route} ${JSON.stringify(c.init.query ?? c.init.body)}`
      expect(res.status, label).toBe(404)
      expect(res.body, label).toEqual(DISABLED)
    }
  })

  it("still authenticates before refusing a frozen route", async () => {
    const { GET } = await load("d2/ops-reporting")
    const res = await GET!(
      new Request("http://127.0.0.1/api/d2/ops-reporting", { headers: { "X-Firm-Id": "firmA" } })
    )
    expect(res.status).toBe(401)
    const mismatch = await call("d4/filings", "GET", {
      query: { view: "dispatch", userId: "partner_b" },
    })
    expect(mismatch.status).toBe(403)
  })
})
