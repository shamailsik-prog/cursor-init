/**
 * FA-CI-002 / FA-DATA-001: Annex A + platform DDL on real Postgres (pgvector).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const postgresUrl = process.env.SIKANDER_POSTGRES_URL;
const ON_CI = Boolean(process.env.CI) && !/^(false|0)$/i.test(process.env.CI ?? "");

if (ON_CI && !postgresUrl) {
  throw new Error(
    "Postgres DDL integration tests require SIKANDER_POSTGRES_URL in CI " +
      "(run them through the Gate G-0 postgres-ddl job)",
  );
}

const suite = postgresUrl ? describe : describe.skip;

const JUDGMENT_ID = "00000000-0000-0000-0000-0000000000fa";
const PROMOTED_VIEW_ID = "00000000-0000-0000-0000-0000000000fb";
const QUARANTINED_VIEW_ID = "00000000-0000-0000-0000-0000000000fc";
const DECLASSIFY_ID = "00000000-0000-0000-0000-0000000000fd";
const DECLASSIFY_ID_B = "00000000-0000-0000-0000-0000000000ff";
const DECLASSIFY_CONCURRENCY_ID = "00000000-0000-0000-0000-000000000100";

function roleClient(role: string, password: string): pg.Client {
  const url = new URL(postgresUrl!);
  url.username = role;
  url.password = password;
  return new pg.Client({ connectionString: url.toString() });
}

suite("Postgres DDL integration (FA-CI-002 / FA-DATA-001)", () => {
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
    const ddlDir = path.join(process.cwd(), "postgres", "ddl");
    const corpus = fs.readFileSync(path.join(ddlDir, "001_corpus_contract.sql"), "utf8");
    const platform = fs.readFileSync(path.join(ddlDir, "002_platform.sql"), "utf8");
    await admin.query(corpus);
    await admin.query(platform);
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
       END $$;`,
    );
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON judgment TO app_writer;
       GRANT SELECT ON classification_rank TO app_writer;
       REVOKE ALL ON judgment_declassify_grant FROM app_writer;
       REVOKE ALL ON FUNCTION declassify(UUID, TEXT, TEXT, TEXT) FROM app_writer;
       REVOKE INSERT, UPDATE, DELETE ON judgment_classification_declassify_audit FROM app_writer;`,
    );
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
  });

  it("PG-DDL-1 applies pgvector extension and judgment table", async () => {
    const ext = await admin.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector'",
    );
    expect(ext.rowCount).toBe(1);
    const cols = await admin.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'judgment'`,
    );
    expect(cols.rows.map((r) => r.column_name)).toContain("classification");
  });

  it("PG-DDL-2 rejects downgrade, leaves row unchanged, and allows upgrade", async () => {
    await admin.query("DELETE FROM judgment WHERE id = $1", [JUDGMENT_ID]);
    await admin.query(
      `INSERT INTO judgment (id, case_title, classification, review_status)
       VALUES ($1, 'FA-CI-002 probe', 'privileged', 'promoted')`,
      [JUDGMENT_ID],
    );
    const writer = roleClient("app_writer", "writer");
    await writer.connect();
    await expect(
      writer.query(
        `UPDATE judgment SET classification = 'public' WHERE id = $1`,
        [JUDGMENT_ID],
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/declassify/i),
    });
    const afterReject = await admin.query(
      "SELECT classification FROM judgment WHERE id = $1",
      [JUDGMENT_ID],
    );
    expect(afterReject.rows[0].classification).toBe("privileged");

    await writer.query(
      `UPDATE judgment SET classification = 'privileged-restricted' WHERE id = $1`,
      [JUDGMENT_ID],
    );
    const afterUpgrade = await admin.query(
      "SELECT classification FROM judgment WHERE id = $1",
      [JUDGMENT_ID],
    );
    expect(afterUpgrade.rows[0].classification).toBe("privileged-restricted");
    await writer.end();
  });

  it("PG-DDL-3 v_judgment is promoted-only; corpus_reader cannot read base table", async () => {
    await admin.query("DELETE FROM judgment WHERE id IN ($1, $2)", [
      PROMOTED_VIEW_ID,
      QUARANTINED_VIEW_ID,
    ]);
    await admin.query(
      `INSERT INTO judgment (id, case_title, classification, review_status)
       VALUES ($1, 'promoted row', 'public', 'promoted'),
              ($2, 'quarantined row', 'public', 'quarantined')`,
      [PROMOTED_VIEW_ID, QUARANTINED_VIEW_ID],
    );

    const reader = roleClient("corpus_reader", "reader");
    await reader.connect();
    const visible = await reader.query(
      "SELECT id FROM v_judgment WHERE id IN ($1, $2) ORDER BY id",
      [PROMOTED_VIEW_ID, QUARANTINED_VIEW_ID],
    );
    expect(visible.rows.map((r) => r.id)).toEqual([PROMOTED_VIEW_ID]);

    await expect(
      reader.query("SELECT id FROM judgment WHERE id = $1 LIMIT 1", [
        PROMOTED_VIEW_ID,
      ]),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      reader.query(
        `INSERT INTO judgment (id, case_title, classification)
         VALUES ('00000000-0000-0000-0000-000000000099', 'x', 'public')`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await reader.end();
  });

  it("PG-DDL-4 platform feature_flags seed is present", async () => {
    const flags = await admin.query(
      "SELECT COUNT(*)::int AS n FROM feature_flags",
    );
    expect(flags.rows[0].n).toBeGreaterThan(5);
  });

  it("PG-DDL-5 FA-DATA-001: SET app.declassify_reason cannot bypass downgrade", async () => {
    const rowId = DECLASSIFY_ID;
    await admin.query("DELETE FROM judgment WHERE id = $1", [rowId]);
    await admin.query(
      `INSERT INTO judgment (id, case_title, classification, review_status)
       VALUES ($1, 'FA-DATA-001 probe', 'privileged', 'promoted')`,
      [rowId],
    );
    const writer = roleClient("app_writer", "writer");
    await writer.connect();
    await writer.query("SET app.declassify_reason = 'partner-audit-probe'");
    await expect(
      writer.query(
        `UPDATE judgment SET classification = 'public' WHERE id = $1`,
        [rowId],
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/declassify/i),
    });
    const row = await admin.query(
      "SELECT classification FROM judgment WHERE id = $1",
      [rowId],
    );
    expect(row.rows[0].classification).toBe("privileged");
    await writer.end();
  });

  it("PG-DDL-6 declassify() downgrades, writes audit row, and requires a reason", async () => {
    const rowId = "00000000-0000-0000-0000-0000000000fe";
    await admin.query("DELETE FROM judgment_classification_declassify_audit WHERE judgment_id = $1", [
      rowId,
    ]);
    await admin.query("DELETE FROM judgment WHERE id = $1", [rowId]);
    await admin.query(
      `INSERT INTO judgment (id, case_title, classification, review_status)
       VALUES ($1, 'declassify path', 'privileged', 'promoted')`,
      [rowId],
    );
    const partner = roleClient("corpus_declassify", "declass");
    await partner.connect();
    await expect(
      partner.query(
        `SELECT declassify($1::uuid, 'public', 'partner-1', '   ')`,
        [rowId],
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/recorded reason/i),
    });
    const auditId = await partner.query(
      `SELECT declassify($1::uuid, 'public', 'partner-1', 'Client waived for filing') AS audit_id`,
      [rowId],
    );
    expect(auditId.rows[0].audit_id).toBeTruthy();
    const row = await admin.query(
      "SELECT classification FROM judgment WHERE id = $1",
      [rowId],
    );
    expect(row.rows[0].classification).toBe("public");
    const audit = await admin.query(
      `SELECT from_classification, to_classification, actor_id, declassify_session_user, reason
       FROM judgment_classification_declassify_audit WHERE id = $1`,
      [auditId.rows[0].audit_id],
    );
    expect(audit.rows[0]).toMatchObject({
      from_classification: "privileged",
      to_classification: "public",
      actor_id: "partner-1",
      declassify_session_user: "corpus_declassify",
      reason: "Client waived for filing",
    });
    const actorComment = await admin.query(
      `SELECT pg_catalog.obj_description(
         (SELECT attrelid FROM pg_catalog.pg_attribute
          WHERE attrelid = 'public.judgment_classification_declassify_audit'::regclass
            AND attname = 'actor_id' AND NOT attisdropped),
         (SELECT attnum FROM pg_catalog.pg_attribute
          WHERE attrelid = 'public.judgment_classification_declassify_audit'::regclass
            AND attname = 'actor_id' AND NOT attisdropped)
       ) AS comment`,
    );
    expect(actorComment.rows[0].comment).toMatch(/application-asserted/i);
    await partner.end();
  });

  it("PG-DDL-7 corpus_reader cannot execute declassify()", async () => {
    const reader = roleClient("corpus_reader", "reader");
    await reader.connect();
    await expect(
      reader.query(
        `SELECT declassify($1::uuid, 'public', 'partner-1', 'reason')`,
        [DECLASSIFY_ID],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await reader.end();
  });

  it("PG-DDL-8 FA-DATA-001: declassify execute and audit table writes denied", async () => {
    const writer = roleClient("app_writer", "writer");
    await writer.connect();
    await expect(
      writer.query(
        `SELECT declassify($1::uuid, 'public', 'partner-1', 'reason')`,
        [DECLASSIFY_ID],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const publicExec = await admin.query(
      `SELECT has_function_privilege('public', 'declassify(uuid,text,text,text)', 'EXECUTE') AS ok`,
    );
    expect(publicExec.rows[0].ok).toBe(false);

    const partner = roleClient("corpus_declassify", "declass");
    await partner.connect();
    for (const sql of [
      `INSERT INTO judgment_classification_declassify_audit
         (judgment_id, from_classification, to_classification, actor_id, declassify_session_user, reason)
         VALUES ($1, 'privileged', 'public', 'x', 'x', 'x')`,
      `UPDATE judgment_classification_declassify_audit SET reason = 'y' WHERE judgment_id = $1`,
      `DELETE FROM judgment_classification_declassify_audit WHERE judgment_id = $1`,
    ]) {
      await expect(partner.query(sql, [DECLASSIFY_ID])).rejects.toMatchObject({
        code: "42501",
      });
    }
    for (const sql of [
      `INSERT INTO judgment_classification_declassify_audit
         (judgment_id, from_classification, to_classification, actor_id, declassify_session_user, reason)
         VALUES ($1, 'privileged', 'public', 'x', 'x', 'x')`,
      `UPDATE judgment_classification_declassify_audit SET reason = 'y' WHERE judgment_id = $1`,
      `DELETE FROM judgment_classification_declassify_audit WHERE judgment_id = $1`,
    ]) {
      await expect(writer.query(sql, [DECLASSIFY_ID])).rejects.toMatchObject({
        code: "42501",
      });
    }
    await writer.end();
    await partner.end();
  });

  it("PG-DDL-9 FA-DATA-001: trigger stays enabled; grant scope; downgrade-only", async () => {
    await admin.query(
      "DELETE FROM judgment_classification_declassify_audit WHERE judgment_id IN ($1, $2)",
      [DECLASSIFY_ID, DECLASSIFY_ID_B],
    );
    await admin.query("DELETE FROM judgment WHERE id IN ($1, $2)", [
      DECLASSIFY_ID,
      DECLASSIFY_ID_B,
    ]);
    await admin.query(
      `INSERT INTO judgment (id, case_title, classification, review_status)
       VALUES ($1, 'grant-a', 'privileged', 'promoted'),
              ($2, 'grant-b', 'privileged', 'promoted')`,
      [DECLASSIFY_ID, DECLASSIFY_ID_B],
    );

    const partner = roleClient("corpus_declassify", "declass");
    await partner.connect();
    await partner.query(
      `SELECT declassify($1::uuid, 'public', 'partner-1', 'ok')`,
      [DECLASSIFY_ID],
    );
    const trig = await admin.query(
      `SELECT tgenabled FROM pg_trigger
       WHERE tgname = 'judgment_monotonic' AND tgrelid = 'public.judgment'::regclass`,
    );
    expect(trig.rows[0].tgenabled).toBe("O");

    const grantsLeft = await admin.query(
      "SELECT count(*)::int AS n FROM judgment_declassify_grant",
    );
    expect(grantsLeft.rows[0].n).toBe(0);

    await expect(
      partner.query(
        `SELECT declassify($1::uuid, 'privileged-restricted', 'partner-1', 'upgrade attempt')`,
        [DECLASSIFY_ID_B],
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/downgrades only/i) });

    await admin.query(
      "UPDATE judgment SET classification = 'internal' WHERE id = $1",
      [DECLASSIFY_ID_B],
    );
    await expect(
      partner.query(
        `SELECT declassify($1::uuid, 'internal', 'partner-1', 'same rank')`,
        [DECLASSIFY_ID_B],
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/downgrades only/i) });

    await admin.query("BEGIN");
    const xidRow = await admin.query("SELECT txid_current()::text AS xid");
    const xid = xidRow.rows[0].xid;
    await admin.query(
      `INSERT INTO judgment_declassify_grant (judgment_id, xid, to_classification)
       VALUES ($1, $2::bigint, 'public')`,
      [DECLASSIFY_ID, xid],
    );
    await expect(
      admin.query(
        `UPDATE judgment SET classification = 'public' WHERE id = $1`,
        [DECLASSIFY_ID_B],
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/declassify/i) });
    await admin.query("ROLLBACK");

    const stale = await admin.query(
      "SELECT count(*)::int AS n FROM judgment_declassify_grant",
    );
    expect(stale.rows[0].n).toBe(0);

    await partner.end();
  });

  it("PG-DDL-10 FA-DATA-001: declassify row lock does not block v_judgment reads", async () => {
    await admin.query("DELETE FROM judgment WHERE id = $1", [
      DECLASSIFY_CONCURRENCY_ID,
    ]);
    await admin.query(
      `INSERT INTO judgment (id, case_title, classification, review_status)
       VALUES ($1, 'concurrency', 'privileged', 'promoted')`,
      [DECLASSIFY_CONCURRENCY_ID],
    );

    const partner = roleClient("corpus_declassify", "declass");
    await partner.connect();
    await partner.query("BEGIN");
    await partner.query(
      `SELECT declassify($1::uuid, 'public', 'partner-1', 'hold row lock')`,
      [DECLASSIFY_CONCURRENCY_ID],
    );

    const reader = roleClient("corpus_reader", "reader");
    await reader.connect();
    const started = Date.now();
    await reader.query("SET lock_timeout = '2s'");
    const visible = await reader.query(
      "SELECT count(*)::int AS n FROM v_judgment WHERE review_status = 'promoted'",
    );
    expect(visible.rows[0].n).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1500);

    await partner.query("COMMIT");
    await reader.end();
    await partner.end();
  });
});
