/**
 * FA-D5-003 Postgres harness: one fresh database per test file on the SIKANDER_POSTGRES_URL server (a superuser URL of a
 * pgvector/pgvector:pg16 server), with the Annex A DDL applied as that superuser in its load-bearing order (001, 003, 004,
 * 005; a file that does not exist yet is skipped, so the suites also run on main for their RED run), a writer login (a
 * corpus_writer member by SET ROLE only, as provisioning grants the runtime role) and a research login (a member of
 * corpus_research_reader and nothing else, spec R2/R11; on main that role does not exist, so the login holds nothing).
 *
 * The corpus is published the way an operator publishes it: the F19 publication CLI, `python -m scraper.publication.cli
 * publish`, as the writer. States a publication cannot produce (a row a superuser wrote outside any publication, a row of a
 * publication that never finished, a judgment reclassified upward) are forced by the superuser, which the publication guard
 * exempts (F05 spec ruling 2). Every password is generated for this run and redacted from anything the harness reports.
 * Synthetic data only: the year 2099, no real judgment, statute or party.
 */
import { execFile } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import pg from "pg"

export const REPO_ROOT = path.resolve(__dirname, "..", "..")
export const DDL_DIR = path.join(REPO_ROOT, "postgres", "ddl")
export const CORPUS_FIXTURES = path.join(REPO_ROOT, "tests", "fixtures", "corpus")
export const FA_D5_003_BATCH = path.join(CORPUS_FIXTURES, "curated-batch.fa-d5-003.json")
const CORPUS_SERVICE = path.join(REPO_ROOT, "corpus_service")

/** The Annex A DDL in order: 004 re-defines 003's inventory, 005 re-defines 004's (spec R4). */
export const ANNEX_A_DDL: readonly string[] = [
  "001_corpus_contract.sql",
  "003_corpus_publication.sql",
  "004_authority_read_views.sql",
  "005_research_reader.sql",
  "006_research_terms.sql",
]

export const LIVE_MODEL = "text-embedding-3-small"
export const DIM = 1536

/** Whether the FA-D5-003 Postgres suites run: `npm run test:fa-d5-003` sets FA_D5_003_SUITE=1. */
export const FA_D5_003_SUITE = process.env.FA_D5_003_SUITE === "1"

/** SIKANDER_POSTGRES_URL, required once the suite is selected: it never passes vacuously. */
export function requirePg(): string {
  const url = (process.env.SIKANDER_POSTGRES_URL ?? "").trim()
  if (!url) {
    throw new Error(
      "the FA-D5-003 suites need SIKANDER_POSTGRES_URL (a superuser URL of a pgvector/pgvector:pg16 server); run them with `npm run test:fa-d5-003`"
    )
  }
  return url
}

export type PublishSummary = {
  publication_id: string
  items: Array<{ item_key: string; entity_type: string; entity_id: string | null; decision: string; reason: string | null }>
}

export type ResearchDb = {
  name: string
  admin: pg.Client
  /** The research login's URL (loopback plaintext, as non-production allows). */
  researchUrl: string
  /** The writer login's URL (corpus_writer member; for term refresh and publication). */
  writerUrl: string
  researchUser: string
  writerUser: string
  urlAs(user?: string, password?: string): string
  /** A fresh login on this database, created for this run (dropped with the database). */
  createLogin(prefix: string): Promise<{ user: string; password: string; url: string }>
  publish(batchPath: string): Promise<PublishSummary>
  drop(): Promise<void>
}

const secret = () => randomBytes(18).toString("hex")

