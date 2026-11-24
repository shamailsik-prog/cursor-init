import { lstatSync, realpathSync, promises as fsp } from "node:fs"
import path from "node:path"
import { backupPayloadProblems, pgContentUnits, type ContentUnit } from "../drill/content"
import { planIdempotentRestore } from "../drill/idempotent"
import { DRILL_POSTGRES_DATABASE, ensureDrillTempRoot, isolationProblems } from "../drill/target"
import { drillDatabaseConninfo, postgresRedirectProblems, scrubLibpqEnv } from "./conn"
import type { KeyRing } from "../lib/envelope.mjs"
import { BundleWriter, openBundleFile, verifyBundle, type ArtefactInfo, type BundleManifest } from "../lib/bundle"
import { writePlaintextExclusiveStream } from "../lib/plaintext"
import { registerPlaintext } from "../lib/emergency"
import { pipeCommandStdout, pushPsqlQueryTimeout, runCommand, PersistentPsqlSession } from "../lib/exec"
import { createScriptGuard, ScriptGuardError } from "./scriptGuard"
import { recordDrillResult, type DrillContentUnit } from "../lib/results"
import { assertPgTargetClean } from "./guards"
import { operatorPrefixProblems } from "./prefix"
import { comparePgManifests, takePgManifest, type PgManifest } from "./manifest"
import { withManifestPsqlEnv } from "./psqlEnv"
import { MANIFEST_SESSION_SETTINGS } from "./sql"

type SocketStamp = {
  dirIno: number
  dirDev: number
  dirReal: string
  fileIno: number
  fileDev: number
  fileReal: string
}

/** lstat the socket directory and the socket file. A symlink or a replaced inode is a different cluster. */
function captureSocket(host: string, port: string): SocketStamp | null | string {
  if (!host.startsWith("/")) return null
  let dirStat: ReturnType<typeof lstatSync>
  try {
    dirStat = lstatSync(host)
  } catch (err) {
    return `postgres socket directory is missing: ${(err as Error).message}`
  }
  if (dirStat.isSymbolicLink()) return "postgres socket directory is a symlink"
  let dirReal = ""
  try {
    dirReal = realpathSync(host)
  } catch {
    return "postgres socket directory does not resolve"
  }
  if (dirReal !== host) return "postgres socket directory resolves outside the explicit target"
  const sock = path.join(host, `.s.PGSQL.${port}`)
  let fileStat: ReturnType<typeof lstatSync>
  try {
    fileStat = lstatSync(sock)
  } catch (err) {
    return `postgres socket is missing: ${(err as Error).message}`
  }
  if (fileStat.isSymbolicLink()) return "postgres socket is a symlink"
  let fileReal = ""
  try {
    fileReal = realpathSync(sock)
  } catch {
    return "postgres socket does not resolve"
  }
  return {
    dirIno: dirStat.ino,
    dirDev: dirStat.dev,
    dirReal,
    fileIno: fileStat.ino,
    fileDev: fileStat.dev,
    fileReal,
  }
}

function socketDrift(host: string, port: string, before: SocketStamp | null): string | null {
  if (!before) return null
  const after = captureSocket(host, port)
  if (typeof after === "string") return after
  if (!after) return "postgres socket path disappeared"
  if (after.dirIno !== before.dirIno || after.dirDev !== before.dirDev || after.dirReal !== before.dirReal) {
    return "postgres socket directory changed after the restore"
  }
  if (after.fileIno !== before.fileIno || after.fileDev !== before.fileDev || after.fileReal !== before.fileReal) {
    return "postgres socket changed after the restore"
  }
  return null
}

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
  /** system_identifier of the cluster this restore is allowed to write. Read it from that cluster before connecting. */
  expectedSystemIdentifier?: string
}

