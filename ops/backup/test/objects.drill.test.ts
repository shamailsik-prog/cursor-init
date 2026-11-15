import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type ChildProcess, spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { S3Client, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import {
  decryptDocumentObjectPayload,
  filesystemPathForStoragePath,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
} from "@/platform/documents/documentObjectStore"
import { newStore } from "@/platform/spine/store"
import { S3Versioned } from "../objects/s3"
import { restoreObjects } from "../objects/restore"
import { isolationProblems } from "../drill/target"
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
  const endpoint = "http://127.0.0.1:19021"
  const deadline = Date.now() + 15_000
  let last = "no response"
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break
    try {
      const res = await fetch(`${endpoint}/minio/health/live`)
      if (res.ok) break
      last = `HTTP ${res.status}`
    } catch (err) {
      last = (err as Error).message
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  if (proc.exitCode !== null) {
    throw new Error(`MinIO exited ${proc.exitCode} before it accepted connections`)
  }
  try {
    const ready = await fetch(`${endpoint}/minio/health/live`)
    if (!ready.ok) throw new Error(`MinIO health ${ready.status}`)
  } catch (err) {
    throw new Error(`MinIO did not accept connections: ${last}; ${(err as Error).message}`)
  }
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
        const targetProblems = isolationProblems({
          kind: "local",
          engine: "objects",
          endpoint,
          bucket,
        })
        expect(targetProblems, targetProblems.join("\n")).toEqual([])
        const problems = await checkVaultProtection(s3, bucket, cfg)
        expect(problems, problems.join("\n")).toEqual([])
        const body = Buffer.from("x")
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "firm/obj", Body: body }))
        const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "firm/obj" }))
        const stored = Buffer.from(await got.Body!.transformToByteArray())
        const digest = createHash("sha256").update(stored).digest("hex")
        expect(digest).toBe(createHash("sha256").update(body).digest("hex"))
        const writer = new S3Versioned(s3, bucket)
        const actual = await writer.resolvedTarget()
        expect(actual.bucket).toBe(bucket)
        expect(actual.endpoint).toBe(endpoint)
        const lying = await restoreObjects({
          rows: [],
          source: writer,
          target: writer,
          store: newStore(),
          location: { kind: "local", endpoint: "https://s3.amazonaws.com", bucket: "prod" },
        })
        expect(lying.refused.join("\n")).toMatch(/endpoint|managed cloud|explicit drill target/)
        const accepted = await restoreObjects({
          rows: [],
          source: writer,
          target: writer,
          store: newStore(),
        })
        expect(accepted.noop).toBe(false)
        expect(accepted.restored).toEqual([])
        expect(accepted.refused.join("\n")).toMatch(/zero-unit/)
        recordDrillResult({
          store: "document-vault",
          rtoMs: Date.now() - started,
          target: { kind: "local", engine: "objects", isolated: true },
          details: {
            ok: true,
            bucket,
            endpoint,
            contentUnits: [{ name: "firm/obj", count: 1, digest, match: true }],
          },
        })
      } finally {
        await stopMinioServer(proc, dataDir)
      }
    },
    120_000
  )

  it(
    "re-uploads when the latest MinIO version is corrupt or a delete marker",
    async () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "f33-minio-restore-"))
      const objectRoot = mkdtempSync(path.join(os.tmpdir(), "f33-obj-root-"))
      process.env.SIKANDER_DOCUMENT_OBJECT_ROOT = objectRoot
      process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "fs"
      process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = randomBytes(32).toString("hex")
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
        const writer = new S3Versioned(s3, bucket)
        const store = newStore()
        const firmId = "firmA"
        const plaintext = Buffer.from("vault-plaintext-minio")
        const contentHash = store.hashKey(firmId, plaintext)
        const stored = await putImmutableDocumentObject({
          store,
          firmId,
          docId: "doc_minio_restore",
          bytes: plaintext,
          contentHash,
          mimeType: "application/octet-stream",
        })
        const intact = await readFile(filesystemPathForStoragePath(stored.storagePath))
        const corrupt = Buffer.from(intact)
        corrupt[corrupt.length - 1] ^= 0x01

        async function servedContentHash(key: string): Promise<string> {
          const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
          const body = Buffer.from(await got.Body!.transformToByteArray())
          return store.hashKey(firmId, decryptDocumentObjectPayload(body))
        }

        const overwriteKey = "firm/overwrite"
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: overwriteKey, Body: intact }))
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: overwriteKey, Body: corrupt }))
        const overwritten = await restoreObjects({
          rows: [{ id: "overwrite", firmId, storagePath: stored.storagePath, contentHash, key: overwriteKey }],
          source: writer,
          target: writer,
          store,
        })
        expect(overwritten.refused, overwritten.refused.join("\n")).toEqual([])
        expect(overwritten.restored).toEqual(["overwrite"])
        expect(await servedContentHash(overwriteKey)).toBe(contentHash)

        const deletedKey = "firm/deleted"
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: deletedKey, Body: intact }))
        await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: deletedKey, BypassGovernanceRetention: true })
        )
        const deleted = await restoreObjects({
          rows: [{ id: "deleted", firmId, storagePath: stored.storagePath, contentHash, key: deletedKey }],
          source: writer,
          target: writer,
          store,
        })
        expect(deleted.refused, deleted.refused.join("\n")).toEqual([])
        expect(deleted.restored).toEqual(["deleted"])
        expect(await servedContentHash(deletedKey)).toBe(contentHash)
      } finally {
        await stopMinioServer(proc, dataDir)
        rmSync(objectRoot, { recursive: true, force: true })
        delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
        delete process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND
        delete process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
        resetDocumentObjectStoreForTests()
      }
    },
    120_000
  )
})
