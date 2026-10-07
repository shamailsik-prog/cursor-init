import { randomUUID } from "node:crypto"
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

/**
 * Gate G-2 (L18 §10, web and WhatsApp side): "two test firms seeded; every
 * read function in D1-1, D1-2, D3-1, D5-1, D2-1 attempted cross-firm through
 * web and WhatsApp returns deny", plus the P5 tenancy views and actions
 * ("live cross-tenant test on P5", v19 line 7387 item 76).
 *
 * Firm A and firm B are seeded through the real route handlers (tests/g2/harness.ts).
 * For every read path (tests/g2/paths.ts):
 * - a firm-A control request must show firm-A data (the leak check is live);
 * - each firm-B role first sends the path's own-scope `base` request; at
 *   least one role must get 200. Only roles whose base succeeded make
 *   boundary attempts: the firm/identity spoofs of that base (X-Firm-Id,
 *   firmId, actorId, userId), which must be refused with FIRM_MISMATCH /
 *   IDENTITY_MISMATCH, and the attacks aimed at firm-A objects, which must be
 *   refused with the exact reason that path gives for a firm-A object;
 * - no response of any role (headers or body) may carry a firm-A identifier
 *   (every id-like field of every firm-A row in the store) or name.
 *
 * The inventory (tests/g2/discovery.ts) reads every method, view, action,
 * WhatsApp command, query param, body field and header from each route's
 * declared surface (app/api/<route>/surface.ts), which the route can only
 * dispatch through (tests/g2.surface-guard.test.ts); anything not tested,
 * attacked or reviewed fails, and a self-test checks surface changes are caught. Runs in memory persistence always and in
 * Firestore persistence too when the emulator is up (ci_gates/gate_g2.sh,
 * which requires both). `G2_COVERAGE_OUT` receives the coverage rows.
 */

const verifyIdToken = vi.fn()
vi.mock("firebase-admin/app", () => ({
  getApps: () => [],
  initializeApp: () => ({ name: "g2-test-app" }),
  applicationDefault: () => ({}),
}))
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }))

import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { setLogLevel } from "firebase/firestore"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { resetSessionStateForTests } from "@/platform/p5/session"
import { getRuntimeRepositories, setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import {
  FIRM_A,
  FIRM_A_USERS,
  FIRM_B,
  FIRM_B_USERS,
  MODULES,
  SURFACES,
  firmMarkers,
  placeholderSeed,
  seedFirm,
  send,
  tokenOf,
  user,
  type Call,
  type FirmSeed,
} from "./g2/harness"
import {
  NON_SELECTOR_BODY_FIELDS,
  NON_SELECTOR_PARAMS,
  NOT_BUILT,
  REVIEWED_HEADERS,
  OUT_OF_SCOPE_MODULES,
  OUT_OF_SCOPE_SELECTORS,
  READ_PATHS,
  selectorKey,
  type Attack,
  type ReadPath,
} from "./g2/paths"
import { discover, inventoryProblems, type Coverage } from "./g2/discovery"
import type { RouteSurface } from "@/platform/http/surface"

function installVerifier(): void {
  const table = new Map([...FIRM_A_USERS, ...FIRM_B_USERS].map((u) => [tokenOf(u.id), u]))
  verifyIdToken.mockReset()
  verifyIdToken.mockImplementation(async (token: string) => {
    const u = table.get(token)
    if (!u) throw new Error("invalid token")
    return { uid: u.id, firmId: u.firmId, role: u.role, clearanceLevel: u.clearanceLevel }
  })
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..")

function routeModules(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name === "route.ts") out.push(full)
    }
  }
  walk(path.join(ROOT, "app/api"))
  return out.map((f) => `/${path.relative(ROOT, path.dirname(f)).split(path.sep).join("/").replace(/^app\//, "")}`).sort()
}

const SPOOFED_PARAMS = ["firmId", "actorId", "userId"]
/** A firm-A object in a placeholder-seeded attack: a firm-A seed id or a firm-A user. */
const FIRM_A_VALUE = new RegExp(`${FIRM_A}-|"(?:${FIRM_A_USERS.map((u) => u.id).join("|")})"`)
const methodsOf = (route: string) => Object.keys(MODULES[route]).filter((k) => /^[A-Z]+$/.test(k))