function envOf(opts: { env?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  return opts.env ? { ...opts.env } : { ...process.env }
}

/** SQL on stdout. pg_restore does not open a database connection. */
export function logicalPgRestoreArgv(dumpPath: string): string[] {
  return ["pg_restore", "--no-owner", "-f", "-", dumpPath]
}

const SAFE_SOCKET = /^\/[A-Za-z0-9_./-]+$/

/**
 * Server-side assertion. It is the first statement of a writing session and is repeated only after a
 * line-start \\connect. \\restrict and \\unrestrict pass through. Every other psql meta-command is refused.
 */
export function identityGuardSql(opts: { expectedSystemIdentifier: string; host: string; port: string }): string {
  if (!/^\d+$/.test(opts.expectedSystemIdentifier)) throw new Error("expected cluster system identifier is required")
  if (!/^[1-9]\d{0,4}$/.test(opts.port) || Number(opts.port) > 65535) throw new Error("postgres target port is missing")
  const host = opts.host
  const socket = host.startsWith("/")
  if (socket) {
    if (!SAFE_SOCKET.test(host) || host.split("/").includes("..")) {
      throw new Error("postgres socket directory is not an isolated temp directory")
    }
  } else if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("postgres host is not loopback")
  }
  const socketCheck = socket
    ? `IF addr <> '' THEN
      RAISE EXCEPTION 'connection was not the unix socket that was checked';
    END IF;
    ok := false;
    FOREACH dir IN ARRAY string_to_array(socks, ',') LOOP
      IF rtrim(btrim(dir), '/') = rtrim('${host}', '/') THEN
        ok := true;
      END IF;
    END LOOP;
    IF NOT ok THEN
      RAISE EXCEPTION 'connected unix socket directory does not match the explicit target';
    END IF;
    IF current_setting('port') IS DISTINCT FROM '${opts.port}' THEN
      RAISE EXCEPTION 'connected server port does not match the explicit target';
    END IF;`
    : `IF addr <> '127.0.0.1' AND addr <> '::1' THEN
      RAISE EXCEPTION 'connected server address does not match the explicit target';
    END IF;
    IF prt IS DISTINCT FROM '${opts.port}' THEN
      RAISE EXCEPTION 'connected server port does not match the explicit target';
    END IF;`
  return `DO $f33guard$
DECLARE
  ident text;
  addr text;
  prt text;
  socks text;
  dir text;
  ok boolean := false;
BEGIN
  SELECT s.system_identifier::text,
         coalesce(host(inet_server_addr()), ''),
         coalesce(inet_server_port()::text, ''),
         coalesce(current_setting('unix_socket_directories'), '')
    INTO ident, addr, prt, socks
    FROM pg_control_system() AS s;
  IF ident IS DISTINCT FROM '${opts.expectedSystemIdentifier}' THEN
    RAISE EXCEPTION 'connected cluster system identifier does not match the drill cluster';
  END IF;
  ${socketCheck}
END
$f33guard$;
`
}

/**
 * COPY data is not a meta-command. Returning false disables that skip.
 * The assignment is the M29 anchor: a false value lets a backslash inside COPY be scanned as SQL.
 */
function copyBodyIsData(): boolean {
  let inCopy = false
  if (true) {
      inCopy = true
  }
  return inCopy
}

let plaintextHook: ((file: string) => void | Promise<void>) | null = null

/** Test-only. Production restore does not take a plaintext hook on its options. */
export function setRestorePlaintextHookForTests(hook: ((file: string) => void | Promise<void>) | null): void {
  plaintextHook = hook
}

async function notePlaintext(file: string): Promise<void> {
  if (plaintextHook) await plaintextHook(file)
}

/**
 * The guard is first. A line-start `\connect` is passed through and the guard is repeated after it.
 * `\restrict` and `\unrestrict` are passed through. Every other psql meta-command is refused,
 * including a `\connect` that is not at the start of a line, `\c`, `\ir`, `\i`, and `:name` interpolation.
 */
export function withIdentityGuards(sql: string, guard: string): string {
  const block = guard.endsWith("\n") ? guard : `${guard}\n`
  const stream = createScriptGuard(block, copyBodyIsData)
  return block + stream.push(sql) + stream.end()
}

/** The idempotent reconnect. The guard is part of this script, not only the scanner inside runScript. */
export function idempotentHop(databaseConn: string, guard: string): string {
  return withIdentityGuards(`\\connect "${databaseConn}"\n`, guard)
}

const LONG_STATEMENT_MS = Number(process.env.SIKANDER_BACKUP_STATEMENT_MS ?? 6 * 60 * 60 * 1000)

async function streamDumpIntoSession(
  session: PersistentPsqlSession,
  dumpPath: string,
  guard: string,
  env: NodeJS.ProcessEnv,
  pgPrefix: string[] | undefined
): Promise<string | null> {
  const block = guard.endsWith("\n") ? guard : `${guard}\n`
  const scanner = createScriptGuard(block, copyBodyIsData)
  const pop = pushPsqlQueryTimeout(LONG_STATEMENT_MS)
  try {
    let scanError: Error | null = null
    const piped = await session.runStreamed(async (write) => {
      await write(block)
      const result = await pipeCommandStdout(logicalPgRestoreArgv(dumpPath), { env, exactEnv: true, pgPrefix }, async (text) => {
        const piece = scanner.push(text)
        if (piece) await write(piece)
      })
      const tail = scanner.end()
      if (tail) await write(tail)
      if (result.code !== 0) {
        scanError = new Error(result.stderr.trim() || `pg_restore exited ${result.code}`)
      }
    })
    void piped
    return scanError ? (scanError as Error).message : null
  } catch (err) {
    if (err instanceof ScriptGuardError) return err.message
    return (err as Error).message
  } finally {
    pop()
  }
}

