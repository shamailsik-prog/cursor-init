import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"

/** Fixed root. os.tmpdir() and TMPDIR are not consulted. */
export const DRILL_TEMP_ROOT = "/tmp/sikander-backup-drill"
export const DRILL_POSTGRES_DATABASE = "legal_scraper"
export const DRILL_PITR_DATABASE = "postgres"
export const DRILL_FIRESTORE_PROJECTS = ["f33-backup-drill", "demo-sikander"] as const
export const DRILL_OBJECT_BUCKET = "f33-vault-drill"

const CLOUD_HOST =
  /(amazonaws\.com|googleapis\.com|cloudsql|neon\.tech|supabase\.co|render\.com|cloudflarestorage\.com|firebaseio\.com)/i

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

/** NFKC plus a non-ASCII rejection. Only the canonical allowlist string is accepted. */
export function explicitDrillName(value: string, allowed: readonly string[]): boolean {
  const trimmed = value.trim()
  if (trimmed.normalize("NFKC") !== trimmed) return false
  if ([...trimmed].some((ch) => ch.charCodeAt(0) > 127)) return false
  return allowed.includes(trimmed)
}

export function databaseConninfo(database: string): boolean {
  const value = database.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true
  if (/(?:^|\s)(?:host|hostaddr|port|dbname|user|password|service|servicefile)\s*=/i.test(value)) return true
  return false
}

export function loopbackHttpEndpoint(endpoint: string): boolean {
  if (!endpoint.startsWith("http://")) return false
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== "http:") return false
  if (url.username || url.password) return false
  if (url.pathname !== "/" && url.pathname !== "") return false
  if (url.search || url.hash) return false
  if (!loopbackHost(url.hostname)) return false
  if (!url.port || !/^[1-9]\d{0,4}$/.test(url.port)) return false
  const port = Number(url.port)
  return port >= 1 && port <= 65535
}

/**
 * Create the root mode 0700 when it is missing, then require that this process owns it,
 * that group and other have no permissions, and that it is not a symlink.
 * A pre-existing directory is never chmod'd: a 0777 root or another user's root is refused.
 */
