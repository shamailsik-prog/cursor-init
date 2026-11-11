/**
 * FA-DATA-002: corpus_embeddings classification coverage on real Postgres.
 * 007 is applied with 001-006. declassify() is called unchanged. Embeddings stay at the
 * higher rank after a judgment is declassified.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const postgresUrl = process.env.SIKANDER_POSTGRES_URL;
const ON_CI = Boolean(process.env.CI) && !/^(false|0)$/i.test(process.env.CI ?? "");

if (ON_CI && !postgresUrl) {
  throw new Error(
    "FA-DATA-002 Postgres tests require SIKANDER_POSTGRES_URL in CI " +
      "(run them through the Gate G-0 postgres-ddl job)",
  );
}

const suite = postgresUrl ? describe : describe.skip;
const DDL_DIR = path.join(process.cwd(), "postgres", "ddl");
const DECLASSIFY = /Classification downgrade rejected: call declassify\(\) with a partner reason/;
const APP_ROLES = [
  "corpus_reader",
  "corpus_writer",
  "corpus_declassify",
  "corpus_authority_reader",
  "corpus_research_reader",
  "app_writer",
] as const;

function ddlFiles(): string[] {
  return fs.readdirSync(DDL_DIR).filter((f) => f.endsWith(".sql")).sort();
}

function roleClient(role: string, password: string): pg.Client {
  const url = new URL(postgresUrl!);
  url.username = role;
  url.password = password;
  return new pg.Client({ connectionString: url.toString() });
}

async function expectSqlState(p: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  let caught: { code?: string; message?: string } | null = null;
  try {
    await p;
  } catch (e) {
    caught = e as { code?: string; message?: string };
  }
  expect(caught, `expected SQLSTATE ${code}, the statement succeeded`).not.toBeNull();
  expect(caught?.code, caught?.message).toBe(code);
  if (message) expect(caught?.message).toMatch(message);
}

const ZERO = `('[' || repeat('0,', 1535) || '0]')::vector`;
const ONE = `('[1,' || repeat('0,', 1534) || '0]')::vector`;

suite("FA-DATA-002 classification coverage", () => {
  let admin: pg.Client;
  const standing: Record<string, boolean> = {};

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
    for (const file of ddlFiles()) {
      await admin.query(fs.readFileSync(path.join(DDL_DIR, file), "utf8"));
    }
    await admin.query(
      `ALTER ROLE corpus_reader LOGIN PASSWORD 'reader';
       ALTER ROLE corpus_writer LOGIN PASSWORD 'writer';
       ALTER ROLE corpus_declassify LOGIN PASSWORD 'declass';`,
    );
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE app_writer LOGIN PASSWORD 'writer';
       EXCEPTION WHEN duplicate_object THEN
         ALTER ROLE app_writer LOGIN PASSWORD 'writer';
       END $$;
       GRANT SELECT, INSERT, UPDATE ON judgment TO app_writer;
       GRANT SELECT ON classification_rank TO app_writer;
       REVOKE ALL ON judgment_declassify_grant FROM app_writer;
       REVOKE ALL ON FUNCTION declassify(UUID, TEXT, TEXT, TEXT) FROM app_writer;`,
    );
    // 007's app_writer revoke runs only when the role already exists. Re-apply 007 then 008 so a role
    // created above loses EXECUTE, then record standing embedding DML before the temporary grant.
    await admin.query(fs.readFileSync(path.join(DDL_DIR, "007_classification_coverage.sql"), "utf8"));
    await admin.query(fs.readFileSync(path.join(DDL_DIR, "008_classification_inventory.sql"), "utf8"));
    for (const role of ["corpus_writer", "app_writer"] as const) {
      const priv = await admin.query(
        `SELECT has_table_privilege($1, 'public.corpus_embeddings', 'INSERT') AS ins,
                has_table_privilege($1, 'public.corpus_embeddings', 'UPDATE') AS upd,
                has_table_privilege($1, 'public.corpus_embeddings', 'DELETE') AS del,
                has_table_privilege($1, 'public.judgment', 'DELETE') AS jdel`,
        [role],
      );
      standing[`${role}.insert`] = priv.rows[0].ins;
      standing[`${role}.update`] = priv.rows[0].upd;
      standing[`${role}.delete`] = priv.rows[0].del;
      standing[`${role}.judgment_delete`] = priv.rows[0].jdel;
    }
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON public.corpus_embeddings TO corpus_writer, app_writer`,
    );
  }, 120_000);

  afterAll(async () => {
    if (admin) {
      await admin.query(
        `REVOKE SELECT, INSERT, UPDATE ON public.corpus_embeddings FROM corpus_writer, app_writer`,
      );
      await admin.end();
    }
  });

  async function withRole<T>(role: "corpus_writer" | "app_writer", body: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = roleClient(role, "writer");
    await client.connect();
    try {
      return await body(client);
    } finally {
      await client.end();
    }
  }

  async function judgment(classification: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO judgment (id, classification) VALUES ($1, $2)`, [id, classification]);
    return id;
  }

  async function insertEmbedding(
    client: pg.Client,
    entityType: string,
    entityId: string,
    rank: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO corpus_embeddings (entity_type, entity_id, model, classification_rank, embedding)
       VALUES ($1, $2, 'text-embedding-3-small', $3, ${ZERO})`,
      [entityType, entityId, rank],
    );
  }

  async function rankOf(entityId: string): Promise<number> {
    const row = await admin.query(
      `SELECT classification_rank FROM corpus_embeddings WHERE entity_id = $1`,
      [entityId],
    );
    return row.rows[0].classification_rank;
  }

  it("records standing privileges: no app role can DELETE judgment or corpus_embeddings, and neither writer has standing embedding DML", async () => {
    expect(standing["corpus_writer.insert"]).toBe(false);
    expect(standing["corpus_writer.update"]).toBe(false);
    expect(standing["corpus_writer.delete"]).toBe(false);
    expect(standing["corpus_writer.judgment_delete"]).toBe(false);
    expect(standing["app_writer.insert"]).toBe(false);
    expect(standing["app_writer.update"]).toBe(false);
    expect(standing["app_writer.delete"]).toBe(false);
    expect(standing["app_writer.judgment_delete"]).toBe(false);
    const owner = await admin.query(
      `SELECT has_table_privilege(current_user, 'public.judgment', 'DELETE') AS judgment,
              has_table_privilege(current_user, 'public.corpus_embeddings', 'DELETE') AS embedding`,
    );
    expect(owner.rows[0]).toEqual({ judgment: true, embedding: true });
    for (const role of APP_ROLES) {
      const priv = await admin.query(
        `SELECT has_table_privilege($1, 'public.judgment', 'DELETE') AS judgment,
                has_table_privilege($1, 'public.corpus_embeddings', 'DELETE') AS embedding,
                has_table_privilege($1, 'public.judgment_declassify_grant', 'SELECT') AS grant_select,
                has_table_privilege($1, 'public.judgment_declassify_grant', 'INSERT') AS grant_insert`,
        [role],
      );
      expect(priv.rows[0], role).toEqual({
        judgment: false,
        embedding: false,
        grant_select: false,
        grant_insert: false,
      });
    }
  });

  it("rejects a corpus_writer or app_writer rank drop, allows a raise and a same-rank update, and ignores app.declassify_reason", async () => {
    for (const role of ["corpus_writer", "app_writer"] as const) {
      const id = await judgment("public");
      await withRole(role, async (client) => {
        await insertEmbedding(client, "judgment", id, 3);
        await expectSqlState(
          client.query(`UPDATE corpus_embeddings SET classification_rank = 0 WHERE entity_id = $1`, [id]),
          "P0001",
          DECLASSIFY,
        );
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.declassify_reason', 'partner said so', true)`);
        await expectSqlState(
          client.query(`UPDATE corpus_embeddings SET classification_rank = 0 WHERE entity_id = $1`, [id]),
          "P0001",
          DECLASSIFY,
        );
        await client.query("ROLLBACK");
        await client.query(`UPDATE corpus_embeddings SET classification_rank = 4 WHERE entity_id = $1`, [id]);
        await client.query(`UPDATE corpus_embeddings SET embedding = ${ONE} WHERE entity_id = $1`, [id]);
      });
      expect(await rankOf(id)).toBe(4);
    }
  });

  it("floors a judgment embedding on the source judgment and leaves statute embeddings without that floor", async () => {
    const privileged = await judgment("privileged");
    const missing = randomUUID();
    const unlabeled = await judgment("not-a-label");
    await withRole("corpus_writer", async (client) => {
      await expectSqlState(
        insertEmbedding(client, "judgment", privileged, 0),
        "P0001",
        DECLASSIFY,
      );
      await insertEmbedding(client, "judgment", privileged, 3);
      await expectSqlState(
        insertEmbedding(client, "judgment", missing, 0),
        "P0001",
        /source judgment missing/,
      );
      await expectSqlState(
        insertEmbedding(client, "judgment", unlabeled, 0),
        "P0001",
        /Unknown classification on source judgment/,
      );
      await expectSqlState(
        insertEmbedding(client, "judgment", privileged, 9),
        "P0001",
        /Unknown classification rank 9/,
      );
      const statuteId = randomUUID();
      await insertEmbedding(client, "statute_section_version", statuteId, 0);
      await client.query(
        `UPDATE corpus_embeddings SET classification_rank = 2 WHERE entity_id = $1`,
        [statuteId],
      );
      await expectSqlState(
        client.query(`UPDATE corpus_embeddings SET classification_rank = 0 WHERE entity_id = $1`, [statuteId]),
        "P0001",
        DECLASSIFY,
      );
      await client.query(`UPDATE corpus_embeddings SET model = 'text-embedding-3-large' WHERE entity_id = $1`, [statuteId]);
      const statute = await admin.query(
        `SELECT classification_rank, model FROM corpus_embeddings WHERE entity_id = $1`,
        [statuteId],
      );
      expect(statute.rows[0]).toMatchObject({ classification_rank: 2, model: "text-embedding-3-large" });
    });
    expect(await rankOf(privileged)).toBe(3);
  });

  it("lets the table owner lower an embedding only with a matching grant, and never below the judgment", async () => {
    const pub = await judgment("public");
    await insertEmbedding(admin, "judgment", pub, 3);
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO judgment_declassify_grant (judgment_id, xid, to_classification)
       VALUES ($1, txid_current(), 'public')`,
      [pub],
    );
    await admin.query(`UPDATE corpus_embeddings SET classification_rank = 0 WHERE entity_id = $1`, [pub]);
    const lowered = await admin.query(
      `SELECT classification_rank FROM corpus_embeddings WHERE entity_id = $1`,
      [pub],
    );
    expect(lowered.rows[0].classification_rank).toBe(0);
    await admin.query("ROLLBACK");
    expect(await rankOf(pub)).toBe(3);

    const high = await judgment("privileged");
    await insertEmbedding(admin, "judgment", high, 4);
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO judgment_declassify_grant (judgment_id, xid, to_classification)
       VALUES ($1, txid_current(), 'public')`,
      [high],
    );
    await expectSqlState(
      admin.query(`UPDATE corpus_embeddings SET classification_rank = 0 WHERE entity_id = $1`, [high]),
      "P0001",
      DECLASSIFY,
    );
    await admin.query("ROLLBACK");
    expect(await rankOf(high)).toBe(4);
  });

  it("does not let an app role use a grant row it cannot read", async () => {
    const id = await judgment("public");
    await withRole("corpus_writer", async (client) => {
      await insertEmbedding(client, "judgment", id, 3);
      await client.query("BEGIN");
      const xid = await client.query(`SELECT txid_current() AS xid`);
      await admin.query(
        `INSERT INTO judgment_declassify_grant (judgment_id, xid, to_classification) VALUES ($1, $2, 'public')`,
        [id, xid.rows[0].xid],
      );
      await expectSqlState(
        client.query(`UPDATE corpus_embeddings SET classification_rank = 0 WHERE entity_id = $1`, [id]),
        "P0001",
        DECLASSIFY,
      );
      await client.query("ROLLBACK");
    });
    await admin.query(`DELETE FROM judgment_declassify_grant WHERE judgment_id = $1`, [id]);
    expect(await rankOf(id)).toBe(3);
  });

  it("keeps the embedding rank when declassify() lowers the judgment, and writes the audit row", async () => {
    const id = await judgment("privileged");
    await insertEmbedding(admin, "judgment", id, 3);
    const audit = await admin.query(
      `SELECT public.declassify($1, 'public', 'partner-1', 'partner recorded reason') AS id`,
      [id],
    );
    const judgmentRow = await admin.query(`SELECT classification FROM judgment WHERE id = $1`, [id]);
    const auditRow = await admin.query(
      `SELECT from_classification, to_classification, actor_id, reason
         FROM judgment_classification_declassify_audit WHERE id = $1`,
      [audit.rows[0].id],
    );
    expect(judgmentRow.rows[0].classification).toBe("public");
    expect(auditRow.rows[0]).toMatchObject({
      from_classification: "privileged",
      to_classification: "public",
      actor_id: "partner-1",
      reason: "partner recorded reason",
    });
    expect(await rankOf(id)).toBe(3);
  });

  it("applies 007 twice then 008, keeps the trigger invoker-only, and lists 15 routines including the guard", async () => {
    const sql = fs.readFileSync(path.join(DDL_DIR, "007_classification_coverage.sql"), "utf8");
    const inventory = fs.readFileSync(path.join(DDL_DIR, "008_classification_inventory.sql"), "utf8");
    await admin.query(sql);
    await admin.query(sql);
    await admin.query(inventory);
    await admin.query(inventory);
    const fn = await admin.query(
      `SELECT p.prosecdef, p.proconfig
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'enforce_embedding_classification'`,
    );
    expect(fn.rowCount).toBe(1);
    expect(fn.rows[0].prosecdef).toBe(false);
    expect(fn.rows[0].proconfig).toEqual(["search_path=pg_catalog, public"]);
    const trigger = await admin.query(
      `SELECT t.tgenabled, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'corpus_embeddings'
          AND t.tgname = 'corpus_embeddings_monotonic' AND NOT t.tgisinternal`,
    );
    expect(trigger.rowCount).toBe(1);
    expect(trigger.rows[0].tgenabled).toBe("O");
    expect(trigger.rows[0].def).toMatch(/BEFORE INSERT OR UPDATE/);
    const relations = await admin.query(`SELECT count(*)::int AS n FROM corpus_contract_relations()`);
    const routines = await admin.query(`SELECT count(*)::int AS n FROM corpus_contract_routines()`);
    const listed = await admin.query(
      `SELECT count(*)::int AS n FROM corpus_contract_routines() r
        WHERE r.routine::text LIKE '%enforce_embedding_classification%'`,
    );
    expect(relations.rows[0].n).toBe(37);
    expect(routines.rows[0].n).toBe(15);
    expect(listed.rows[0].n).toBe(1);
    for (const role of ["public", ...APP_ROLES]) {
      const exec = await admin.query(
        `SELECT has_function_privilege($1, 'public.enforce_embedding_classification()', 'EXECUTE') AS ok`,
        [role],
      );
      expect(exec.rows[0].ok, role).toBe(false);
    }
    await withRole("corpus_writer", async (client) => {
      await expectSqlState(client.query(`SELECT public.enforce_embedding_classification()`), "42501");
    });
  });
});
