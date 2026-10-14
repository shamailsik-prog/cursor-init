/**
 * The F05 Postgres harness (plan D14, D15): one fresh database per test file on the SIKANDER_POSTGRES_URL server
 * (a superuser URL of a pgvector/pgvector:pg16 server), with the Annex A DDL applied as that superuser, a writer
 * login (a corpus_writer member by SET ROLE only, as PR 2b provisions the runtime role) and a reader login (a
 * corpus_reader member). The corpus is seeded the way an operator seeds it: through PR 2's publication CLI,
 * `python -m scraper.publication.cli publish`, as the writer.
 *
 * The suites that use it run only with F05_AUTHORITY_SUITE=1 (functions/vitest.config.ts excludes them otherwise),
 * and then a missing SIKANDER_POSTGRES_URL fails the run instead of skipping it: the job must not pass vacuously.
 * Every password is generated here, for this run, and redacted from anything the harness reports.
 */
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import pg from "pg"

/** The Annex A DDL in its load-bearing order (plan D13): 004 re-defines the inventory 003 created. */
export const ANNEX_A_DDL: readonly string[] = ["001_corpus_contract.sql", "003_corpus_publication.sql", "004_authority_read_views.sql"]

export const REPO_ROOT = path.resolve(__dirname, "..", "..")
const DDL_DIR = path.join(REPO_ROOT, "postgres", "ddl")
const CORPUS_SERVICE = path.join(REPO_ROOT, "corpus_service")
export const CORPUS_FIXTURES = path.join(REPO_ROOT, "tests", "fixtures", "corpus")

/** The publication CLI's stdout (scraper/publication/cli.py `_summary`). */
export type PublishSummary = {
  publication_id: string
  batch_key: string
  already: boolean
  seq: number
  counts: Record<string, number>
  items: Array<{ item_key: string; entity_type: string; entity_id: string | null; decision: string; reason: string | null; review_status: string | null }>
}

export type CorpusDb = {
  name: string
  /** A superuser session on this database (ruling 2: its writes bypass the publication guard). */
  admin: pg.Client
  readerUrl: string
  writerUrl: string
  writerUser: string
  writerPassword: string
  readerUser: string
  readerPassword: string
  /** A URL for `user` on this database (the superuser's when no user is given). */
  urlAs(user?: string, password?: string): string
  publish(batchPath: string, actor?: string): Promise<PublishSummary>
  drop(): Promise<void>
}

/** SIKANDER_POSTGRES_URL, required: a Pg suite never skips (D14). */
export function requirePgSuite(): string {
  const url = (process.env.SIKANDER_POSTGRES_URL ?? "").trim()
  if (!url) {
    throw new Error(
      "the F05 Postgres suites need SIKANDER_POSTGRES_URL (a superuser URL of a pgvector/pgvector:pg16 server); " +
        "run them with `npm run test:f05-authority`"
    )
  }
  return url
}

const secret = () => randomBytes(18).toString("hex")

