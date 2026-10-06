import { readdirSync, statSync } from "node:fs"
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
import { resetSessionStateForTests } from "@/platform/p5/session"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { composeDraft } from "@/services/d4-1/drafts"
import { getDocumentTypes } from "@/lib/foundation-data"

const TOKENS: Record<string, Record<string, unknown>> = {
  "token-partner-a": { uid: "partner_a", firmId: "firmA", role: "partner" },
  "token-associate-a": { uid: "associate_a", firmId: "firmA" },
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

async function load(route: string): Promise<RouteModule> {
  return (await import(`@/app/api/${route}/route`)) as RouteModule
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
  return { matterId: matter.id, draftId: draft.id }
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
})

const DISABLED = { error: "feature_disabled", flag: "LEGACY_GOVERNANCE_CHAINS" }

describe("boot with every non-core layer disabled", () => {
  it("has every non-core flag off and core on", () => {
    expect(NON_CORE_FLAGS.length).toBeGreaterThan(0)
    for (const flag of NON_CORE_FLAGS) expect(isFeatureEnabled(flag), flag).toBe(false)
    expect(isFeatureEnabled("CORE_ENABLED")).toBe(true)
  })

  it("imports every route module", { timeout: 120_000 }, async () => {
    expect(ROUTE_FILES.length).toBeGreaterThan(0)
    for (const file of ROUTE_FILES) {
      const mod = (await import(`@/${file.replace(/\.tsx?$/, "")}`)) as Record<string, unknown>
      const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter(
        (m) => typeof mod[m] === "function"
      )
      expect(methods.length, file).toBeGreaterThan(0)
    }
  })

  it("answers every core route with a valid session and minimal input, no 5xx", { timeout: 120_000 }, async () => {
    const { matterId, draftId } = seedMatterAndDraft()
    const page = { limit: "10", cursor: "0" }
    const calls: Array<[string, "GET" | "POST", { query?: Record<string, string>; body?: unknown; token?: string }, number?]> = [
      ["g0/monitor", "GET", {}, 200],
      ["g0/normalise", "POST", { body: { raw: "CP 1234", courtId: "SHC" } }, 200],
      ["d1/matters", "GET", { query: { ...page } }, 200],
      [
        "d1/matters",
        "POST",
        {
          body: {
            action: "create",
            firmId: "firmA",
            clientId: "client_a",
            title: "Boot-created matter",
            courtId: "SHC",
            classification: "internal",
          },
        },
        200,
      ],
      ["d1/clients", "GET", { query: { ...page } }, 200],
      ["d1/documents", "GET", { query: { matterId, ...page } }, 200],
      ["d1/document-workflow", "GET", { query: { matterId, ...page } }, 200],
      ["d1/reporting", "GET", { query: { ...page } }, 200],
      ["d2/court-ops", "GET", { query: { ...page } }, 200],
      ["d4/drafts", "GET", { query: { matterId, ...page } }, 200],
      ["d4/drafts", "GET", { query: { view: "templates", ...page } }, 200],
      [
        "d4/drafts",
        "POST",
        {
          token: "token-associate-a",
          body: {
            action: "preflight",
            matterId,
            classification: "internal",
            citedJudgmentIds: [],
            temporalCitations: [],
          },
        },
        200,
      ],
      ["p1/committee-brain", "GET", { query: { ...page } }, 200],
      ["p5/tenancy", "GET", { query: { view: "memberships", firmId: "firmA", ...page } }, 200],
      ["d4/filings", "GET", { query: { ...page } }, 200],
      ["d4/filings", "GET", { query: { view: "packages", ...page } }, 200],
    ]
    for (const [route, method, init, expected] of calls) {
      const res = await call(route, method, init)
      const label = `${method} /api/${route} ${JSON.stringify(init.query ?? init.body ?? {})}`
      expect(res.status, `${label} -> ${JSON.stringify(res.body)}`).toBeLessThan(500)
      expect(res.body, label).not.toMatchObject({ error: "feature_disabled" })
      if (expected !== undefined) expect(res.status, `${label} -> ${JSON.stringify(res.body)}`).toBe(expected)
    }

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

  it("answers every frozen route with 404 feature_disabled", async () => {
    const page = { limit: "10", cursor: "0" }
    const frozen: Array<[string, "GET" | "POST", { query?: Record<string, string>; body?: unknown }]> = [
      ["d2/ops-reporting", "GET", { query: { ...page } }],
      ["d2/ops-reporting", "GET", { query: { view: "alert_waiver_expiry_disputes", ...page } }],
      ["d2/ops-reporting", "POST", { body: { action: "acknowledge_workflow_ops_alert_digest" } }],
      ["d4/filings", "GET", { query: { view: "dispatch", ...page } }],
      ["d4/filings", "GET", { query: { view: "escalation_owner_rota", ...page } }],
      ["d4/filings", "POST", { body: { action: "assign_primary_owner", packageId: "pkg_x" } }],
      ["d4/filings", "POST", { body: { action: "record_submission_receipt", packageId: "pkg_x" } }],
    ]
    for (const [route, method, init] of frozen) {
      const res = await call(route, method, init)
      const label = `${method} /api/${route} ${JSON.stringify(init.query ?? init.body)}`
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