export async function createResearchDb(suite: string): Promise<ResearchDb> {
  if (!/^[a-z0-9_]{1,16}$/.test(suite)) throw new Error(`createResearchDb: bad suite name ${suite}`)
  const base = new URL(requirePg())
  const hex = randomBytes(4).toString("hex")
  const name = `fad5003_${suite}_${hex}`
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
  const logins: string[] = []
  const writerUser = `fad5w_${hex}`
  const researchUser = `fad5r_${hex}`
  const writerPassword = secret()
  const researchPassword = secret()
  secrets.push(writerPassword, researchPassword)
  try {
    await admin.query("SET client_min_messages = warning")
    for (const file of ANNEX_A_DDL) {
      const p = path.join(DDL_DIR, file)
      if (fs.existsSync(p)) await admin.query(fs.readFileSync(p, "utf8"))
    }
    await admin.query(`CREATE ROLE "${writerUser}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${writerPassword}'`)
    await admin.query(`GRANT corpus_writer TO "${writerUser}" WITH INHERIT FALSE, SET TRUE`)
    await admin.query(`CREATE ROLE "${researchUser}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${researchPassword}'`)
    logins.push(writerUser, researchUser)
    const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'corpus_research_reader'")
    if (role.rowCount === 1) await admin.query(`GRANT corpus_research_reader TO "${researchUser}"`)
  } catch (e) {
    await admin.end()
    throw new Error(redact(e instanceof Error ? e.message : String(e)))
  }

  const python = process.env.SIKANDER_CORPUS_PYTHON?.trim() || "python3"
  const writerUrl = urlAs(writerUser, writerPassword)

  const publish = (batchPath: string): Promise<PublishSummary> =>
    new Promise((resolve, reject) => {
      const dsn = new URL(writerUrl)
      dsn.protocol = "postgresql+asyncpg:"
      execFile(
        python,
        ["-m", "scraper.publication.cli", "publish", "--batch", path.resolve(batchPath), "--actor", "fa-d5-003-curator-2099"],
        {
          cwd: CORPUS_SERVICE,
          env: { ...process.env, DATABASE_URL: dsn.toString(), REDIS_URL: "", ENVIRONMENT: "development", SKIP_DIR_CREATE: "1" },
          timeout: 180_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`publish ${path.basename(batchPath)} failed: ${redact(String(stderr)).slice(-2000)}`))
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

  const createLogin = async (prefix: string) => {
    if (!/^[a-z][a-z0-9_]{0,11}$/.test(prefix)) throw new Error(`createLogin: bad prefix ${prefix}`)
    const user = `${prefix}_${randomBytes(3).toString("hex")}`
    const password = secret()
    secrets.push(password)
    await admin.query(`CREATE ROLE "${user}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`)
    logins.push(user)
    return { user, password, url: urlAs(user, password) }
  }

  const drop = async (): Promise<void> => {
    await admin.end().catch(() => undefined)
    const s = new pg.Client({ connectionString: base.toString() })
    await s.connect()
    try {
      await s.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      for (const login of logins) await s.query(`DROP ROLE IF EXISTS "${login}"`)
    } finally {
      await s.end()
    }
  }

  return {
    name,
    admin,
    researchUrl: urlAs(researchUser, researchPassword),
    writerUrl,
    researchUser,
    writerUser,
    urlAs,
    createLogin,
    publish,
    drop,
  }
}

/** Judgment ids by item key from a CLI summary. */
export function judgmentIds(summary: PublishSummary): Record<string, string> {
  const out: Record<string, string> = {}
  for (const o of summary.items) if (o.entity_type === "judgment" && o.entity_id) out[o.item_key] = o.entity_id
  return out
}

/** A one-hot vector, as pgvector text. */
export function oneHot(i: number): string {
  const v = new Array<number>(DIM).fill(0)
  v[i % DIM] = 1
  return `[${v.join(",")}]`
}

/** A judgment row the superuser writes with every visible property except a finished publication (spec R3). */
export async function insertUnpublishedJudgment(
  admin: pg.Client,
  title: string,
  citation: string,
  publication: "none" | "unfinished"
): Promise<string> {
  let publicationId: string | null = null
  if (publication === "unfinished") {
    publicationId = randomUUID()
    await admin.query(
      `INSERT INTO corpus_publication (id, batch_key, input_sha256, source_kind, actor_id, publisher_session_user)
       VALUES ($1, $2, $3, 'curated', 'fa-d5-003-superuser', current_user)`,
      [publicationId, `curated/fa-d5-003-unfinished-${randomBytes(4).toString("hex")}`, "d".repeat(64)]
    )
  }
  const source = await admin.query(
    `INSERT INTO source_provenance (source_name, source_url, fetched_at, content_hash, extraction_method, extractor_version)
     VALUES ('fa-d5-003-superuser', 'https://fa-d5-003.example.invalid/superuser', '2099-03-04T05:06:07Z', $1, 'manual', 'fa-d5-003-fixture-1')
     RETURNING id`,
    ["e".repeat(64)]
  )
  const judgment = await admin.query(
    `INSERT INTO judgment (case_title, bench_type, classification, source_id, review_status, publication_id)
     VALUES ($1, 'division', 'public', $2, 'promoted', $3) RETURNING id::text AS id`,
    [title, source.rows[0].id, publicationId]
  )
  await admin.query(
    `INSERT INTO citation (judgment_id, citation_text, source_id, review_status, publication_id) VALUES ($1, $2, $3, 'promoted', $4)`,
    [judgment.rows[0].id, citation, source.rows[0].id, publicationId]
  )
  return judgment.rows[0].id as string
}

/** One vector per judgment id under `model` (the superuser stands in for the corpus side's embedding writer). */
/** Rebuild the research term index (writer session; needs 006 applied). */
export async function refreshResearchTerms(writerUrl: string): Promise<void> {
  const python = process.env.SIKANDER_CORPUS_PYTHON?.trim() || "python3"
  const dsn = new URL(writerUrl)
  dsn.protocol = "postgresql+asyncpg:"
  await new Promise<void>((resolve, reject) => {
    execFile(
      python,
      [
        "-c",
        `import asyncio
from sqlalchemy import text
from scraper.database import engine
from scraper.publication.research_terms import refresh_research_terms
async def main():
  async with engine.begin() as conn:
    await conn.execute(text("SET LOCAL ROLE corpus_writer"))
    await refresh_research_terms(conn)
asyncio.run(main())`,
      ],
      {
        cwd: CORPUS_SERVICE,
        env: { ...process.env, DATABASE_URL: dsn.toString(), REDIS_URL: "", ENVIRONMENT: "development", SKIP_DIR_CREATE: "1" },
        timeout: 600_000,
      },
      (err, _stdout, stderr) => (err ? reject(new Error(String(stderr).slice(-2000))) : resolve())
    )
  })
}

/**
 * Promoted, visible judgments for scale tests (superuser; one shared finished publication). Each title embeds
 * `marker` and a unique ordinal so keyword search can target one row among 25k+.
 */
export async function bulkInsertVisibleJudgments(admin: pg.Client, count: number, marker: string): Promise<void> {
  const promoted = count * 2
  const pub = await admin.query(
    `INSERT INTO corpus_publication (
       id, batch_key, input_sha256, source_kind, actor_id, publisher_session_user,
       finished_at, item_count, promoted_count, quarantined_count, updated_count, unchanged_count, rejected_count
     )
     VALUES ($1, $2, $3, 'curated', 'fa-d5-003-bulk', current_user, now(), $4, $4, 0, 0, 0, 0) RETURNING id`,
    [randomUUID(), `curated/fa-d5-003-bulk-${randomBytes(4).toString("hex")}`, "b".repeat(64), promoted]
  )
  const publicationId = pub.rows[0].id as string
  const source = await admin.query(
    `INSERT INTO source_provenance (source_name, source_url, fetched_at, content_hash, extraction_method, extractor_version)
     VALUES ('fa-d5-003-bulk', 'https://fa-d5-003.example.invalid/bulk', '2099-03-04T05:06:07Z', $1, 'manual', 'fa-d5-003-fixture-1')
     RETURNING id`,
    ["c".repeat(64)]
  )
  const sourceId = source.rows[0].id as string
  const chunk = 2000
  for (let start = 0; start < count; start += chunk) {
    const end = Math.min(start + chunk, count) - 1
    await admin.query(
      `WITH ins AS (
         INSERT INTO judgment (case_title, bench_type, classification, source_id, review_status, publication_id)
         SELECT 'Synthetic ' || $1 || ' judgment ordinal ' || g, 'single', 'public', $2, 'promoted', $3
           FROM generate_series($4::int, $5::int) AS g
         RETURNING id, case_title
       )
       INSERT INTO citation (judgment_id, citation_text, source_id, review_status, publication_id)
       SELECT id,
              'PLD 2099 SC ' || substring(case_title from 'ordinal ([0-9]+)$'),
              $2, 'promoted', $3
         FROM ins`,
      [marker, sourceId, publicationId, start, end]
    )
  }
}

export async function insertEmbeddings(admin: pg.Client, ids: readonly string[], model = LIVE_MODEL, rank = 0): Promise<void> {
  let i = 0
  for (const id of ids) {
    await admin.query(
      `INSERT INTO corpus_embeddings (entity_type, entity_id, model, classification_rank, embedding)
       VALUES ('judgment', $1, $2, $3, $4::vector) ON CONFLICT (entity_type, entity_id, model) DO NOTHING`,
      [id, model, rank, oneHot(i)]
    )
    i += 1
  }
}