export async function createCorpusDb(suite: string): Promise<CorpusDb> {
  if (!/^[a-z0-9_]{1,20}$/.test(suite)) throw new Error(`createCorpusDb: bad suite name ${suite}`)
  const base = new URL(requirePgSuite())
  const hex = randomBytes(4).toString("hex")
  const name = `f05_${suite}_${hex}`
  const urlAs = (user?: string, password?: string): string => {
    const u = new URL(base.toString())
    u.pathname = `/${name}`
    if (user) {
      u.username = user
      u.password = password ?? ""
    }
    return u.toString()
  }
  const secrets = [base.password, decodeURIComponent(base.password)].filter(Boolean)
  const redact = (text: string): string => secrets.reduce((t, s) => (s ? t.split(s).join("<redacted>") : t), text)

  const server = new pg.Client({ connectionString: base.toString() })
  await server.connect()
  try {
    await server.query(`CREATE DATABASE "${name}"`)
  } finally {
    await server.end()
  }

  const admin = new pg.Client({ connectionString: urlAs() })
  await admin.connect()
  const writerUser = `f05w_${hex}`
  const readerUser = `f05r_${hex}`
  const writerPassword = secret()
  const readerPassword = secret()
  secrets.push(writerPassword, readerPassword)
  try {
    for (const file of ANNEX_A_DDL) {
      const p = path.join(DDL_DIR, file)
      // A file that does not exist yet is skipped, so the suite also runs on the base (001 + 003) for its RED run.
      if (fs.existsSync(p)) await admin.query(fs.readFileSync(p, "utf8"))
    }
    await admin.query(`CREATE ROLE "${writerUser}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${writerPassword}'`)
    await admin.query(`GRANT corpus_writer TO "${writerUser}" WITH INHERIT FALSE, SET TRUE`)
    await admin.query(`CREATE ROLE "${readerUser}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${readerPassword}'`)
    await admin.query(`GRANT corpus_reader TO "${readerUser}"`)
  } catch (e) {
    await admin.end()
    throw new Error(redact(e instanceof Error ? e.message : String(e)))
  }

  const python = process.env.SIKANDER_CORPUS_PYTHON?.trim() || "python3"
  const writerUrl = urlAs(writerUser, writerPassword)

  const publish = (batchPath: string, actor = "f05-curator-2099"): Promise<PublishSummary> =>
    new Promise((resolve, reject) => {
      const dsn = new URL(writerUrl)
      dsn.protocol = "postgresql+asyncpg:"
      execFile(
        python,
        ["-m", "scraper.publication.cli", "publish", "--batch", path.resolve(batchPath), "--actor", actor],
        {
          cwd: CORPUS_SERVICE,
          env: { ...process.env, DATABASE_URL: dsn.toString(), REDIS_URL: "", ENVIRONMENT: "development", SKIP_DIR_CREATE: "1" },
          timeout: 180_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`publish ${path.basename(batchPath)} failed (exit ${String((err as { code?: unknown }).code)}): ${redact(String(stderr)).slice(-2000)}`))
            return
          }
          try {
            resolve(JSON.parse(String(stdout)) as PublishSummary)
          } catch {
            reject(new Error(`publish ${path.basename(batchPath)}: stdout is not the summary JSON`))
          }
        }
      )
    })

  const drop = async (): Promise<void> => {
    await admin.end().catch(() => undefined)
    const s = new pg.Client({ connectionString: base.toString() })
    await s.connect()
    try {
      await s.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      await s.query(`DROP ROLE IF EXISTS "${writerUser}"`)
      await s.query(`DROP ROLE IF EXISTS "${readerUser}"`)
    } finally {
      await s.end()
    }
  }

  return {
    name,
    admin,
    readerUrl: urlAs(readerUser, readerPassword),
    writerUrl,
    writerUser,
    writerPassword,
    readerUser,
    readerPassword,
    urlAs,
    publish,
    drop,
  }
}

const READER_ENV = ["SIKANDER_CORPUS_READER_URL", "SIKANDER_CORPUS_MAX_STALENESS_HOURS", "SIKANDER_CORPUS_READER_CA"] as const

/** Point the corpus reader configuration at `db` (loopback, plaintext, as non-production allows); returns a restore. */
export function withCorpusReaderEnv(db: Pick<CorpusDb, "readerUrl">, hours = 24): () => void {
  const saved = Object.fromEntries(READER_ENV.map((k) => [k, process.env[k]]))
  process.env.SIKANDER_CORPUS_READER_URL = db.readerUrl
  process.env.SIKANDER_CORPUS_MAX_STALENESS_HOURS = String(hours)
  delete process.env.SIKANDER_CORPUS_READER_CA
  return () => {
    for (const k of READER_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

/**
 * Forget the selected corpus store and its cached state (`resetCorpusAuthorityStoreForTests`, plan Task 8). Until that
 * seam exists this does nothing, so the e2e also loads and runs on the base for its RED run.
 */
export async function resetAuthorityStore(): Promise<void> {
  const mod = (await import("../src/d4/authority")) as unknown as Record<string, unknown>
  const reset = mod.resetCorpusAuthorityStoreForTests
  if (typeof reset === "function") await (reset as () => Promise<void>)()
}
