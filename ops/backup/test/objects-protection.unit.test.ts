import { describe, expect, it } from "vitest"
import { desiredVaultProtection } from "../objects/protection"
import { loadInfraConfig } from "../config"
import path from "node:path"

const REPO = path.resolve(__dirname, "../../..")

describe("document vault object lock mode", () => {
  it("requires COMPLIANCE retention in infra config (not bypassable GOVERNANCE)", () => {
    const cfg = loadInfraConfig(REPO).documentVault
    expect(cfg.governanceMode).toBe("COMPLIANCE")
    expect(desiredVaultProtection(cfg).mode).toBe("COMPLIANCE")
  })
})
