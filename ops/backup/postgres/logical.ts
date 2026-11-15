import { createWriteStream, promises as fsp } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { backupPayloadProblems, pgContentUnits, type ContentUnit } from "../drill/content"
import { planIdempotentRestore } from "../drill/idempotent"
import { isolationProblems, postgresTargetFromEnv } from "../drill/target"
import type { KeyRing } from "../lib/envelope.mjs"
import { BundleWriter, openBundleFile, verifyBundle, type ArtefactInfo, type BundleManifest } from "../lib/bundle"
import { runCommand, psqlArgv, PersistentPsqlSession, PsqlSession } from "../lib/exec"
import { recordDrillResult, type DrillContentUnit } from "../lib/results"
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

type LogicalRestoreResult = {
  ok: boolean
  differences: string[]
  rtoMs: number
  idempotent: boolean
  content: Array<ContentUnit & { match: boolean }>
}

function matchedUnits(manifest: PgManifest, match: boolean): Array<ContentUnit & { match: boolean }> {
  return pgContentUnits(manifest).map((unit) => ({ ...unit, match }))
}

function recordVerified(
  opts: RestoreLogicalOptions,
  kind: "local" | "temp",
  rtoMs: number,
  idempotent: boolean,
  content: DrillContentUnit[]
): void {
  if (!opts.recordStore || content.some((unit) => !unit.match)) return
  recordDrillResult({
    store: opts.recordStore,
    rtoMs,
    idempotent,
    target: { kind, engine: "postgres", isolated: true },
    details: { ok: true, contentUnits: content },
    problems: [],
  })
}

export async function restoreLogical(opts: RestoreLogicalOptions): Promise<LogicalRestoreResult> {
  const started = Date.now()
  const fail = (differences: string[]): LogicalRestoreResult => ({
    ok: false,
    differences,
    rtoMs: Date.now() - started,
    idempotent: false,
    content: [],
  })
  const env = envOf(opts)
  const target = postgresTargetFromEnv(env, opts.db)
  const targetProblems = isolationProblems(target)
  if (targetProblems.length) return fail(targetProblems)

  const verify = await verifyBundle(opts.bundleDir, opts.ring)
  if (!verify.ok || !verify.manifest || !verify.bundle) return fail(verify.problems)
  const payloadProblems = backupPayloadProblems({
    store: verify.bundle.store,
    storeManifest: verify.manifest.store,
    artefacts: verify.manifest.artefacts,
  })
  if (payloadProblems.length) return fail(payloadProblems)

  const expected = verify.manifest.store as PgManifest
  const bundleManifest = verify.manifest
  const admin = new PsqlSession(opts.pgPrefix, env, "postgres")
  let exists = 0
  try {
    exists = Number(await admin.queryScalar(`SELECT count(*) FROM pg_database WHERE datname = '${opts.db.replace(/'/g, "''")}';`))
  } catch (err) {
    return fail([(err as Error).message])
  }
  if (exists > 0) {
    try {
      const targetSession = new PsqlSession(opts.pgPrefix, env, opts.db)
      const actual = await takePgManifest(targetSession, opts.db)
      const differences = comparePgManifests(expected, actual)
      const plan = planIdempotentRestore({ targetExists: true, contentMatch: differences.length === 0 })
      if (plan.action === "noop") {
        const content = matchedUnits(actual, true)
        const rtoMs = Date.now() - started
        recordVerified(opts, target.kind, rtoMs, true, content)
        return { ok: true, differences: [], rtoMs, idempotent: true, content }
      }
      return fail([plan.reason, ...differences])
    } catch (err) {
      return fail([(err as Error).message])
    }
  }

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
      return fail([(err as Error).message])
    }
    const create = await runCommand(psqlArgv("postgres", ["-c", `CREATE DATABASE "${opts.db.replace(/"/g, '""')}";`]), {
      env,
      pgPrefix: opts.pgPrefix,
    })
    if (create.code !== 0) return fail([create.stderr || create.stdout])
    const extensions = await runCommand(
      psqlArgv(opts.db, [
        "-c",
        "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;",
      ]),
      { env, pgPrefix: opts.pgPrefix }
    )
    if (extensions.code !== 0) return fail([extensions.stderr || extensions.stdout])
    const applyGlobals = await runCommand(psqlArgv(opts.db, ["-f", globalsTmp]), { env, pgPrefix: opts.pgPrefix })
    if (applyGlobals.code !== 0) return fail([applyGlobals.stderr || applyGlobals.stdout])
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
      return fail([msg])
    }
    const targetSession = new PsqlSession(opts.pgPrefix, env, opts.db)
    const actual = await takePgManifest(targetSession, opts.db)
    const differences = comparePgManifests(expected, actual)
    const rtoMs = Date.now() - started
    const content = matchedUnits(actual, differences.length === 0)
    if (differences.length === 0) recordVerified(opts, target.kind, rtoMs, false, content)
    return { ok: differences.length === 0, differences, rtoMs, idempotent: false, content }
  } finally {
    await fsp.rm(globalsTmp, { force: true })
    await fsp.rm(dumpTmp, { force: true })
  }
}
