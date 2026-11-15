import { randomBytes } from "node:crypto"
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
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
import { acceptRestoreChild, assessContentMatch, backupPayloadProblems } from "../drill/content"
import { planIdempotentRestore } from "../drill/idempotent"
import { drillScratchDir, ensureDrillTempRoot, isolationProblems } from "../drill/target"
import { BundleWriter } from "../lib/bundle"
import { makeKeyRing } from "../lib/envelope.mjs"
import * as exec from "../lib/exec"
import { recordDrillResult } from "../lib/results"
import { compareFirestoreManifests, type FirestoreManifest } from "../firestore/manifest"
import { restoreFirestoreEmulator } from "../firestore/emulator"
import type { VersionedObjectAccess } from "../objects/s3"
import { restoreObjects } from "../objects/restore"
import { connectedTargetProblems, scrubLibpqEnv } from "../postgres/conn"
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
    root = drillScratchDir("f33-bundle-")
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
    expect(res.differences).toContain("table public.t: checksum missing")
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
    expect(res.differences).toContain("database.dump: truncated")
  })

  it("refuses a zero-unit postgres manifest before it can report success", async () => {
    const key = randomBytes(32)
    const writer = await BundleWriter.create(root, "postgres-logical", key)
    await writer.addBuffer("globals.sql", Buffer.from("SELECT 1;\n"))
    await writer.addBuffer("database.dump", Buffer.from("not-empty-dump"))
    const dir = await writer.finish({
      meta: { serverVersion: "16.0", database: "legal_scraper" },
      tables: {},
    })
    const res = await restoreLogical({
      bundleDir: dir,
      ring: makeKeyRing(key),
      db: "legal_scraper",
      env: { ...process.env, PGHOST: root, PGPORT: "1" },
    })
    expect(res.ok).toBe(false)
    expect(res.differences).toContain("zero-unit restore is not success")
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
    expect(res.differences.join("\n")).toMatch(/no content report/)
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
    expect(report.refused?.join("\n") ?? "").toMatch(/endpoint and bucket/)
  })

  it("does not write again when the isolated target already holds the intact bytes", async () => {
    const { encrypted, hash, store } = await intact()
    let puts = 0
    const report = await restoreObjects({
      rows: [{ id: "row1", firmId: "firmA", storagePath: "s3://b/k", contentHash: hash, key: "k" }],
      source: {
        listVersions: async () => [{ key: "k", versionId: "v1", isLatest: true }],
        getVersion: async () => encrypted,
        put: async () => {},
      },
      target: {
        resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" }),
        listVersions: async () => [{ key: "k", versionId: "current", isLatest: true }],
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

  it("re-uploads when an older version is intact and the latest version is corrupt", async () => {
    const { encrypted, hash, store } = await intact()
    const corrupt = Buffer.from(encrypted)
    corrupt[corrupt.length - 1] ^= 0x01
    const bodies: Record<string, Buffer> = { old: encrypted, new: corrupt }
    let written: Buffer | undefined
    const report = await restoreObjects({
      rows: [{ id: "row-overwrite", firmId: "firmA", storagePath: "s3://b/k", contentHash: hash, key: "k" }],
      source: {
        resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" }),
        listVersions: async () => [
          { key: "k", versionId: "old", isLatest: false },
          { key: "k", versionId: "new", isLatest: true },
        ],
        getVersion: async (_key, versionId) => bodies[versionId ?? ""] ?? Buffer.alloc(0),
        put: async () => {},
      },
      target: {
        resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" }),
        listVersions: async () => [
          { key: "k", versionId: "old", isLatest: false },
          { key: "k", versionId: "new", isLatest: true },
        ],
        getVersion: async (_key, versionId) => bodies[versionId ?? ""] ?? Buffer.alloc(0),
        put: async (_key, body) => {
          written = body
        },
      },
      store,
    })
    expect(report.refused).toEqual([])
    expect(report.noop).toBe(false)
    expect(report.restored).toEqual(["row-overwrite"])
    expect(written?.equals(encrypted)).toBe(true)
  })

  it("re-uploads when the latest entry is a delete marker and an older version is intact", async () => {
    const { encrypted, hash, store } = await intact()
    let puts = 0
    const report = await restoreObjects({
      rows: [{ id: "row-deleted", firmId: "firmA", storagePath: "s3://b/k", contentHash: hash, key: "k" }],
      source: {
        resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" }),
        listVersions: async () => [
          { key: "k", versionId: "old", isLatest: false },
          { key: "k", versionId: "del", isLatest: true, isDeleteMarker: true },
        ],
        getVersion: async () => encrypted,
        put: async () => {},
      },
      target: {
        resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" }),
        listVersions: async () => [
          { key: "k", versionId: "old", isLatest: false },
          { key: "k", versionId: "del", isLatest: true, isDeleteMarker: true },
        ],
        getVersion: async () => encrypted,
        put: async () => {
          puts += 1
        },
      },
      store,
    })
    expect(report.refused).toEqual([])
    expect(report.noop).toBe(false)
    expect(report.restored).toEqual(["row-deleted"])
    expect(puts).toBe(1)
  })

  it("does not report an empty row set as a no-op success", async () => {
    const report = await restoreObjects({
      rows: [],
      source: {
        resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" }),
        listVersions: async () => [],
        getVersion: async () => Buffer.alloc(0),
        put: async () => {},
      },
      target: {
        resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" }),
        listVersions: async () => [],
        getVersion: async () => Buffer.alloc(0),
        put: async () => {},
      },
      store: newStore(),
    })
    expect(report.noop).toBe(false)
    expect(report.restored).toEqual([])
    expect(report.refused.join("\n")).toMatch(/zero-unit/)
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

describe("gap: zero-unit success, lookalikes, symlinks, and the writer endpoint", () => {
  it("refuses a passing report with an empty content unit list", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f33-zero-unit-"))
    try {
      expect(() =>
        recordDrillResult(
          {
            store: "postgres-logical",
            rtoMs: 1,
            target: { kind: "temp", engine: "postgres", isolated: true },
            details: { ok: true, contentUnits: [] },
          },
          { ...process.env, SIKANDER_BACKUP_RESULTS_DIR: dir }
        )
      ).toThrow(/zero-unit/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses lookalike database names that a production denylist misses", async () => {
    const names = ["proddb", "preprod", "live1", "golive", "pr\u043Ed", "\uFF50rod"]
    for (const db of names) {
      const res = await restoreLogical({
        bundleDir: path.join(os.tmpdir(), "f33-missing-bundle"),
        ring: makeKeyRing(randomBytes(32)),
        db,
        env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: "1" },
      })
      expect(res.ok, db).toBe(false)
      expect(res.differences.join("\n"), db).toMatch(/explicit drill target/)
    }
  })

  it("refuses a symlink to /etc even when the link path is under the temp root", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f33-symlink-"))
    const link = path.join(dir, "sock")
    symlinkSync("/etc", link)
    try {
      const problems = isolationProblems({
        kind: "temp",
        engine: "postgres",
        host: link,
        database: "legal_scraper",
      })
      expect(problems.join("\n")).toMatch(/symlink/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses /opt/production-pgdata when TMPDIR is /", () => {
    const prior = process.env.TMPDIR
    process.env.TMPDIR = "/"
    try {
      const problems = isolationProblems({
        kind: "temp",
        engine: "postgres",
        host: "/opt/production-pgdata",
        database: "legal_scraper",
        dataDir: "/opt/production-pgdata",
      })
      expect(problems.join("\n")).toMatch(/isolated temp/)
    } finally {
      if (prior === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = prior
    }
  })

  it("checks the object writer's endpoint, not a declared loopback location", async () => {
    let listed = 0
    const report = await restoreObjects({
      rows: [{ id: "row1", firmId: "firmA", storagePath: "s3://b/k", contentHash: HEX, key: "k" }],
      source: {
        listVersions: async () => [{ key: "k", versionId: "v1" }],
        getVersion: async () => Buffer.from("x"),
        put: async () => {},
      },
      target: {
        resolvedTarget: async () => ({ endpoint: "https://s3.amazonaws.com", bucket: "f33-vault-drill" }),
        listVersions: async () => {
          listed += 1
          return []
        },
        getVersion: async () => Buffer.from("x"),
        put: async () => {
          listed += 1
        },
      },
      store: newStore(),
      location: { kind: "local", endpoint: "http://127.0.0.1:9", bucket: "f33-vault-drill" },
    })
    expect(listed).toBe(0)
    expect(report.restored).toEqual([])
    expect(report.refused.join("\n")).toMatch(/endpoint|managed cloud/)
  })
})

describe("mutants: loopback, endpoint, firestore host, report target, and digests", () => {
  it("accepts only an exact loopback host", () => {
    const base = { kind: "local" as const, engine: "postgres" as const, database: "legal_scraper" }
    expect(isolationProblems({ ...base, host: "127.0.0.1" })).toEqual([])
    expect(isolationProblems({ ...base, host: "localhost" })).toEqual([])
    expect(isolationProblems({ ...base, host: "::1" })).toEqual([])
    for (const host of ["10.1.2.3", "127.0.0.2", "0.0.0.0", "localhost.evil.com", "127.0.0.1.example", ""]) {
      expect(isolationProblems({ ...base, host }).join("\n"), host).toMatch(/loopback|missing/)
    }
  })

  it("accepts only a loopback http endpoint with a port and the drill bucket", () => {
    const ok = { kind: "local" as const, engine: "objects" as const, bucket: "f33-vault-drill" }
    expect(isolationProblems({ ...ok, endpoint: "http://127.0.0.1:19021" })).toEqual([])
    expect(isolationProblems({ ...ok, endpoint: "http://localhost:1" })).toEqual([])
    expect(isolationProblems({ ...ok, endpoint: "http://[::1]:9" })).toEqual([])
    for (const endpoint of [
      "https://127.0.0.1:19021",
      "http://127.0.0.1",
      "http://127.0.0.1:19021/bucket",
      "http://10.0.0.1:19021",
      "http://example:19021",
      "http://127.0.0.1:19021?x=1",
    ]) {
      expect(isolationProblems({ ...ok, endpoint }).join("\n"), endpoint).toMatch(/endpoint/)
    }
    expect(isolationProblems({ ...ok, endpoint: "http://127.0.0.1:9", bucket: "f33-vault-drill-evil" }).join("\n")).toMatch(
      /explicit drill target/
    )
    expect(isolationProblems({ kind: "local", engine: "objects", endpoint: "http://127.0.0.1:9" }).join("\n")).toMatch(
      /explicit drill target/
    )
  })

  it("accepts only the drill firestore projects on loopback", () => {
    expect(
      isolationProblems({ kind: "emulator", engine: "firestore", host: "127.0.0.1", projectId: "f33-backup-drill" })
    ).toEqual([])
    expect(
      isolationProblems({ kind: "emulator", engine: "firestore", host: "localhost", projectId: "demo-sikander" })
    ).toEqual([])
    expect(
      isolationProblems({
        kind: "emulator",
        engine: "firestore",
        host: "10.0.0.5",
        projectId: "f33-backup-drill",
      }).join("\n")
    ).toMatch(/not loopback/)
    expect(
      isolationProblems({
        kind: "emulator",
        engine: "firestore",
        host: "127.0.0.1",
        projectId: "f33-backup-drill-evil",
      }).join("\n")
    ).toMatch(/explicit drill target/)
    expect(
      isolationProblems({
        kind: "emulator",
        engine: "firestore",
        host: "127.0.0.1",
        projectId: "demo-sikander.evil",
      }).join("\n")
    ).toMatch(/explicit drill target/)
  })

  it("refuses a passing report whose target or digest is not the drill contract", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f33-report-mutant-"))
    const env = { ...process.env, SIKANDER_BACKUP_RESULTS_DIR: dir }
    const unit = { name: "public.t", count: 1, digest: HEX, match: true as const }
    const passing = {
      store: "postgres-logical",
      rtoMs: 1,
      target: { kind: "temp" as const, engine: "postgres", isolated: true as const },
      details: { ok: true, contentUnits: [unit] },
    }
    try {
      expect(() =>
        recordDrillResult(
          { ...passing, target: { kind: "managed", engine: "postgres", isolated: true } as unknown as typeof passing.target },
          env
        )
      ).toThrow(/isolated local, emulator, or temp/)
      expect(() =>
        recordDrillResult(
          { ...passing, target: { kind: "temp", engine: "postgres", isolated: false } as unknown as typeof passing.target },
          env
        )
      ).toThrow(/isolated/)
      expect(() =>
        recordDrillResult({ ...passing, details: { ok: true, contentUnits: [{ ...unit, digest: "AB".repeat(32) }] } }, env)
      ).toThrow(/counts and checksums/)
      expect(() =>
        recordDrillResult({ ...passing, details: { ok: true, contentUnits: [{ ...unit, digest: "ab".repeat(31) }] } }, env)
      ).toThrow(/counts and checksums/)
      expect(() =>
        recordDrillResult({ ...passing, details: { ok: true, contentUnits: [{ ...unit, digest: "g".repeat(64) }] } }, env)
      ).toThrow(/counts and checksums/)
      expect(() =>
        recordDrillResult({ ...passing, details: { ok: true, contentUnits: [{ ...unit, digest: "" }] } }, env)
      ).toThrow(/counts and checksums/)
      expect(() =>
        recordDrillResult({ ...passing, details: { ok: true, contentUnits: [{ ...unit, match: false }] } }, env)
      ).toThrow(/counts and checksums/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("requires a real sha256 on both sides of a postgres compare", () => {
    const left = emptyPg()
    const right = emptyPg()
    left.tables["public.t"] = { rows: 1, digest: HEX }
    right.tables["public.t"] = { rows: 1, digest: HEX }
    expect(comparePgManifests(left, right)).toEqual([])
    right.tables["public.t"] = { rows: 1, digest: "cd".repeat(32) }
    expect(comparePgManifests(left, right).join("\n")).toMatch(/digest differs/)
    left.tables["public.t"] = { rows: 1, digest: "zz".repeat(32) }
    right.tables["public.t"] = { rows: 1, digest: "zz".repeat(32) }
    expect(comparePgManifests(left, right).join("\n")).toMatch(/checksum missing/)
  })

  it("allows the PITR maintenance database only together with a drill data directory", () => {
    const dataDir = drillScratchDir("f33-pitr-target-")
    try {
      expect(
        isolationProblems({
          kind: "temp",
          engine: "postgres",
          host: "127.0.0.1",
          database: "postgres",
          dataDir,
        })
      ).toEqual([])
      expect(
        isolationProblems({ kind: "local", engine: "postgres", host: "127.0.0.1", database: "postgres" }).join("\n")
      ).toMatch(/explicit drill target/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe("restore guards that a one-line deletion must fail", () => {
  const identity = {
    inetAddr: "",
    inetPort: "",
    socketDirs: "/tmp/sikander-backup-drill/sock",
    systemIdentifier: "100",
  }

  it("F07 refuses a unix-socket target whose connection has an inet address", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f33-sock-"))
    try {
      const problems = connectedTargetProblems({
        host: dir,
        port: "5432",
        expectedSystemIdentifier: "100",
        row: { ...identity, inetAddr: "127.0.0.1", inetPort: "5432", socketDirs: dir },
      })
      expect(problems).toEqual(["connection was not the unix socket that was checked"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F08 refuses a unix-socket directory that is not the explicit target", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f33-sock-"))
    const other = mkdtempSync(path.join(os.tmpdir(), "f33-other-"))
    try {
      const problems = connectedTargetProblems({
        host: dir,
        port: "5432",
        expectedSystemIdentifier: "100",
        row: { ...identity, socketDirs: other },
      })
      expect(problems).toEqual(["connected unix socket directory does not match the explicit target"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })

  it("F09 refuses a TCP connection that is not loopback", () => {
    const problems = connectedTargetProblems({
      host: "127.0.0.1",
      port: "5432",
      expectedSystemIdentifier: "100",
      row: { ...identity, inetAddr: "10.1.2.3", inetPort: "5432", socketDirs: "" },
    })
    expect(problems.join("\n")).toMatch(/server address/)
  })

  it("F10 refuses a TCP connection whose port differs", () => {
    const problems = connectedTargetProblems({
      host: "127.0.0.1",
      port: "5432",
      expectedSystemIdentifier: "100",
      row: { ...identity, inetAddr: "127.0.0.1", inetPort: "1", socketDirs: "" },
    })
    expect(problems.join("\n")).toMatch(/server port/)
  })

  it("F04 drops every libpq PG variable, including PGHOSTADDR", () => {
    const scrubbed = scrubLibpqEnv({
      NODE_ENV: "test",
      PATH: "/usr/bin",
      PGHOST: "/tmp/sock",
      PGHOSTADDR: "10.9.8.7",
      PGSERVICE: "prod",
      PGSERVICEFILE: "/tmp/pg_service.conf",
      PGPASSFILE: "/tmp/pgpass",
    })
    expect(scrubbed.PATH).toBe("/usr/bin")
    expect(scrubbed.PGHOST).toBeUndefined()
    expect(scrubbed.PGHOSTADDR).toBeUndefined()
    expect(scrubbed.PGSERVICE).toBeUndefined()
    expect(scrubbed.PGSERVICEFILE).toBeUndefined()
    expect(scrubbed.PGPASSFILE).toBeUndefined()
  })

  it("F25 and F26 keep exactEnv from inheriting PGHOSTADDR", async () => {
    const prior = process.env.PGHOSTADDR
    process.env.PGHOSTADDR = "10.9.8.7"
    try {
      const child = await exec.runCommand(["node", "-e", "process.stdout.write(process.env.PGHOSTADDR || '')"], {
        exactEnv: true,
        env: { NODE_ENV: "test", PATH: process.env.PATH },
      })
      expect(child.code).toBe(0)
      expect(child.stdout).toBe("")
    } finally {
      if (prior === undefined) delete process.env.PGHOSTADDR
      else process.env.PGHOSTADDR = prior
    }
  })

  it("F15 refuses a symlink used as the drill temp root", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f33-root-real-"))
    const link = path.join(os.tmpdir(), `f33-root-link-${process.pid}`)
    symlinkSync(dir, link)
    try {
      expect(() => ensureDrillTempRoot(link)).toThrow(/symlink/)
    } finally {
      rmSync(link, { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a pre-existing temp root owned by another user and does not chmod it", () => {
    const before = lstatSync("/root")
    expect(before.uid).not.toBe(process.getuid?.())
    expect(() => ensureDrillTempRoot("/root")).toThrow(/not owned/)
    const after = lstatSync("/root")
    expect(after.mode).toBe(before.mode)
    expect(after.uid).toBe(before.uid)
  })

  it("refuses a pre-existing 0777 temp root and does not chmod it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f33-root-open-"))
    chmodSync(dir, 0o777)
    try {
      expect(() => ensureDrillTempRoot(dir)).toThrow(/world-accessible/)
      expect(lstatSync(dir).mode & 0o777).toBe(0o777)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("creates a missing temp root as mode 0700", () => {
    const dir = path.join(os.tmpdir(), `f33-root-new-${process.pid}-${Date.now()}`)
    try {
      expect(ensureDrillTempRoot(dir)).toBe(dir)
      expect(lstatSync(dir).mode & 0o777).toBe(0o700)
      expect(lstatSync(dir).uid).toBe(process.getuid?.())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F36 refuses a writer bucket outside the drill allowlist", async () => {
    const report = await restoreObjects({
      rows: [{ id: "row1", firmId: "firmA", storagePath: "s3://b/k", contentHash: HEX, key: "k" }],
      source: {
        listVersions: async () => [],
        getVersion: async () => Buffer.from("x"),
        put: async () => {},
      },
      target: {
        resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "other-bucket" }),
        listVersions: async () => {
          throw new Error("list must not run")
        },
        getVersion: async () => Buffer.from("x"),
        put: async () => {
          throw new Error("put must not run")
        },
      },
      store: newStore(),
    })
    expect(report.restored).toEqual([])
    expect(report.refused.join("\n")).toMatch(/explicit drill target/)
  })

  it("F37 refuses a writer endpoint that is not an isolated loopback", async () => {
    let listed = 0
    const report = await restoreObjects({
      rows: [{ id: "row1", firmId: "firmA", storagePath: "s3://b/k", contentHash: HEX, key: "k" }],
      source: {
        listVersions: async () => [],
        getVersion: async () => Buffer.from("x"),
        put: async () => {},
      },
      target: {
        resolvedTarget: async () => ({ endpoint: "https://s3.amazonaws.com", bucket: "f33-vault-drill" }),
        listVersions: async () => {
          listed += 1
          return []
        },
        getVersion: async () => Buffer.from("x"),
        put: async () => {
          listed += 1
        },
      },
      store: newStore(),
    })
    expect(listed).toBe(0)
    expect(report.refused.join("\n")).toMatch(/endpoint|managed cloud/)
  })

  it("M28 refuses a content report when the process exit code is non-zero", () => {
    const accepted = acceptRestoreChild({
      code: 1,
      stdout: `DRILL_CONTENT_JSON ${JSON.stringify({
        ok: true,
        units: [{ name: "public.t", count: 1, digest: HEX }],
        problems: [],
      })}`,
      stderr: "",
    })
    expect(accepted.ok).toBe(false)
    expect(accepted.problems.join("\n")).toMatch(/exited 1/)
  })

  it("M29 refuses a content report whose ok flag is not true", () => {
    const accepted = acceptRestoreChild({
      code: 0,
      stdout: `DRILL_CONTENT_JSON ${JSON.stringify({
        ok: false,
        units: [{ name: "public.t", count: 1, digest: HEX }],
        problems: [],
      })}`,
      stderr: "",
    })
    expect(accepted.ok).toBe(false)
    expect(accepted.problems.join("\n")).toMatch(/not ok/)
  })

  it("M27 reports a table row-count difference when the checksum matches", () => {
    const left = emptyPg()
    const right = emptyPg()
    left.tables["public.t"] = { rows: 2, digest: HEX }
    right.tables["public.t"] = { rows: 9, digest: HEX }
    expect(comparePgManifests(left, right)).toEqual(["table public.t: rows 2 -> 9"])
  })

  it("M31 reports a content count difference when the checksum matches", () => {
    const problems = assessContentMatch(
      [{ name: "public.t", count: 2, digest: HEX }],
      [{ name: "public.t", count: 9, digest: HEX }]
    )
    expect(problems).toEqual(["public.t: count 2 -> 9"])
  })

  it("M23 refuses a logical backup with no globals.sql", () => {
    const problems = backupPayloadProblems({
      store: "postgres-logical",
      storeManifest: { tables: { "public.t": { rows: 1, digest: HEX } } },
      artefacts: [{ name: "database.dump", plaintextBytes: 12 }],
    })
    expect(problems).toContain("globals.sql: missing (partial)")
  })

  it("M24 refuses a zero-byte firestore export.tar", () => {
    const problems = backupPayloadProblems({
      store: "firestore-emulator",
      storeManifest: { collections: { matters: { count: 1, digest: HEX } } },
      artefacts: [{ name: "export.tar", plaintextBytes: 0 }],
    })
    expect(problems).toContain("export.tar: truncated")
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
