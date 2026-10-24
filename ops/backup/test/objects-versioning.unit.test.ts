import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { checkVaultProtection } from "../objects/protection"

describe("checkVaultProtection versioning", () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("reports when bucket versioning is not Enabled", async () => {
    const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "GetBucketVersioningCommand") {
        return { Status: "Suspended" }
      }
      return {
        ObjectLockConfiguration: { Rule: { DefaultRetention: { Days: 2555, Mode: "COMPLIANCE" } } },
      }
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
