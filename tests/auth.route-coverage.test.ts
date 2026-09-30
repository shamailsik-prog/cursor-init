import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("firebase-admin/app", () => ({
  getApps: () => [],
  initializeApp: () => ({ name: "test-app" }),
  applicationDefault: () => ({}),
}))
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: async () => {
      throw new Error("no token should reach the verifier in this test")
    },
  }),
}))

// Behavioural check (#8): import every route module and call every exported
// HTTP method with no credentials in the default firebase mode. Anything but a
// 401 means the handler is reachable without authentication. The regex checks
// below are a secondary lint.
// Every exported HTTP handler under app/api must go through withSession, and
// only the reviewed allow-list may opt out of authentication.
const PUBLIC_ROUTES = new Set(["app/api/g0/monitor/route.ts"])
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...routeFiles(full))
    else if (/^route\.(ts|tsx|js)$/.test(name)) out.push(full)
  }
  return out
}

const root = path.resolve(__dirname, "..")
const files = routeFiles(path.join(root, "app/api")).map((f) => path.relative(root, f))

describe("app/api route authentication coverage", () => {
  it("finds route files", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file} wraps every exported handler with withSession`, () => {
      const source = readFileSync(path.join(root, file), "utf8")
      for (const method of METHODS) {
        const exported = new RegExp(
          `export\\s+(?:async\\s+)?(?:function\\s+${method}\\b|const\\s+${method}\\b)`
        ).test(source)
        if (!exported) continue
        const wrapped = new RegExp(
          `export\\s+async\\s+function\\s+${method}\\(request: Request\\)\\s*\\{\\s*return withSession\\(request, handle\\w+(?:, [^)]+)?\\)\\s*\\}`
        ).test(source)
        expect(wrapped, `${file} ${method} must be \`return withSession(request, handle...)\``).toBe(
          true
        )
      }
      const isPublic = /withSession\([^)]*\{\s*public:\s*true\s*\}/.test(source)
      expect(isPublic).toBe(PUBLIC_ROUTES.has(file))
    })
  }
})

describe("app/api routes reject unauthenticated calls (behavioural)", () => {
  beforeAll(async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("FIREBASE_PROJECT_ID", "demo-sikander")
    const { resetSessionStateForTests } = await import("@/platform/p5/session")
    resetSessionStateForTests()
  })
  afterAll(() => {
    vi.unstubAllEnvs()
  })

  for (const file of files) {
    it(`${file}: every exported method returns 401 without a token`, { timeout: 120_000 }, async () => {
      const mod = (await import(`@/${file.replace(/\.tsx?$/, "")}`)) as Record<string, unknown>
      const exported = METHODS.filter((m) => typeof mod[m] === "function")
      expect(exported.length).toBeGreaterThan(0)
      for (const method of exported) {
        const handler = mod[method] as (req: Request) => Promise<Response>
        const hasBody = method !== "GET" && method !== "HEAD"
        const req = new Request(`http://127.0.0.1/${file.replace(/\/route\.tsx?$/, "")}?actorId=partner_a&userId=partner_a&limit=1&cursor=0`, {
          method,
          headers: hasBody
            ? { "Content-Type": "application/json", "Idempotency-Key": "8e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b" }
            : {},
          body: hasBody ? JSON.stringify({ actorId: "partner_a", firmId: "firmA", action: "create" }) : undefined,
        })
        const res = await handler(req)
        if (PUBLIC_ROUTES.has(file)) {
          expect(res.status, `${file} ${method}`).not.toBe(401)
        } else {
          expect(res.status, `${file} ${method}`).toBe(401)
        }
      }
    })
  }
})
