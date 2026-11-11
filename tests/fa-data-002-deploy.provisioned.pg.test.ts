/**
 * FA-DATA-002-DEPLOY-001: 007 is installed by the same path that provisions a corpus database.
 *
 * Fresh volume: docker-entrypoint order 10-init.sql, 15-apply-annex-a.sh, 20-provision-roles.sh.
 * Existing volume: a database left at 001-006, then apply-annex-a.sh twice and provision-roles.sh twice.
 * Refusal: 001-006 only, 008 without 007, and a disabled corpus_embeddings_monotonic trigger.
 * Drift: GRANT EXECUTE to the runtime role and PUBLIC is revoked; a non-superuser owner is refused.
 *
 * The production embeddings job (worker-embed, scraper.tasks.embeddings) writes the ORM tables
 * case_law_master, statutes_master and record_embedding_chunks as APP_DB_USER. No application
 * statement inserts into corpus_embeddings. corpus_writer has no grant on that table. The only role
 * that can INSERT or UPDATE it is the table owner, the bootstrap superuser apply-annex-a.sh runs as.
 * This file does not grant DML to make the trigger test pass. Runtime against a deployed corpus
 * database is not what this container proves.
 */
import { spawnSync } from "node:child_process"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const REPO = process.cwd()
const IMAGE =
  "pgvector/pgvector:pg16@sha256:a97d77306ff47cc1d8add4d000cec2207da2e110746318df3137ce53c337ca30"
const APP_USER = "corpus_app"
const MIG_USER = "corpus_migrate"
const BOOT_PW = "q02b-boot-password-not-a-default"
const APP_PW = "q02b-app-password-not-a-default"
const MIG_PW = "q02b-mig-password-not-a-default"
const THROUGH_006 = [
  "001_corpus_contract.sql",
  "003_corpus_publication.sql",
  "004_authority_read_views.sql",
  "005_research_reader.sql",
  "006_research_terms.sql",
]
const REFUSAL = "re-apply 007/008 with 15-apply-annex-a.sh"
const JUDGMENT = "00000000-0000-0000-0000-0000000002b1"
const VECTOR = `(('[' || repeat('0,', 1535) || '0]')::vector)`

const container = `q02b-deploy-${process.pid}`

type Cmd = { status: number; stdout: string; stderr: string }

function docker(args: string[]): Cmd {
  const r = spawnSync("docker", args, { encoding: "utf8" })
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: `${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`,
  }
}

function psql(db: string, sql: string): Cmd {
  return docker([
    "exec", "-u", "postgres", container,
    "psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-q",
    "-U", "postgres", "-d", db, "-tAc", sql,
  ])
}

function must(db: string, sql: string): string {
  const r = psql(db, sql)
  expect(r.status, `${r.stderr}\n${r.stdout}\nSQL: ${sql}`).toBe(0)
  return r.stdout.trim()
}

/** DDL and DML success. psql -tAc prints no command tag, so the check is the exit status. */
function ok(db: string, sql: string): void {
  must(db, sql)
}

function applyFiles(db: string, files: readonly string[]): void {
  for (const file of files) {
    const r = docker([
      "exec", "-u", "postgres", container,
      "psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-q",
      "-U", "postgres", "-d", db,
      "-c", "SET client_min_messages = warning",
      "-f", `/etc/postgresql/corpus/ddl/${file}`,
    ])
    expect(r.status, `${file} on ${db}\n${r.stderr}`).toBe(0)
  }
}

function runScript(script: string, db: string): Cmd {
  return docker([
    "exec", "-u", "postgres",
    "-e", "POSTGRES_USER=postgres",
    "-e", `POSTGRES_DB=${db}`,
    "-e", `APP_DB_USER=${APP_USER}`,
    "-e", `APP_DB_PASSWORD=${APP_PW}`,
    "-e", `MIGRATE_DB_USER=${MIG_USER}`,
    "-e", `MIGRATE_DB_PASSWORD=${MIG_PW}`,
    "-e", `POSTGRES_PASSWORD=${BOOT_PW}`,
    container, script,
  ])
}

