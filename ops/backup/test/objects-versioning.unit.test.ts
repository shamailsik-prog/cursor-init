import { GetBucketVersioningCommand, GetObjectLockConfigurationCommand } from "@aws-sdk/client-s3"
import { describe, expect, it, vi } from "vitest"
import { checkVaultProtection } from "../objects/protection"

describe("checkVaultProtection versioning", () => {
  it("reports when bucket versioning is not Enabled", async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetBucketVersioningCommand) {
        return { Status: "Suspended" }
      }
      if (cmd instanceof GetObjectLockConfigurationCommand) {
        return {
          ObjectLockConfiguration: { Rule: { DefaultRetention: { Days: 2555, Mode: "COMPLIANCE" } } },
        }
      }
      throw new Error("unexpected command")
    })
    const s3 = { send } as unknown as import("@aws-sdk/client-s3").S3Client
    const problems = await checkVaultProtection(s3, "b", {
      objectLockDays: 2555,
      governanceMode: "COMPLIANCE",
      r2LockMinAgeSeconds: 1,
    })
    expect(problems.some((p) => p.includes("versioning"))).toBe(true)
  })
})
