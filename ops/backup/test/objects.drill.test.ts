import { existsSync, mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { type ChildProcess, spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { S3Client, CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { applyVaultProtection, checkVaultProtection } from "../objects/protection"
import { loadInfraConfig } from "../config"
import { recordDrillResult } from "../lib/results"
import { stopMinioServer } from "./helpers/minio"

const REPO = path.resolve(__dirname, "../../..")

function minioBin(): string {
  return (
    process.env.SIKANDER_BACKUP_DRILL_MINIO_BIN?.trim() ||
    path.join(os.homedir(), ".cache/sikander-minio/minio")
  )
}

async function startMinio(dir: string): Promise<{ endpoint: string; proc: ChildProcess; dataDir: string }> {
  const bin = minioBin()
  if (!existsSync(bin)) {
    throw new Error(
      `build or install MinIO at ${bin} (see gate-g0.yml document-object-s3 job) or set SIKANDER_BACKUP_DRILL_MINIO_BIN`
    )
  }
  const dataDir = path.join(dir, "data")
  const proc = spawn(bin, ["server", dataDir, "--address", "127.0.0.1:19021", "--console-address", "127.0.0.1:19022"], {
    env: { ...process.env, MINIO_ROOT_USER: "minioadmin", MINIO_ROOT_PASSWORD: "minioadmin" },
    stdio: "ignore",
  })
  await new Promise((r) => setTimeout(r, 2000))
  return {
    endpoint: "http://127.0.0.1:19021",
    proc,
    dataDir: dir,
  }
}

describe("document vault objects drill", () => {
  it(
    "applies Object Lock protection on a versioned bucket",
    async () => {
      const started = Date.now()
      const tmp = mkdtempSync(path.join(os.tmpdir(), "f33-minio-"))
      const { endpoint, proc, dataDir } = await startMinio(tmp)
      try {
        const cfg = loadInfraConfig(REPO).documentVault
        const s3 = new S3Client({
          region: "auto",
          endpoint,
          forcePathStyle: true,
          credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
        })
        const bucket = "f33-vault-drill"
        await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }))
        await applyVaultProtection(s3, bucket, cfg)
        const problems = await checkVaultProtection(s3, bucket, cfg)
        expect(problems, problems.join("\n")).toEqual([])
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "firm/obj", Body: Buffer.from("x") }))
        recordDrillResult({
          store: "document-vault",
          rtoMs: Date.now() - started,
          details: { bucket, endpoint },
        })
      } finally {
        await stopMinioServer(proc, dataDir)
      }
    },
    120_000
  )
})