/** What the attacks cover on each route (aimed attacks evaluated on placeholder seeds). */
function coverageOf(route: string): Coverage {
  const a = placeholderSeed(FIRM_A)
  const b = placeholderSeed(FIRM_B)
  const paths = READ_PATHS.filter((p) => p.route === route)
  const aimed = paths.map((p) => [selectorKey(p), p.aimed(a, b)] as const)
  return {
    listedSelectors: new Set([...READ_PATHS.map(selectorKey), ...Object.keys(OUT_OF_SCOPE_SELECTORS)]),
    outOfScopeSelectors: new Set(Object.keys(OUT_OF_SCOPE_SELECTORS)),
    attackedParams: new Set([...SPOOFED_PARAMS, ...aimed.flatMap(([, xs]) => xs.flatMap((x) => Object.keys(x.call.query ?? {})))]),
    reviewedParams: new Set(Object.keys(NON_SELECTOR_PARAMS)),
    // A body field counts as attacked only when some aimed attack sets it to a firm-A object (placeholder ids / firm-A users).
    attackedBodyFields: new Map(
      aimed.map(([key, xs]) => [
        key,
        new Set(xs.flatMap((x) => Object.entries(x.call.body ?? {}).filter(([, v]) => FIRM_A_VALUE.test(JSON.stringify(v))).map(([k]) => k))),
      ])
    ),
    reviewedBodyFields: new Set(Object.keys(NON_SELECTOR_BODY_FIELDS)),
    reviewedHeaders: new Set(Object.keys(REVIEWED_HEADERS)),
  }
}

function problemsOf(route: string, surface: RouteSurface = SURFACES[route], methods = methodsOf(route)): string[] {
  return inventoryProblems(route, discover(route, surface, methods), coverageOf(route))
}

/** Surface changes the inventory must catch (the review's forms that change what a route accepts). */
const MUTATIONS: Array<[string, string, (s: RouteSurface) => RouteSurface, string[]?]> = [
  ["J a new body field on an existing action", "/api/d1/clients", (s) => ({ ...s, bodyFields: { ...s.bodyFields, conflict_check: [...s.bodyFields.conflict_check, "entityIds"] } })],
  ["a new non-id-named body field (caseRef)", "/api/d1/clients", (s) => ({ ...s, bodyFields: { ...s.bodyFields, conflict_check: [...s.bodyFields.conflict_check, "caseRef"] } })],
  // On revoke_session_reference: update_role is retired and out of the read set (re-audit N-3).
  ["a new body field on a tenancy action (scope)", "/api/p5/tenancy", (s) => ({ ...s, bodyFields: { ...s.bodyFields, revoke_session_reference: [...s.bodyFields.revoke_session_reference, "scope"] } })],
  ["a new by-id query param", "/api/d1/clients", (s) => ({ ...s, queryParams: [...s.queryParams, "id"] })],
  ["a new view", "/api/d1/document-workflow", (s) => ({ ...s, views: [...s.views, "export_all"] })],
  ["a new action", "/api/p5/tenancy", (s) => ({ ...s, actions: [...s.actions, "dump_firm"], bodyFields: { ...s.bodyFields, dump_firm: ["action", "actorId", "firmId"] } })],
  ["a new WhatsApp command", "/api/d2/court-ops", (s) => ({ ...s, commands: [...(s.commands ?? []), "hearings"] })],
  ["a new request header", "/api/d1/matters", (s) => ({ ...s, headers: [...s.headers, "x-view"] })],
  ["another exported method", "/api/d1/clients", (s) => s, ["GET", "POST", "PATCH"]],
]

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

type CoverageRow = {
  suite: string
  mode: string
  service: string
  channel: string
  path: string
  status: string
  attempts: number
  allowed: number
  roleRefused?: string[]
  note?: string
}
const coverage: CoverageRow[] = []

afterAll(() => {
  const out = process.env.G2_COVERAGE_OUT
  if (!out) return
  const rows: CoverageRow[] = [
    ...coverage,
    ...NOT_BUILT.map((n) => ({ suite: "next", mode: "-", service: n.service, channel: n.channel, path: n.path, status: "not_built", attempts: 0, allowed: 0, note: n.note })),
    ...Object.entries(OUT_OF_SCOPE_MODULES).map(([route, why]) => ({
      suite: "next",
      mode: "-",
      service: why.split(" ")[0],
      channel: "web",
      path: route,
      status: "out_of_scope",
      attempts: 0,
      allowed: 0,
      note: why,
    })),
    ...Object.entries(OUT_OF_SCOPE_SELECTORS).map(([sel, why]) => ({ suite: "next", mode: "-", service: why.split(" ")[0], channel: "web", path: sel, status: "out_of_scope", attempts: 0, allowed: 0, note: why })),
  ]
  writeFileSync(out, JSON.stringify({ suite: "next", rows }, null, 2))
})

