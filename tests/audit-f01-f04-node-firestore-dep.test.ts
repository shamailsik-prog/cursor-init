import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("FA-F01-004 Node 22 and @google-cloud/firestore dependency", () => {
  it("declares engines.node >= 22 and @google-cloud/firestore in package.json", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      engines?: { node?: string }
      dependencies?: Record<string, string>
    }
    expect(pkg.engines?.node).toBe(">=22")
    expect(pkg.dependencies?.["@google-cloud/firestore"]).toBeTruthy()
  })
})
