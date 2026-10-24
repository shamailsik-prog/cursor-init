import path from "node:path"
import type { PsqlSession } from "../lib/exec"
import { runCommand } from "../lib/exec"

export class PgTargetNotCleanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PgTargetNotCleanError"
  }
}

function majorVersion(version: string): number {
  const m = /^(\d+)/.exec(version.trim())
  return m ? Number(m[1]) : 0
}

/** Refuse restore into a non-clean cluster (R14). */
export async function assertPgTargetClean(
  session: PsqlSession,
  db: string,
  roleNamesFromGlobals: string[],
  backupServerVersion: string
): Promise<void> {
  const targetVersion = await session.queryScalar("SHOW server_version;")
  if (majorVersion(targetVersion) < majorVersion(backupServerVersion)) {
    throw new PgTargetNotCleanError(
      `target server ${targetVersion.trim()} is older than backup ${backupServerVersion.trim()}`
    )
  }
  const exists = await session.queryScalar(
    `SELECT count(*) FROM pg_database WHERE datname = '${db.replace(/'/g, "''")}';`
  )
  if (Number(exists) > 0) throw new PgTargetNotCleanError(`target database ${db} already exists`)

  for (const role of roleNamesFromGlobals) {
    if (role.startsWith("pg_")) continue
    const n = await session.queryScalar(
      `SELECT count(*) FROM pg_roles WHERE rolname = '${role.replace(/'/g, "''")}';`
    )
    if (Number(n) > 0) throw new PgTargetNotCleanError(`role ${role} already exists on target`)
  }
}

export async function assertPitrDataDirClean(dataDir: string): Promise<void> {
  const r = await runCommand(["test", "!", "-e", path.join(dataDir, "PG_VERSION")])
  if (r.code !== 0) throw new PgTargetNotCleanError(`PITR data directory is not empty: ${dataDir}`)
}
