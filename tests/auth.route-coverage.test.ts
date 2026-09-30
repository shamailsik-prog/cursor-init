import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

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