export function ensureDrillTempRoot(root: string = DRILL_TEMP_ROOT): string {
  let created = false
  try {
    lstatSync(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    mkdirSync(root, { recursive: true, mode: 0o700 })
    created = true
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  if (created && uid !== undefined) {
    const createdStat = lstatSync(root)
    if (!createdStat.isSymbolicLink() && createdStat.uid === uid && (createdStat.mode & 0o077) !== 0) {
      chmodSync(root, 0o700)
    }
  }
  const st = lstatSync(root)
  if (st.isSymbolicLink()) throw new Error("drill temp root is a symlink")
  if (uid === undefined || st.uid !== uid) throw new Error("drill temp root is not owned by the drill user")
  if ((st.mode & 0o077) !== 0) throw new Error("drill temp root is group- or world-accessible")
  if (realpathSync(root) !== root) throw new Error("drill temp root resolves outside itself")
  return root
}

export function drillScratchDir(prefix: string): string {
  const safe = prefix.replace(/[^a-z0-9-]/gi, "") || "scratch-"
  const stem = safe.endsWith("-") ? safe : `${safe}-`
  return mkdtempSync(path.join(ensureDrillTempRoot(), stem))
}

function hasSymlinkComponent(absPath: string): boolean {
  if (!absPath.startsWith("/")) return false
  const parts = absPath.split(path.sep).filter(Boolean)
  let cur = path.parse(absPath).root
  for (const part of parts) {
    cur = path.join(cur, part)
    try {
      if (lstatSync(cur).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

function resolvedPath(candidate: string): string | null {
  try {
    return realpathSync(candidate)
  } catch {
    const parts = candidate.split(path.sep).filter(Boolean)
    let cur = path.parse(candidate).root
    let lastReal: string | null = null
    const rest: string[] = []
    let missing = false
    for (const part of parts) {
      if (missing) {
        rest.push(part)
        continue
      }
      const next = path.join(cur, part)
      try {
        lstatSync(next)
        cur = next
        lastReal = realpathSync(next)
      } catch {
        missing = true
        rest.push(part)
      }
    }
    if (!lastReal) return null
    return path.resolve(lastReal, ...rest)
  }
}

/** realpath containment under the fixed drill root. Symlinks are refused. TMPDIR is ignored. */
export function tempPathProblems(candidate: string): string[] {
  if (!candidate.startsWith("/")) return [`not an isolated temp directory: ${candidate}`]
  let root: string
  try {
    root = ensureDrillTempRoot()
  } catch (err) {
    return [(err as Error).message]
  }
  if (hasSymlinkComponent(candidate)) return [`symlink refused: ${candidate}`]
  const resolved = resolvedPath(candidate)
  if (!resolved) return [`not an isolated temp directory: ${candidate}`]
  if (hasSymlinkComponent(resolved)) return [`symlink refused: ${candidate}`]
  const rel = path.relative(root, resolved)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || resolved === root) {
    return [`not an isolated temp directory: ${candidate}`]
  }
  return []
}

export function insideTempDir(dir: string): boolean {
  return tempPathProblems(dir).length === 0
}

function cloudProblems(value: unknown): string[] {
  if (typeof value === "string" && CLOUD_HOST.test(value)) {
    return [`restore target looks like a managed cloud endpoint (${value})`]
  }
  return []
}

function postgresDatabaseProblems(database: string, pitr: boolean): string[] {
  if (!database) return ["postgres target database is missing"]
  if (databaseConninfo(database)) return ["database argument contains a conninfo or URI"]
  const allowed = pitr ? [DRILL_PITR_DATABASE] : [DRILL_POSTGRES_DATABASE]
  if (!explicitDrillName(database, allowed)) {
    return [`postgres database ${database} is not an explicit drill target`]
  }
  return []
}

/**
 * Fail closed. A target is usable only when its kind is explicitly local, emulator, or temp
 * and every host, path, name, and endpoint is an explicit drill target. An `isolated: true` flag is ignored.
 * Managed-cloud restore (FA-F33-R3-001) is not a target this drill accepts.
 * The second argument is ignored so a caller cannot point the check at TMPDIR.
 */
export function isolationProblems(target: unknown, _ignoredTmpRoot?: string): string[] {
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
    const pitr = typeof claim.dataDir === "string"
    if (!host) problems.push("postgres target host is missing")
    else if (host.startsWith("/")) {
      for (const problem of tempPathProblems(host)) {
        problems.push(
          problem.startsWith("symlink") ? problem : `postgres socket directory is not an isolated temp directory: ${host}`
        )
      }
    } else if (!loopbackHost(host)) problems.push(`postgres host ${host} is not loopback`)
    problems.push(...postgresDatabaseProblems(database, pitr))
    if (pitr) {
      const dataDir = claim.dataDir as string
      for (const problem of tempPathProblems(dataDir)) {
        problems.push(
          problem.startsWith("symlink")
            ? problem
            : `postgres data directory is not an isolated temp directory: ${dataDir}`
        )
      }
    }
  }

  if (engine === "firestore") {
    if (kind !== "emulator") problems.push("firestore restore requires an emulator target")
    const host = typeof claim.host === "string" ? claim.host.trim() : ""
    if (!loopbackHost(host)) problems.push(`firestore host ${host || "(missing)"} is not loopback`)
    const projectId = typeof claim.projectId === "string" ? claim.projectId.trim() : ""
    if (!explicitDrillName(projectId, DRILL_FIRESTORE_PROJECTS)) {
      problems.push(`firestore project ${projectId || "(missing)"} is not an explicit drill target`)
    }
    const database = typeof claim.database === "string" ? claim.database : ""
    if (database && !explicitDrillName(database, DRILL_FIRESTORE_PROJECTS)) {
      problems.push(`firestore database ${database} is not an explicit drill target`)
    }
    if (typeof claim.importDir === "string") {
      for (const problem of tempPathProblems(claim.importDir)) {
        problems.push(
          problem.startsWith("symlink")
            ? problem
            : `firestore import directory is not an isolated temp directory: ${claim.importDir}`
        )
      }
    }
  }

  if (engine === "objects") {
    if (kind === "emulator") problems.push("object target cannot use emulator kind")
    const endpoint = typeof claim.endpoint === "string" ? claim.endpoint.trim() : ""
    const bucket = typeof claim.bucket === "string" ? claim.bucket.trim() : ""
    if (!endpoint) problems.push("object restore target is missing (explicit local or temp required)")
    else if (!loopbackHttpEndpoint(endpoint)) problems.push(`object endpoint ${endpoint} is not an explicit local endpoint`)
    if (!explicitDrillName(bucket, [DRILL_OBJECT_BUCKET])) {
      problems.push(`object bucket ${bucket || "(missing)"} is not an explicit drill target`)
    }
  }

  return problems
}

export function assertIsolatedRestoreTarget(target: unknown): void {
  const problems = isolationProblems(target)
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
