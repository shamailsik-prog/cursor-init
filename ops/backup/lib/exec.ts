import { randomBytes } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { drillScratchDir } from "../drill/target"
import { runEmergencyCleanup } from "./emergency"
import { withManifestPsqlEnv } from "../postgres/psqlEnv"

/** Docker client environment. PATH is fixed so a caller PATH cannot select the binary. DOCKER_* is never copied. */
export const DOCKER_CLIENT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
const DOCKER_ENV_KEYS = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM"] as const

let psqlQueryTimeoutMs = 120_000
let dockerPathOverride: string | null = null
let stdoutFault: ((chunk: Buffer | string) => void) | null = null

/** Tests shrink this so a hung statement fails without waiting for the drill timeout. */
export function setPsqlQueryTimeoutForTests(ms: number): void {
  psqlQueryTimeoutMs = ms
}

/** Backup and whole-script restore use a long limit. The returned function restores the previous one. */
export function pushPsqlQueryTimeout(ms: number): () => void {
  const previous = psqlQueryTimeoutMs
  psqlQueryTimeoutMs = ms
  return () => {
    psqlQueryTimeoutMs = previous
  }
}

/** Tests point `docker` at a wrapper directory. Production keeps the fixed system PATH. */
export function setDockerClientPathForTests(dir: string | null): void {
  dockerPathOverride = dir
}

/** Tests throw from a stdout data handler. The handler must catch it and clean up. */
export function setStdoutFaultForTests(fn: ((chunk: Buffer | string) => void) | null): void {
  stdoutFault = fn
}

function emptyDockerConfigDir(): string {
  const dir = "/tmp/sikander-backup-drill/empty-docker-config"
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const cfg = path.join(dir, "config.json")
  if (existsSync(cfg)) rmSync(cfg)
  return dir
}

export function commandChildEnv(argv0: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (argv0 !== "docker" && argv0 !== "docker-compose") return env
  const next: NodeJS.ProcessEnv = {
    PATH: DOCKER_CLIENT_PATH,
    NODE_ENV: env.NODE_ENV ?? "production",
    DOCKER_CONFIG: emptyDockerConfigDir(),
  }
  if (dockerPathOverride) next.PATH = dockerPathOverride
  for (const key of DOCKER_ENV_KEYS) {
    if (key === "HOME") continue
    if (env[key]) next[key] = env[key]
  }
  return next
}

function handlerFault(chunk: Buffer | string, child: { kill: (signal?: NodeJS.Signals) => boolean }, reject: (err: Error) => void): boolean {
  try {
    stdoutFault?.(chunk)
    return false
  } catch (err) {
    try {
      child.kill("SIGKILL")
    } catch {
      // the child has already exited
    }
    runEmergencyCleanup()
    reject(err as Error)
    return true
  }
}

class Utf8Capture {
  private readonly decoder = new StringDecoder("utf8")
  private text = ""

  push(chunk: Buffer | string): void {
    this.text += typeof chunk === "string" ? chunk : this.decoder.write(chunk)
  }

  peek(): string {
    return this.text
  }

  end(): string {
    this.text += this.decoder.end()
    return this.text
  }
}

export type CommandResult = { code: number; stdout: string; stderr: string; stdoutBytes?: Buffer }

