/**
 * G-3 against a local Postgres (the CI service container or SIKANDER_POSTGRES_URL).
 * Not a staging or production proof. The unit proofs in tests/p6.g3.test.ts do not need a database.
 */
import { execFileSync, spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import pg from "pg"
import { createPgMasterStore, InMemoryMasterStore, type CommitVersionInput } from "@/platform/p6/masterStore"
import * as storeModule from "@/platform/p6/masterStore"
import { applyChange, approveProposal, proposeChange, rollbackMaster } from "@/platform/p6/proposeChange"
import { masterWriteAuditLog, nextSnapshot } from "@/platform/p6/masterWrite"

const postgresUrl = process.env.SIKANDER_POSTGRES_URL?.trim()
if (process.env.CI && !postgresUrl) {
  throw new Error("P6 master Postgres proof requires SIKANDER_POSTGRES_URL in CI")
}

const suite = postgresUrl ? describe : describe.skip
const DDL = fs.readFileSync(path.join(process.cwd(), "postgres/ddl/009_p6_master.sql"), "utf8")
const ACTOR_KEY_DDL = fs.readFileSync(path.join(process.cwd(), "postgres/ddl/011_p6_actor_key.sql"), "utf8")
const MAIN_DDL = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/p6/009_p6_master_main.sql"), "utf8")
const D8125172_DDL = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/p6/009_p6_master_d8125172.sql"), "utf8")

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

      // CHECK-only. With the status trigger off, the check still rejects a blank or self approver.
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
        await asP6.query("BEGIN")
        await asP6.query("SET LOCAL ROLE p6_service")
        await expect(
          asP6.query(
            `UPDATE change_proposals
                SET status = 'approved', decided_by = E'\\n', decided_kind = 'partner', decided_role = 'partner'
              WHERE id = $1`,
            [pendingEdit.id],
          ),
        ).rejects.toThrow(/substantive_partner_approval/)
        await asP6.query("ROLLBACK")
        await asP6.query("BEGIN")
        await asP6.query("SET LOCAL ROLE p6_service")
        await expect(
          asP6.query(
            `UPDATE change_proposals
                SET status = 'approved', decided_by = 'learner-1', decided_kind = 'partner', decided_role = 'partner'
              WHERE id = $1`,
            [pendingEdit.id],
          ),
        ).rejects.toThrow(/substantive_partner_approval/)
        await asP6.query("ROLLBACK")
      } finally {
        await admin.query("ALTER TABLE change_proposals ENABLE TRIGGER change_proposals_status_transition")
      }

      // A substantive pending row cannot take the cosmetic apply edge. This is not R1 D11.
      const substantiveApply = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "learner-style",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.apply-edge",
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

      // R1 D6. approved -> applied cannot rewrite the partner who decided.
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

      // R1 D11. The catch-all refuses pending -> rejected and approved -> pending.
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(
          `UPDATE change_proposals SET status = 'rejected' WHERE id = $1 AND status = 'pending'`,
          [pendingEdit.id],
        ),
      ).rejects.toThrow(/proposal status transition is refused/)
      await asP6.query("ROLLBACK")
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(
          `UPDATE change_proposals SET status = 'pending' WHERE id = $1 AND status = 'approved'`,
          [self.id],
        ),
      ).rejects.toThrow(/proposal status transition is refused/)
      await asP6.query("ROLLBACK")
      const afterD11 = await admin.query<{ id: string; status: string }>(
        `SELECT id, status FROM change_proposals WHERE id = ANY($1::uuid[])`,
        [[pendingEdit.id, self.id]],
      )
      expect(afterD11.rows).toEqual(
        expect.arrayContaining([
          { id: pendingEdit.id, status: "pending" },
          { id: self.id, status: "approved" },
        ]),
      )

      // R1 D14. Dropping the cosmetic guard would let this partner approval land.
      const cosmeticId = randomUUID()
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await asP6.query(
        `INSERT INTO change_proposals
           (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
            proposed_by, status, payload_hash)
         VALUES ($1, 'firmA', 'learner', 'confidential', 'cosmetic', 'mutable', 'clause.d14',
                 '{"wording":"cosmetic"}'::jsonb, 'partner_a', 'pending', 'abc')`,
        [cosmeticId],
      )
      await expect(
        asP6.query(
          `UPDATE change_proposals
              SET status = 'approved', decided_by = 'partner_b', decided_kind = 'partner', decided_role = 'partner'
            WHERE id = $1 AND status = 'pending'`,
          [cosmeticId],
        ),
      ).rejects.toThrow(/approval is not a direct status change/)
      await asP6.query("ROLLBACK")
      const cosmeticKept = await admin.query<{ status: string }>(
        `SELECT status FROM change_proposals WHERE id = $1`,
        [cosmeticId],
      )
      expect(cosmeticKept.rows).toEqual([])

      // MEM-252-005 mirror. approved -> applied cannot rewrite proposed_by.
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(
          `UPDATE change_proposals SET status = 'applied', proposed_by = 'other-actor' WHERE id = $1 AND status = 'approved'`,
          [self.id],
        ),
      ).rejects.toThrow(/approved proposal payload is frozen|proposedBy is immutable/)
      await asP6.query("ROLLBACK")
      const proposerKept = await admin.query<{ proposed_by: string; status: string }>(
        `SELECT proposed_by, status FROM change_proposals WHERE id = $1`,
        [self.id],
      )
      expect(proposerKept.rows[0]).toEqual({ proposed_by: "partner_a", status: "approved" })

      const spaced = await admin.query<{
        newline: string
        tab: string
        nbsp: string
        line: string
        vt: string
        ff: string
        cr: string
        ogham: string
        para: string
        next: string
      }>(
        `SELECT public.p6_actor_key($1) AS newline, public.p6_actor_key($2) AS tab,
                public.p6_actor_key($3) AS nbsp, public.p6_actor_key($4) AS line,
                public.p6_actor_key($5) AS vt, public.p6_actor_key($6) AS ff,
                public.p6_actor_key($7) AS cr, public.p6_actor_key($8) AS ogham,
                public.p6_actor_key($9) AS para, public.p6_actor_key($10) AS next`,
        [
          "partner_a\n",
          "\tpartner_a",
          "partner_a\u00A0",
          "partner_a\u2028",
          "\vpartner_a",
          "\fpartner_a",
          "\rpartner_a",
          "\u1680partner_a",
          "partner_a\u2029",
          "partner_a\u0085",
        ],
      )
      expect(spaced.rows[0]).toEqual({
        newline: "partner_a",
        tab: "partner_a",
        nbsp: "partner_a",
        line: "partner_a",
        vt: "partner_a",
        ff: "partner_a",
        cr: "partner_a",
        ogham: "partner_a",
        para: "partner_a",
        // U+0085 survives trim, then the actor-id charset rejects the key.
        next: "",
      })
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

      // PARITY-R2-003. JS NFKC folds U+A7F1 to S; the same raw-SQL self-approval must be refused.
      const swash = "\u{A7F1}"
      const swashKey = await admin.query<{ key: string }>(`SELECT public.p6_actor_key($1) AS key`, [swash])
      expect(swashKey.rows[0]?.key).toBe("s")
      const swashRow = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "learner-style",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.swash",
          payload: { wording: "swash" },
          proposedBy: "s",
        },
        store,
      )
      await asP6.query("BEGIN")
      await asP6.query("SET LOCAL ROLE p6_service")
      await expect(
        asP6.query(
          `UPDATE change_proposals
              SET status = 'approved', decided_by = $2, decided_kind = 'partner', decided_role = 'partner'
            WHERE id = $1 AND status = 'pending'`,
          [swashRow.id, swash],
        ),
      ).rejects.toThrow(/differ from proposer/)
      await asP6.query("ROLLBACK")

      const duplicate = await store.getProposal(pendingEdit.id)
      await expect(store.insertProposal({ ...duplicate!, proposedBy: "other-actor" })).rejects.toThrow(
        new RegExp(`proposal id already exists: ${pendingEdit.id}`),
      )
      const duplicateStill = await admin.query<{ proposed_by: string }>(
        `SELECT proposed_by FROM change_proposals WHERE id = $1`,
        [pendingEdit.id],
      )
      expect(duplicateStill.rows[0]?.proposed_by).toBe("learner-1")
      const head = await admin.query<{ version_id: string | null }>(
        `SELECT version_id FROM master_knowledge WHERE firm_id = 'firmA'`,
      )
      await expect(
        store.commitVersion({
          firmId: "firmA",
          proposalId: pendingEdit.id,
          action: "apply",
          diff: { key: pendingEdit.entryKey, partition: "mutable", before: { entries: {} }, after: { entries: {} } },
          snapshot: { entries: {} },
          authorId: "partner_b",
          authorKind: "partner",
          restoredFromVersionId: null,
          classification: "confidential",
          proposal: { ...duplicate!, proposedBy: "other-actor" },
          expectedBaseVersionId: head.rows[0]?.version_id ?? null,
        }),
      ).rejects.toThrow(/proposedBy is immutable/)
      await expect(
        store.commitVersion({
          firmId: "firmA",
          proposalId: pendingEdit.id,
          action: "apply",
          diff: { key: pendingEdit.entryKey, partition: "mutable", before: { entries: {} }, after: { entries: {} } },
          snapshot: { entries: {} },
          authorId: "partner_b",
          authorKind: "partner",
          restoredFromVersionId: null,
          classification: "confidential",
          proposal: { ...duplicate!, payload: { wording: "swapped" } },
          expectedBaseVersionId: head.rows[0]?.version_id ?? null,
        }),
      ).rejects.toThrow(/approved proposal payload is frozen/)
      const approvedForCas = await store.getProposal(self.id)
      await store.runExclusive(async (tx) => {
        await expect(
          tx.casProposal({ ...approvedForCas!, status: "applied", proposedBy: "other-actor" }, "approved"),
        ).rejects.toThrow(/proposedBy is immutable/)
      })
      const casKept = await admin.query<{ proposed_by: string; status: string }>(
        `SELECT proposed_by, status FROM change_proposals WHERE id = $1`,
        [self.id],
      )
      expect(casKept.rows[0]).toEqual({ proposed_by: "partner_a", status: "approved" })

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
    const selfId = randomUUID()
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
      await client.query(
        `INSERT INTO change_proposals
           (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
            proposed_by, status, decided_by, decided_kind, decided_role, payload_hash)
         VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', 'clause.legacy-self',
                 '{"wording":"self"}'::jsonb, 'partner_a', 'approved', 'partner_a', 'partner', 'partner', 'abc')`,
        [selfId],
      )
      await client.query("RESET ROLE")
      const before = await client.query<{
        id: string
        proposed_by: string
        status: string
        decided_by: string | null
        decided_kind: string
        decided_role: string
      }>(
        `SELECT id, proposed_by, status, decided_by, decided_kind, decided_role
           FROM change_proposals WHERE id = ANY($1::uuid[]) ORDER BY entry_key`,
        [[badId, selfId]],
      )
      const upgraded = applyPsqlFile(connection, DDL)
      const constraint = await client.query<{ def: string; convalidated: boolean }>(
        `SELECT pg_get_constraintdef(oid) AS def, convalidated
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
      const kept = await client.query<{
        id: string
        proposed_by: string
        status: string
        decided_by: string | null
        decided_kind: string
        decided_role: string
      }>(
        `SELECT id, proposed_by, status, decided_by, decided_kind, decided_role
           FROM change_proposals WHERE id = ANY($1::uuid[]) ORDER BY entry_key`,
        [[badId, selfId]],
      )
      if (upgraded.status === 0) {
        expect(constraint.rows[0]?.def ?? "").toMatch(/p6_actor_key|decided_by IS NOT NULL/)
        expect(constraint.rows[0]?.convalidated).toBe(true)
        expect(names).toContain("change_proposals_status_transition")
        expect(names).toContain("change_proposals_p6_writer")
      } else {
        expect(upgraded.stderr).toMatch(/refusing to replace substantive_partner_approval/)
        expect(upgraded.stderr).toContain(badId)
        expect(upgraded.stderr).toContain(selfId)
        expect(constraint.rows).toHaveLength(1)
        expect(constraint.rows[0]?.convalidated).toBe(true)
        expect(constraint.rows[0]?.def ?? "").not.toMatch(/decided_by IS NOT NULL/)
        expect(names).toContain("change_proposals_p6_writer")
        expect(names).not.toContain("change_proposals_status_transition")
        expect(kept.rows).toEqual(before.rows)
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
        const okConstraint = await ok.query<{ def: string; convalidated: boolean }>(
          `SELECT pg_get_constraintdef(oid) AS def, convalidated
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
        expect(okConstraint.rows[0]?.convalidated).toBe(true)
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

  async function freshDb(prefix: string): Promise<{ name: string; url: string; client: pg.Client }> {
    const name = `${prefix}_${randomBytes(4).toString("hex")}`
    const server = new pg.Client({ connectionString: adminUrl })
    await server.connect()
    try {
      await server.query(`CREATE DATABASE ${quoteIdent(name)}`)
    } finally {
      await server.end()
    }
    const url = new URL(adminUrl)
    url.pathname = `/${name}`
    const client = new pg.Client({ connectionString: url.toString() })
    await client.connect()
    return { name, url: url.toString(), client }
  }

  async function dropDb(name: string, client?: pg.Client): Promise<void> {
    await client?.end()
    const drop = new pg.Client({ connectionString: adminUrl })
    await drop.connect()
    try {
      await drop.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      )
      await drop.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`)
    } finally {
      await drop.end()
    }
  }

  async function expectRefused(
    client: pg.Client,
    sql: string,
    params: unknown[],
    message: RegExp,
  ): Promise<void> {
    await client.query("BEGIN")
    await client.query("SET LOCAL ROLE p6_service")
    try {
      await expect(client.query(sql, params)).rejects.toThrow(message)
    } finally {
      await client.query("ROLLBACK")
    }
  }

  it("TEST-252-R3-001: raw SQL refuses pending rewrites and the catch-all transitions", async () => {
    const db = await freshDb("p6r3")
    try {
      await db.client.query(DDL)
      await db.client.query("SET ROLE p6_service")
      const substantiveId = randomUUID()
      const firmId = randomUUID()
      const requestedId = randomUUID()
      const relabelId = randomUUID()
      const stampId = randomUUID()
      const approvedId = randomUUID()
      const cosmeticId = randomUUID()
      const rejectedId = randomUUID()
      async function insertPending(id: string, entryKey: string, changeClass: "cosmetic" | "substantive", proposedBy: string) {
        await db.client.query(
          `INSERT INTO change_proposals
             (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
              proposed_by, status, requested_class, payload_hash)
           VALUES ($1, 'firmA', 'learner', 'confidential', $2, 'mutable', $3,
                   '{"wording":"substantive body"}'::jsonb, $4, 'pending', $2, 'abc')`,
          [id, changeClass, entryKey, proposedBy],
        )
      }
      await insertPending(substantiveId, "clause.d15", "substantive", "partner_a")
      await insertPending(firmId, "clause.d16", "substantive", "partner_a")
      await insertPending(requestedId, "clause.d17", "substantive", "partner_a")
      await insertPending(relabelId, "clause.d18", "substantive", "partner_a")
      await insertPending(stampId, "clause.d9", "substantive", "partner_a")
      await insertPending(approvedId, "clause.catch-approved", "substantive", "partner_a")
      await insertPending(cosmeticId, "clause.catch-applied", "cosmetic", "learner-1")
      await insertPending(rejectedId, "clause.catch-rejected", "substantive", "partner_a")
      await db.client.query("RESET ROLE")

      // D15T. A proposed_by rewrite, then self-approval by the original proposer.
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET proposed_by = 'partner_b' WHERE id = $1 AND status = 'pending'`,
        [substantiveId],
        /approved proposal payload is frozen/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals
            SET status = 'approved', decided_by = 'partner_a', decided_kind = 'partner', decided_role = 'partner'
          WHERE id = $1 AND status = 'pending'`,
        [substantiveId],
        /differ from proposer/,
      )
      // D16T / D17. firm_id and requested_class stay frozen on a pending row.
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET firm_id = 'firmB' WHERE id = $1 AND status = 'pending'`,
        [firmId],
        /approved proposal payload is frozen/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET requested_class = 'cosmetic' WHERE id = $1 AND status = 'pending'`,
        [requestedId],
        /approved proposal payload is frozen/,
      )
      // D18. Relabel substantive to cosmetic, then the cosmetic auto-apply.
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET change_class = 'cosmetic' WHERE id = $1 AND status = 'pending'`,
        [relabelId],
        /approval is not a direct status change/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals
            SET status = 'applied', decided_by = 'p6', decided_kind = 'system', decided_role = 'system'
          WHERE id = $1 AND status = 'pending'`,
        [relabelId],
        /proposal status transition is refused/,
      )
      // D9full. A decided_by stamp while the row stays pending.
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET decided_by = 'partner_b' WHERE id = $1 AND status = 'pending'`,
        [stampId],
        /approval is not a direct status change/,
      )

      await db.client.query("BEGIN")
      await db.client.query("SET LOCAL ROLE p6_service")
      await db.client.query(
        `UPDATE change_proposals
            SET status = 'approved', decided_by = 'partner_b', decided_kind = 'partner', decided_role = 'partner'
          WHERE id = $1 AND status = 'pending'`,
        [approvedId],
      )
      await db.client.query(
        `UPDATE change_proposals
            SET status = 'applied', decided_by = 'p6', decided_kind = 'system', decided_role = 'system'
          WHERE id = $1 AND status = 'pending'`,
        [cosmeticId],
      )
      await db.client.query("COMMIT")
      await db.client.query("ALTER TABLE change_proposals DISABLE TRIGGER change_proposals_status_transition")
      await db.client.query("BEGIN")
      await db.client.query("SET LOCAL ROLE p6_service")
      await db.client.query(`UPDATE change_proposals SET status = 'rejected' WHERE id = $1`, [rejectedId])
      await db.client.query("COMMIT")
      await db.client.query("ALTER TABLE change_proposals ENABLE TRIGGER change_proposals_status_transition")

      await expectRefused(
        db.client,
        `UPDATE change_proposals
            SET status = 'pending', decided_by = NULL, decided_kind = NULL, decided_role = NULL
          WHERE id = $1 AND status = 'applied'`,
        [cosmeticId],
        /proposal status transition is refused/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET status = 'rejected' WHERE id = $1 AND status = 'approved'`,
        [approvedId],
        /proposal status transition is refused/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals
            SET status = 'rejected', decided_by = NULL, decided_kind = NULL, decided_role = NULL
          WHERE id = $1 AND status = 'applied'`,
        [cosmeticId],
        /proposal status transition is refused/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET status = 'pending' WHERE id = $1 AND status = 'rejected'`,
        [rejectedId],
        /proposal status transition is refused/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET decided_by = 'partner_c' WHERE id = $1 AND status = 'applied'`,
        [cosmeticId],
        /proposal status transition is refused/,
      )

      const kept = await db.client.query<{
        id: string
        proposed_by: string
        firm_id: string
        requested_class: string
        change_class: string
        status: string
        decided_by: string | null
      }>(
        `SELECT id, proposed_by, firm_id, requested_class, change_class, status, decided_by
           FROM change_proposals WHERE id = ANY($1::uuid[])`,
        [[substantiveId, firmId, requestedId, relabelId, stampId, cosmeticId]],
      )
      const byId = new Map(kept.rows.map((row) => [row.id, row]))
      expect(byId.get(substantiveId)).toMatchObject({ proposed_by: "partner_a", status: "pending", decided_by: null })
      expect(byId.get(firmId)).toMatchObject({ firm_id: "firmA", status: "pending" })
      expect(byId.get(requestedId)).toMatchObject({ requested_class: "substantive", status: "pending" })
      expect(byId.get(relabelId)).toMatchObject({ change_class: "substantive", status: "pending", decided_by: null })
      expect(byId.get(stampId)).toMatchObject({ status: "pending", decided_by: null })
      expect(byId.get(cosmeticId)).toMatchObject({ status: "applied", decided_by: "p6", change_class: "cosmetic" })
    } finally {
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("PARITY-252-R3-002: Postgres refuses Unicode 16 case-pair self-approval", async () => {
    const db = await freshDb("p6key")
    try {
      await db.client.query(DDL)
      await db.client.query(ACTOR_KEY_DDL)
      await db.client.query(ACTOR_KEY_DDL)
      const pairs: Array<[string, string]> = [
        ["\u{16EA0}", "\u{16EBB}"],
        ["\u{A7CE}", "\u{A7CF}"],
        ["\u{A7D2}", "\u{A7D3}"],
      ]
      for (const [upper, lower] of pairs) {
        const folded = await db.client.query<{ upper: string; lower: string }>(
          `SELECT public.p6_actor_key($1) AS upper, public.p6_actor_key($2) AS lower`,
          [upper, lower],
        )
        expect(folded.rows[0]).toEqual({ upper: "", lower: "" })
      }
      const ascii = await db.client.query<{ key: string }>(`SELECT public.p6_actor_key($1) AS key`, ["Partner_A"])
      expect(ascii.rows[0]?.key).toBe("partner_a")
      await db.client.query("SET ROLE p6_service")
      for (const [upper, lower] of pairs) {
        const id = randomUUID()
        await db.client.query(
          `INSERT INTO change_proposals
             (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
              proposed_by, status, payload_hash)
           VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', $2,
                   '{"wording":"unicode"}'::jsonb, $3, 'pending', 'abc')`,
          [id, `clause.${id.slice(0, 8)}`, upper],
        )
        await expect(
          db.client.query(
            `UPDATE change_proposals
                SET status = 'approved', decided_by = $2, decided_kind = 'partner', decided_role = 'partner'
              WHERE id = $1 AND status = 'pending'`,
            [id, lower],
          ),
        ).rejects.toThrow(/differ from proposer|partner approval|approval is not a direct status change|proposer key missing/)
        await expect(
          db.client.query(
            `UPDATE change_proposals
                SET status = 'approved', decided_by = 'partner_b', decided_kind = 'partner', decided_role = 'partner'
              WHERE id = $1 AND status = 'pending'`,
            [id],
          ),
        ).rejects.toThrow(/proposer key missing/)
        const kept = await db.client.query<{ status: string }>(`SELECT status FROM change_proposals WHERE id = $1`, [id])
        expect(kept.rows[0]?.status).toBe("pending")
      }
      await db.client.query("RESET ROLE")
    } finally {
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("DOC-252-R3-003: tx.commitVersion runs the proposal guards", async () => {
    const db = await freshDb("p6doc")
    const pool = new pg.Pool({ connectionString: db.url, max: 1 })
    try {
      await db.client.query(DDL)
      await db.client.query(ACTOR_KEY_DDL)
      await db.client.query(`GRANT p6_service TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`)
      const store = createPgMasterStore(pool)
      const pending = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "learner-style",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.doc",
          payload: { wording: "original" },
          proposedBy: "partner_a",
        },
        store,
      )
      const input = {
        firmId: "firmA",
        proposalId: pending.id,
        action: "apply" as const,
        diff: { key: pending.entryKey, partition: "mutable" as const, before: { entries: {} }, after: { entries: {} } },
        snapshot: { entries: {} },
        authorId: "partner_b",
        authorKind: "partner" as const,
        restoredFromVersionId: null,
        classification: "confidential",
        expectedBaseVersionId: null,
      }
      await expect(
        store.runExclusive((tx) => tx.commitVersion({ ...input, proposal: { ...pending, proposedBy: "other-actor" } })),
      ).rejects.toThrow(/proposedBy is immutable/)
      await expect(
        store.runExclusive((tx) => tx.commitVersion({ ...input, proposal: { ...pending, payload: { wording: "swapped" } } })),
      ).rejects.toThrow(/frozen/)
      await expect(
        store.runExclusive((tx) =>
          tx.commitVersion({
            ...input,
            proposal: { ...pending, id: "00000000-0000-4000-8000-0000000000bb" },
            proposalId: "00000000-0000-4000-8000-0000000000bb",
          }),
        ),
      ).rejects.toThrow(/proposal not found/)
      const kept = await db.client.query<{ proposed_by: string; status: string; versions: number }>(
        `SELECT p.proposed_by, p.status, (SELECT count(*)::int FROM master_versions) AS versions
           FROM change_proposals p WHERE p.id = $1`,
        [pending.id],
      )
      expect(kept.rows[0]).toEqual({ proposed_by: "partner_a", status: "pending", versions: 0 })
    } finally {
      await pool.end()
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("INFO-252-R3: a large legacy set names the first 20 ids and the count", async () => {
    const db = await freshDb("p6info")
    try {
      expect(applyPsqlFile(db.url, MAIN_DDL).status).toBe(0)
      const ids = Array.from({ length: 25 }, () => randomUUID()).sort()
      await db.client.query("SET ROLE p6_service")
      for (const [index, id] of ids.entries()) {
        await db.client.query(
          `INSERT INTO change_proposals
             (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
              proposed_by, status, decided_by, decided_kind, decided_role, payload_hash)
           VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', $2,
                   '{"wording":"legacy"}'::jsonb, 'partner_a', 'approved', NULL, 'partner', 'partner', 'abc')`,
          [id, `clause.legacy.${index}`],
        )
      }
      await db.client.query("RESET ROLE")
      const upgraded = applyPsqlFile(db.url, DDL)
      expect(upgraded.status).not.toBe(0)
      expect(upgraded.stderr).toMatch(/refusing to replace substantive_partner_approval/)
      expect(upgraded.stderr).toMatch(/20 of 25/)
      expect(upgraded.stderr).toContain(ids[0])
      expect(upgraded.stderr).toContain(ids[19])
      expect(upgraded.stderr).not.toContain(ids[20])
    } finally {
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  async function actorKeyMd5(client: pg.Client): Promise<string | null> {
    const found = await client.query<{ digest: string | null }>(
      `SELECT CASE
                WHEN to_regprocedure('public.p6_actor_key(text)') IS NULL THEN NULL
                ELSE md5(pg_get_functiondef('public.p6_actor_key(text)'::regprocedure))
              END AS digest`,
    )
    return found.rows[0]?.digest ?? null
  }

  async function insertLegacyApprovals(client: pg.Client): Promise<{ badIds: string[]; allIds: string[] }> {
    const bad = [
      ["Partner B", "clause.space"],
      ["partner+1@x", "clause.plus"],
      ["partner_é", "clause.acute"],
      ["partner:1", "clause.colon"],
    ] as const
    const badIds: string[] = []
    const allIds: string[] = []
    await client.query("SET ROLE p6_service")
    for (const [approver, key] of bad) {
      const id = randomUUID()
      badIds.push(id)
      allIds.push(id)
      await client.query(
        `INSERT INTO change_proposals
           (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
            proposed_by, status, payload_hash)
         VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', $2,
                 '{"wording":"legacy"}'::jsonb, 'partner_a', 'pending', 'abc')`,
        [id, key],
      )
      await client.query(
        `UPDATE change_proposals
            SET status = 'approved', decided_by = $2, decided_kind = 'partner', decided_role = 'partner'
          WHERE id = $1`,
        [id, approver],
      )
    }
    for (let index = 0; index < 3; index += 1) {
      const id = randomUUID()
      allIds.push(id)
      await client.query(
        `INSERT INTO change_proposals
           (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
            proposed_by, status, payload_hash)
         VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', $2,
                 '{"wording":"good"}'::jsonb, 'partner_a', 'pending', 'abc')`,
        [id, `clause.good.${index}`],
      )
      await client.query(
        `UPDATE change_proposals
            SET status = 'approved', decided_by = 'partner_b', decided_kind = 'partner', decided_role = 'partner'
          WHERE id = $1`,
        [id],
      )
    }
    for (let index = 0; index < 3; index += 1) {
      const id = randomUUID()
      allIds.push(id)
      await client.query(
        `INSERT INTO change_proposals
           (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
            proposed_by, status, payload_hash)
         VALUES ($1, 'firmA', 'learner', 'confidential', 'cosmetic', 'mutable', $2,
                 '{"wording":"pending"}'::jsonb, 'partner_a', 'pending', 'abc')`,
        [id, `clause.pending.${index}`],
      )
    }
    await client.query("RESET ROLE")
    return { badIds, allIds }
  }

  function restoreDump(sourceUrl: string, targetUrl: string): { status: number; stderr: string } {
    const source = new URL(sourceUrl)
    const target = new URL(targetUrl)
    const dump = path.join("/tmp", `p6dump-${randomBytes(4).toString("hex")}.sql`)
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(source.password) }
    try {
      execFileSync(
        "pg_dump",
        [
          "-h",
          source.hostname,
          "-p",
          source.port || "5432",
          "-U",
          decodeURIComponent(source.username),
          "-d",
          source.pathname.replace(/^\//, ""),
          "--no-owner",
          "--no-acl",
          "-f",
          dump,
        ],
        { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      )
      const wrapped = path.join("/tmp", `p6restore-${randomBytes(4).toString("hex")}.sql`)
      fs.writeFileSync(
        wrapped,
        `BEGIN;\nSET session_replication_role = replica;\n\\i ${dump}\nCOMMIT;\n`,
      )
      try {
        execFileSync(
          "psql",
          [
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "-q",
            "-h",
            target.hostname,
            "-p",
            target.port || "5432",
            "-U",
            decodeURIComponent(target.username),
            "-d",
            target.pathname.replace(/^\//, ""),
            "-f",
            wrapped,
          ],
          { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        )
        return { status: 0, stderr: "" }
      } catch (error) {
        const failed = error as { status?: number; stderr?: string }
        return { status: failed.status ?? 1, stderr: failed.stderr ?? String(error) }
      } finally {
        fs.rmSync(wrapped, { force: true })
      }
    } finally {
      fs.rmSync(dump, { force: true })
    }
  }

  function startPsqlFile(connectionString: string, sql: string): {
    finished: Promise<{ status: number; stderr: string }>
    stop: () => void
  } {
    const file = path.join("/tmp", `p6mig-${randomBytes(4).toString("hex")}.sql`)
    fs.writeFileSync(file, sql)
    const url = new URL(connectionString)
    const child = spawn(
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
      { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) } },
    )
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    const finished = new Promise<{ status: number; stderr: string }>((resolve) => {
      child.on("close", (code) => {
        fs.rmSync(file, { force: true })
        resolve({ status: code ?? 1, stderr })
      })
    })
    return {
      finished,
      stop: () => {
        child.kill("SIGTERM")
      },
    }
  }

  async function waitForRelationLock(datname: string): Promise<boolean> {
    const watcher = new pg.Client({ connectionString: adminUrl })
    await watcher.connect()
    const started = Date.now()
    try {
      while (Date.now() - started < 8_000) {
        const found = await watcher.query(
          `SELECT 1
             FROM pg_stat_activity
            WHERE datname = $1
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND wait_event = 'relation'`,
          [datname],
        )
        if ((found.rowCount ?? 0) > 0) return true
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      return false
    } finally {
      await watcher.end()
    }
  }

  async function seedTwoGoodApprovals(client: pg.Client): Promise<void> {
    await client.query("SET ROLE p6_service")
    for (const key of ["clause.good.1", "clause.good.2"]) {
      const id = randomUUID()
      await client.query(
        `INSERT INTO change_proposals
           (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
            proposed_by, status, payload_hash)
         VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', $2,
                 '{"wording":"good"}'::jsonb, 'partner_a', 'pending', 'abc')`,
        [id, key],
      )
      await client.query(
        `UPDATE change_proposals
            SET status = 'approved', decided_by = 'partner_b', decided_kind = 'partner', decided_role = 'partner'
          WHERE id = $1`,
        [id],
      )
    }
    await client.query("RESET ROLE")
  }

  function restoreCustomDump(sourceUrl: string, targetUrl: string): { status: number; stderr: string } {
    const source = new URL(sourceUrl)
    const target = new URL(targetUrl)
    const dump = path.join("/tmp", `p6fc-${randomBytes(4).toString("hex")}.dump`)
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(source.password) }
    const base = ["-h", source.hostname, "-p", source.port || "5432", "-U", decodeURIComponent(source.username)]
    try {
      execFileSync(
        "pg_dump",
        [...base, "-d", source.pathname.replace(/^\//, ""), "-Fc", "--no-owner", "--no-acl", "-f", dump],
        { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      )
      execFileSync(
        "pg_restore",
        [
          "--no-owner",
          "--no-acl",
          "--exit-on-error",
          "--single-transaction",
          "-h",
          target.hostname,
          "-p",
          target.port || "5432",
          "-U",
          decodeURIComponent(target.username),
          "-d",
          target.pathname.replace(/^\//, ""),
          dump,
        ],
        { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      )
      return { status: 0, stderr: "" }
    } catch (error) {
      const failed = error as { status?: number; stderr?: string }
      return { status: failed.status ?? 1, stderr: failed.stderr ?? String(error) }
    } finally {
      fs.rmSync(dump, { force: true })
    }
  }

  async function openPartnerBWriter(url: string): Promise<{ client: pg.Client; id: string }> {
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    const id = randomUUID()
    await client.query("BEGIN")
    await client.query("SET LOCAL ROLE p6_service")
    await client.query(
      `INSERT INTO change_proposals
         (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
          proposed_by, status, payload_hash)
       VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', 'clause.bad',
               '{"wording":"legacy"}'::jsonb, 'partner_a', 'pending', 'abc')`,
      [id],
    )
    await client.query(
      `UPDATE change_proposals
          SET status = 'approved', decided_by = 'Partner B', decided_kind = 'partner', decided_role = 'partner'
        WHERE id = $1`,
      [id],
    )
    return { client, id }
  }

  function actorKeyTransaction(sql: string): { preamble: string; transaction: string } {
    const marker = "CREATE OR REPLACE FUNCTION public.p6_actor_key_next"
    const at = sql.indexOf(marker)
    const begin = sql.lastIndexOf("BEGIN;", at)
    const commit = sql.indexOf("COMMIT;", at)
    if (at < 0 || begin < 0 || commit < 0) throw new Error("actor key transaction missing")
    return { preamble: sql.slice(0, begin), transaction: sql.slice(begin, commit + "COMMIT;".length) }
  }

  async function refuseWhileWriterHoldsPartnerB(sql: string, prefix: string, preamble?: string): Promise<void> {
    const db = await freshDb(prefix)
    const restored = await freshDb(`${prefix}r`)
    let writer: pg.Client | undefined
    let migration: ReturnType<typeof startPsqlFile> | undefined
    try {
      expect(applyPsqlFile(db.url, D8125172_DDL).status).toBe(0)
      if (preamble) {
        const prepared = applyPsqlFile(db.url, preamble)
        expect(prepared.status, prepared.stderr).toBe(0)
      }
      await seedTwoGoodApprovals(db.client)
      const before = await actorKeyMd5(db.client)
      expect(before).toBeTruthy()
      const open = await openPartnerBWriter(db.url)
      writer = open.client
      migration = startPsqlFile(db.url, sql)
      const waited = await waitForRelationLock(db.name)
      expect(waited).toBe(true)
      await writer.query("COMMIT")
      await writer.end()
      writer = undefined
      const upgraded = await migration.finished
      migration = undefined
      expect(upgraded.status).not.toBe(0)
      expect(upgraded.stderr).toMatch(/refusing to replace substantive_partner_approval/)
      expect(upgraded.stderr).toContain(open.id)
      expect(await actorKeyMd5(db.client)).toBe(before)
      const leftover = await db.client.query<{ present: string | null }>(
        `SELECT to_regprocedure('public.p6_actor_key_next(text)')::text AS present`,
      )
      expect(leftover.rows[0]?.present ?? null).toBeNull()
      const kept = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM change_proposals`)
      expect(kept.rows[0]?.n).toBe(3)
      const round = restoreCustomDump(db.url, restored.url)
      expect(round.status, round.stderr).toBe(0)
      const restoredCount = await restored.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM change_proposals`,
      )
      expect(restoredCount.rows[0]?.n).toBe(3)
    } finally {
      if (writer) await writer.query("ROLLBACK").catch(() => undefined)
      await writer?.end()
      migration?.stop()
      await dropDb(db.name, db.client)
      await dropDb(restored.name, restored.client)
    }
  }

  it("TEST-258-R2-002: 011 installs the narrower key when every substantive row still has a distinct partner", async () => {
    const db = await freshDb("p6inst")
    try {
      expect(applyPsqlFile(db.url, D8125172_DDL).status).toBe(0)
      await seedTwoGoodApprovals(db.client)
      const before = await actorKeyMd5(db.client)
      const installed = applyPsqlFile(db.url, ACTOR_KEY_DDL)
      expect(installed.status, installed.stderr).toBe(0)
      expect(await actorKeyMd5(db.client)).not.toBe(before)
      const keys = await db.client.query<{ spaced: string; plus: string; colon: string; sharp: string }>(
        `SELECT public.p6_actor_key('Partner B') AS spaced,
                public.p6_actor_key('partner+1@x') AS plus,
                public.p6_actor_key('partner:1') AS colon,
                public.p6_actor_key('straße') AS sharp`,
      )
      expect(keys.rows[0]).toEqual({ spaced: "", plus: "", colon: "", sharp: "strasse" })
      const gone = await db.client.query<{ present: string | null }>(
        `SELECT to_regprocedure('public.p6_actor_key_next(text)')::text AS present`,
      )
      expect(gone.rows[0]?.present ?? null).toBeNull()
    } finally {
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("MIG-258-R2-001: 009 waits for an open Partner B writer, then refuses, and restore keeps 3/3", async () => {
    const parts = actorKeyTransaction(DDL)
    await refuseWhileWriterHoldsPartnerB(parts.transaction, "p6r2009", parts.preamble)
    await refuseWhileWriterHoldsPartnerB(DDL, "p6r2009f")
  }, 90_000)

  it("MIG-258-R2-001: 011 waits for an open Partner B writer, then refuses, and restore keeps 3/3", async () => {
    await refuseWhileWriterHoldsPartnerB(ACTOR_KEY_DDL, "p6r2011")
  }, 60_000)

  it("MSG-258-R2-004: an empty or whitespace proposer key is not an approver mismatch", async () => {
    const db = await freshDb("p6msg")
    try {
      await db.client.query(DDL)
      await db.client.query("SET ROLE p6_service")
      for (const proposedBy of ["", "   ", " \t "]) {
        const id = randomUUID()
        await db.client.query(
          `INSERT INTO change_proposals
             (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
              proposed_by, status, payload_hash)
           VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', $2,
                   '{"wording":"missing"}'::jsonb, $3, 'pending', 'abc')`,
          [id, `clause.msg.${id.slice(0, 8)}`, proposedBy],
        )
        await expect(
          db.client.query(
            `UPDATE change_proposals
                SET status = 'approved', decided_by = 'partner_b', decided_kind = 'partner', decided_role = 'partner'
              WHERE id = $1`,
            [id],
          ),
        ).rejects.toThrow(/proposer key missing/)
        const kept = await db.client.query<{ status: string }>(`SELECT status FROM change_proposals WHERE id = $1`, [id])
        expect(kept.rows[0]?.status).toBe("pending")
      }
    } finally {
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("MIG-258-001: narrowing p6_actor_key refuses legacy rows and keeps the installed function", async () => {
    const chain = await freshDb("p6mig258")
    const forward = await freshDb("p6mig258b")
    const restored = await freshDb("p6mig258r")
    try {
      expect(applyPsqlFile(chain.url, D8125172_DDL).status).toBe(0)
      const seeded = await insertLegacyApprovals(chain.client)
      expect(seeded.allIds).toHaveLength(10)
      const before = await actorKeyMd5(chain.client)
      expect(before).toBeTruthy()
      const upgraded = applyPsqlFile(chain.url, DDL)
      expect(upgraded.status).not.toBe(0)
      expect(upgraded.stderr).toMatch(/refusing to replace substantive_partner_approval/)
      expect(upgraded.stderr).toMatch(/4 of 4/)
      for (const id of seeded.badIds) expect(upgraded.stderr).toContain(id)
      expect(await actorKeyMd5(chain.client)).toBe(before)
      const leftover = await chain.client.query<{ present: string | null }>(
        `SELECT to_regprocedure('public.p6_actor_key_next(text)')::text AS present`,
      )
      expect(leftover.rows[0]?.present ?? null).toBeNull()
      const kept = await chain.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM change_proposals`)
      expect(kept.rows[0]?.n).toBe(10)

      const round = restoreDump(chain.url, restored.url)
      expect(round.status, round.stderr).toBe(0)
      const restoredCount = await restored.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM change_proposals`,
      )
      expect(restoredCount.rows[0]?.n).toBe(10)

      expect(applyPsqlFile(forward.url, D8125172_DDL).status).toBe(0)
      const forwardRows = await insertLegacyApprovals(forward.client)
      const forwardBefore = await actorKeyMd5(forward.client)
      const forwarded = applyPsqlFile(forward.url, ACTOR_KEY_DDL)
      expect(forwarded.status).not.toBe(0)
      expect(forwarded.stderr).toMatch(/refusing to replace substantive_partner_approval/)
      expect(forwarded.stderr).toMatch(/4 of 4/)
      for (const id of forwardRows.badIds) expect(forwarded.stderr).toContain(id)
      expect(await actorKeyMd5(forward.client)).toBe(forwardBefore)
    } finally {
      await dropDb(chain.name, chain.client)
      await dropDb(forward.name, forward.client)
      await dropDb(restored.name, restored.client)
    }
  }, 60_000)

  it("TEST-258-002: pending raw SQL refuses identity rewrites, stamps, and non-charset actor keys", async () => {
    const db = await freshDb("p6pin")
    try {
      await db.client.query(DDL)
      await db.client.query("SET ROLE p6_service")
      const id = randomUUID()
      await db.client.query(
        `INSERT INTO change_proposals
           (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
            proposed_by, status, payload_hash)
         VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', 'clause.pin',
                 '{"wording":"pin"}'::jsonb, 'partner_a', 'pending', 'abc')`,
        [id],
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET entry_key = 'clause.other' WHERE id = $1`,
        [id],
        /frozen/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET source_module = 'other' WHERE id = $1`,
        [id],
        /frozen/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET classification = 'public' WHERE id = $1`,
        [id],
        /frozen/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET decided_kind = 'partner' WHERE id = $1`,
        [id],
        /approval is not a direct status change/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET decided_role = 'partner' WHERE id = $1`,
        [id],
        /approval is not a direct status change/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET declassify = true WHERE id = $1`,
        [id],
        /approval is not a direct status change/,
      )
      const keys = await db.client.query<{ spaced: string; plus: string; colon: string }>(
        `SELECT public.p6_actor_key('Partner B') AS spaced,
                public.p6_actor_key('partner+1@x') AS plus,
                public.p6_actor_key('partner:1') AS colon`,
      )
      expect(keys.rows[0]).toEqual({ spaced: "", plus: "", colon: "" })
      const kept = await db.client.query<{ entry_key: string; source_module: string; classification: string; declassify: boolean }>(
        `SELECT entry_key, source_module, classification, declassify FROM change_proposals WHERE id = $1`,
        [id],
      )
      expect(kept.rows[0]).toEqual({
        entry_key: "clause.pin",
        source_module: "learner",
        classification: "confidential",
        declassify: false,
      })
    } finally {
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("FREEZE-258-003: a pending row cannot change id or created_at", async () => {
    const db = await freshDb("p6freeze")
    try {
      await db.client.query(DDL)
      await db.client.query("SET ROLE p6_service")
      const id = randomUUID()
      await db.client.query(
        `INSERT INTO change_proposals
           (id, firm_id, source_module, classification, change_class, partition, entry_key, payload,
            proposed_by, status, payload_hash)
         VALUES ($1, 'firmA', 'learner', 'confidential', 'substantive', 'mutable', 'clause.freeze-id',
                 '{"wording":"id"}'::jsonb, 'partner_a', 'pending', 'abc')`,
        [id],
      )
      const before = await db.client.query<{ created_at: Date }>(
        `SELECT created_at FROM change_proposals WHERE id = $1`,
        [id],
      )
      const nextId = randomUUID()
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET id = $2 WHERE id = $1`,
        [id, nextId],
        /frozen/,
      )
      await expectRefused(
        db.client,
        `UPDATE change_proposals SET created_at = created_at + interval '1 day' WHERE id = $1`,
        [id],
        /frozen/,
      )
      const kept = await db.client.query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM change_proposals WHERE id = $1 OR id = $2`,
        [id, nextId],
      )
      expect(kept.rows).toHaveLength(1)
      expect(kept.rows[0]?.id).toBe(id)
      expect(kept.rows[0]?.created_at.toISOString()).toBe(before.rows[0]?.created_at.toISOString())
    } finally {
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("PARITY-258-005: Postgres rejects U+0130 and U+1CCD6-U+1CCF9 before lower", async () => {
    const db = await freshDb("p6parity")
    try {
      await db.client.query(DDL)
      const keys = await db.client.query<{ dotted: string; start: string; mid: string; end: string; sharp: string; wide: string }>(
        `SELECT public.p6_actor_key(chr(304)) AS dotted,
                public.p6_actor_key(chr(117974)) AS start,
                public.p6_actor_key(chr(117984)) AS mid,
                public.p6_actor_key(chr(118009)) AS end,
                public.p6_actor_key('straße') AS sharp,
                public.p6_actor_key(chr(65328) || chr(65313)) AS wide`,
      )
      expect(keys.rows[0]?.dotted).toBe("")
      expect(keys.rows[0]?.start).toBe("")
      expect(keys.rows[0]?.mid).toBe("")
      expect(keys.rows[0]?.end).toBe("")
      expect(keys.rows[0]?.sharp).toBe("strasse")
      expect(keys.rows[0]?.wide).toBe("pa")
    } finally {
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("BYPASS-271: a rollback forge, a pending substantive, and a swapped snapshot are refused", async () => {
    const db = await freshDb("p6bypass")
    const pool = new pg.Pool({ connectionString: db.url, max: 1 })
    try {
      await db.client.query(DDL)
      await db.client.query(ACTOR_KEY_DDL)
      await db.client.query(`GRANT p6_service TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`)
      const store = createPgMasterStore(pool)
      const forged = {
        entries: {
          forged: {
            partition: "mutable" as const,
            key: "forged",
            body: { wording: "forged" },
            classification: "confidential" as const,
          },
        },
      }
      await expect(
        store.commitVersion({
          firmId: "firmA",
          proposalId: null,
          action: "rollback",
          diff: { key: "*", partition: "mutable", before: { entries: {} }, after: forged },
          snapshot: forged,
          authorId: "clerk_x",
          authorKind: "partner",
          restoredFromVersionId: null,
          classification: "confidential",
          proposal: null,
          expectedBaseVersionId: null,
        }),
      ).rejects.toThrow(/version not found/)
      const pending = await store.insertProposal({
        id: randomUUID(),
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        requestedClass: null,
        partition: "mutable",
        entryKey: "clause.pending",
        payload: { wording: "stored" },
        proposedBy: "learner-1",
        status: "pending",
        decidedBy: null,
        decidedKind: null,
        decidedRole: null,
        declassify: false,
        payloadHash: "pending",
      })
      const disguisedBefore = {
        entries: {
          [pending.entryKey]: {
            partition: "mutable" as const,
            key: pending.entryKey,
            body: pending.payload,
            classification: "confidential" as const,
          },
        },
      }
      await store.runExclusive(async (tx) => {
        expect("pgClient" in tx).toBe(false)
        expect("persistVersion" in tx).toBe(false)
        const openRaw = (
          storeModule as {
            sessionForWrite?: (session: object) => { pgClient?: { query: (sql: string) => Promise<unknown> } }
          }
        ).sessionForWrite
        if (openRaw) {
          const raw = openRaw(tx)
          await expect(raw.pgClient?.query("INSERT INTO master_versions DEFAULT VALUES")).rejects.toThrow()
        }
        expect(openRaw).toBeUndefined()
        await expect(
          tx.commitVersion({
            firmId: pending.firmId,
            proposalId: pending.id,
            action: "apply",
            diff: { key: pending.entryKey, partition: "mutable", before: disguisedBefore, after: forged },
            snapshot: forged,
            authorId: "p6",
            authorKind: "system",
            restoredFromVersionId: null,
            classification: "confidential",
            proposal: pending,
            expectedBaseVersionId: null,
          }),
        ).rejects.toThrow(/bound to the proposal|partner approval/)
      })
      const approved = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "15",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.bound",
          payload: { wording: "approved text" },
          proposedBy: "learner-1",
        },
        store,
      )
      await approveProposal(approved.id, { actorId: "partner_b", kind: "partner", role: "partner" }, store)
      const stored = await store.getProposal(approved.id)
      await store.runExclusive(async (tx) => {
        const head = await tx.currentSnapshot("firmA")
        const applied = { ...stored!, status: "applied" as const }
        expect(await tx.casProposal(applied, "approved")).toBe(true)
        await expect(
          tx.commitVersion({
            firmId: "firmA",
            proposalId: stored!.id,
            action: "apply",
            diff: { key: stored!.entryKey, partition: "mutable", before: head, after: forged },
            snapshot: forged,
            authorId: "partner_b",
            authorKind: "partner",
            restoredFromVersionId: null,
            classification: "confidential",
            proposal: applied,
            expectedBaseVersionId: await tx.lockFirm("firmA"),
          }),
        ).rejects.toThrow(/bound to the proposal/)
      })
      const versions = await db.client.query(`SELECT count(*)::int AS n FROM master_versions`)
      expect(versions.rows[0]?.n).toBe(0)
      expect("sessionForWrite" in storeModule).toBe(false)
      const memory = new InMemoryMasterStore({ role: "p6_service" })
      const openRaw = (
        storeModule as {
          sessionForWrite?: (session: object) => {
            persistVersion?: (input: CommitVersionInput) => Promise<{ committed: boolean }>
          }
        }
      ).sessionForWrite
      await memory.runExclusive(async (tx) => {
        expect("persistVersion" in tx).toBe(false)
        if (openRaw) {
          const written = await openRaw(tx).persistVersion?.({
            firmId: "firmA",
            proposalId: null,
            action: "rollback",
            diff: { key: "*", partition: "mutable", before: { entries: {} }, after: forged },
            snapshot: forged,
            authorId: "clerk_x",
            authorKind: "partner",
            restoredFromVersionId: null,
            classification: "confidential",
            proposal: null,
            expectedBaseVersionId: null,
          })
          expect(written?.committed).toBe(false)
        }
      })
      expect(openRaw).toBeUndefined()
      expect(await memory.listVersions("firmA")).toEqual([])
    } finally {
      await pool.end()
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("TEST-271-004: a deferred trigger fails COMMIT and the same proposal can retry", async () => {
    const db = await freshDb("p6commit")
    const pool = new pg.Pool({ connectionString: db.url, max: 1 })
    try {
      await db.client.query(DDL)
      await db.client.query(ACTOR_KEY_DDL)
      await db.client.query(`
        CREATE TABLE public.p6_fail_commit (id int primary key);
        CREATE FUNCTION public.p6_fail_commit_fn() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM public.p6_fail_commit) THEN
            RAISE EXCEPTION 'master write did not commit';
          END IF;
          RETURN NULL;
        END $$;
        CREATE CONSTRAINT TRIGGER p6_fail_commit_trg
          AFTER INSERT ON public.master_versions
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION public.p6_fail_commit_fn();
        GRANT SELECT ON public.p6_fail_commit TO p6_service;
      `)
      await db.client.query(`GRANT p6_service TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`)
      await db.client.query(`INSERT INTO public.p6_fail_commit (id) VALUES (1)`)
      const store = createPgMasterStore(pool)
      const pending = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "15",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.retry",
          payload: { wording: "retry" },
          proposedBy: "learner-1",
        },
        store,
      )
      await approveProposal(pending.id, { actorId: "partner_b", kind: "partner", role: "partner" }, store)
      const auditBefore = masterWriteAuditLog().length
      await expect(applyChange(pending.id, store)).rejects.toThrow(/did not commit/)
      const failed = await db.client.query<{ n: number; status: string }>(
        `SELECT (SELECT count(*)::int FROM master_versions) AS n, status FROM change_proposals WHERE id = $1`,
        [pending.id],
      )
      expect(failed.rows[0]).toEqual({ n: 0, status: "approved" })
      expect(masterWriteAuditLog().slice(auditBefore)).toEqual([])
      await db.client.query(`DELETE FROM public.p6_fail_commit`)
      const applied = await applyChange(pending.id, store)
      expect(applied.masterWritten).toBe(true)
      const committed = await db.client.query(`SELECT count(*)::int AS n FROM master_versions`)
      expect(committed.rows[0]?.n).toBe(1)
      expect(masterWriteAuditLog().slice(auditBefore)).toEqual([
        expect.objectContaining({ proposalId: pending.id, versionId: applied.versionId, outcome: "committed" }),
      ])
    } finally {
      await pool.end()
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("BYPASS-271-R2-001: a stale cosmetic proposal cannot revert a partner change", async () => {
    const db = await freshDb("p6stale")
    const pool = new pg.Pool({ connectionString: db.url, max: 1 })
    try {
      await db.client.query(DDL)
      await db.client.query(ACTOR_KEY_DDL)
      await db.client.query(`GRANT p6_service TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`)
      const store = createPgMasterStore(pool)
      const partner = { actorId: "partner_b", kind: "partner" as const, role: "partner" }
      const first = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "15",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.stale",
          payload: { wording: "alpha" },
          proposedBy: "learner-1",
        },
        store,
      )
      await approveProposal(first.id, partner, store)
      await applyChange(first.id, store)
      const cosmetic = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "15",
          classification: "confidential",
          changeClass: "cosmetic",
          partition: "mutable",
          entryKey: "clause.stale",
          payload: { wording: "alpha " },
          proposedBy: "learner-1",
        },
        store,
      )
      expect(cosmetic.changeClass).toBe("cosmetic")
      expect(cosmetic.status).toBe("pending")
      const later = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "15",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.stale",
          payload: { wording: "beta" },
          proposedBy: "learner-1",
        },
        store,
      )
      await approveProposal(later.id, partner, store)
      await applyChange(later.id, store)
      await expect(applyChange(cosmetic.id, store)).rejects.toThrow(/partner approval/)
      const current = await store.currentSnapshot("firmA")
      const stored = await store.getProposal(cosmetic.id)
      const versionsBefore = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM master_versions`)
      await expect(
        store.commitVersion({
          firmId: "firmA",
          proposalId: cosmetic.id,
          action: "apply",
          diff: { key: cosmetic.entryKey, partition: "mutable", before: current, after: nextSnapshot(current, stored!) },
          snapshot: nextSnapshot(current, stored!),
          authorId: "p6",
          authorKind: "system",
          restoredFromVersionId: null,
          classification: "confidential",
          proposal: stored,
          expectedBaseVersionId: (await store.listVersions("firmA")).at(-1)?.id ?? null,
        }),
      ).rejects.toThrow(/partner approval/)
      const head = await db.client.query<{ snapshot: { entries: Record<string, { body: unknown }> } }>(
        `SELECT snapshot FROM master_knowledge WHERE firm_id = 'firmA'`,
      )
      expect(head.rows[0]?.snapshot.entries["clause.stale"]?.body).toEqual({ wording: "beta" })
      const row = await db.client.query<{ status: string }>(`SELECT status FROM change_proposals WHERE id = $1`, [cosmetic.id])
      expect(row.rows[0]?.status).toBe("pending")
      const versionsAfter = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM master_versions`)
      expect(versionsAfter.rows[0]?.n).toBe(versionsBefore.rows[0]?.n)
    } finally {
      await pool.end()
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("BYPASS-271-R2-002: an exported seal cannot commit a lying session or a forged rollback", async () => {
    const db = await freshDb("p6seal")
    const pool = new pg.Pool({ connectionString: db.url, max: 1 })
    try {
      await db.client.query(DDL)
      await db.client.query(ACTOR_KEY_DDL)
      await db.client.query(`GRANT p6_service TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`)
      const store = createPgMasterStore(pool)
      const partner = { actorId: "partner_b", kind: "partner" as const, role: "partner" }
      const pending = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "15",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.seal",
          payload: { wording: "NEVER APPROVED" },
          proposedBy: "learner-1",
        },
        store,
      )
      const current = await store.currentSnapshot("firmA")
      const base = (await store.listVersions("firmA")).at(-1)?.id ?? null
      const lying = {
        ...pending,
        status: "approved" as const,
        decidedBy: "partner_b",
        decidedKind: "partner" as const,
        decidedRole: "partner",
      }
      const snapshot = nextSnapshot(current, lying)
      const writer = await import("@/platform/p6/masterWrite")
      const seal = (writer as { sealMasterSession?: (session: object, raw: object) => void }).sealMasterSession
      const write = (writer as { writeMaster?: (input: CommitVersionInput, session: object, gate: { declassify: boolean }) => Promise<{ committed: boolean }> }).writeMaster
      const client = new pg.Client({ connectionString: db.url })
      await client.connect()
      let committed = false
      try {
        await client.query("BEGIN")
        await client.query("SET LOCAL ROLE p6_service")
        if (typeof seal === "function" && typeof write === "function") {
          const session = {
            async getProposal() {
              return lying
            },
            async currentSnapshot() {
              return current
            },
            async currentClassification() {
              return "confidential" as const
            },
            async lockFirm() {
              return base
            },
            async getVersion() {
              return null
            },
            async assertCommitShape() {},
          }
          seal(session, { pgClient: client, allowDeclassify: async () => {} })
          const result = await write(
            {
              firmId: "firmA",
              proposalId: pending.id,
              action: "apply",
              diff: { key: pending.entryKey, partition: "mutable", before: current, after: snapshot },
              snapshot,
              authorId: "partner_b",
              authorKind: "partner",
              restoredFromVersionId: null,
              classification: "confidential",
              proposal: lying,
              expectedBaseVersionId: base,
            },
            session,
            { declassify: false },
          )
          committed = result.committed === true
        }
        await client.query("COMMIT")
      } finally {
        await client.end()
      }
      expect(committed).toBe(false)
      expect(typeof seal).not.toBe("function")
      const leaked = await db.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM master_versions WHERE snapshot::text LIKE '%NEVER APPROVED%'`,
      )
      expect(leaked.rows[0]?.n).toBe(0)

      const real = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "15",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.real",
          payload: { wording: "real" },
          proposedBy: "learner-1",
        },
        store,
      )
      await approveProposal(real.id, partner, store)
      const applied = await applyChange(real.id, store)
      const arbitrary = {
        entries: {
          forged: {
            partition: "mutable" as const,
            key: "forged",
            body: { wording: "ARBITRARY SNAPSHOT" },
            classification: "confidential" as const,
          },
        },
      }
      const realVersion = await store.getVersion(applied.versionId)
      const realHead = await store.currentSnapshot("firmA")
      const fake = {
        role: "p6_service",
        async getVersion() {
          return { ...realVersion!, snapshot: arbitrary }
        },
        async runExclusive(fn: (tx: object) => Promise<unknown>) {
          const held = new pg.Client({ connectionString: db.url })
          await held.connect()
          try {
            await held.query("BEGIN")
            await held.query("SET LOCAL ROLE p6_service")
            const tx = {
              async lockFirm() {
                return applied.versionId
              },
              async currentSnapshot() {
                return realHead
              },
              async currentClassification() {
                return "confidential" as const
              },
              async getVersion() {
                return { ...realVersion!, snapshot: arbitrary }
              },
              async getProposal() {
                return null
              },
              async assertCommitShape() {},
            }
            if (typeof seal === "function") seal(tx, { pgClient: held, allowDeclassify: async () => {} })
            const result = await fn(tx)
            await held.query("COMMIT")
            return result
          } catch (error) {
            await held.query("ROLLBACK")
            throw error
          } finally {
            await held.end()
          }
        },
      }
      await expect(
        rollbackMaster({ firmId: "firmA", toVersionId: applied.versionId, actor: partner }, fake as unknown as ReturnType<typeof createPgMasterStore>),
      ).rejects.toThrow(/master session is closed|bound to the proposal/)
      const forged = await db.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM master_versions WHERE snapshot::text LIKE '%ARBITRARY SNAPSHOT%'`,
      )
      expect(forged.rows[0]?.n).toBe(0)
      const head = await db.client.query<{ snapshot: { entries: Record<string, { body: unknown }> } }>(
        `SELECT snapshot FROM master_knowledge WHERE firm_id = 'firmA'`,
      )
      expect(head.rows[0]?.snapshot.entries["clause.real"]?.body).toEqual({ wording: "real" })
    } finally {
      await pool.end()
      await dropDb(db.name, db.client)
    }
  }, 60_000)

  it("STATUS-R2-003 and N3b: a committed approval is applied, and a finished session is closed", async () => {
    const db = await freshDb("p6status")
    const pool = new pg.Pool({ connectionString: db.url, max: 1 })
    try {
      await db.client.query(DDL)
      await db.client.query(ACTOR_KEY_DDL)
      await db.client.query(`GRANT p6_service TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`)
      const store = createPgMasterStore(pool)
      const partner = { actorId: "partner_b", kind: "partner" as const, role: "partner" }
      const pending = await proposeChange(
        {
          firmId: "firmA",
          sourceModule: "15",
          classification: "confidential",
          changeClass: "substantive",
          partition: "mutable",
          entryKey: "clause.status",
          payload: { wording: "kept" },
          proposedBy: "learner-1",
        },
        store,
      )
      await approveProposal(pending.id, partner, store)
      const stored = await store.getProposal(pending.id)
      const current = await store.currentSnapshot("firmA")
      const snapshot = nextSnapshot(current, stored!)
      const committed = await store.commitVersion({
        firmId: "firmA",
        proposalId: pending.id,
        action: "apply",
        diff: { key: pending.entryKey, partition: "mutable", before: current, after: snapshot },
        snapshot,
        authorId: "partner_b",
        authorKind: "partner",
        restoredFromVersionId: null,
        classification: "confidential",
        proposal: null,
        expectedBaseVersionId: null,
      })
      expect(committed.committed).toBe(true)
      const status = await db.client.query<{ status: string }>(`SELECT status FROM change_proposals WHERE id = $1`, [pending.id])
      expect(status.rows[0]?.status).toBe("applied")
      await expect(applyChange(pending.id, store)).rejects.toThrow(/already applied/)
      const versions = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM master_versions`)
      expect(versions.rows[0]?.n).toBe(1)
      let finished: { commitVersion: (input: CommitVersionInput) => Promise<unknown> } | undefined
      await store.runExclusive(async (tx) => {
        finished = tx
      })
      await expect(
        finished!.commitVersion({
          firmId: "firmA",
          proposalId: null,
          action: "rollback",
          diff: { key: "*", partition: "mutable", before: current, after: current },
          snapshot: current,
          authorId: "partner_b",
          authorKind: "partner",
          restoredFromVersionId: committed.versionId,
          classification: "confidential",
          proposal: null,
          expectedBaseVersionId: committed.versionId,
        }),
      ).rejects.toThrow(/master session is closed/)
    } finally {
      await pool.end()
      await dropDb(db.name, db.client)
    }
  }, 60_000)
})