describe("G-2 read-path inventory", () => {
  it("every app/api route module is either a G-2 module or mapped out of scope", () => {
    const inScope = new Set(Object.keys(MODULES))
    expect(routeModules().filter((r) => !inScope.has(r) && !(r in OUT_OF_SCOPE_MODULES))).toEqual([])
    for (const r of [...inScope, ...Object.keys(OUT_OF_SCOPE_MODULES)]) expect(routeModules()).toContain(r)
  })

  it("every G-2 module declares its request surface", () => {
    expect(Object.keys(SURFACES).sort()).toEqual(Object.keys(MODULES).sort())
  })

  it("every method, view, action, command, query param, body field and header of the G-2 surfaces is tested, attacked or reviewed", () => {
    expect(Object.keys(MODULES).flatMap((route) => problemsOf(route))).toEqual([])
  })

  it("nothing listed is stale: every tested or reviewed selector is still declared", () => {
    const declared = new Set(Object.keys(MODULES).flatMap((route) => discover(route, SURFACES[route], methodsOf(route)).selectors))
    expect([...coverageOf("/api/d1/clients").listedSelectors].filter((s) => !declared.has(s))).toEqual([])
  })

  it.each(MUTATIONS)("self-test: the inventory catches %s", (_label, route, mutate, methods) => {
    expect(problemsOf(route, mutate(SURFACES[route]), methods ?? methodsOf(route)).length).toBeGreaterThan(0)
  })

  it("each G-2 service has tested read paths or NOT_BUILT entries", () => {
    for (const s of ["D1-1", "D1-2", "D3-1", "D5-1", "D2-1", "P5"] as const) {
      expect([s, READ_PATHS.some((p) => p.service === s) || NOT_BUILT.some((n) => n.service === s)]).toEqual([s, true])
    }
  })
})

// ---------------------------------------------------------------------------
// Attacks
// ---------------------------------------------------------------------------

/** The tenant and identity spoofs of a firm-B caller's own base request. */
function spoofs(base: Call, readPath: ReadPath): Attack[] {
  const withParam = (key: string, value: string): Call =>
    base.method === "GET" ? { ...base, query: { ...base.query, [key]: value } } : { ...base, body: { ...base.body, [key]: value } }
  const subject = new Set(readPath.subjectParams ?? [])
  return [
    { label: "X-Firm-Id=firmA", call: { ...base, firmHeader: FIRM_A }, mustDeny: true, expect: /FIRM_MISMATCH/ },
    { label: "firmId=firmA", call: withParam("firmId", FIRM_A), mustDeny: true, expect: /IDENTITY_MISMATCH/ },
    { label: "actorId=partner_a", call: withParam("actorId", "partner_a"), mustDeny: true, expect: /IDENTITY_MISMATCH/ },
    ...(base.method === "GET" && !subject.has("userId")
      ? [{ label: "userId=client_a", call: withParam("userId", "client_a"), mustDeny: true, expect: /IDENTITY_MISMATCH/ }]
      : []),
  ]
}

const MODES = ["memory", ...(process.env.FIRESTORE_EMULATOR_HOST ? ["firestore"] : [])] as const

