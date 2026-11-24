import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HttpError } from "../src/http/errors"
import { assertLooseVaultEnabled, isLooseVaultEnabled } from "../src/d1/looseVault/flag"

/**
 * Module-shape tests for the loose vault (L4.5 / E-18). They do not touch Firestore.
 * The env name is hardcoded so a rename of the flag constant cannot hide a miss.
 */
const FLAG = "SIKANDER_FLAG_L4_LOOSE_VAULT"
const DIR = path.resolve(__dirname, "../src/d1/looseVault")

const saved = process.env[FLAG]
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG]
  else process.env[FLAG] = saved
})

describe("loose vault flag", () => {
  it("is off unless the env value is exactly true after trim", () => {
    delete process.env[FLAG]
    expect(isLooseVaultEnabled()).toBe(false)
    process.env[FLAG] = ""
    expect(isLooseVaultEnabled()).toBe(false)
    process.env[FLAG] = "false"
    expect(isLooseVaultEnabled()).toBe(false)
    process.env[FLAG] = "yes"
    expect(isLooseVaultEnabled()).toBe(false)
    process.env[FLAG] = " TRUE "
    expect(isLooseVaultEnabled()).toBe(true)
    delete process.env[FLAG]
    expect(() => assertLooseVaultEnabled()).toThrow(HttpError)
    try {
      assertLooseVaultEnabled()
    } catch (err) {
      expect(err).toMatchObject({ status: 404, code: "feature_disabled" })
    }
  })
})

describe("loose vault source", () => {
  it("has no delete path in the module", () => {
    const files = readdirSync(DIR).filter((name) => name.endsWith(".ts"))
    expect(files).toEqual(expect.arrayContaining(["tags.ts", "search.ts", "convert.ts", "escalation.ts", "flag.ts"]))
    for (const name of files) {
      const src = readFileSync(path.join(DIR, name), "utf8")
      expect(src.includes(".delete("), name).toBe(false)
      expect(src.includes("recursiveDelete"), name).toBe(false)
    }
  })

  it("convert never writes a null matterId", () => {
    const src = readFileSync(path.join(DIR, "convert.ts"), "utf8")
    expect(src).not.toMatch(/matterId:\s*null/)
  })

  it("records the per-uploader upload-block reading and that nothing is deleted", () => {
    const readme = readFileSync(path.join(DIR, "README.md"), "utf8")
    expect(readme.toLowerCase()).toContain("per uploader")
    expect(readme.toLowerCase()).toContain("never delet")
    expect(readme).toContain("SIKANDER_FLAG_L4_LOOSE_VAULT")
  })
})
