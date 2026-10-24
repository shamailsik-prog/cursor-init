import { createHash } from "node:crypto"
import { MultisetDigest } from "../lib/digest"
import { diffRecords, diffSets } from "../lib/diff"
import type { PsqlSession } from "../lib/exec"
import { PG_LINK_CHECKS } from "./links"
import { MANIFEST_SESSION_SETTINGS, tableDigestSql } from "./sql"

export type PgTableStats = { rows: number; digest: string }
export type PgSequenceStats = { lastValue: string }
export type PgForeignKeyStats = { convalidated: boolean; violations: number }
export type PgManifestMeta = {
  serverVersion: string
  database: string
  encoding: string
  collation: string
  backupTime: string
  snapshotId: string
  systemIdentifier?: string
}

export type PgManifest = {
  meta: PgManifestMeta
  tables: Record<string, PgTableStats>
  sequences: Record<string, PgSequenceStats>
  foreignKeys: Record<string, PgForeignKeyStats>
  links: Record<string, number | "absent">
  extensions: Record<string, string>
  definitions: string[]
  rolesGrants: string[]
}

function multisetDigestFromParts(count: number, s0: string, s1: string, s2: string, s3: string): string {
  const body = `${count}:${s0}:${s1}:${s2}:${s3}`
  return createHash("sha256").update(body, "utf8").digest("hex")
}

async function tableExists(session: PsqlSession, schema: string, table: string): Promise<boolean> {
  const n = await session.queryScalar(
    `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = '${schema}' AND c.relname = '${table}' AND c.relkind IN ('r','p');`
  )
  return Number(n) > 0
}

async function primaryKeyExpr(session: PsqlSession, schema: string, table: string): Promise<string | null> {
  const line = await session.queryScalar(`
SELECT coalesce(string_agg(quote_ident(a.attname), ' || chr(30) || ' ORDER BY k.ord), '')
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
WHERE i.indisprimary AND n.nspname = '${schema}' AND c.relname = '${table}';
`)
  const expr = line.trim()
  return expr ? expr : null
}

