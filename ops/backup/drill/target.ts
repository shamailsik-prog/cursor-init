import os from "node:os"
import path from "node:path"

const CLOUD_HOST = /(amazonaws\.com|googleapis\.com|cloudsql|neon\.tech|supabase\.co|render\.com|cloudflarestorage\.com|firebaseio\.com)/i
const PRODUCTION_NAME = /(^|[^a-z0-9])(prod|production|live)([^a-z0-9]|$)/i
const EMULATOR_PROJECT = /^(demo-|f33-|local-|drill-|test-)/
const LOOPBACK_HTTP = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(?:\/|$)/

export class RestoreTargetRefused extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(problems.join("; "))
    this.name = "RestoreTargetRefused"
    this.problems = problems
  }
}

function loopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"
}

function productionLooking(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === "(default)") return true
  return PRODUCTION_NAME.test(trimmed)
}

/** A dedicated directory under the temp root. The temp root itself is not an isolated target. */
export function insideTempDir(dir: string, tmpRoot = os.tmpdir()): boolean {
  if (!dir.startsWith("/")) return false
  const root = path.resolve(tmpRoot)
  const resolved = path.resolve(dir)
  const rel = path.relative(root, resolved)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function cloudProblems(value: unknown): string[] {
  if (typeof value === "string" && CLOUD_HOST.test(value)) {
    return [`restore target looks like a managed cloud endpoint (${value})`]
  }
  return []
}

/**
 * Fail closed. A target is usable only when its kind is explicitly local, emulator, or temp
 * and every host, path, name, and endpoint agrees. An `isolated: true` flag is ignored.
 * Managed-cloud restore (FA-F33-R3-001) is not a target this drill accepts.
 */
export function isolationProblems(target: unknown, tmpRoot = os.tmpdir()): string[] {
  if (!target || typeof target !== "object") return ["restore target is missing (fail closed)"]
  const claim = target as Record<string, unknown>
  const problems: string[] = []
  const kind = claim.kind
  const engine = claim.engine
  if (kind !== "local" && kind !== "emulator" && kind !== "temp") {
    problems.push("restore target is not an explicit local, emulator, or temp target")
  }
  if (engine !== "postgres" && engine !== "firestore" && engine !== "objects") {
    problems.push("restore target engine is not postgres, firestore, or objects")
  }
  for (const value of Object.values(claim)) problems.push(...cloudProblems(value))

  if (engine === "postgres") {
    if (kind === "emulator") problems.push("postgres target cannot use emulator kind")
    const host = typeof claim.host === "string" ? claim.host.trim() : ""
    const database = typeof claim.database === "string" ? claim.database.trim() : ""
    if (!host) problems.push("postgres target host is missing")
    else if (host.startsWith("/")) {
      if (!insideTempDir(host, tmpRoot)) problems.push(`postgres socket directory is not an isolated temp directory: ${host}`)
    } else if (!loopbackHost(host)) problems.push(`postgres host ${host} is not loopback`)
    if (!database) problems.push("postgres target database is missing")
    else if (productionLooking(database)) problems.push(`postgres database ${database} looks like production`)
    if (typeof claim.dataDir === "string" && !insideTempDir(claim.dataDir, tmpRoot)) {
      problems.push(`postgres data directory is not an isolated temp directory: ${claim.dataDir}`)
    }
  }

  if (engine === "firestore") {
    if (kind !== "emulator") problems.push("firestore restore requires an emulator target")
    const host = typeof claim.host === "string" ? claim.host.trim() : ""
    if (!loopbackHost(host)) problems.push(`firestore host ${host || "(missing)"} is not loopback`)
    const projectId = typeof claim.projectId === "string" ? claim.projectId.trim() : ""
    if (!EMULATOR_PROJECT.test(projectId) || productionLooking(projectId)) {
      problems.push(`firestore project ${projectId || "(missing)"} is not an explicit emulator project`)
    }
    const database = typeof claim.database === "string" ? claim.database : ""
    if (database && productionLooking(database)) problems.push(`firestore database ${database} looks like production`)
    if (typeof claim.importDir === "string" && !insideTempDir(claim.importDir, tmpRoot)) {
      problems.push(`firestore import directory is not an isolated temp directory: ${claim.importDir}`)
    }
  }

  if (engine === "objects") {
    if (kind === "emulator") problems.push("object target cannot use emulator kind")
    const endpoint = typeof claim.endpoint === "string" ? claim.endpoint.trim() : ""
    const root = typeof claim.root === "string" ? claim.root.trim() : ""
    if (!endpoint && !root) problems.push("object restore target is missing (explicit local or temp required)")
    if (endpoint && !LOOPBACK_HTTP.test(endpoint)) problems.push(`object endpoint ${endpoint} is not an explicit local endpoint`)
    if (root && !insideTempDir(root, tmpRoot)) problems.push(`object root ${root} is not an isolated temp directory`)
    const bucket = typeof claim.bucket === "string" ? claim.bucket : ""
    if (bucket && productionLooking(bucket)) problems.push(`object bucket ${bucket} looks like production`)
  }

  return problems
}

export function assertIsolatedRestoreTarget(target: unknown, tmpRoot = os.tmpdir()): void {
  const problems = isolationProblems(target, tmpRoot)
  if (problems.length) throw new RestoreTargetRefused(problems)
}

export function postgresTargetFromEnv(env: NodeJS.ProcessEnv, database: string): {
  kind: "local" | "temp"
  engine: "postgres"
  host: string
  database: string
} {
  const host = env.PGHOST?.trim() ?? ""
  return { kind: host.startsWith("/") ? "temp" : "local", engine: "postgres", host, database }
}

export function firestoreEmulatorTarget(opts: { host: string; projectId: string; importDir: string }): {
  kind: "emulator"
  engine: "firestore"
  host: string
  projectId: string
  importDir: string
} {
  return { kind: "emulator", engine: "firestore", host: opts.host, projectId: opts.projectId, importDir: opts.importDir }
}
