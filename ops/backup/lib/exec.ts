import { randomBytes } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { withManifestPsqlEnv } from "../postgres/psqlEnv"

export type CommandResult = { code: number; stdout: string; stderr: string; stdoutBytes?: Buffer }

export type RunCommandOptions = {
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** R19: argv prefix before client programs (e.g. docker compose exec … gosu postgres). */
  pgPrefix?: string[]
  /** When set, stdout is captured as a Buffer (required for pg_dump custom format). */
  binaryStdout?: boolean
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
    const chunks: Buffer[] = []
    child.stdout.on("data", (c: Buffer | string) => {
      if (options.binaryStdout) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      else stdout += String(c)
    })
    child.stderr.on("data", (c) => {
      stderr += String(c)
    })
    child.on("error", reject)
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        stdoutBytes: options.binaryStdout ? Buffer.concat(chunks) : undefined,
      })
    )
  })
}

export function psqlArgv(db: string, extra: string[] = []): string[] {
  return ["psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-X", "-d", db, ...extra]
}

export type PsqlQueryable = {
  query(sql: string): Promise<string>
  queryLines(sql: string): Promise<string[]>
  queryScalar(sql: string): Promise<string>
}

type SyncWaiter = {
  marker: string
  start: number
  resolve: (text: string) => void
  reject: (err: Error) => void
}

/**
 * Holds one libpq session open so a REPEATABLE READ snapshot stays valid while pg_dump runs (R6).
 */
export class PersistentPsqlSession implements PsqlQueryable {
  private readonly proc: ChildProcessWithoutNullStreams
  private buffer = ""
  private stderr = ""
  private waiters: SyncWaiter[] = []
  private closed = false

  private constructor(
    private readonly pgPrefix: string[] | undefined,
    readonly env: NodeJS.ProcessEnv,
    readonly database: string
  ) {
    const argv = prefixArgv(pgPrefix, psqlArgv(database, ["-t", "-A"]))
    this.proc = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += String(chunk)
      this.drain()
    })
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += String(chunk)
    })
    this.proc.on("error", (err) => this.failAll(err))
    this.proc.on("close", (code) => {
      if (!this.closed && code !== 0) {
        this.failAll(new Error(this.stderr || `psql exited ${code ?? 1}`))
      }
    })
  }

  static async open(
    pgPrefix: string[] | undefined,
    env: NodeJS.ProcessEnv,
    database: string
  ): Promise<PersistentPsqlSession> {
    return new PersistentPsqlSession(pgPrefix, env, database)
  }

  private failAll(err: Error): void {
    for (const w of this.waiters.splice(0)) w.reject(err)
  }

  private drain(): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]
      const idx = this.buffer.indexOf(w.marker, w.start)
      if (idx >= 0) {
        const text = this.buffer.slice(w.start, idx).trim()
        this.waiters.splice(i, 1)
        w.resolve(text)
      }
    }
  }

  private sync(sql: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error("psql session closed"))
    const marker = `__F33_SYNC_${randomBytes(8).toString("hex")}__`
    const start = this.buffer.length
    return new Promise((resolve, reject) => {
      this.waiters.push({ marker, start, resolve, reject })
      const stmt = sql.trimEnd().endsWith(";") ? sql : `${sql};`
      this.proc.stdin.write(`${stmt}\n\\echo ${marker}\n`)
    })
  }

  async query(sql: string): Promise<string> {
    return await this.sync(sql)
  }

  async queryLines(sql: string): Promise<string[]> {
    const out = await this.sync(sql)
    return out
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
  }

  async queryScalar(sql: string): Promise<string> {
    const out = await this.sync(sql)
    const line = out.split("\n").map((l) => l.trim()).filter(Boolean).pop()
    if (!line) throw new Error(`empty scalar result for: ${sql}`)
    return line
  }

  prefix(): string[] | undefined {
    return this.pgPrefix
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.proc.stdin.end()
    } catch {
      // already closed
    }
    this.proc.kill("SIGTERM")
  }
}

/** One-shot psql invocations (restore manifest, guards). */
export class PsqlSession implements PsqlQueryable {
  private readonly env: NodeJS.ProcessEnv

  constructor(
    private readonly pgPrefix: string[] | undefined,
    env: NodeJS.ProcessEnv,
    private readonly database: string
  ) {
    this.env = withManifestPsqlEnv(env)
  }

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
    const r = await runCommand(psqlArgv(this.database, ["-t", "-A", "-c", sql]), {
      env: this.env,
      pgPrefix: this.pgPrefix,
    })
    if (r.code !== 0) throw new Error(r.stderr || r.stdout || `psql exited ${r.code}`)
    return r.stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
  }

  async queryScalar(sql: string): Promise<string> {
    const r = await runCommand(psqlArgv(this.database, ["-t", "-A", "-c", sql]), {
      env: this.env,
      pgPrefix: this.pgPrefix,
    })
    if (r.code !== 0) throw new Error(r.stderr || r.stdout || `psql exited ${r.code}`)
    return r.stdout.trim()
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
