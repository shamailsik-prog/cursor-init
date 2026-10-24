import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { DEPLOY_PROFILE_GCP_PROJECT_ID, gcpProjectIdForDeployProfile } from "../src/deployManifestProfile"

describe("deploy manifest profile binding (F32 R5-004 / R5FU-003)", () => {
  it("matches infra/deploy-manifest.json environments", () => {
    const manifestPath = path.resolve(process.cwd(), "..", "infra", "deploy-manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      environments: Record<string, { gcpProjectId?: string; env?: Record<string, string> }>
    }
    for (const [profile, cfg] of Object.entries(manifest.environments)) {
      if (profile === "local") continue
      expect(cfg.gcpProjectId).toBe(DEPLOY_PROFILE_GCP_PROJECT_ID[profile])
      expect(cfg.env?.SIKANDER_DEPLOY_PROFILE).toBe(profile)
    }
  })

  it("does not treat prototype pollution keys as deploy profiles", () => {
    expect(gcpProjectIdForDeployProfile("__proto__")).toBeUndefined()
    expect(gcpProjectIdForDeployProfile("constructor")).toBeUndefined()
  })
})
