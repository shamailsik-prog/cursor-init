import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("document vault objects drill", () => {
  it(
    "fails fast when the MinIO binary is missing",
    () => {
      const bin =
        process.env.SIKANDER_BACKUP_DRILL_MINIO_BIN?.trim() ||
        path.join(os.homedir(), ".cache/sikander-minio/minio")
      expect(
        existsSync(bin),
        `build or install MinIO at ${bin} (see gate-g0.yml document-object-s3 job) or set SIKANDER_BACKUP_DRILL_MINIO_BIN`
      ).toBe(true)
    },
    120_000
  )
})
