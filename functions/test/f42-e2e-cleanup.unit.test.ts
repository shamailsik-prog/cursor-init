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

  it("afterAll wires deleteFirmScopedData to the file-level firms and uids arrays (kills M4 empty-array mutant)", () => {
    const src = readFileSync(DELETION_E2E, "utf8")
    // FA-F42-R1-015-001-001: require the call inside the afterAll(async () => { … }, 120_000) hook body,
    // not merely somewhere after the substring "afterAll" (e.g. import line + Mmove it.skip at EOF).
    expect(src).toMatch(
      /afterAll\s*\(\s*async\s*\(\s*\)\s*=>\s*\{[\s\S]*?deleteFirmScopedData\s*\(\s*firms\s*,\s*uids\s*\)[\s\S]*?\},\s*120_000\s*\)/,
    )
    expect(src).not.toMatch(/deleteFirmScopedData\s*\(\s*\[\s*\]\s*,\s*\[\s*\]\s*\)/)
  })

  it("FA-F42-R1-015-001-001: Mmove (cleanup only in it.skip) fails the afterAll hook guard", () => {
    const mmoveSrc = `
import { afterAll, it } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
afterAll(async () => {}, 120_000)
it.skip("moved cleanup", () => { deleteFirmScopedData(firms, uids) })
`
    expect(mmoveSrc).not.toMatch(
      /afterAll\s*\(\s*async\s*\(\s*\)\s*=>\s*\{[\s\S]*?deleteFirmScopedData\s*\(\s*firms\s*,\s*uids\s*\)[\s\S]*?\},\s*120_000\s*\)/,
    )
  })
})
