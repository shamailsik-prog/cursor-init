import { createWriteStream, promises as fsp } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import type { KeyRing } from "../lib/envelope.mjs"
import { BundleWriter, openBundleFile, verifyBundle } from "../lib/bundle"
import { runCommand, psqlArgv, PsqlSession } from "../lib/exec"
import { recordDrillResult } from "../lib/results"
import { assertPgTargetClean } from "./guards"
import { comparePgManifests, takePgManifest, type PgManifest } from "./manifest"

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

export async function backupLogical(opts: BackupLogicalOptions): Promise<{ dir: string; manifest: PgManifest }> {
  const env = envOf(opts)
  const session = new PsqlSession(opts.pgPrefix, env, opts.db)
  const manifest = await takePgManifest(session, opts.db)
  const snap = manifest.meta.snapshotId
  const writer = await BundleWriter.create(opts.outRoot, "postgres-logical", opts.key)
  const globals = await runCommand(["pg_dumpall", "--globals-only", "--no-role-passwords"], {
    env,
    pgPrefix: opts.pgPrefix,
  })
  if (globals.code !== 0) throw new Error(globals.stderr || globals.stdout)
  await writer.addBuffer("globals.sql", Buffer.from(globals.stdout, "utf8"))
  const dump = await runCommand(
    ["pg_dump", "--format=custom", `--snapshot=${snap}`, opts.db],
    { env, pgPrefix: opts.pgPrefix }
  )
  if (dump.code !== 0) throw new Error(dump.stderr || dump.stdout)
  await writer.addBuffer("database.dump", Buffer.from(dump.stdout, "binary"))
  const dir = await writer.finish(manifest)
  return { dir, manifest }
}

function parseRolesFromGlobals(sql: string): string[] {
  const roles: string[] = []
  for (const line of sql.split("\n")) {
    const m = /^CREATE ROLE\s+([^\s;]+)/i.exec(line.trim())
    if (m) roles.push(m[1].replace(/"/g, ""))
  }
  return roles
}

async function decryptToFile(bundleDir: string, name: string, ring: KeyRing, dest: string): Promise<void> {
  await pipeline(openBundleFile(bundleDir, name, ring), createWriteStream(dest))
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
  const env = envOf(opts)
  const globalsTmp = path.join(opts.bundleDir, ".globals.plain.part")
  await decryptToFile(opts.bundleDir, "globals.sql", opts.ring, globalsTmp)
  const globalsSql = await fsp.readFile(globalsTmp, "utf8")
  const roles = parseRolesFromGlobals(globalsSql)
  const admin = new PsqlSession(opts.pgPrefix, env, "postgres")
  try {
    await assertPgTargetClean(admin, opts.db, roles, expected.meta.serverVersion)
  } catch (err) {
    await fsp.rm(globalsTmp, { force: true })
    return { ok: false, differences: [(err as Error).message], rtoMs: Date.now() - started }
  }
  const create = await runCommand(psqlArgv("postgres", ["-c", `CREATE DATABASE "${opts.db.replace(/"/g, '""')}";`]), {
    env,
    pgPrefix: opts.pgPrefix,
  })
  if (create.code !== 0) {
    await fsp.rm(globalsTmp, { force: true })
    return { ok: false, differences: [create.stderr || create.stdout], rtoMs: Date.now() - started }
  }
  const applyGlobals = await runCommand(psqlArgv(opts.db, ["-f", globalsTmp]), { env, pgPrefix: opts.pgPrefix })
  await fsp.rm(globalsTmp, { force: true })
  if (applyGlobals.code !== 0) {
    return { ok: false, differences: [applyGlobals.stderr || applyGlobals.stdout], rtoMs: Date.now() - started }
  }
  const dumpTmp = path.join(opts.bundleDir, ".dump.part")
  await decryptToFile(opts.bundleDir, "database.dump", opts.ring, dumpTmp)
  const restore = await runCommand(["pg_restore", "--no-owner", "-d", opts.db, dumpTmp], {
    env,
    pgPrefix: opts.pgPrefix,
  })
  await fsp.rm(dumpTmp, { force: true })
  if (restore.code !== 0) {
    return { ok: false, differences: [restore.stderr || restore.stdout], rtoMs: Date.now() - started }
  }
  const targetSession = new PsqlSession(opts.pgPrefix, env, opts.db)
  const actual = await takePgManifest(targetSession, opts.db)
  const differences = comparePgManifests(expected, actual)
  const rtoMs = Date.now() - started
  if (opts.recordStore) await recordDrillResult(opts.recordStore, rtoMs, { ok: differences.length === 0 })
  return { ok: differences.length === 0, differences, rtoMs }
}
