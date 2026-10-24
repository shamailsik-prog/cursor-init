import { createWriteStream, promises as fsp } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import type { KeyRing } from "../lib/envelope.mjs"
import { BundleWriter, openBundleFile, verifyBundle, type ArtefactInfo, type BundleManifest } from "../lib/bundle"
import { runCommand, psqlArgv, PersistentPsqlSession, PsqlSession } from "../lib/exec"
import { recordDrillResult } from "../lib/results"
import { assertPgTargetClean } from "./guards"
import { comparePgManifests, takePgManifest, type PgManifest } from "./manifest"
import { MANIFEST_SESSION_SETTINGS } from "./sql"

export type BackupLogicalOptions = {
  db: string
  outRoot: string
  key: Buffer
  pgPrefix?: string[]
  env?: NodeJS.ProcessEnv
}

export type RestoreLogicalOptions = {
  bundleDir: string
  ring: KeyRing
  db: string
  pgPrefix?: string[]
  env?: NodeJS.ProcessEnv
  recordStore?: string
}

function envOf(opts: { env?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  return { ...process.env, ...opts.env }
}

export function logicalPgRestoreArgv(db: string, dumpPath: string): string[] {
  return ["pg_restore", "--no-owner", "-d", db, dumpPath]
}

export async function backupLogical(opts: BackupLogicalOptions): Promise<{ dir: string; manifest: PgManifest }> {
  const env = envOf(opts)
  const session = await PersistentPsqlSession.open(opts.pgPrefix, env, opts.db)
  let manifest: PgManifest
  let snap: string
  try {
    await session.query(MANIFEST_SESSION_SETTINGS)
    await session.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;")
    snap = await session.queryScalar("SELECT pg_export_snapshot();")
    const backupTime = new Date().toISOString()
    manifest = await takePgManifest(session, opts.db, { snapshotId: snap, backupTime })
    const dump = await runCommand(
      ["pg_dump", "--format=custom", `--snapshot=${snap}`, opts.db],
      { env, pgPrefix: opts.pgPrefix, binaryStdout: true }
    )
    if (dump.code !== 0) throw new Error(dump.stderr || dump.stdout)
    const dumpBytes = dump.stdoutBytes
    if (!dumpBytes?.length) throw new Error("pg_dump produced an empty custom-format dump")
    await session.query("ROLLBACK;")
    const writer = await BundleWriter.create(opts.outRoot, "postgres-logical", opts.key)
    const globals = await runCommand(["pg_dumpall", "--globals-only", "--no-role-passwords"], {
      env,
      pgPrefix: opts.pgPrefix,
    })
    if (globals.code !== 0) throw new Error(globals.stderr || globals.stdout)
    await writer.addBuffer("globals.sql", Buffer.from(globals.stdout, "utf8"))
    await writer.addBuffer("database.dump", dumpBytes)
    const dir = await writer.finish(manifest)
    return { dir, manifest }
  } finally {
    session.close()
  }
}

function parseRolesFromGlobals(sql: string): string[] {
  const roles: string[] = []
  for (const line of sql.split("\n")) {
    const m = /^CREATE ROLE\s+([^\s;]+)/i.exec(line.trim())
    if (m) {
      const name = m[1].replace(/"/g, "")
      if (!name.startsWith("pg_") && name !== "postgres") roles.push(name)
    }
  }
  return roles
}

function stripBootstrapSuperuser(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !/^CREATE ROLE\s+postgres\b/i.test(line.trim()) && !/^ALTER ROLE\s+postgres\b/i.test(line.trim()))
    .join("\n")
}

function artefactExpect(manifest: BundleManifest, name: string): ArtefactInfo {
  const expect = manifest.artefacts.find((a) => a.name === name)
  if (!expect) throw new Error(`${name}: not listed in bundle manifest`)
  return expect
}

async function decryptToFile(
  bundleDir: string,
  name: string,
  ring: KeyRing,
  dest: string,
  expect: ArtefactInfo
): Promise<void> {
  await pipeline(openBundleFile(bundleDir, name, ring, expect), createWriteStream(dest))
}

export async function restoreLogical(opts: RestoreLogicalOptions): Promise<{
  ok: boolean
  differences: string[]
  rtoMs: number
}> {
  const started = Date.now()
  const verify = await verifyBundle(opts.bundleDir, opts.ring)
  if (!verify.ok || !verify.manifest) {
    return { ok: false, differences: verify.problems, rtoMs: Date.now() - started }
  }
  const expected = verify.manifest.store as PgManifest
  const bundleManifest = verify.manifest
  const env = envOf(opts)
  const globalsTmp = path.join(opts.bundleDir, ".globals.plain.part")
  const dumpTmp = path.join(opts.bundleDir, ".dump.part")
  try {
    await decryptToFile(
      opts.bundleDir,
      "globals.sql",
      opts.ring,
      globalsTmp,
      artefactExpect(bundleManifest, "globals.sql")
    )
    let globalsSql = await fsp.readFile(globalsTmp, "utf8")
    globalsSql = stripBootstrapSuperuser(globalsSql)
    await fsp.writeFile(globalsTmp, globalsSql, "utf8")
    const roles = parseRolesFromGlobals(globalsSql)
    const admin = new PsqlSession(opts.pgPrefix, env, "postgres")
    try {
      await assertPgTargetClean(admin, opts.db, roles, expected.meta.serverVersion)
    } catch (err) {
      return { ok: false, differences: [(err as Error).message], rtoMs: Date.now() - started }
    }
    const create = await runCommand(psqlArgv("postgres", ["-c", `CREATE DATABASE "${opts.db.replace(/"/g, '""')}";`]), {
      env,
      pgPrefix: opts.pgPrefix,
    })
    if (create.code !== 0) {
      return { ok: false, differences: [create.stderr || create.stdout], rtoMs: Date.now() - started }
    }
    const extensions = await runCommand(
      psqlArgv(opts.db, [
        "-c",
        "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;",
      ]),
      { env, pgPrefix: opts.pgPrefix }
    )
    if (extensions.code !== 0) {
      return { ok: false, differences: [extensions.stderr || extensions.stdout], rtoMs: Date.now() - started }
    }
    const applyGlobals = await runCommand(psqlArgv(opts.db, ["-f", globalsTmp]), { env, pgPrefix: opts.pgPrefix })
    if (applyGlobals.code !== 0) {
      return { ok: false, differences: [applyGlobals.stderr || applyGlobals.stdout], rtoMs: Date.now() - started }
    }
    await decryptToFile(
      opts.bundleDir,
      "database.dump",
      opts.ring,
      dumpTmp,
      artefactExpect(bundleManifest, "database.dump")
    )
    const restore = await runCommand(logicalPgRestoreArgv(opts.db, dumpTmp), {
      env,
      pgPrefix: opts.pgPrefix,
    })
    if (restore.code !== 0) {
      const msg = [restore.stderr, restore.stdout].filter(Boolean).join("\n").trim() || `pg_restore exited ${restore.code}`
      return { ok: false, differences: [msg], rtoMs: Date.now() - started }
    }
    const targetSession = new PsqlSession(opts.pgPrefix, env, opts.db)
    const actual = await takePgManifest(targetSession, opts.db)
    const differences = comparePgManifests(expected, actual)
    const rtoMs = Date.now() - started
    if (opts.recordStore) {
      recordDrillResult({ store: opts.recordStore, rtoMs, details: { ok: differences.length === 0 } })
    }
    return { ok: differences.length === 0, differences, rtoMs }
  } finally {
    await fsp.rm(globalsTmp, { force: true })
    await fsp.rm(dumpTmp, { force: true })
  }
}