function createdb(name: string): void {
  const r = psql("postgres", `CREATE DATABASE ${name}`)
  expect(r.status, r.stderr).toBe(0)
}

function assertInstalled(db: string): void {
  expect(must(db, `SELECT t.tgenabled FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'corpus_embeddings'
       AND t.tgname = 'corpus_embeddings_monotonic' AND NOT t.tgisinternal`)).toBe("O")
  expect(must(db, "SELECT count(*) FROM public.corpus_contract_routines()")).toBe("15")
  expect(must(db, `SELECT count(*) FROM public.corpus_contract_routines() r
     WHERE r.routine::text LIKE '%enforce_embedding_classification%'`)).toBe("1")
  expect(must(db, "SELECT count(*) FROM public.corpus_contract_relations()")).toBe("37")
  expect(must(db, `SELECT has_function_privilege('public', 'public.enforce_embedding_classification()', 'EXECUTE')`)).toBe("f")
  expect(must(db, `SELECT has_function_privilege('corpus_writer', 'public.enforce_embedding_classification()', 'EXECUTE')`)).toBe("f")
  expect(must(db, `SELECT has_function_privilege('${APP_USER}', 'public.enforce_embedding_classification()', 'EXECUTE')`)).toBe("f")
}

describe("FA-DATA-002-DEPLOY-001 provisioned corpus database", () => {
  beforeAll(() => {
    const started = docker([
      "run", "-d", "--name", container,
      "-e", "POSTGRES_USER=postgres",
      "-e", `POSTGRES_PASSWORD=${BOOT_PW}`,
      "-e", "POSTGRES_DB=legal_scraper",
      "-e", `APP_DB_USER=${APP_USER}`,
      "-e", `APP_DB_PASSWORD=${APP_PW}`,
      "-e", `MIGRATE_DB_USER=${MIG_USER}`,
      "-e", `MIGRATE_DB_PASSWORD=${MIG_PW}`,
      "-v", `${path.join(REPO, "postgres/ddl")}:/etc/postgresql/corpus/ddl:ro`,
      "-v", `${path.join(REPO, "corpus_service/init.sql")}:/docker-entrypoint-initdb.d/10-init.sql:ro`,
      "-v", `${path.join(REPO, "corpus_service/docker/postgres/apply-annex-a.sh")}:/docker-entrypoint-initdb.d/15-apply-annex-a.sh:ro`,
      "-v", `${path.join(REPO, "corpus_service/docker/postgres/provision-roles.sh")}:/docker-entrypoint-initdb.d/20-provision-roles.sh:ro`,
      IMAGE,
    ])
    expect(started.status, started.stderr).toBe(0)
    const deadline = Date.now() + 120_000
    let ready = ""
    while (Date.now() < deadline) {
      const ping = docker(["exec", "-u", "postgres", container, "pg_isready", "-U", "postgres", "-d", "legal_scraper"])
      const logs = docker(["logs", container])
      ready = `${logs.stdout}\n${logs.stderr}`
      if (ping.status === 0 && ready.includes("Annex A (001, 003, 004, 005, 006, 007, 008) applied")
          && ready.includes(`roles ${MIG_USER} (schema owner) and ${APP_USER} (runtime DML) ready`)) {
        return
      }
      const state = docker(["inspect", "-f", "{{.State.Status}}", container])
      if (state.stdout.trim() === "exited") {
        throw new Error(`postgres init exited\n${ready}`)
      }
      spawnSync("sleep", ["1"])
    }
    throw new Error(`postgres init did not finish\n${ready}`)
  }, 180_000)

  afterAll(() => {
    docker(["rm", "-f", container])
  })

  it("fresh volume: init applies 007 and 008, then provision-roles, with the guard enabled", () => {
    assertInstalled("legal_scraper")
    expect(must("legal_scraper", `SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles
      WHERE rolname IN ('${APP_USER}', '${MIG_USER}')`)).toBe(`${APP_USER},${MIG_USER}`)
  })

  it("existing volume: apply-annex-a twice and provision-roles twice on a database left at 001-006", () => {
    createdb("corpus_from_006")
    applyFiles("corpus_from_006", THROUGH_006)
    expect(must("corpus_from_006", "SELECT to_regprocedure('public.enforce_embedding_classification()') IS NULL")).toBe("t")
    for (let i = 0; i < 2; i += 1) {
      const applied = runScript("/docker-entrypoint-initdb.d/15-apply-annex-a.sh", "corpus_from_006")
      expect(applied.status, applied.stderr).toBe(0)
      expect(`${applied.stdout}\n${applied.stderr}`).toContain("Annex A (001, 003, 004, 005, 006, 007, 008) applied to corpus_from_006")
      const provisioned = runScript("/docker-entrypoint-initdb.d/20-provision-roles.sh", "corpus_from_006")
      expect(provisioned.status, provisioned.stderr).toBe(0)
      expect(`${provisioned.stdout}\n${provisioned.stderr}`).toContain("ready in corpus_from_006")
    }
    assertInstalled("corpus_from_006")
  })

  it("refuses provision-roles and 008 when 007 was never applied", () => {
    createdb("corpus_refuse")
    applyFiles("corpus_refuse", THROUGH_006)
    const provisioned = runScript("/docker-entrypoint-initdb.d/20-provision-roles.sh", "corpus_refuse")
    expect(provisioned.status).not.toBe(0)
    expect(`${provisioned.stdout}\n${provisioned.stderr}`).toContain(REFUSAL)
    const alone = docker([
      "exec", "-u", "postgres", container,
      "psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-q",
      "-U", "postgres", "-d", "corpus_refuse",
      "-f", "/etc/postgresql/corpus/ddl/008_classification_inventory.sql",
    ])
    expect(alone.status).not.toBe(0)
    expect(`${alone.stdout}\n${alone.stderr}`).toMatch(/007/)
    expect(must("corpus_refuse", "SELECT count(*) FROM public.corpus_contract_routines()")).toBe("14")
  })

  it("refuses provision-roles when corpus_embeddings_monotonic is disabled", () => {
    createdb("corpus_disabled")
    const applied = runScript("/docker-entrypoint-initdb.d/15-apply-annex-a.sh", "corpus_disabled")
    expect(applied.status, applied.stderr).toBe(0)
    const first = runScript("/docker-entrypoint-initdb.d/20-provision-roles.sh", "corpus_disabled")
    expect(first.status, first.stderr).toBe(0)
    ok("corpus_disabled", "ALTER TABLE public.corpus_embeddings DISABLE TRIGGER corpus_embeddings_monotonic")
    const refused = runScript("/docker-entrypoint-initdb.d/20-provision-roles.sh", "corpus_disabled")
    expect(refused.status).not.toBe(0)
    expect(`${refused.stdout}\n${refused.stderr}`).toContain(REFUSAL)
    expect(must("corpus_disabled", `SELECT t.tgenabled FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'corpus_embeddings'
        AND t.tgname = 'corpus_embeddings_monotonic' AND NOT t.tgisinternal`)).toBe("D")
  })

  it("revokes a test GRANT EXECUTE on the guard from the runtime role and PUBLIC", () => {
    ok("legal_scraper", `GRANT EXECUTE ON FUNCTION public.enforce_embedding_classification() TO ${APP_USER}, PUBLIC`)
    expect(must("legal_scraper", `SELECT has_function_privilege('${APP_USER}', 'public.enforce_embedding_classification()', 'EXECUTE')`)).toBe("t")
    expect(must("legal_scraper", `SELECT has_function_privilege('public', 'public.enforce_embedding_classification()', 'EXECUTE')`)).toBe("t")
    const provisioned = runScript("/docker-entrypoint-initdb.d/20-provision-roles.sh", "legal_scraper")
    expect(provisioned.status, provisioned.stderr).toBe(0)
    expect(must("legal_scraper", `SELECT has_function_privilege('${APP_USER}', 'public.enforce_embedding_classification()', 'EXECUTE')`)).toBe("f")
    expect(must("legal_scraper", `SELECT has_function_privilege('public', 'public.enforce_embedding_classification()', 'EXECUTE')`)).toBe("f")
    assertInstalled("legal_scraper")
  })

  it("refuses provision-roles when enforce_embedding_classification() is owned by a non-superuser", () => {
    ok("legal_scraper", `ALTER FUNCTION public.enforce_embedding_classification() OWNER TO ${APP_USER}`)
    const refused = runScript("/docker-entrypoint-initdb.d/20-provision-roles.sh", "legal_scraper")
    expect(refused.status).not.toBe(0)
    expect(`${refused.stdout}\n${refused.stderr}`).toContain("not owned by a superuser")
    ok("legal_scraper", "ALTER FUNCTION public.enforce_embedding_classification() OWNER TO postgres")
    const restored = runScript("/docker-entrypoint-initdb.d/20-provision-roles.sh", "legal_scraper")
    expect(restored.status, restored.stderr).toBe(0)
  })

  it("fires the 007 trigger for the table owner, the only role that can write corpus_embeddings", () => {
    const who = must("legal_scraper", `SELECT current_user || '|' || pg_catalog.pg_get_userbyid(c.relowner)
      || '|' || has_table_privilege(current_user, 'public.judgment', 'SELECT')
      || '|' || has_table_privilege(current_user, 'public.classification_rank', 'SELECT')
      || '|' || has_table_privilege(current_user, 'public.corpus_embeddings', 'INSERT')
      || '|' || has_table_privilege(current_user, 'public.corpus_embeddings', 'UPDATE')
      || '|' || has_table_privilege('corpus_writer', 'public.corpus_embeddings', 'INSERT')
      || '|' || has_table_privilege('${APP_USER}', 'public.corpus_embeddings', 'INSERT')
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'corpus_embeddings'`)
    // || casts boolean to text as true/false. The owner can read the trigger's tables and write the
    // embedding table; corpus_writer and the runtime role cannot.
    expect(who).toBe("postgres|postgres|true|true|true|true|false|false")

    ok("legal_scraper", `INSERT INTO judgment (id, case_title, classification)
      VALUES ('${JUDGMENT}', 'Q02b synthetic 2099', 'privileged')`)
    const low = psql("legal_scraper", `INSERT INTO corpus_embeddings (entity_type, entity_id, model, classification_rank, embedding)
      VALUES ('judgment', '${JUDGMENT}', 'q02b-low', 0, ${VECTOR})`)
    expect(low.status).not.toBe(0)
    expect(`${low.stdout}\n${low.stderr}`).toMatch(/Classification downgrade rejected/)

    ok("legal_scraper", `INSERT INTO corpus_embeddings (entity_type, entity_id, model, classification_rank, embedding)
      VALUES ('judgment', '${JUDGMENT}', 'q02b-ok', 3, ${VECTOR})`)
    expect(must("legal_scraper", "SELECT classification_rank FROM corpus_embeddings WHERE model = 'q02b-ok'")).toBe("3")

    const lowered = psql("legal_scraper", "UPDATE corpus_embeddings SET classification_rank = 2 WHERE model = 'q02b-ok'")
    expect(lowered.status).not.toBe(0)
    expect(`${lowered.stdout}\n${lowered.stderr}`).toMatch(/Classification downgrade rejected/)
    expect(must("legal_scraper", "SELECT classification_rank FROM corpus_embeddings WHERE model = 'q02b-ok'")).toBe("3")

    ok("legal_scraper", "UPDATE corpus_embeddings SET classification_rank = 4 WHERE model = 'q02b-ok'")
    expect(must("legal_scraper", "SELECT classification_rank FROM corpus_embeddings WHERE model = 'q02b-ok'")).toBe("4")
  })
})
