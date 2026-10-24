import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCommand } from "../../lib/exec"

export type PgCluster = {
  dir: string
  port: number
  env: NodeJS.ProcessEnv
  stop: () => Promise<void>
  runAs: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
}

function findFreePort(start: number): number {
  const base = Number(process.env.SIKANDER_BACKUP_DRILL_PG_PORT ?? start)
  return base
}

function pgEnv(extra: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const bin = process.env.SIKANDER_BACKUP_DRILL_PG_BIN?.trim() || "/usr/lib/postgresql/16/bin"
  return { ...process.env, ...extra, PATH: `${bin}:${process.env.PATH ?? ""}` } as NodeJS.ProcessEnv
}

function pgPrefix(): string[] {
  if (typeof process.getuid === "function" && process.getuid() === 0) return ["runuser", "-u", "postgres", "--"]
  return []
}

export async function startCluster(opts: {
  port?: number
  walSegSize?: number
  archive?: { archiveDir: string; keyFile: string; walScript: string }
}): Promise<PgCluster> {
  const prefix = pgPrefix()
  const which = await runCommand(["bash", "-lc", "command -v initdb && command -v pg_ctl && command -v psql"], {
    env: pgEnv(),
    pgPrefix: prefix,
  })
  if (which.code !== 0) {
    throw new Error(
      "PostgreSQL 16 client programs are not on PATH (install postgresql-16). Set SIKANDER_BACKUP_DRILL_PG_PORT when multiple drills run."
    )
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "f33-pg-"))
  const port = opts.port ?? findFreePort(55432)
  const initArgs = ["initdb", "-D", dir, "--no-instructions", "-U", "postgres"]
  if (opts.walSegSize) initArgs.push(`--wal-segsize=${opts.walSegSize}`)
  const init = await runCommand(initArgs, { env: pgEnv(), pgPrefix: prefix })
  if (init.code !== 0) throw new Error(init.stderr || init.stdout)
  const conf = path.join(dir, "postgresql.conf")
  let extra = `port = ${port}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = '${dir}'\n`
  if (opts.archive) {
    extra += `wal_level = replica\narchive_mode = on\narchive_timeout = 60\n`
    extra += `archive_command = 'node ${opts.archive.walScript} archive %p %f --archive-dir ${opts.archive.archiveDir} --key-file ${opts.archive.keyFile}'\n`
  }
  writeFileSync(conf, extra, { flag: "a" })
  const env = pgEnv({ PGDATA: dir, PGPORT: String(port), PGHOST: dir, PGUSER: "postgres" })
  const start = await runCommand(["pg_ctl", "-D", dir, "-l", path.join(dir, "log"), "-w", "start"], {
    env,
    pgPrefix: prefix,
  })
  if (start.code !== 0) throw new Error(start.stderr || start.stdout)
  return {
    dir,
    port,
    env,
    async stop() {
      await runCommand(["pg_ctl", "-D", dir, "-m", "fast", "stop"], { env, pgPrefix: prefix })
      rmSync(dir, { recursive: true, force: true })
    },
    runAs(argv) {
      return runCommand(argv, { env, pgPrefix: prefix })
    },
  }
}