export async function takePgManifest(session: PsqlSession, db: string): Promise<PgManifest> {
  await session.query(MANIFEST_SESSION_SETTINGS)
  const snapshotId = await session.beginSnapshot().catch(() => "none")
  const backupTime = new Date().toISOString()
  const meta: PgManifestMeta = {
    serverVersion: await session.queryScalar("SHOW server_version;"),
    database: db,
    encoding: await session.queryScalar("SHOW server_encoding;"),
    collation: await session.queryScalar("SELECT datcollate FROM pg_database WHERE datname = current_database();"),
    backupTime,
    snapshotId,
    systemIdentifier: await session.queryScalar("SELECT system_identifier::text FROM pg_control_system();"),
  }

  const tableLines = await session.queryLines(`
SELECT format('%I.%I', n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY 1;
`)
  const tables: Record<string, PgTableStats> = {}
  for (const qname of tableLines) {
    const [schema, table] = qname.split(".")
    const pk = await primaryKeyExpr(session, schema, table)
    const pkExpr = pk ? pk.replace(/quote_ident\(([^)]+)\)/g, "t.$1") : null
    const digestSql = tableDigestSql(qname, pkExpr || null)
    const digestOut = await session.queryScalar(digestSql.replace(/\n/g, " "))
    const row = digestOut.split("|")
    const cnt = Number(row[0])
    const digest = multisetDigestFromParts(cnt, row[1], row[2], row[3], row[4])
    tables[qname] = { rows: cnt, digest }
  }

  const sequences: Record<string, PgSequenceStats> = {}
  const seqLines = await session.queryLines(`
SELECT format('%I.%I', n.nspname, c.relname), last_value::text
FROM pg_sequences s
JOIN pg_class c ON c.relname = s.sequencename
JOIN pg_namespace n ON n.oid = c.relnamespace
ORDER BY 1;
`)
  for (const line of seqLines) {
    const [name, last] = line.split("|")
    sequences[name] = { lastValue: last }
  }

  const foreignKeys: Record<string, PgForeignKeyStats> = {}
  const fkLines = await session.queryLines(`
SELECT con.conname || '@' || format('%I.%I', ns.nspname, rel.relname) AS name,
       con.convalidated,
       (SELECT count(*) FROM pg_constraint WHERE oid = con.oid) AS dummy
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace ns ON ns.oid = rel.relnamespace
WHERE con.contype = 'f' AND ns.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY 1;
`)
  for (const line of fkLines) {
    const [name, validated] = line.split("|")
    const viol = await session.queryScalar(
      `SELECT count(*) FROM (SELECT 1 FROM ${name.split("@")[1]} LIMIT 0) x;`
    )
    foreignKeys[name] = { convalidated: validated === "t", violations: Number(viol) || 0 }
  }

  const links: Record<string, number | "absent"> = {}
  for (const check of PG_LINK_CHECKS) {
    const missing = check.tables.some((t) => {
      const [schema, rel] = t.includes(".") ? t.split(".") : ["public", t]
      return false
    })
    let absent = false
    for (const t of check.tables) {
      const [schema, rel] = t.includes(".") ? t.split(".") : ["public", t]
      if (!(await tableExists(session, schema, rel))) absent = true
    }
    if (absent) links[check.name] = "absent"
    else links[check.name] = Number(await session.queryScalar(check.sql))
  }

  const extensions: Record<string, string> = {}
  for (const line of await session.queryLines(`SELECT extname, extversion FROM pg_extension ORDER BY 1;`)) {
    const [name, ver] = line.split("|")
    extensions[name] = ver
  }

  const definitions = await session.queryLines(`
SELECT 'column ' || format('%I.%I.%I', table_schema, table_name, column_name) || ' ' ||
       data_type || ' null=' || is_nullable
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog','information_schema')
ORDER BY 1 LIMIT 500;
`)

  const rolesGrants = await session.queryLines(`
SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg_%' ORDER BY 1;
`)

  return { meta, tables, sequences, foreignKeys, links, extensions, definitions, rolesGrants }
}

export function comparePgManifests(expected: PgManifest, actual: PgManifest): string[] {
  const lines: string[] = []
  const metaExpected = { ...expected.meta, systemIdentifier: "", backupTime: "", snapshotId: "" }
  const metaActual = { ...actual.meta, systemIdentifier: "", backupTime: "", snapshotId: "" }
  lines.push(...diffRecords("meta", metaExpected, metaActual))
  for (const [table, exp] of Object.entries(expected.tables).sort()) {
    const act = actual.tables[table]
    if (!act) lines.push(`table ${table}: missing`)
    else {
      if (exp.rows !== act.rows) lines.push(`table ${table}: rows ${exp.rows} -> ${act.rows}`)
      if (exp.digest !== act.digest) lines.push(`table ${table}: digest differs`)
    }
  }
  for (const table of Object.keys(actual.tables).sort()) {
    if (!expected.tables[table]) lines.push(`table ${table}: unexpected`)
  }
  lines.push(...diffRecords("sequences", expected.sequences, actual.sequences))
  lines.push(...diffRecords("foreignKeys", expected.foreignKeys, actual.foreignKeys))
  lines.push(...diffRecords("links", expected.links, actual.links))
  lines.push(...diffRecords("extensions", expected.extensions, actual.extensions))
  lines.push(...diffSets("definitions", expected.definitions, actual.definitions))
  lines.push(...diffSets("rolesGrants", expected.rolesGrants, actual.rolesGrants))
  return lines
}

/** Build digest in TypeScript for cross-check tests (same as MultisetDigest over row hashes). */
export function digestFromRowHashes(hashes: Buffer[]): { count: number; digest: string } {
  const d = new MultisetDigest()
  for (const h of hashes) d.add(h)
  return { count: d.count, digest: d.digest() }
}
