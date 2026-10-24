import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type CommandResult = { code: number; stdout: string; stderr: string }

export type RunCommandOptions = {
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** R19: argv prefix before client programs (e.g. docker compose exec … gosu postgres). */
  pgPrefix?: string[]
}

function prefixArgv(pgPrefix: string[] | undefined, argv: string[]): string[] {
  return pgPrefix?.length ? [...pgPrefix, ...argv] : argv
}

/** Run a subprocess; rejects when the executable cannot be started. */
export async function runCommand(argv: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  const full = prefixArgv(options.pgPrefix, argv)
  const env = { ...process.env, ...options.env }
  return await new Promise((resolve, reject) => {
    const child = spawn(full[0], full.slice(1), { env, cwd: options.cwd })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => {
      stdout += String(c)
    })
    child.stderr.on("data", (c) => {
      stderr += String(c)
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

export function psqlArgv(db: string, extra: string[] = []): string[] {
  return ["psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-X", "-d", db, ...extra]
}

/** One psql session (repeatable-read snapshot) for manifest + dump coordination (R6, R8). */
export class PsqlSession {
  constructor(
    private readonly pgPrefix: string[] | undefined,
    private readonly env: NodeJS.ProcessEnv,
    private readonly database: string
  ) {}

  async query(sql: string): Promise<string> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f33-psql-"))
    const file = path.join(dir, "q.sql")
    writeFileSync(file, sql, "utf8")
    try {
      const r = await runCommand(psqlArgv(this.database, ["-f", file]), {
        env: this.env,
        pgPrefix: this.pgPrefix,
      })
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || `psql exited ${r.code}`)
      return r.stdout
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async queryLines(sql: string): Promise<string[]> {
    return this.query(sql)
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
  }

  async queryScalar(sql: string): Promise<string> {
    const lines = await this.queryLines(sql)
    if (!lines.length) return ""
    const last = lines[lines.length - 1]
    return last.trim()
  }

  /** BEGIN RR READ ONLY and return pg_export_snapshot() id (caller must COMMIT/ROLLBACK). */
  async beginSnapshot(): Promise<string> {
    const snap = await this.queryScalar("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();")
    const id = snap.split("\n").pop()?.trim()
    if (!id) throw new Error("pg_export_snapshot returned nothing")
    return id
  }

  async rollback(): Promise<void> {
    await this.query("ROLLBACK;")
  }

  async commit(): Promise<void> {
    await this.query("COMMIT;")
  }

  envVars(): NodeJS.ProcessEnv {
    return this.env
  }

  prefix(): string[] | undefined {
    return this.pgPrefix
  }

  db(): string {
    return this.database
  }
}
