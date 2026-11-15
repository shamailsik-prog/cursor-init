/**
 * G-3 against a local Postgres (the CI service container or SIKANDER_POSTGRES_URL).
 * Not a staging or production proof. The unit proofs in tests/p6.g3.test.ts do not need a database.
 */
import { execFileSync } from "node:child_process"
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
const MAIN_DDL = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/p6/009_p6_master_main.sql"), "utf8")

function applyPsqlFile(connectionString: string, sql: string): { status: number; stderr: string } {
  const file = path.join("/tmp", `p6mig-${randomBytes(4).toString("hex")}.sql`)
  fs.writeFileSync(file, sql)
  const url = new URL(connectionString)
  try {
    execFileSync(
      "psql",
      [
        "-v",
        "ON_ERROR_STOP=1",
        "--no-psqlrc",
        "-q",
        "-h",
        url.hostname,
        "-p",
        url.port || "5432",
        "-U",
        decodeURIComponent(url.username),
        "-d",
        url.pathname.replace(/^\//, ""),
        "-f",
        file,
      ],
      {
        env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    return { status: 0, stderr: "" }
  } catch (error) {
    const failed = error as { status?: number; stderr?: string }
    return { status: failed.status ?? 1, stderr: failed.stderr ?? String(error) }
  } finally {
    fs.rmSync(file, { force: true })
  }
}

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

    const writerTriggers = await admin.query<{ table_name: string; tgname: string }>(
      `SELECT c.relname AS table_name, t.tgname
         FROM pg_catalog.pg_trigger t
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND t.tgenabled = 'O'
          AND t.tgname IN (
            'change_proposals_p6_writer',
            'change_proposals_status_transition',
            'master_versions_p6_writer',
            'master_knowledge_p6_writer'
          )
        ORDER BY t.tgname`,
    )
    expect(writerTriggers.rows).toEqual([
      { table_name: "change_proposals", tgname: "change_proposals_p6_writer" },
      { table_name: "change_proposals", tgname: "change_proposals_status_transition" },
      { table_name: "master_knowledge", tgname: "master_knowledge_p6_writer" },
      { table_name: "master_versions", tgname: "master_versions_p6_writer" },
    ])
    await expect(
      admin.query(
        `INSERT INTO master_versions
           (id, firm_id, version_no, action, diff, snapshot, author_id, author_kind)
         VALUES (gen_random_uuid(), 'firmZ', 1, 'apply', '{}', '{}', 'owner', 'system')`,
      ),
    ).rejects.toThrow(/non-P6 writer refused/)
    await expect(
      admin.query(
        `INSERT INTO master_knowledge (firm_id, snapshot, classification, version_id)
         VALUES ('firmZ', '{}', 'internal', gen_random_uuid())`,
      ),
    ).rejects.toThrow(/non-P6 writer refused/)
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

    const cosmetic = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "learner-style",
        classification: "confidential",
        changeClass: "cosmetic",
        partition: "mutable",
        entryKey: "clause.nda.confidentiality",
        payload: { wording: "Keep  it secret." },
        proposedBy: "learner-1",
      },
      store,
    )
    expect(cosmetic.changeClass).toBe("cosmetic")
    const cosmeticApplied = await applyChange(cosmetic.id, store)
    expect(cosmeticApplied.masterWritten).toBe(true)
    expect((await store.getProposal(cosmetic.id))?.status).toBe("applied")
    expect((await store.getProposal(cosmetic.id))?.decidedKind).toBe("system")

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
    const pendingEdit = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "learner-style",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.pending",
        payload: { wording: "original request" },
        proposedBy: "learner-1",
      },
      store,
    )
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
        asP6.query(`UPDATE change_proposals SET payload = '{"wording":"swapped"}'::jsonb WHERE id = $1 AND status = 'pending'`, [
          pendingEdit.id,
        ]),
      ).rejects.toThrow(/frozen/)
      await asP6.query("ROLLBACK")
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(`UPDATE master_knowledge SET classification = 'public' WHERE firm_id = 'firmA'`),
      ).rejects.toThrow(/declassify/)
      await asP6.query("ROLLBACK")

      // FA-Q07-R2-006. A direct insert or update cannot mint an approved row. The approval
      // update is allowed only from pending, with a partner attestation and a different actor.
      const forgedId = randomUUID()
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(
          `INSERT INTO change_proposals
             (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
              proposed_by, status, decided_by, decided_kind, decided_role, payload_hash)
           VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', 'clause.forged',
                   '{"wording":"forged"}'::jsonb, 'learner-1', 'approved', 'partner_b', 'partner', 'partner', 'abc')`,
          [forgedId],
        ),
      ).rejects.toThrow(/new proposals are pending/)
      await asP6.query("ROLLBACK")
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(
          `INSERT INTO change_proposals
             (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
              proposed_by, status, payload_hash)
           VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', 'clause.forged',
                   '{"wording":"forged"}'::jsonb, 'learner-1', 'approved', 'abc')`,
          [forgedId],
        ),
      ).rejects.toThrow(/new proposals are pending/)
      await asP6.query("ROLLBACK")

      const self = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "learner-style",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.self",
          payload: { wording: "self" },
          proposedBy: "partner_a",
        },
        store,
      )
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(
          `UPDATE change_proposals
              SET status = 'approved', decided_by = $2, decided_kind = 'partner', decided_role = 'partner'
            WHERE id = $1`,
          [self.id, "partner_a\u200D"],
        ),
      ).rejects.toThrow(/differ from proposer/)
      await asP6.query("ROLLBACK")
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(
          `UPDATE change_proposals
              SET status = 'approved', decided_by = NULL, decided_kind = NULL, decided_role = NULL
            WHERE id = $1`,
          [self.id],
        ),
      ).rejects.toThrow(/approval is not a direct status change|proposal status transition is refused/)
      await asP6.query("ROLLBACK")
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await asP6.query(
        `UPDATE change_proposals
            SET status = 'approved', decided_by = 'partner_b', decided_kind = 'partner', decided_role = 'partner'
          WHERE id = $1 AND status = 'pending'`,
        [self.id],
      )
      await asP6.query("COMMIT")
      const stamped = await admin.query<{ status: string; decided_by: string }>(
        `SELECT status, decided_by FROM change_proposals WHERE id = $1`,
        [self.id],
      )
      expect(stamped.rows[0]).toEqual({ status: "approved", decided_by: "partner_b" })
      await expect(approveProposal(self.id, { actorId: "partner_c", kind: "partner", role: "partner" }, store)).rejects.toThrow(
        /not pending/,
      )
      const keys = await admin.query<{ plain: string; zwj: string; wide: string; folded: string; upper: string }>(
        `SELECT public.p6_actor_key($1) AS plain, public.p6_actor_key($2) AS zwj,
                public.p6_actor_key($3) AS wide, public.p6_actor_key($4) AS folded,
                public.p6_actor_key($5) AS upper`,
        ["partner_a", "partner_a\u200D", "\uFF50\uFF41\uFF52\uFF54\uFF4E\uFF45\uFF52\uFF3F\uFF41", "straße", "STRASSE"],
      )
      expect(keys.rows[0]?.plain).toBe("partner_a")
      expect(keys.rows[0]?.zwj).toBe("partner_a")
      expect(keys.rows[0]?.wide).toBe("partner_a")
      expect(keys.rows[0]?.folded).toBe("strasse")
      expect(keys.rows[0]?.upper).toBe("strasse")

      // D6. The CHECK still rejects a null approver when the transition trigger is off.
      await admin.query("ALTER TABLE change_proposals DISABLE TRIGGER change_proposals_status_transition")
      try {
        await asP6.query("BEGIN")
        await asP6.query("SET LOCAL ROLE p6_service")
        await expect(
          asP6.query(
            `UPDATE change_proposals
                SET status = 'approved', decided_by = NULL, decided_kind = 'partner', decided_role = 'partner'
              WHERE id = $1`,
            [pendingEdit.id],
          ),
        ).rejects.toThrow(/substantive_partner_approval/)
        await asP6.query("ROLLBACK")
      } finally {
        await admin.query("ALTER TABLE change_proposals ENABLE TRIGGER change_proposals_status_transition")
      }

      // D11. A substantive pending row cannot be applied as a system decision.
      const substantiveApply = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "learner-style",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.d11",
          payload: { wording: "substantive apply" },
          proposedBy: "learner-1",
        },
        store,
      )
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(
          `UPDATE change_proposals
              SET status = 'applied', decided_by = 'p6', decided_kind = 'system', decided_role = 'system'
            WHERE id = $1 AND status = 'pending'`,
          [substantiveApply.id],
        ),
      ).rejects.toThrow(/proposal status transition is refused/)
      await asP6.query("ROLLBACK")

      // D14. approved -> applied cannot rewrite the partner who decided.
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(
          `UPDATE change_proposals
              SET status = 'applied', decided_by = 'partner_c'
            WHERE id = $1 AND status = 'approved'`,
          [self.id],
        ),
      ).rejects.toThrow(/proposal status transition is refused/)
      await asP6.query("ROLLBACK")

      const spaced = await admin.query<{ newline: string; tab: string; nbsp: string; line: string }>(
        `SELECT public.p6_actor_key($1) AS newline, public.p6_actor_key($2) AS tab,
                public.p6_actor_key($3) AS nbsp, public.p6_actor_key($4) AS line`,
        ["partner_a\n", "\tpartner_a", "partner_a\u00A0", "partner_a\u2028"],
      )
      expect(spaced.rows[0]).toEqual({ newline: "partner_a", tab: "partner_a", nbsp: "partner_a", line: "partner_a" })
      const newlineSelf = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "learner-style",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.newline",
          payload: { wording: "newline" },
          proposedBy: "partner_a",
        },
        store,
      )
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(
          `UPDATE change_proposals
              SET status = 'approved', decided_by = E'partner_a\\n', decided_kind = 'partner', decided_role = 'partner'
            WHERE id = $1 AND status = 'pending'`,
          [newlineSelf.id],
        ),
      ).rejects.toThrow(/differ from proposer/)
      await asP6.query("ROLLBACK")

      const proposerRow = await store.getProposal(pendingEdit.id)
      await expect(store.saveProposal({ ...proposerRow!, proposedBy: "other-actor" })).rejects.toThrow(/proposedBy is immutable/)
      const proposerStill = await admin.query<{ proposed_by: string }>(
        `SELECT proposed_by FROM change_proposals WHERE id = $1`,
        [pendingEdit.id],
      )
      expect(proposerStill.rows[0]?.proposed_by).toBe("learner-1")
    } finally {
      await asP6.end()
    }
  }, 60_000)

  it("MIG-252-001: a legacy null approver does not leave the approval check half-replaced", async () => {
    const migHex = randomBytes(4).toString("hex")
    const migDb = `p6mig_${migHex}`
    const server = new pg.Client({ connectionString: adminUrl })
    await server.connect()
    try {
      await server.query(`CREATE DATABASE ${quoteIdent(migDb)}`)
    } finally {
      await server.end()
    }
    const migUrl = new URL(adminUrl)
    migUrl.pathname = `/${migDb}`
    const connection = migUrl.toString()
    const legacy = applyPsqlFile(connection, MAIN_DDL)
    expect(legacy.status, legacy.stderr).toBe(0)
    const client = new pg.Client({ connectionString: connection })
    await client.connect()
    const badId = randomUUID()
    try {
      await client.query("SET ROLE p6_service")
      await client.query(
        `INSERT INTO change_proposals
           (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
            proposed_by, status, decided_by, decided_kind, decided_role, payload_hash)
         VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', 'clause.legacy',
                 '{"wording":"legacy"}'::jsonb, 'partner_a', 'approved', NULL, 'partner', 'partner', 'abc')`,
        [badId],
      )
      await client.query("RESET ROLE")
      const upgraded = applyPsqlFile(connection, DDL)
      const constraint = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_catalog.pg_constraint
          WHERE conname = 'substantive_partner_approval'
            AND conrelid = 'public.change_proposals'::regclass`,
      )
      const triggers = await client.query<{ tgname: string }>(
        `SELECT t.tgname
           FROM pg_catalog.pg_trigger t
           JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = 'change_proposals' AND NOT t.tgisinternal AND t.tgenabled = 'O'`,
      )
      const names = triggers.rows.map((row) => row.tgname)
      const kept = await client.query<{ status: string; decided_by: string | null }>(
        `SELECT status, decided_by FROM change_proposals WHERE id = $1`,
        [badId],
      )
      if (upgraded.status === 0) {
        expect(constraint.rows[0]?.def ?? "").toMatch(/p6_actor_key|decided_by IS NOT NULL/)
        expect(names).toContain("change_proposals_status_transition")
        expect(names).toContain("change_proposals_p6_writer")
      } else {
        expect(upgraded.stderr).toMatch(/refusing to replace substantive_partner_approval/)
        expect(constraint.rows).toHaveLength(1)
        expect(constraint.rows[0]?.def ?? "").not.toMatch(/decided_by IS NOT NULL/)
        expect(names).toContain("change_proposals_p6_writer")
        expect(names).not.toContain("change_proposals_status_transition")
        expect(kept.rows[0]).toEqual({ status: "approved", decided_by: null })
      }

      const okDb = `p6ok_${migHex}`
      const creator = new pg.Client({ connectionString: adminUrl })
      await creator.connect()
      try {
        await creator.query(`CREATE DATABASE ${quoteIdent(okDb)}`)
      } finally {
        await creator.end()
      }
      const okUrl = new URL(adminUrl)
      okUrl.pathname = `/${okDb}`
      const okConnection = okUrl.toString()
      expect(applyPsqlFile(okConnection, MAIN_DDL).status).toBe(0)
      const ok = new pg.Client({ connectionString: okConnection })
      await ok.connect()
      const goodId = randomUUID()
      try {
        await ok.query("SET ROLE p6_service")
        await ok.query(
          `INSERT INTO change_proposals
             (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
              proposed_by, status, payload_hash)
           VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', 'clause.kept',
                   '{"wording":"kept"}'::jsonb, 'partner_a', 'pending', 'abc')`,
          [goodId],
        )
        await ok.query(
          `UPDATE change_proposals
              SET status = 'approved', decided_by = 'partner_b', decided_kind = 'partner', decided_role = 'partner'
            WHERE id = $1`,
          [goodId],
        )
        await ok.query("RESET ROLE")
        const okUpgrade = applyPsqlFile(okConnection, DDL)
        expect(okUpgrade.status, okUpgrade.stderr).toBe(0)
        const okConstraint = await ok.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def
             FROM pg_catalog.pg_constraint
            WHERE conname = 'substantive_partner_approval'
              AND conrelid = 'public.change_proposals'::regclass`,
        )
        const okTriggers = await ok.query<{ tgname: string }>(
          `SELECT t.tgname
             FROM pg_catalog.pg_trigger t
             JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
            WHERE c.relname = 'change_proposals' AND NOT t.tgisinternal AND t.tgenabled = 'O'`,
        )
        expect(okConstraint.rows[0]?.def ?? "").toMatch(/p6_actor_key/)
        expect(okTriggers.rows.map((row) => row.tgname)).toContain("change_proposals_status_transition")
        const good = await ok.query<{ status: string; decided_by: string }>(
          `SELECT status, decided_by FROM change_proposals WHERE id = $1`,
          [goodId],
        )
        expect(good.rows[0]).toEqual({ status: "approved", decided_by: "partner_b" })
      } finally {
        await ok.end()
        const dropOk = new pg.Client({ connectionString: adminUrl })
        await dropOk.connect()
        try {
          await dropOk.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [okDb],
          )
          await dropOk.query(`DROP DATABASE IF EXISTS ${quoteIdent(okDb)}`)
        } finally {
          await dropOk.end()
        }
      }
    } finally {
      await client.end()
      const drop = new pg.Client({ connectionString: adminUrl })
      await drop.connect()
      try {
        await drop.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [migDb],
        )
        await drop.query(`DROP DATABASE IF EXISTS ${quoteIdent(migDb)}`)
      } finally {
        await drop.end()
      }
    }
  }, 60_000)
})
