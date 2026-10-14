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
       GRANT SELECT ON classification_rank TO app_writer;`,
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
      `SELECT from_classification, to_classification, actor_id, reason
       FROM judgment_classification_declassify_audit WHERE id = $1`,
      [auditId.rows[0].audit_id],
    );
    expect(audit.rows[0]).toMatchObject({
      from_classification: "privileged",
      to_classification: "public",
      actor_id: "partner-1",
      reason: "Client waived for filing",
    });
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
});
