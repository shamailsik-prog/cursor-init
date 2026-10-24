import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const ADVISORIES = path.resolve(__dirname, "../../../docs/audits/known-advisories.md")

describe("known-advisories", () => {
  it("does not allowlist patched root undici GHSA-xjj6-f33q-929c after FA-DEP-002", () => {
    const doc = readFileSync(ADVISORIES, "utf8")
    expect(doc).not.toContain("GHSA-xjj6-f33q-929c")
  })
})