async function scriptError(session: PersistentPsqlSession, sql: string): Promise<string | null> {
  try {
    await session.runScript(sql)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export async function backupLogical(opts: BackupLogicalOptions): Promise<{ dir: string; manifest: PgManifest }> {
  const prefixProblems = operatorPrefixProblems(opts.pgPrefix)
  if (prefixProblems.length) throw new Error(prefixProblems.join("; "))
  const env = envOf(opts)
  const session = await PersistentPsqlSession.open(opts.pgPrefix, env, opts.db)
  const popTimeout = pushPsqlQueryTimeout(LONG_STATEMENT_MS)
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
    popTimeout()
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
  await writePlaintextExclusiveStream(dest, openBundleFile(bundleDir, name, ring, expect))
}

type LogicalRestoreResult = {
  ok: boolean
  differences: string[]
  rtoMs: number
  idempotent: boolean
  content: Array<ContentUnit & { match: boolean }>
  commandPrefix: string[]
}

function matchedUnits(manifest: PgManifest, match: boolean): Array<ContentUnit & { match: boolean }> {
  return pgContentUnits(manifest).map((unit) => ({ ...unit, match }))
}

function recordVerified(
  opts: RestoreLogicalOptions,
  kind: "local" | "temp",
  rtoMs: number,
  idempotent: boolean,
  content: DrillContentUnit[],
  commandPrefix: string[]
): void {
  if (!opts.recordStore || content.some((unit) => !unit.match)) return
  recordDrillResult({
    store: opts.recordStore,
    rtoMs,
    idempotent,
    target: { kind, engine: "postgres", isolated: true },
    details: { ok: true, contentUnits: content },
    problems: [],
    commandPrefix,
  })
}

function successContent(content: Array<ContentUnit & { match: boolean }>): string[] {
  if (content.length === 0) return ["zero-unit restore is not success"]
  if (content.some((unit) => !unit.match)) return ["restored content does not match"]
  return []
}

export async function restoreLogical(opts: RestoreLogicalOptions): Promise<LogicalRestoreResult> {
  const started = Date.now()
  const commandPrefix = [...(opts.pgPrefix ?? [])]
  const fail = (differences: string[]): LogicalRestoreResult => ({
    ok: false,
    differences,
    rtoMs: Date.now() - started,
    idempotent: false,
    content: [],
    commandPrefix,
  })
  const prefixProblems = operatorPrefixProblems(opts.pgPrefix)
  if (prefixProblems.length) return fail(prefixProblems)
  const env = envOf(opts)
  const redirect = postgresRedirectProblems(env)
  if (redirect.length) return fail(redirect)
  const host = env.PGHOST?.trim() ?? ""
  const port = env.PGPORT?.trim() ?? ""
  const user = env.PGUSER?.trim() || "postgres"
  const target = {
    kind: host.startsWith("/") ? ("temp" as const) : ("local" as const),
    engine: "postgres" as const,
    host,
    database: opts.db,
  }
  const targetProblems = isolationProblems(target)
  if (targetProblems.length) return fail(targetProblems)
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) return fail(["postgres target port is missing"])
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(user)) return fail(["postgres target user is not an explicit drill role"])

  const verify = await verifyBundle(opts.bundleDir, opts.ring)
  if (!verify.ok || !verify.manifest || !verify.bundle) return fail(verify.problems)
  const payloadProblems = backupPayloadProblems({
    store: verify.bundle.store,
    storeManifest: verify.manifest.store,
    artefacts: verify.manifest.artefacts,
  })
  if (payloadProblems.length) return fail(payloadProblems)
  const expectedId = opts.expectedSystemIdentifier?.trim() ?? ""
  if (!/^\d+$/.test(expectedId)) return fail(["expected cluster system identifier is required"])

  const expected = verify.manifest.store as PgManifest
  const bundleManifest = verify.manifest
  const childEnv = withManifestPsqlEnv(scrubLibpqEnv(env))
  const db = DRILL_POSTGRES_DATABASE
  const maintenance = drillDatabaseConninfo({ host, port, user, maintenance: true })
  const databaseConn = drillDatabaseConninfo({ host, port, user })
  const socketStamp = captureSocket(host, port)
  if (typeof socketStamp === "string") return fail([socketStamp])
  let guard = ""
  try {
    guard = identityGuardSql({ expectedSystemIdentifier: expectedId, host, port })
  } catch (err) {
    return fail([(err as Error).message])
  }

  const session = await PersistentPsqlSession.open(opts.pgPrefix, childEnv, "postgres", {
    conninfo: maintenance,
    exactEnv: true,
  })
  let scratch: string | undefined
  let releaseScratch: (() => void) | undefined
  try {
    const gate = await scriptError(session, guard)
    if (gate) return fail([gate])
    const driftedAtConnect = socketDrift(host, port, socketStamp)
    if (driftedAtConnect) return fail([driftedAtConnect])

    const exists = Number(await session.queryScalar(`SELECT count(*) FROM pg_database WHERE datname = '${db}';`))
    if (exists > 0) {
      const hop = await scriptError(session, idempotentHop(databaseConn, guard))
      const driftedHop = socketDrift(host, port, socketStamp)
      if (driftedHop || hop) return fail([driftedHop, hop].filter((item): item is string => Boolean(item)))
      const actual = await takePgManifest(session, db)
      const differences = comparePgManifests(expected, actual)
      const plan = planIdempotentRestore({ targetExists: true, contentMatch: differences.length === 0 })
      if (plan.action === "noop") {
        const content = matchedUnits(actual, true)
        const empty = successContent(content)
        if (empty.length) return fail(empty)
        const rtoMs = Date.now() - started
        recordVerified(opts, target.kind, rtoMs, true, content, commandPrefix)
        return { ok: true, differences: [], rtoMs, idempotent: true, content, commandPrefix }
      }
      return fail([plan.reason, ...differences])
    }

    scratch = await fsp.mkdtemp(path.join(ensureDrillTempRoot(), "f33-pg-plain-"))
    releaseScratch = registerPlaintext(scratch)
    const globalsTmp = path.join(scratch, "globals.sql")
    const dumpTmp = path.join(scratch, "database.dump")
    await decryptToFile(opts.bundleDir, "globals.sql", opts.ring, globalsTmp, artefactExpect(bundleManifest, "globals.sql"))
    await notePlaintext(globalsTmp)
    const driftedPlain = socketDrift(host, port, socketStamp)
    if (driftedPlain) return fail([driftedPlain])

    const globalsSql = stripBootstrapSuperuser(await fsp.readFile(globalsTmp, "utf8"))
    await assertPgTargetClean(session, db, parseRolesFromGlobals(globalsSql), expected.meta.serverVersion)
    await decryptToFile(opts.bundleDir, "database.dump", opts.ring, dumpTmp, artefactExpect(bundleManifest, "database.dump"))
    await notePlaintext(dumpTmp)
    const driftedDump = socketDrift(host, port, socketStamp)
    if (driftedDump) return fail([driftedDump])

    const createSql = withIdentityGuards(
      `CREATE DATABASE "${db}";\n\\connect "${databaseConn}"\nCREATE EXTENSION IF NOT EXISTS vector;\nCREATE EXTENSION IF NOT EXISTS pg_trgm;\nCREATE EXTENSION IF NOT EXISTS pgcrypto;\n`,
      guard
    )
    const created = await scriptError(session, createSql)
    const applied = created ? null : await scriptError(session, withIdentityGuards(globalsSql, guard))
    const restored = created || applied ? null : await streamDumpIntoSession(session, dumpTmp, guard, childEnv, opts.pgPrefix)
    const driftedWrite = socketDrift(host, port, socketStamp)
    const writeError = created || applied || restored
    if (driftedWrite || writeError) {
      return fail([driftedWrite, writeError].filter((item): item is string => Boolean(item)))
    }

    const actual = await takePgManifest(session, db)
    const differences = comparePgManifests(expected, actual)
    const rtoMs = Date.now() - started
    const content = matchedUnits(actual, differences.length === 0)
    if (differences.length === 0) {
      const empty = successContent(content)
      if (empty.length) return fail(empty)
      recordVerified(opts, target.kind, rtoMs, false, content, commandPrefix)
    }
    return { ok: differences.length === 0, differences, rtoMs, idempotent: false, content, commandPrefix }
  } catch (err) {
    return fail([(err as Error).message])
  } finally {
    session.close()
    if (scratch) await fsp.rm(scratch, { recursive: true, force: true })
    releaseScratch?.()
  }
}
