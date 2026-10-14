/**
 * FA-CI-002: apply Annex A + platform DDL against real Postgres (pgvector) and exercise
 * classification trigger and corpus_reader grants. Skipped locally unless SIKANDER_POSTGRES_URL is set.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const postgresUrl = process.env.SIKANDER_POSTGRES_URL;
const suite = postgresUrl ? describe : describe.skip;

const JUDGMENT_ID = "00000000-0000-0000-0000-0000000000fa";

suite("Postgres DDL integration (FA-CI-002)", () => {
  let admin: pg.Client;

  beforeAll(async () => {
    if (!postgresUrl) return;
    admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
    const ddlDir = path.join(process.cwd(), "postgres", "ddl");
    const corpus = fs.readFileSync(path.join(ddlDir, "001_corpus_contract.sql"), "utf8");
    const platform = fs.readFileSync(path.join(ddlDir, "002_platform.sql"), "utf8");
    await admin.query(corpus);
    await admin.query(platform);
    await admin.query(
      `ALTER ROLE corpus_reader LOGIN PASSWORD 'reader';
       ALTER ROLE corpus_writer LOGIN PASSWORD 'writer';`,
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

  it("PG-DDL-2 rejects classification downgrade without declassify path", async () => {
    await admin.query("DELETE FROM judgment WHERE id = $1", [JUDGMENT_ID]);
    await admin.query(
      `INSERT INTO judgment (id, case_title, classification, review_status)
       VALUES ($1, 'FA-CI-002 probe', 'privileged', 'promoted')`,
      [JUDGMENT_ID],
    );
    const writerUrl = new URL(postgresUrl!);
    writerUrl.username = "app_writer";
    writerUrl.password = "writer";
    const writer = new pg.Client({ connectionString: writerUrl.toString() });
    await writer.connect();
    await expect(
      writer.query(
        `UPDATE judgment SET classification = 'public' WHERE id = $1`,
        [JUDGMENT_ID],
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/declassify/i),
    });
    await writer.end();
  });

  it("PG-DDL-3 corpus_reader selects promoted views only and cannot insert into judgment", async () => {
    const readerUrl = new URL(postgresUrl!);
    readerUrl.username = "corpus_reader";
    readerUrl.password = "reader";
    const reader = new pg.Client({ connectionString: readerUrl.toString() });
    await reader.connect();
    const view = await reader.query("SELECT COUNT(*)::int AS n FROM v_judgment");
    expect(view.rows[0].n).toBeGreaterThanOrEqual(0);
    await expect(
      reader.query(
        `INSERT INTO judgment (id, case_title, classification)
         VALUES ('00000000-0000-0000-0000-000000000099', 'x', 'public')`,
      ),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await reader.end();
  });

  it("PG-DDL-4 platform feature_flags seed is present", async () => {
    const flags = await admin.query(
      "SELECT COUNT(*)::int AS n FROM feature_flags",
    );
    expect(flags.rows[0].n).toBeGreaterThan(5);
  });
});