describe.each(MODES)("G-2 cross-firm isolation, %s persistence", (mode) => {
  let env: RulesTestEnvironment | undefined
  let A: FirmSeed
  let B: FirmSeed

  /** Runs `fn` with this mode's persistence wired (Firestore: an admin context on the emulator). */
  async function inMode<T>(fn: () => Promise<T>): Promise<T> {
    if (mode === "memory") return fn()
    let result!: T
    await env!.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      try {
        result = await fn()
      } finally {
        setFirestorePersistenceForTests(null)
      }
    })
    return result
  }

  beforeAll(async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("FIREBASE_PROJECT_ID", "demo-sikander")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", mode)
    resetSessionStateForTests()
    resetRuntimeStoreForTests()
    installVerifier()
    if (mode === "firestore") {
      setLogLevel("silent")
      env = await initializeTestEnvironment({
        projectId: "demo-g2-next",
        firestore: { rules: readFileSync(path.join(ROOT, "firestore.rules"), "utf8") },
      })
      await env.clearFirestore()
    }
    await inMode(async () => {
      const store = getRuntimeStore()
      const repos = await getRuntimeRepositories(store)
      for (const u of [...FIRM_A_USERS, ...FIRM_B_USERS]) {
        store.users.set(u.id, u)
        await repos.users.upsert(u)
      }
      A = await seedFirm(FIRM_A, "alpha")
      B = await seedFirm(FIRM_B, "beta")
    })
  }, 300_000)

  afterAll(async () => {
    await env?.cleanup()
    vi.unstubAllEnvs()
    resetSessionStateForTests()
    resetRuntimeStoreForTests()
  })

  it.each(READ_PATHS.map((p) => [selectorKey(p), p] as const))("%s: every firm-B role is denied firm-A data", async (_key, readPath) => {
    await inMode(async () => {
      const failures: string[] = []

      if (readPath.control) {
        const call = await readPath.control.call(A)
        const res = await send(user(readPath.control.as), call)
        const shows = readPath.control.shows?.(A) ?? FIRM_A
        if (res.status !== 200) failures.push(`control as ${readPath.control.as}: status ${res.status} ${res.text}`)
        else if (!res.text.includes(shows)) failures.push(`control as ${readPath.control.as}: firm-A data (${shows}) not shown`)
      }

      const markers = firmMarkers(A)
      const leaksIn = (text: string, call: Call) => {
        // A marker the caller itself sent (an id it aimed at, a query it typed) may be echoed; any other is a leak.
        const sent = JSON.stringify(call)
        return markers.filter((m) => text.includes(m) && !sent.includes(m))
      }

      const cache = new Map<string, unknown>()
      const fresh = async <T,>(key: string, build: () => Promise<T>): Promise<T> => {
        if (!cache.has(key)) cache.set(key, await build())
        return cache.get(key) as T
      }

      let attempts = 0
      let allowed = 0
      const baseOk: string[] = []
      const roleRefused: string[] = []
      // Partner last: a successful base consumes its fresh state, a refused one leaves it for the next role.
      for (const caller of [...FIRM_B_USERS].reverse()) {
        const baseCall = await readPath.base({ caller, A, B, fresh })
        const baseRes = await send(caller, baseCall)
        const baseLeak = leaksIn(baseRes.text, baseCall)
        if (baseLeak.length) failures.push(`${caller.id} base: leaked ${baseLeak.join(",")}`)
        if (baseRes.status >= 500) failures.push(`${caller.id} base: server error ${baseRes.status} ${baseRes.text}`)
        const counted = baseRes.status === 200
        if (counted) {
          baseOk.push(caller.id)
          cache.clear()
        } else {
          roleRefused.push(`${caller.id}:${baseRes.status}`)
        }

        for (const attack of [...spoofs(baseCall, readPath), ...readPath.aimed(A, B)]) {
          const res = await send(caller, attack.call)
          const leak = leaksIn(res.text, attack.call)
          const refused = res.status >= 400 && res.status < 500
          if (counted) attempts++
          if (leak.length > 0 || (counted && attack.mustDeny && !refused)) {
            allowed++
            failures.push(`${caller.id} ${attack.label}: status ${res.status}${leak.length ? `, leaked ${leak.join(",")}` : ""}`)
          } else if (counted && attack.mustDeny && attack.expect && !attack.expect.test(res.text)) {
            failures.push(`${caller.id} ${attack.label}: refused ${res.status} for another reason: ${res.text.split("\n")[1]}`)
          }
          if (res.status >= 500) failures.push(`${caller.id} ${attack.label}: server error ${res.status} ${res.text}`)
        }
      }
      if (baseOk.length === 0) failures.push(`no firm-B role could run the base request (${roleRefused.join(", ")})`)

      coverage.push({
        suite: "next",
        mode,
        service: readPath.service,
        channel: readPath.channel,
        path: selectorKey(readPath),
        status: "tested",
        attempts,
        allowed,
        roleRefused,
        note: readPath.note,
      })
      expect(failures).toEqual([])
      expect(attempts).toBeGreaterThan(0)
    })
  }, 300_000)

  it("the Idempotency-Key of a firm-A write replays nothing to a firm-B caller", async () => {
    await inMode(async () => {
      const key = randomUUID()
      const aBody = { action: "conflict_check", firmId: FIRM_A, entityId: A.entityId }
      const first = await send(user("partner_a"), { route: "/api/d1/clients", method: "POST", body: aBody, idempotencyKey: key })
      expect(first.status).toBe(200)
      const markers = firmMarkers(A)
      for (const caller of FIRM_B_USERS) {
        for (const body of [{ action: "conflict_check", firmId: FIRM_B, entityId: B.entityId }, { action: "conflict_check", entityId: A.entityId }]) {
          const res = await send(caller, { route: "/api/d1/clients", method: "POST", body, idempotencyKey: key })
          const sent = JSON.stringify(body)
          expect([caller.id, markers.filter((m) => res.text.includes(m) && !sent.includes(m))]).toEqual([caller.id, []])
        }
      }
    })
  }, 60_000)
})
