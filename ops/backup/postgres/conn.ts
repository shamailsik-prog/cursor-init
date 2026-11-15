import { realpathSync } from "node:fs"
import { DRILL_POSTGRES_DATABASE } from "../drill/target"

export const LIBPQ_REDIRECT_KEYS = ["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE"] as const

export function postgresRedirectProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = []
  for (const key of LIBPQ_REDIRECT_KEYS) {
    if ((env[key] ?? "").trim()) {
      problems.push(`${key} is refused; it can redirect the connection away from the checked target`)
    }
  }
  return problems
}

/** Child environment for a restore. Drops every libpq variable except PGOPTIONS, which the manifest session sets. */
export function scrubLibpqEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(next)) {
    if (key.startsWith("PG")) delete next[key]
  }
  return next
}

function quoteConn(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

/** One conninfo. The database name is the drill constant, never the raw argument. */
export function explicitConninfo(opts: { host: string; port: string; database: string; user: string }): string {
  return [
    `host=${quoteConn(opts.host)}`,
    `port=${quoteConn(opts.port)}`,
    `dbname=${quoteConn(opts.database)}`,
    `user=${quoteConn(opts.user)}`,
  ].join(" ")
}

export function drillDatabaseConninfo(opts: { host: string; port: string; user: string; maintenance?: boolean }): string {
  return explicitConninfo({
    host: opts.host,
    port: opts.port,
    database: opts.maintenance ? "postgres" : DRILL_POSTGRES_DATABASE,
    user: opts.user,
  })
}

export const SERVER_IDENTITY_SQL =
  "SELECT concat_ws(chr(31), coalesce(host(inet_server_addr()), ''), coalesce(inet_server_port()::text, ''), coalesce(current_setting('unix_socket_directories'), ''), s.system_identifier::text) FROM pg_control_system() AS s"

export type ServerIdentity = {
  inetAddr: string
  inetPort: string
  socketDirs: string
  systemIdentifier: string
}

export function parseServerIdentity(line: string): ServerIdentity | null {
  const parts = line.trim().split("\u001f")
  if (parts.length !== 4) return null
  return {
    inetAddr: parts[0],
    inetPort: parts[1],
    socketDirs: parts[2],
    systemIdentifier: parts[3],
  }
}

export function connectedTargetProblems(opts: {
  host: string
  port: string
  expectedSystemIdentifier: string
  row: ServerIdentity
}): string[] {
  const problems: string[] = []
  if (!/^\d+$/.test(opts.expectedSystemIdentifier) || opts.row.systemIdentifier !== opts.expectedSystemIdentifier) {
    problems.push("connected cluster system identifier does not match the drill cluster")
  }
  if (opts.host.startsWith("/")) {
    if (opts.row.inetAddr) problems.push("connection was not the unix socket that was checked")
    let expected = ""
    try {
      expected = realpathSync(opts.host)
    } catch {
      expected = ""
    }
    const matched = opts.row.socketDirs
      .split(",")
      .map((dir) => dir.trim())
      .filter(Boolean)
      .some((dir) => {
        try {
          return expected !== "" && realpathSync(dir) === expected
        } catch {
          return false
        }
      })
    if (!matched) problems.push("connected unix socket directory does not match the explicit target")
  } else {
    const addr = opts.row.inetAddr
    if (addr !== "127.0.0.1" && addr !== "::1") {
      problems.push("connected server address does not match the explicit target")
    }
    if (opts.row.inetPort !== opts.port) {
      problems.push("connected server port does not match the explicit target")
    }
  }
  return problems
}
