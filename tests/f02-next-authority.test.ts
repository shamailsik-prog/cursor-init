/**
 * Audit F02: the nine Next.js domain routes that still read and write Firestore
 * on their own must enter through the Functions authority wrapper. `/api/g0/normalise`
 * is not one of them (no domain repository). This file fails until each route
 * module delegates with `withF02Authority`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = process.cwd()

/** Next-only domain routes that call `getRuntimeRepositories` (issue #30, F02). */
export const F02_ROUTE_FILES = [
  "app/api/d1/matters/route.ts",
  "app/api/d1/documents/route.ts",
  "app/api/d1/document-workflow/route.ts",
  "app/api/d1/reporting/route.ts",
  "app/api/d2/court-ops/route.ts",
  "app/api/d2/ops-reporting/route.ts",
  "app/api/d4/drafts/route.ts",
  "app/api/d4/filings/route.ts",
  "app/api/p5/tenancy/route.ts",
] as const

function source(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
}

describe("F02 Next authority entry", () => {
  it.each(F02_ROUTE_FILES)("%s delegates through withF02Authority", (file) => {
    expect(source(file)).toContain("withF02Authority(")
  })

  it("leaves the normaliser on the Next path", () => {
    expect(source("app/api/g0/normalise/route.ts")).not.toContain("withF02Authority(")
  })
})
