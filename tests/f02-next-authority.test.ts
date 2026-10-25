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

import { F02_ROUTE_FILES } from "@/tests/helpers/f02-route-files"

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
