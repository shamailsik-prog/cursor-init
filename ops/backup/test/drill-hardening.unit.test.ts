import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import {
  filesystemPathForStoragePath,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
} from "@/platform/documents/documentObjectStore"
import { newStore } from "@/platform/spine/store"
import { assessContentMatch } from "../drill/content"
import { planIdempotentRestore } from "../drill/idempotent"
import { isolationProblems } from "../drill/target"
import { BundleWriter } from "../lib/bundle"
import { makeKeyRing } from "../lib/envelope.mjs"
import * as exec from "../lib/exec"
import { recordDrillResult } from "../lib/results"
import { compareFirestoreManifests, type FirestoreManifest } from "../firestore/manifest"
import { restoreFirestoreEmulator } from "../firestore/emulator"
import type { VersionedObjectAccess } from "../objects/s3"
import { restoreObjects } from "../objects/restore"
import { comparePgManifests, type PgManifest, type PgTableStats } from "../postgres/manifest"
import { preparePitrRestore } from "../postgres/pitr"
import { restoreLogical } from "../postgres/logical"

const RUNBOOK = path.resolve(__dirname, "../../../docs/runbooks/backup-restore.md")
const HEX = "ab".repeat(32)

function emptyPg(): PgManifest {
  return {
    meta: {
      serverVersion: "16.0",
      database: "legal_scraper",
      encoding: "UTF8",
      collation: "C",
      backupTime: "2026-01-01T00:00:00.000Z",
      snapshotId: "snap",
    },
    tables: {},
    sequences: {},
    foreignKeys: {},
    links: {},
    extensions: {},
    definitions: [],
    roles: [],
    grants: [],
  }
}

describe("gap: restore content requires counts and checksums", () => {
  it("refuses postgres manifests that agree on row counts and omit checksums", () => {
    const a = emptyPg()
    const b = emptyPg()
    a.tables["public.judgment"] = { rows: 2, digest: "" } as PgTableStats
    b.tables["public.judgment"] = { rows: 2, digest: "" } as PgTableStats
    const lines = comparePgManifests(a, b)
    expect(lines.join("\n")).toMatch(/table public\.judgment: checksum missing/)
  })

  it("refuses firestore manifests that agree on document counts and omit checksums", () => {
    const side = {
      collections: { firms: { count: 2 } },
      firms: {},
      relationships: {},
    } as unknown as FirestoreManifest
    const lines = compareFirestoreManifests(side, side)
    expect(lines.join("\n")).toMatch(/collections\.firms: checksum missing/)
  })
})

