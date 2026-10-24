import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const WORKFLOW = path.resolve(__dirname, "../../../.github/workflows/backup-drill.yml")

describe("backup-drill workflow", () => {
  it("alerts when the scheduled drill fails", () => {
    const yaml = readFileSync(WORKFLOW, "utf8")
    expect(yaml).toContain("Alert on backup drill failure")
    expect(yaml).toMatch(/if:\s*failure\(\)/)
    expect(yaml).toMatch(/github\.event_name\s*==\s*'schedule'/)
  })
})