export type RunCommandOptions = {
  env?: NodeJS.ProcessEnv
  /**
   * Use `env` as the complete child environment. The default merge keeps process.env keys the caller deleted,
   * which reintroduces PGHOSTADDR and the other libpq redirects.
   */
  exactEnv?: boolean
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
  const merged: NodeJS.ProcessEnv = options.exactEnv
    ? ({ ...options.env } as NodeJS.ProcessEnv)
    : { ...process.env, ...options.env }
  const env = commandChildEnv(full[0], merged)
  return await new Promise((resolve, reject) => {
    const child = spawn(full[0], full.slice(1), { env, cwd: options.cwd })
    const stdoutText = new Utf8Capture()
    const stderrText = new Utf8Capture()
    const chunks: Buffer[] = []
    child.stdout.on("data", (c: Buffer | string) => {
      try {
        if (handlerFault(c, child, reject)) return
        if (options.binaryStdout) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        else stdoutText.push(c)
      } catch (err) {
        try { child.kill("SIGKILL") } catch { /* already gone */ }
        runEmergencyCleanup()
        reject(err as Error)
      }
    })
    child.stderr.on("data", (c: Buffer | string) => {
      try {
        if (handlerFault(c, child, reject)) return
      stderrText.push(c)
      } catch (err) {
        try { child.kill("SIGKILL") } catch { /* already gone */ }
        runEmergencyCleanup()
        reject(err as Error)
      }
    })
    child.on("error", reject)
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: stdoutText.end(),
        stderr: stderrText.end(),
        stdoutBytes: options.binaryStdout ? Buffer.concat(chunks) : undefined,
      })
    )
  })
}

