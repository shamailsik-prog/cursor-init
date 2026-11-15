/**
 * G-3 against a local Postgres (the CI service container or SIKANDER_POSTGRES_URL).
 * Not a staging or production proof. The unit proofs in tests/p6.g3.test.ts do not need a database.
 */
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import pg from "pg"
import { createPgMasterStore } from "@/platform/p6/masterStore"
import { applyChange, approveProposal, proposeChange, rollbackMaster } from "@/platform/p6/proposeChange"

const postgresUrl = process.env.SIKANDER_POSTGRES_URL?.trim()
if (process.env.CI && !postgresUrl) {
  throw new Error("P6 master Postgres proof requires SIKANDER_POSTGRES_URL in CI")
}

const suite = postgresUrl ? describe : describe.skip
const DDL = fs.readFileSync(path.join(process.cwd(), "postgres/ddl/009_p6_master.sql"), "utf8")

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("refusing unsafe identifier")
  return `"${name}"`
}

suite("G3 master grants on local Postgres", () => {
  const adminUrl = postgresUrl ?? ""
  const hex = randomBytes(4).toString("hex")
  const database = `p6g3_${hex}`
  const writerUser = `p6w_${hex}`
  const outsiderUser = `p6o_${hex}`
  const writerPassword = randomBytes(18).toString("hex")
  const outsiderPassword = randomBytes(18).toString("hex")
  let admin: pg.Client
  let writerPool: pg.Pool

  function urlAs(user?: string, password?: string): string {
    const url = new URL(adminUrl)
    url.pathname = `/${database}`
    if (user) {
      url.username = user
      url.password = password ?? ""
    }
    return url.toString()
  }

  afterAll(async () => {
    await writerPool?.end()
    await admin?.end()
    const server = new pg.Client({ connectionString: adminUrl })
    await server.connect()
    try {
      await server.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database],
      )
      await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      await server.query(`DROP ROLE IF EXISTS ${quoteIdent(writerUser)}`)
      await server.query(`DROP ROLE IF EXISTS ${quoteIdent(outsiderUser)}`)
    } finally {
      await server.end()
    }
  })

  it("applies twice, refuses a non-P6 writer, and commits a version only as p6_service", async () => {
    const server = new pg.Client({ connectionString: adminUrl })
    await server.connect()
    try {
      await server.query(`CREATE DATABASE ${quoteIdent(database)}`)
    } finally {
      await server.end()
    }

    admin = new pg.Client({ connectionString: urlAs() })
    await admin.connect()
    await admin.query(DDL)
    await admin.query(DDL)
    await admin.query(
      `CREATE ROLE ${quoteIdent(writerUser)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${writerPassword}'`,
    )
    await admin.query(
      `CREATE ROLE ${quoteIdent(outsiderUser)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${outsiderPassword}'`,
    )
    await admin.query(`GRANT p6_service TO ${quoteIdent(writerUser)} WITH INHERIT FALSE, SET TRUE`)

    const proposalId = randomUUID()
    const outsider = new pg.Client({ connectionString: urlAs(outsiderUser, outsiderPassword) })
    await outsider.connect()
    try {
      await expect(
        outsider.query(
          `INSERT INTO change_proposals
             (id, firm_id, source_module, classification, change_class, partition, entry_key, payload, proposed_by, status)
           VALUES ($1, 'firmA', 'learner', 'internal', 'cosmetic', 'mutable', 'clause.order', '{}', 'learner', 'pending')`,
          [proposalId],
        ),
      ).rejects.toMatchObject({ code: "42501" })
    } finally {
      await outsider.end()
    }

    await expect(
      admin.query(
        `INSERT INTO change_proposals
           (id, firm_id, source_module, classification, change_class, partition, entry_key, payload, proposed_by, status)
         VALUES ($1, 'firmA', 'learner', 'internal', 'cosmetic', 'mutable', 'clause.order', '{}', 'learner', 'pending')`,
        [proposalId],
      ),
    ).rejects.toThrow(/non-P6 writer refused/)

    const who = await admin.query<{ u: string }>("SELECT current_user AS u")
    const grants = await admin.query<{ grantee: string; privilege_type: string; table_name: string }>(
      `SELECT grantee, privilege_type, table_name
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name IN ('change_proposals', 'master_versions', 'master_knowledge')
          AND grantee <> $1`,
      [who.rows[0]?.u],
    )
    const writers = new Set(grants.rows.filter((row) => row.privilege_type !== "SELECT").map((row) => row.grantee))
    expect([...writers]).toEqual(["p6_service"])
    expect(grants.rows.some((row) => row.table_name === "master_versions" && row.privilege_type === "UPDATE")).toBe(false)
    expect(grants.rows.some((row) => row.privilege_type === "DELETE")).toBe(false)

    writerPool = new pg.Pool({ connectionString: urlAs(writerUser, writerPassword), max: 2 })
    const store = createPgMasterStore(writerPool)
    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "learner-style",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.nda.confidentiality",
        payload: { wording: "Keep it secret." },
        proposedBy: "learner-1",
      },
      store,
    )
    await approveProposal(pending.id, { actorId: "partner_a", kind: "partner", role: "partner" }, store)
    const applied = await applyChange(pending.id, store)
    expect(applied.masterWritten).toBe(true)
    const rolled = await rollbackMaster(
      { firmId: "firmA", toVersionId: applied.versionId, actor: { actorId: "partner_a", kind: "partner", role: "partner" } },
      store,
    )
    expect(rolled.masterWritten).toBe(true)

    const versions = await admin.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM master_versions WHERE firm_id = 'firmA' GROUP BY action ORDER BY action`,
    )
    expect(versions.rows).toEqual([
      { action: "apply", n: 1 },
      { action: "rollback", n: 1 },
    ])
    const head = await admin.query<{ snapshot: { entries: Record<string, { body: unknown }> } }>(
      `SELECT snapshot FROM master_knowledge WHERE firm_id = 'firmA'`,
    )
    expect(head.rows[0]?.snapshot.entries["clause.nda.confidentiality"]?.body).toEqual({ wording: "Keep it secret." })

    // p6_service has no UPDATE grant. The owner bypasses GRANT, so the append-only trigger is what refuses this.
    await expect(
      admin.query("UPDATE master_versions SET author_id = 'forged' WHERE firm_id = 'firmA'"),
    ).rejects.toThrow(/append-only/)

    const parallel = new pg.Pool({ connectionString: urlAs(writerUser, writerPassword), max: 8 })
    try {
      const raced = createPgMasterStore(parallel)
      const partner = { actorId: "partner_b", kind: "partner" as const, role: "partner" as const }
      const keys = ["clause.a", "clause.b", "clause.c", "clause.d"]
      const ids: string[] = []
      for (const key of keys) {
        const pending = await proposeChange(
          {
            firmId: "firmA",
            sourceModule: "learner-style",
            classification: "confidential",
            changeClass: "substantive",
            partition: "mutable",
            entryKey: key,
            payload: { wording: key },
            proposedBy: "learner-1",
          },
          raced,
        )
        await approveProposal(pending.id, partner, raced)
        ids.push(pending.id)
      }
      const applied = await Promise.all(ids.map((id) => applyChange(id, raced)))
      expect(applied.every((row) => row.masterWritten)).toBe(true)
      const head = await admin.query<{ snapshot: { entries: Record<string, { body: unknown }> } }>(
        `SELECT snapshot FROM master_knowledge WHERE firm_id = 'firmA'`,
      )
      for (const key of keys) expect(head.rows[0]?.snapshot.entries[key]?.body).toEqual({ wording: key })

      const same = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "learner-style",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.same",
          payload: { wording: "once" },
          proposedBy: "learner-1",
        },
        raced,
      )
      await approveProposal(same.id, partner, raced)
      const twice = await Promise.allSettled([applyChange(same.id, raced), applyChange(same.id, raced), applyChange(same.id, raced)])
      expect(twice.filter((row) => row.status === "fulfilled")).toHaveLength(1)
      const versions = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM master_versions WHERE proposal_id = $1`,
        [same.id],
      )
      expect(versions.rows[0]?.n).toBe(1)
    } finally {
      await parallel.end()
    }

    for (const table of ["change_proposals", "master_versions", "master_knowledge"]) {
      await expect(admin.query(`DELETE FROM ${table}`)).rejects.toThrow(/delete or truncate refused|append-only/)
    }
    // A lone TRUNCATE of a referenced table fails the foreign-key check before any trigger.
    // Listing the referencing tables lets the statement trigger refuse the command.
    await expect(admin.query("TRUNCATE master_knowledge")).rejects.toThrow(/delete or truncate refused/)
    await expect(admin.query("TRUNCATE master_versions, master_knowledge")).rejects.toThrow(/delete or truncate refused/)
    await expect(
      admin.query("TRUNCATE change_proposals, master_versions, master_knowledge"),
    ).rejects.toThrow(/delete or truncate refused/)
    const asP6 = new pg.Client({ connectionString: urlAs(writerUser, writerPassword) })
    await asP6.connect()
    try {
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(`UPDATE change_proposals SET payload = '{"wording":"mutated"}'::jsonb WHERE status = 'applied'`),
      ).rejects.toThrow(/frozen/)
      await asP6.query("ROLLBACK")
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(`UPDATE master_knowledge SET classification = 'public' WHERE firm_id = 'firmA'`),
      ).rejects.toThrow(/declassify/)
      await asP6.query("ROLLBACK")
    } finally {
      await asP6.end()
    }
  }, 60_000)
})
