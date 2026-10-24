import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const SOURCE = readFileSync("tests/f32-ttl-collections.firestore.test.ts", "utf8")

describe("F32 TTL emulator structural probes (R119-003)", () => {
  it("does not hard-code auditor mutant claim or doc id literals", () => {
    expect(SOURCE).not.toMatch(/\bsupport\s*:/)
    expect(SOURCE).not.toMatch(/STRUCTURAL_PROBE_DOC_ID\s*=\s*["']target["']/)
    expect(SOURCE).not.toMatch(/\bcustomBypass\b/)
    expect(SOURCE).toMatch(/randomBytes|crypto\.randomUUID/)
  })
})
