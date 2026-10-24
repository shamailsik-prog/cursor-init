import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { loadInfraConfig } from "../config"

const REPO = path.resolve(__dirname, "../../..")

describe("infra backup config", () => {
  it("loads and validates policy.json", () => {
    const cfg = loadInfraConfig(REPO)
    expect(cfg.policy.stores["postgres-logical"]).toBeDefined()
    expect(cfg.policy.stores.firestore?.ownerRole).toBeTruthy()
  })

  it("matches runbook RPO/RTO table rows", () => {
    const runbook = readFileSync(path.join(REPO, "docs/runbooks/backup-restore.md"), "utf8")
    const cfg = loadInfraConfig(REPO)
    for (const [store, row] of Object.entries(cfg.policy.stores) as Array<
      [string, { rpo: string; rtoTargetMinutes: number }]
    >) {
      expect(runbook).toContain(store)
      expect(runbook).toContain(row.rpo)
      expect(runbook).toContain(String(row.rtoTargetMinutes))
    }
  })
})
