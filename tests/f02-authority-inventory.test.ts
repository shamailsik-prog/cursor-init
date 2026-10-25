/**
 * Register #30 / audit F02: the nine Firestore domain console APIs must share one
 * inventory — Next route modules, path constants, and Functions authority mounts.
 */
import { describe, expect, it } from "vitest"
import { F02_NEXT_AUTHORITY_ROUTES } from "../functions/src/http/f02NextAuthority"
import { F02_ROUTE_PATHS } from "@/platform/authority/f02Routes"
import { F02_ROUTE_FILES } from "@/tests/helpers/f02-route-files"

function routeKeys(): Set<string> {
  return new Set(F02_NEXT_AUTHORITY_ROUTES.map((route) => `${route.method} ${route.path}`))
}

describe("F02 authority inventory (register #30)", () => {
  it("lists the same nine Next route modules as path constants", () => {
    const pathsFromFiles = F02_ROUTE_FILES.map((file) => {
      const match = file.match(/^app\/api\/(.+)\/route\.ts$/)
      if (!match) throw new Error(`unexpected F02 route file: ${file}`)
      return `/api/${match[1]}`
    })
    expect(pathsFromFiles.sort()).toEqual([...F02_ROUTE_PATHS].sort())
  })

  it("mounts GET and POST on the in-process Functions router for every F02 path", () => {
    const keys = routeKeys()
    for (const path of F02_ROUTE_PATHS) {
      expect(keys.has(`GET ${path}`), `missing GET ${path}`).toBe(true)
      expect(keys.has(`POST ${path}`), `missing POST ${path}`).toBe(true)
    }
    expect(F02_NEXT_AUTHORITY_ROUTES.length).toBe(F02_ROUTE_PATHS.length * 2)
  })
})
