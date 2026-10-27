import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const DELETION_E2E = path.join(__dirname, "f42-retention-deletion.e2e.emu.test.ts")

describe("FA-F42-R1-015: F42 deletion e2e registers every extra firm and auth user for afterAll cleanup", () => {
  it("records otherFirm (uniq(\"f42x\")) and the low-clearance partner uid", () => {
    const src = readFileSync(DELETION_E2E, "utf8")
    expect(src).toMatch(/const otherFirm = uniq\("f42x"\)[\s\S]*?firms\.push\(otherFirm\)/)
    expect(src).toMatch(
      /const low = await mintIdToken\(\{ firmId: f\.firmId, role: "partner", clearanceLevel: "public" \}\)[\s\S]*?uids\.push\(low\.uid\)/,
    )
  })
})
