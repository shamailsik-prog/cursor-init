import { readFileSync } from "node:fs"
import path from "node:path"
import type { PgCluster } from "./cluster"
import { runCommand, psqlArgv } from "../../lib/exec"

const REPO = path.resolve(__dirname, "../../../..")
const DDL = path.join(REPO, "postgres", "ddl")

export async function seedAnnexA(cluster: PgCluster, db = "legal_scraper"): Promise<void> {
  await cluster.runAs(psqlArgv("postgres", ["-c", `CREATE DATABASE ${db};`]))
  await cluster.runAs(psqlArgv(db, ["-c", "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"]))
  const files = ["001_corpus_contract.sql", "003_corpus_publication.sql", "004_authority_read_views.sql"]
  for (const f of files) {
    const file = path.join(DDL, f)
    const r = await cluster.runAs(psqlArgv(db, ["-f", file]))
    if (r.code !== 0) throw new Error(r.stderr || r.stdout)
  }
}

export async function seedRows(cluster: PgCluster, db = "legal_scraper"): Promise<void> {
  const sql = `
INSERT INTO court (full_name) VALUES ('F33 Synthetic Court') RETURNING id;
INSERT INTO judgment (case_title, full_text, classification)
  SELECT 'F33 case', 'text', 'public' FROM court LIMIT 1;
`
  const r = await cluster.runAs(psqlArgv(db, ["-c", sql]))
  if (r.code !== 0) throw new Error(r.stderr || r.stdout)
}