describe("gap: a passing drill report is machine-readable content, not an exit flag", () => {
  it("refuses to record a passing drill that has no per-unit counts and checksums", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f33-report-gap-"))
    try {
      expect(() =>
        recordDrillResult(
          { store: "postgres-logical", rtoMs: 1, details: { ok: true } },
          { ...process.env, SIKANDER_BACKUP_RESULTS_DIR: dir }
        )
      ).toThrow(/counts and checksums/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes schema sikander-backup-drill/1 with each unit's count and checksum", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f33-report-ok-"))
    try {
      const file = recordDrillResult(
        {
          store: "postgres-logical",
          rtoMs: 5,
          idempotent: false,
          target: { kind: "temp", engine: "postgres", isolated: true },
          details: {
            ok: true,
            contentUnits: [{ name: "public.judgment", count: 2, digest: HEX, match: true }],
          },
        },
        { ...process.env, SIKANDER_BACKUP_RESULTS_DIR: dir }
      )
      const body = JSON.parse(readFileSync(file, "utf8")) as {
        schema?: string
        content?: { units?: Array<{ name: string; count: number; digest: string; match: boolean }> }
      }
      expect(body.schema).toBe("sikander-backup-drill/1")
      expect(body.content?.units).toEqual([{ name: "public.judgment", count: 2, digest: HEX, match: true }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("gap: restore targets fail closed unless they are explicit local, emulator, or temp", () => {
  it("refuses a postgres restore whose host is not an isolated temp socket, before any bundle read", async () => {
    const res = await restoreLogical({
      bundleDir: path.join(os.tmpdir(), "f33-missing-bundle"),
      ring: makeKeyRing(randomBytes(32)),
      db: "legal_scraper",
      env: { ...process.env, PGHOST: "/var/lib/postgresql", PGPORT: "1" },
    })
    expect(res.ok).toBe(false)
    expect(res.differences.join("\n")).toMatch(/isolated temp/)
  })

  it("refuses a production-looking database name on loopback", async () => {
    const res = await restoreLogical({
      bundleDir: path.join(os.tmpdir(), "f33-missing-bundle"),
      ring: makeKeyRing(randomBytes(32)),
      db: "production",
      env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: "1" },
    })
    expect(res.ok).toBe(false)
    expect(res.differences.join("\n")).toMatch(/production/)
  })

  it("refuses PITR into a data directory outside the temp root", async () => {
    await expect(
      preparePitrRestore({
        bundleDir: path.join(os.tmpdir(), "f33-missing-pitr-bundle"),
        ring: makeKeyRing(randomBytes(32)),
        dataDir: "/opt/production-pgdata",
        archiveDir: path.join(os.tmpdir(), "f33-wal"),
        keyFile: path.join(os.tmpdir(), "f33.key"),
        target: "immediate",
        pgWalScript: path.join(os.tmpdir(), "pg-wal.mjs"),
      })
    ).rejects.toThrow(/isolated temp/)
  })

  it("refuses a firestore restore whose import directory is not a temp directory", async () => {
    const res = await restoreFirestoreEmulator({
      bundleDir: path.join(os.tmpdir(), "f33-missing-fs-bundle"),
      ring: makeKeyRing(randomBytes(32)),
      host: "127.0.0.1",
      port: 9,
      importDir: "/etc",
    })
    expect(res.ok).toBe(false)
    expect(res.differences.join("\n")).toMatch(/isolated temp/)
  })
})

describe("gap: partial backups and exit-code-only firestore restores are refused", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "f33-partial-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("refuses a postgres bundle whose tables have counts and no checksums, before connecting", async () => {
    const key = randomBytes(32)
    const writer = await BundleWriter.create(root, "postgres-logical", key)
    await writer.addBuffer("globals.sql", Buffer.from("SELECT 1;\n"))
    await writer.addBuffer("database.dump", Buffer.from("not-empty-dump"))
    const dir = await writer.finish({
      meta: { serverVersion: "16.0", database: "legal_scraper" },
      tables: { "public.t": { rows: 3 } },
    })
    const res = await restoreLogical({
      bundleDir: dir,
      ring: makeKeyRing(key),
      db: "legal_scraper",
      env: { ...process.env, PGHOST: root, PGPORT: "1" },
    })
    expect(res.ok).toBe(false)
    expect(res.differences.join("\n")).toMatch(/checksum missing|partial/)
  })

  it("refuses a zero-byte dump when the manifest claims rows", async () => {
    const key = randomBytes(32)
    const writer = await BundleWriter.create(root, "postgres-logical", key)
    await writer.addBuffer("globals.sql", Buffer.from("SELECT 1;\n"))
    await writer.addBuffer("database.dump", Buffer.alloc(0))
    const dir = await writer.finish({
      meta: { serverVersion: "16.0" },
      tables: { "public.t": { rows: 3, digest: HEX } },
    })
    const res = await restoreLogical({
      bundleDir: dir,
      ring: makeKeyRing(key),
      db: "legal_scraper",
      env: { ...process.env, PGHOST: root, PGPORT: "1" },
    })
    expect(res.ok).toBe(false)
    expect(res.differences.join("\n")).toMatch(/truncated/)
  })

  it("does not treat a zero exit and a text ok line as a firestore content match", async () => {
    const key = randomBytes(32)
    const writer = await BundleWriter.create(root, "firestore-emulator", key)
    await writer.addBuffer("export.tar", Buffer.from("export-bytes"))
    const dir = await writer.finish({
      collections: { firms: { count: 2, digest: HEX } },
      firms: {},
      relationships: {},
    })
    vi.spyOn(exec, "runCommand").mockResolvedValue({ code: 0, stdout: "firestore drill ok\n", stderr: "" })
    const res = await restoreFirestoreEmulator({
      bundleDir: dir,
      ring: makeKeyRing(key),
      host: "127.0.0.1",
      port: 9,
      importDir: root,
    })
    expect(res.ok).toBe(false)
    expect(res.differences.join("\n")).toMatch(/checksum missing|content report/)
  })
})

describe("gap: object restore is local-only and idempotent", () => {
  let objectRoot: string

  beforeEach(() => {
    objectRoot = mkdtempSync(path.join(os.tmpdir(), "f33-obj-gap-"))
    process.env.SIKANDER_DOCUMENT_OBJECT_ROOT = objectRoot
    process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "fs"
    process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = randomBytes(32).toString("hex")
  })

  afterEach(() => {
    rmSync(objectRoot, { recursive: true, force: true })
    delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
    delete process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND
    delete process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
    resetDocumentObjectStoreForTests()
  })

  async function intact(): Promise<{ encrypted: Buffer; hash: string; store: ReturnType<typeof newStore> }> {
    const store = newStore()
    const bytes = Buffer.from("vault-plaintext")
    const hash = store.hashKey("firmA", bytes)
    const put = await putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_gap",
      bytes,
      contentHash: hash,
      mimeType: "application/octet-stream",
    })
    const encrypted = await readFile(filesystemPathForStoragePath(put.storagePath))
    return { encrypted, hash, store }
  }

  it("refuses an object restore that does not name an explicit local or temp target", async () => {
    const { encrypted, hash, store } = await intact()
    let puts = 0
    const access = (body: Buffer): VersionedObjectAccess => ({
      listVersions: async () => [{ key: "k", versionId: "v1" }],
      getVersion: async () => body,
      put: async () => {
        puts += 1
      },
    })
    const report = await restoreObjects({
      rows: [{ id: "row1", firmId: "firmA", storagePath: "s3://b/k", contentHash: hash, key: "k" }],
      source: access(encrypted),
      target: access(encrypted),
      store,
    })
    expect(puts).toBe(0)
    expect(report.restored).toEqual([])
    expect(report.refused?.join("\n") ?? "").toMatch(/local|temp/)
  })

  it("does not write again when the isolated target already holds the intact bytes", async () => {
    const { encrypted, hash, store } = await intact()
    let puts = 0
    const report = await restoreObjects({
      rows: [{ id: "row1", firmId: "firmA", storagePath: "s3://b/k", contentHash: hash, key: "k" }],
      source: {
        listVersions: async () => [{ key: "k", versionId: "v1" }],
        getVersion: async () => encrypted,
        put: async () => {},
      },
      target: {
        listVersions: async () => [{ key: "k", versionId: "current" }],
        getVersion: async () => encrypted,
        put: async () => {
          puts += 1
        },
      },
      store,
      location: { kind: "temp", root: objectRoot, bucket: "f33-vault-drill" },
    })
    expect(puts).toBe(0)
    expect(report.restored).toEqual([])
    expect(report.noop).toBe(true)
    expect(report.unrecoverable).toEqual([])
  })
})

describe("local drill decision table", () => {
  it("re-runs only when the isolated target is absent or already matches", () => {
    expect(planIdempotentRestore({ targetExists: false, contentMatch: null }).action).toBe("restore")
    expect(planIdempotentRestore({ targetExists: true, contentMatch: true }).action).toBe("noop")
    expect(planIdempotentRestore({ targetExists: true, contentMatch: false }).action).toBe("refuse")
    expect(planIdempotentRestore({ targetExists: true, contentMatch: null }).action).toBe("refuse")
  })

  it("refuses a managed cloud firestore target even when a caller marks it isolated", () => {
    const problems = isolationProblems({
      kind: "managed",
      engine: "firestore",
      host: "firestore.googleapis.com",
      projectId: "sikander-prod",
      database: "(default)",
      isolated: true,
    })
    expect(problems.join("\n")).toMatch(/not an explicit local, emulator, or temp/)
    expect(problems.join("\n")).toMatch(/managed cloud/)
  })

  it("refuses a vault unit whose count matches and whose checksum does not", () => {
    const hash = "aa".repeat(32)
    const other = "bb".repeat(32)
    const problems = assessContentMatch(
      [{ name: "firmA/doc", count: 1, digest: hash }],
      [{ name: "firmA/doc", count: 1, digest: other }]
    )
    expect(problems.join("\n")).toMatch(/checksum differs/)
  })
})

describe("gap: runbook states the local drill contract", () => {
  it("records fail-closed local targets, content checksums, and parked managed restore", () => {
    const text = readFileSync(RUNBOOK, "utf8")
    expect(text).toMatch(/FA-F33-R3-001/)
    expect(text).toMatch(/sikander-backup-drill\/1/)
    expect(text).toMatch(/fail closed/)
    expect(text).not.toMatch(/Shamail/)
  })
})
