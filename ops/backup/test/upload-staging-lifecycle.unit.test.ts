import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { UPLOAD_STAGING_LIFECYCLE_DAYS, UPLOAD_STAGING_OBJECT_PREFIX } from "@/platform/documents/documentObjectStore"
import { loadInfraConfig } from "../config"
import { desiredUploadStagingLifecycle } from "../objects/protection"

const REPO = path.resolve(__dirname, "../../..")

describe("upload-staging bucket lifecycle", () => {
  it("pins a one-day expiry on the upload-staging/ prefix and does not apply it", () => {
    const cfg = loadInfraConfig(REPO).uploadStagingLifecycle
    expect(cfg.prefix).toBe(UPLOAD_STAGING_OBJECT_PREFIX)
    expect(cfg.expirationDays).toBe(1)
    expect(cfg.expirationDays).toBe(UPLOAD_STAGING_LIFECYCLE_DAYS)
    expect(cfg.objectLock).toBe("none")
    const desired = desiredUploadStagingLifecycle(cfg)
    expect(desired.objectLock).toBe("none")
    expect(desired.s3.Rules).toEqual([
      {
        ID: "expire-upload-staging",
        Status: "Enabled",
        Filter: { Prefix: "upload-staging/" },
        Expiration: { Days: 1 },
      },
    ])
    expect(desired.r2.rules[0]).toMatchObject({
      id: "expire-upload-staging",
      enabled: true,
      prefix: "upload-staging/",
      condition: { type: "Age", maxAgeSeconds: 86400 },
    })
    const vault = loadInfraConfig(REPO).documentVault
    expect(vault.objectLockDays).not.toBe(cfg.expirationDays)
    const protection = readFileSync(path.join(REPO, "ops/backup/objects/protection.ts"), "utf8")
    const apply = protection.slice(protection.indexOf("export async function applyVaultProtection"))
    expect(apply.includes("PutBucketLifecycleConfiguration")).toBe(false)
    expect(apply.includes("desiredUploadStagingLifecycle")).toBe(false)
  })
})