/** Stream stdout as text. The full stdout is not retained. A handler throw kills the child and runs emergency cleanup. */
export async function pipeCommandStdout(
  argv: string[],
  options: RunCommandOptions,
  onText: (text: string) => Promise<void>
): Promise<{ code: number; stderr: string }> {
  const full = prefixArgv(options.pgPrefix, argv)
  const merged: NodeJS.ProcessEnv = options.exactEnv
    ? ({ ...options.env } as NodeJS.ProcessEnv)
    : { ...process.env, ...options.env }
  const env = commandChildEnv(full[0], merged)
  const decoder = new StringDecoder("utf8")
  const stderrText = new Utf8Capture()
  return await new Promise((resolve, reject) => {
    const child = spawn(full[0], full.slice(1), { env, cwd: options.cwd })
    let failed = false
    let chain = Promise.resolve()
    const fail = (err: Error) => {
      if (failed) return
      failed = true
      try { child.kill("SIGKILL") } catch { /* already gone */ }
      reject(err)
    }
    child.stdout.on("data", (c: Buffer | string) => {
      chain = chain.then(async () => {
        if (failed) return
        if (handlerFault(c, child, fail)) return
        const text = typeof c === "string" ? c : decoder.write(c)
        if (text) await onText(text)
      }).catch(fail)
    })
    child.stderr.on("data", (c: Buffer | string) => {
      try {
        const errChunk = c
        stderrText.push(errChunk)
      } catch (err) {
        fail(err as Error)
      }
    })
    child.on("error", fail)
    child.on("close", (code) => {
      void chain.then(async () => {
        if (failed) return
        const tail = decoder.end()
        if (tail) await onText(tail)
        resolve({ code: code ?? 1, stderr: stderrText.end() })
      }).catch(fail)
    })
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
  private stdinBroken = false
  private queryTimer: ReturnType<typeof setTimeout> | undefined
  private activeRearm: (() => void) | null = null
  private resolveExit: ((err: Error) => void) | null = null
  private readonly stdoutText = new Utf8Capture()
  private readonly stderrText = new Utf8Capture()

  private constructor(
    private readonly pgPrefix: string[] | undefined,
    readonly env: NodeJS.ProcessEnv,
    readonly database: string,
    conninfo: string | undefined,
    exactEnv: boolean
  ) {
    const argv = prefixArgv(pgPrefix, psqlArgv(conninfo ?? database, ["-t", "-A"]))
    const merged: NodeJS.ProcessEnv = exactEnv ? { ...env } : { ...process.env, ...env }
    this.proc = spawn(argv[0], argv.slice(1), {
      env: commandChildEnv(argv[0], merged),
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.proc.stdout.on("data", (chunk: Buffer | string) => {
      try {
        if (handlerFault(chunk, this.proc, (err) => this.markClosed(err))) return
      this.stdoutText.push(chunk)
        this.buffer = this.stdoutText.peek()
        this.drain()
        this.activeRearm?.()
      } catch (err) {
        try { this.proc.kill("SIGKILL") } catch { /* already gone */ }
        runEmergencyCleanup()
        this.markClosed(err as Error)
      }
    })
    this.proc.stderr.on("data", (chunk: Buffer | string) => {
      try {
        this.stderrText.push(chunk)
        this.stderr = this.stderrText.peek()
        this.activeRearm?.()
      } catch (err) {
        try { this.proc.kill("SIGKILL") } catch { /* already gone */ }
        runEmergencyCleanup()
        this.markClosed(err as Error)
      }
    })
    this.proc.stdin.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EPIPE") {
        this.stdinBroken = true
        return
      }
      this.markClosed(err)
    })
    this.proc.on("error", (err) => this.markClosed(err))
    this.proc.on("close", (code) => {
      this.buffer = this.stdoutText.end()
      this.stderr = this.stderrText.end()
      this.drain()
      this.closed = true
      const message = this.stderr.trim()
      const err = new Error(message || (code !== 0 ? `psql exited ${code ?? 1}` : "psql session closed"))
      this.resolveExit?.(err)
      if (code !== 0) this.failAll(err)
      else if (this.waiters.length) this.failAll(new Error("psql session closed"))
    })
  }

  static async open(
    pgPrefix: string[] | undefined,
    env: NodeJS.ProcessEnv,
    database: string,
    opts?: { conninfo?: string; exactEnv?: boolean }
  ): Promise<PersistentPsqlSession> {
    return new PersistentPsqlSession(pgPrefix, env, database, opts?.conninfo, opts?.exactEnv === true)
  }

  private markClosed(err: Error): void {
    if (this.closed) return
    this.closed = true
    this.failAll(err)
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

  private armQueryTimer(waiter: SyncWaiter, reject: (err: Error) => void): void {
    if (this.queryTimer) clearTimeout(this.queryTimer)
    this.queryTimer = setTimeout(() => {
      const still = this.waiters.indexOf(waiter)
      if (still >= 0) this.waiters.splice(still, 1)
      this.killSession(new Error("psql query timed out"))
      reject(new Error("psql query timed out"))
    }, psqlQueryTimeoutMs)
    this.queryTimer.unref?.()
  }

  private killSession(err: Error): void {
    if (this.queryTimer) clearTimeout(this.queryTimer)
    this.activeRearm = null
    if (!this.closed) {
      this.closed = true
      try {
        this.proc.kill("SIGKILL")
      } catch {
        // already exited
      }
    }
    this.failAll(err)
  }

  private async writeRaw(payload: string): Promise<void> {
    if (this.closed) throw new Error("psql session closed")
    if (this.stdinBroken) throw await this.psqlExitError()
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (err?: Error | null) => {
        if (settled) return
        settled = true
        if (err && (err as NodeJS.ErrnoException).code === "EPIPE") {
          this.stdinBroken = true
          void this.psqlExitError().then(reject, reject)
          return
        }
        if (err) {
          this.markClosed(err)
          reject(err)
          return
        }
        resolve()
      }
      try {
        const ok = this.proc.stdin.write(payload, (err) => done(err))
        if (ok) done()
        else this.proc.stdin.once("drain", () => done())
      } catch (err) {
        done(err as Error)
      }
    })
  }

  private psqlExitError(): Promise<Error> {
    if (this.closed) return Promise.resolve(new Error(this.stderr.trim() || "psql session closed"))
    return new Promise((resolve) => {
      this.resolveExit = resolve
    })
  }

  private sync(sql: string, wholeScript = false): Promise<string> {
    if (this.closed) return Promise.reject(new Error("psql session closed"))
    const marker = `__F33_SYNC_${randomBytes(8).toString("hex")}__`
    const start = this.buffer.length
    return new Promise((resolve, reject) => {
      this.waiters.push({ marker, start, resolve, reject })
      const stmt = wholeScript || sql.trimEnd().endsWith(";") ? sql : `${sql};`
      const body = stmt.endsWith("\n") ? stmt : `${stmt}\n`
      const payload = `${body}\\echo ${marker}\n`
      const waiter = this.waiters[this.waiters.length - 1]
      this.armQueryTimer(waiter, reject)
      this.activeRearm = () => this.armQueryTimer(waiter, reject)
      const finish = waiter.resolve
      const fail = waiter.reject
      waiter.resolve = (text) => {
        if (this.queryTimer) clearTimeout(this.queryTimer)
        this.activeRearm = null
        finish(text)
      }
      waiter.reject = (err) => {
        if (this.queryTimer) clearTimeout(this.queryTimer)
        this.activeRearm = null
        fail(err)
      }
      void this.writeRaw(payload).catch((err) => {
        if (!this.closed) this.markClosed(err as Error)
        else waiter.reject(err as Error)
      })
    })
  }

  /** Stream a script into the open session, then wait until psql finishes it. */
  async runStreamed(produce: (write: (chunk: string) => Promise<void>) => Promise<void>): Promise<string> {
    if (this.closed) return Promise.reject(new Error("psql session closed"))
    const marker = `__F33_SYNC_${randomBytes(8).toString("hex")}__`
    const start = this.buffer.length
    return await new Promise((resolve, reject) => {
      this.waiters.push({ marker, start, resolve, reject })
      const waiter = this.waiters[this.waiters.length - 1]
      this.armQueryTimer(waiter, reject)
      this.activeRearm = () => this.armQueryTimer(waiter, reject)
      const finish = waiter.resolve
      const fail = waiter.reject
      waiter.resolve = (text) => {
        if (this.queryTimer) clearTimeout(this.queryTimer)
        this.activeRearm = null
        finish(text)
      }
      waiter.reject = (err) => {
        if (this.queryTimer) clearTimeout(this.queryTimer)
        this.activeRearm = null
        fail(err)
      }
      void produce((chunk) => this.writeRaw(chunk))
        .then(() => this.writeRaw(`\\echo ${marker}\n`))
        .catch((err) => {
          try { this.proc.kill("SIGKILL") } catch { /* already gone */ }
          this.markClosed(err as Error)
        })
    })
  }

  /** Send a psql script unchanged, including \\connect, and wait until it finishes. */
  async runScript(sql: string): Promise<string> {
    return await this.sync(sql, true)
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
    private readonly database: string,
    private readonly conninfo?: string,
    private readonly exactEnv = false
  ) {
    this.env = withManifestPsqlEnv(env)
  }

  private connectionArg(): string {
    return this.conninfo ?? this.database
  }

  async query(sql: string): Promise<string> {
    const dir = drillScratchDir("f33-psql-")
    const file = path.join(dir, "q.sql")
    writeFileSync(file, sql, "utf8")
    try {
      const r = await runCommand(psqlArgv(this.connectionArg(), ["-f", file]), {
        env: this.env,
        exactEnv: this.exactEnv,
        pgPrefix: this.pgPrefix,
      })
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || `psql exited ${r.code}`)
      return r.stdout
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async queryLines(sql: string): Promise<string[]> {
    const r = await runCommand(psqlArgv(this.connectionArg(), ["-t", "-A", "-c", sql]), {
      env: this.env,
      exactEnv: this.exactEnv,
      pgPrefix: this.pgPrefix,
    })
    if (r.code !== 0) throw new Error(r.stderr || r.stdout || `psql exited ${r.code}`)
    return r.stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
  }

  async queryScalar(sql: string): Promise<string> {
    const r = await runCommand(psqlArgv(this.connectionArg(), ["-t", "-A", "-c", sql]), {
      env: this.env,
      exactEnv: this.exactEnv,
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
