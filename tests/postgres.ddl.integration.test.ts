/**
 * FA-CI-002 / FA-DATA-001: Annex A + platform DDL on real Postgres (pgvector).
 */
import { createHash, randomUUID } from "node:crypto";
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

// ---- F19 (003_corpus_publication.sql) helpers -------------------------------------------------
const DDL_DIR = path.join(process.cwd(), "postgres", "ddl");
const DDL_HEAD = ["001_corpus_contract.sql", "002_platform.sql", "003_corpus_publication.sql"];
const CONTRACT_TABLES = [
  "court", "judge", "instrument", "statute", "statute_section", "statute_section_version",
  "judgment", "citation", "treatment",
];
const ZERO_COUNTS = { items: 0, promoted: 0, quarantined: 0, updated: 0, unchanged: 0, rejected: 0 };

/** Every .sql file in postgres/ddl, in byte order; 001, 002 and 003 must come first. */
function ddlFiles(): string[] {
  const files = fs.readdirSync(DDL_DIR).filter((f) => f.endsWith(".sql")).sort();
  if (JSON.stringify(files.slice(0, DDL_HEAD.length)) !== JSON.stringify(DDL_HEAD)) {
    throw new Error(`postgres/ddl must start with ${DDL_HEAD.join(", ")}; found ${files.join(", ")}`);
  }
  return files;
}

const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");
const batchKey = (n: number) => `pgddl-${n}-${randomUUID()}`;

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

// The tables a corpus_publication_item can name (its entity_type CHECK).
const ITEM_TABLES = ["judgment", "citation", "treatment", "statute", "statute_section", "statute_section_version"];

/** One write item (promoted, or quarantined for any other status) for every contract row the
 *  publication stamped, as publish_batch writes them; returns the matching finish() counts. */
async function auditRows(client: pg.Client, publicationId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = { ...ZERO_COUNTS };
  for (const table of ITEM_TABLES) {
    const rows = await client.query(`SELECT id, review_status FROM ${table} WHERE publication_id = $1 ORDER BY id`, [
      publicationId,
    ]);
    for (const row of rows.rows) {
      const promoted = row.review_status === "promoted";
      await client.query(
        `INSERT INTO corpus_publication_item (publication_id, item_key, entity_type, entity_id, decision, reason, content_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [publicationId, `${table}:${row.id}`, table, row.id, promoted ? "promoted" : "quarantined",
          promoted ? null : "pgddl_held", sha(`${table}:${row.id}`)],
      );
      counts.items += 1;
      counts[promoted ? "promoted" : "quarantined"] += 1;
    }
  }
  return counts;
}

/** BEGIN; begin(); body(pid); finish(counts); COMMIT. ROLLBACK and rethrow on any error.
 *  counts "audit-rows" writes an item for every row the body stamped and finishes with those counts. */
async function publishAs(
  client: pg.Client,
  key: string,
  inputSha: string,
  body: (publicationId: string) => Promise<void>,
  counts: Record<string, number> | "audit-rows" = ZERO_COUNTS,
): Promise<{ id: string; seq: string }> {
  await client.query("BEGIN");
  try {
    const begun = await client.query(
      "SELECT publication_id, already FROM corpus_publication_begin($1, $2, 'curated', 'pgddl-actor')",
      [key, inputSha],
    );
    const id: string = begun.rows[0].publication_id;
    await body(id);
    const finalCounts = counts === "audit-rows" ? await auditRows(client, id) : counts;
    const finished = await client.query(
      "SELECT corpus_publication_finish($1::uuid, $2::jsonb)::text AS seq",
      [id, JSON.stringify(finalCounts)],
    );
    await client.query("COMMIT");
    return { id, seq: finished.rows[0].seq };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Run one statement inside its own savepoint, so a failure leaves the transaction usable. */
async function inSavepoint(client: pg.Client, sql: string, params: unknown[] = []): Promise<void> {
  await client.query("SAVEPOINT pgddl_case");
  try {
    await client.query(sql, params);
    await client.query("RELEASE SAVEPOINT pgddl_case");
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT pgddl_case");
    throw e;
  }
}

/** A source_provenance row (complete unless overridden); returns its id. */
async function insertProvenance(client: pg.Client, overrides: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    source_name: "pgddl-f19-source",
    source_url: "https://f19.example.invalid/pgddl",
    fetched_at: "2099-01-01T00:00:00Z",
    content_hash: "c".repeat(64),
    extraction_method: "manual",
    extractor_version: "pgddl-f19",
    raw_storage_key: null,
    ...overrides,
  };
  const id = randomUUID();
  await client.query(
    `INSERT INTO source_provenance
       (id, source_name, source_url, fetched_at, content_hash, extraction_method, extractor_version, raw_storage_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, row.source_name, row.source_url, row.fetched_at, row.content_hash, row.extraction_method,
      row.extractor_version, row.raw_storage_key],
  );
  return id;
}

const INSERT_JUDGMENT = `INSERT INTO judgment (id, case_title, bench_type, source_id, review_status, publication_id)
  VALUES ($1, $2, $3, $4, $5, $6)`;
const INSERT_CITATION = `INSERT INTO citation (id, judgment_id, citation_text, source_id, review_status, publication_id)
  VALUES ($1, $2, $3, $4, $5, $6)`;

// ---- F19 fix round 1 (re-audit D1-D4) ----------------------------------------------------------
// The re-auditor's actor: a login role that reaches corpus_writer by SET ROLE only (INHERIT FALSE),
// as PR 2b provisions the runtime role. Its password is generated for this run and never stored.
const R1_ROLE = "pgddl_r1_publisher";
let r1Password: string | null = null;

async function r1Writer(adminClient: pg.Client): Promise<pg.Client> {
  if (r1Password === null) {
    const password = randomUUID();
    await adminClient.query(`DO $$ BEGIN CREATE ROLE ${R1_ROLE}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await adminClient.query(`ALTER ROLE ${R1_ROLE} LOGIN NOSUPERUSER PASSWORD '${password}'`);
    await adminClient.query(`GRANT corpus_writer TO ${R1_ROLE} WITH INHERIT FALSE, SET TRUE`);
    r1Password = password;
  }
  const client = roleClient(R1_ROLE, r1Password);
  await client.connect();
  await client.query("SET ROLE corpus_writer");
  return client;
}

/** corpus_publication_begin() in the caller's open transaction; returns the publication id. */
async function beginPublication(client: pg.Client, n: number): Promise<string> {
  const begun = await client.query(
    "SELECT publication_id FROM corpus_publication_begin($1, $2, 'curated', 'pgddl-actor')",
    [batchKey(n), sha(`${n}-${randomUUID()}`)],
  );
  return begun.rows[0].publication_id;
}

async function countOf(client: pg.Client, sql: string, params: unknown[] = []): Promise<number> {
  return (await client.query(sql, params)).rows[0].n;
}

suite("Postgres DDL integration (FA-CI-002 / FA-DATA-001)", () => {
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
    // Every postgres/ddl/*.sql in order (F19 adds 003; PR 3's 004 is picked up automatically).
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
      `SELECT d.description AS comment
       FROM pg_catalog.pg_description d
       JOIN pg_catalog.pg_class c ON c.oid = d.objoid
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
       WHERE c.relname = 'judgment_classification_declassify_audit'
         AND a.attname = 'actor_id'`,
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
      `SELECT count(*)::int AS n
       FROM pg_catalog.aclexplode(
         (SELECT proacl FROM pg_catalog.pg_proc WHERE proname = 'declassify' LIMIT 1)
       ) acl
       WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'`,
    );
    expect(publicExec.rows[0].n).toBe(0);

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
    ).rejects.toMatchObject({
      message: expect.stringMatching(/applies only to downgrades/i),
    });

    const sameRankId = "00000000-0000-0000-0000-000000000101";
    await admin.query("DELETE FROM judgment WHERE id = $1", [sameRankId]);
    await admin.query(
      `INSERT INTO judgment (id, case_title, classification, review_status)
       VALUES ($1, 'same-rank', 'internal', 'promoted')`,
      [sameRankId],
    );
    await expect(
      partner.query(
        `SELECT declassify($1::uuid, 'internal', 'partner-1', 'same rank')`,
        [sameRankId],
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/applies only to downgrades/i),
    });

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

  // ---- F19: 003_corpus_publication.sql ---------------------------------------------------------
  // Audit rows cannot be deleted (append-only), so every case uses fresh UUIDs and batch keys.

  it("PG-DDL-11 003: corpus_writer and app_writer cannot promote outside a publication", async () => {
    const writer = roleClient("corpus_writer", "writer");
    await writer.connect();
    try {
      const prov = await insertProvenance(writer);
      await expectSqlState(
        writer.query(INSERT_JUDGMENT, [randomUUID(), "F19 PG-DDL-11 2099", "division", prov, "promoted", null]),
        "SKP02",
        /publication_required/,
      );
      const quarantined = randomUUID();
      await writer.query(INSERT_JUDGMENT, [quarantined, "F19 PG-DDL-11 q 2099", "division", prov, "quarantined", null]);
      await expectSqlState(
        writer.query("UPDATE judgment SET review_status = 'promoted' WHERE id = $1", [quarantined]),
        "SKP02",
        /publication_required/,
      );
      await expectSqlState(
        writer.query("INSERT INTO corpus_publication_grant (xid, publication_id) VALUES (txid_current(), $1)", [randomUUID()]),
        "42501",
      );
      // A grant is scoped to its own publication: a row carrying another publication's id fails.
      const other = await publishAs(writer, batchKey(11), sha(`11b-${randomUUID()}`), async () => {});
      await writer.query("BEGIN");
      try {
        await writer.query("SELECT * FROM corpus_publication_begin($1, $2, 'curated', 'pgddl-actor')", [
          batchKey(11),
          sha(`11a-${randomUUID()}`),
        ]);
        await expectSqlState(
          writer.query(INSERT_JUDGMENT, [randomUUID(), "F19 PG-DDL-11 b 2099", "division", prov, "promoted", other.id]),
          "SKP02",
          /publication_required/,
        );
      } finally {
        await writer.query("ROLLBACK");
      }
    } finally {
      await writer.end();
    }

    const seeded = randomUUID();
    await admin.query(INSERT_JUDGMENT, [seeded, "F19 PG-DDL-11 seeded 2099", "division", null, "promoted", null]);
    const app = roleClient("app_writer", "writer");
    await app.connect();
    try {
      await expectSqlState(
        app.query("UPDATE judgment SET case_title = 'F19 rewritten 2099' WHERE id = $1", [seeded]),
        "SKP02",
        /publication_required/,
      );
      await expectSqlState(
        app.query(INSERT_JUDGMENT, [randomUUID(), "F19 PG-DDL-11 app 2099", "division", null, "promoted", null]),
        "SKP02",
      );
      await expectSqlState(
        app.query("SELECT corpus_publication_begin($1, $2, 'curated', 'x')", [batchKey(11), sha("11c")]),
        "42501",
      );
      await expectSqlState(
        app.query("INSERT INTO corpus_publication_grant (xid, publication_id) VALUES (txid_current(), $1)", [randomUUID()]),
        "42501",
      );
    } finally {
      await app.end();
    }
    const unchanged = await admin.query("SELECT case_title FROM judgment WHERE id = $1", [seeded]);
    expect(unchanged.rows[0].case_title).toBe("F19 PG-DDL-11 seeded 2099");
  });

  it("PG-DDL-12 003: a promoted row needs complete provenance, a bench, a valid treatment and a valid version history", async () => {
    const writer = roleClient("corpus_writer", "writer");
    await writer.connect();
    try {
      await publishAs(writer, batchKey(12), sha(`12-${randomUUID()}`), async (pid) => {
        const ok = await insertProvenance(writer);
        const judgment = (title: string, bench: string | null, source: string | null) =>
          inSavepoint(writer, INSERT_JUDGMENT, [randomUUID(), title, bench, source, "promoted", pid]);
        // provenance
        await expectSqlState(judgment("F19 no source 2099", "division", null), "SKP03", /provenance_incomplete/);
        const noHash = await insertProvenance(writer, { content_hash: null });
        await expectSqlState(judgment("F19 no hash 2099", "division", noHash), "SKP03", /provenance_incomplete/);
        const noLocation = await insertProvenance(writer, { source_url: null, raw_storage_key: null });
        await expectSqlState(judgment("F19 no location 2099", "division", noLocation), "SKP03", /provenance_incomplete/);
        const keyOnly = await insertProvenance(writer, { source_url: null, raw_storage_key: "raw/pgddl/f19-2099.pdf" });
        await judgment("F19 storage key only 2099", "division", keyOnly);
        // bench (B-10, ruling 9)
        await expectSqlState(judgment("F19 no bench 2099", null, ok), "SKP04", /bench_required/);
        await expectSqlState(judgment("F19 blank bench 2099", "", ok), "SKP04", /bench_required/);

        // treatments (B-7)
        const treating = randomUUID();
        const treated = randomUUID();
        await inSavepoint(writer, INSERT_JUDGMENT, [treating, "F19 treating 2099", "larger", ok, "promoted", pid]);
        await inSavepoint(writer, INSERT_JUDGMENT, [treated, "F19 treated 2099", "division", ok, "promoted", pid]);
        const treatment = (args: { treated?: string | null; kind?: string; anchor?: string | null; bench?: string; confidence: number }) =>
          inSavepoint(
            writer,
            `INSERT INTO treatment (id, treating_judgment_id, treated_judgment_id, treatment, passage_anchor,
               treating_bench_type, confidence, source_id, review_status, publication_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'promoted', $9)`,
            [randomUUID(), treating, args.treated === undefined ? treated : args.treated, args.kind ?? "overruled",
              args.anchor ?? null, args.bench ?? "larger", args.confidence, ok, pid],
          );
        await expectSqlState(treatment({ confidence: 0.69 }), "SKP05", /treatment_confidence/);
        await treatment({ confidence: 0.7 });
        await expectSqlState(treatment({ treated: null, kind: "followed", confidence: 0.9 }), "SKP05", /treatment_judgment_missing/);
        await expectSqlState(treatment({ treated: randomUUID(), kind: "applied", confidence: 0.9 }), "SKP05", /treatment_judgment_missing/);
        await expectSqlState(treatment({ kind: "doubted", bench: "panel", confidence: 0.9 }), "23514");
        await treatment({ kind: "followed", anchor: null, confidence: 0.9 });
        await expectSqlState(treatment({ kind: "followed", anchor: "", confidence: 0.9 }), "23505");

        // statutes and section versions (Annex A A.4, B-5)
        const statuteSql = `INSERT INTO statute (id, name, jurisdiction, source_id, review_status, publication_id)
          VALUES ($1, $2, $3, $4, 'promoted', $5)`;
        await expectSqlState(inSavepoint(writer, statuteSql, [randomUUID(), `Test Act 2099 ${randomUUID()}`, "PK", ok, pid]), "23514");
        const statute = randomUUID();
        await inSavepoint(writer, statuteSql, [statute, `Test Act 2099 ${randomUUID()}`, "Federal", ok, pid]);
        const section = randomUUID();
        await inSavepoint(
          writer,
          `INSERT INTO statute_section (id, statute_id, section_number, source_id, review_status, publication_id)
           VALUES ($1, $2, '5', $3, 'promoted', $4)`,
          [section, statute, ok, pid],
        );
        const version = (no: number, from: string | null, to: string | null) =>
          inSavepoint(
            writer,
            `INSERT INTO statute_section_version (id, section_id, version_no, effective_from, effective_to, text,
               version_confidence, source_id, review_status, publication_id)
             VALUES ($1, $2, $3, $4, $5, 'Test Act 2099 text', 0.9, $6, 'promoted', $7)`,
            [randomUUID(), section, no, from, to, ok, pid],
          );
        await expectSqlState(version(9, null, "2099-02-01"), "SKP06", /version_effective_from_required/);
        await expectSqlState(version(9, "2099-02-01", "2099-02-01"), "SKP06", /version_range_invalid/);
        await expectSqlState(version(9, "2099-03-01", "2099-02-01"), "SKP06", /version_range_invalid/);
        await version(1, "2099-01-01", "2099-07-01");
        await version(2, "2099-07-01", null); // adjacent ranges do not overlap ([from, to))
        await expectSqlState(version(3, "2099-03-01", "2099-04-01"), "SKP06", /version_overlap/);
        await expectSqlState(version(4, "2099-12-01", null), "SKP06", /version_overlap/);
      }, "audit-rows");
    } finally {
      await writer.end();
    }
  });

  it("PG-DDL-13 003: review_status defaults to quarantined on every contract table", async () => {
    for (const table of CONTRACT_TABLES) {
      const col = await admin.query(
        `SELECT column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'review_status'`,
        [table],
      );
      expect(col.rows[0]?.column_default, table).toMatch(/^'quarantined'/);
    }
    const id = randomUUID();
    const writer = roleClient("corpus_writer", "writer");
    await writer.connect();
    await writer.query("INSERT INTO judgment (id, case_title, bench_type) VALUES ($1, 'F19 PG-DDL-13 2099', 'single')", [id]);
    await writer.end();
    const stored = await admin.query("SELECT review_status FROM judgment WHERE id = $1", [id]);
    expect(stored.rows[0].review_status).toBe("quarantined");
    const reader = roleClient("corpus_reader", "reader");
    await reader.connect();
    const seen = await reader.query("SELECT count(*)::int AS n FROM v_judgment WHERE id = $1", [id]);
    await reader.end();
    expect(seen.rows[0].n).toBe(0);
  });

  it("PG-DDL-14 003: declassify() still downgrades a published judgment; only classification and updated_at bypass the guard", async () => {
    const id = randomUUID();
    const writer = roleClient("corpus_writer", "writer");
    await writer.connect();
    const published = await publishAs(writer, batchKey(14), sha(`14-${id}`), async (pid) => {
      const prov = await insertProvenance(writer);
      await writer.query(
        `INSERT INTO judgment (id, case_title, bench_type, source_id, review_status, classification, publication_id)
         VALUES ($1, 'F19 PG-DDL-14 2099', 'division', $2, 'promoted', 'privileged', $3)`,
        [id, prov, pid],
      );
    }, "audit-rows");
    await writer.end();

    const partner = roleClient("corpus_declassify", "declass");
    await partner.connect();
    const audit = await partner.query(
      "SELECT declassify($1::uuid, 'public', 'partner-1', 'F19 regression: declassify after publication') AS audit_id",
      [id],
    );
    await partner.end();
    expect(audit.rows[0].audit_id).toBeTruthy();
    const row = await admin.query("SELECT classification, publication_id, review_status FROM judgment WHERE id = $1", [id]);
    expect(row.rows[0]).toMatchObject({ classification: "public", publication_id: published.id, review_status: "promoted" });
    const auditRows = await admin.query(
      "SELECT count(*)::int AS n FROM judgment_classification_declassify_audit WHERE judgment_id = $1",
      [id],
    );
    expect(auditRows.rows[0].n).toBe(1);

    const app = roleClient("app_writer", "writer");
    await app.connect();
    try {
      await app.query("UPDATE judgment SET classification = 'internal' WHERE id = $1", [id]);
      await app.query("UPDATE judgment SET updated_at = now() WHERE id = $1", [id]);
      await expectSqlState(app.query("UPDATE judgment SET citation_count = 1 WHERE id = $1", [id]), "SKP02", /publication_required/);
      await expectSqlState(
        app.query("UPDATE judgment SET classification = 'confidential', case_title = 'F19 changed 2099' WHERE id = $1", [id]),
        "SKP02",
      );
    } finally {
      await app.end();
    }
    const after = await admin.query("SELECT classification, citation_count, case_title FROM judgment WHERE id = $1", [id]);
    expect(after.rows[0]).toMatchObject({ classification: "internal", citation_count: 0, case_title: "F19 PG-DDL-14 2099" });
    const trig = await admin.query(
      "SELECT tgenabled FROM pg_trigger WHERE tgname = 'judgment_monotonic' AND tgrelid = 'public.judgment'::regclass",
    );
    expect(trig.rows[0].tgenabled).toBe("O");
  });

  it("PG-DDL-15 003: corpus_publication_begin is idempotent per (batch_key, input_sha256)", async () => {
    const key = batchKey(15);
    const h1 = sha(`15-${key}`);
    const writer = roleClient("corpus_writer", "writer");
    await writer.connect();
    try {
      const first = await publishAs(writer, key, h1, async () => {});
      const meta = async () =>
        Object.fromEntries(
          (await admin.query("SELECT key, value FROM corpus_metadata WHERE key IN ('publication_contract','publication_seq','last_refresh')"))
            .rows.map((r) => [r.key, r.value]),
        );
      const before = await meta();
      expect(before.publication_contract).toBe("1");
      expect(before.publication_seq).toBe(first.seq);
      expect(before.last_refresh).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

      await writer.query("BEGIN");
      const again = await writer.query(
        "SELECT publication_id, already FROM corpus_publication_begin($1, $2, 'curated', 'pgddl-actor')",
        [key, h1],
      );
      await writer.query("COMMIT");
      expect(again.rows[0]).toEqual({ publication_id: first.id, already: true });
      const rows = await admin.query("SELECT count(*)::int AS n FROM corpus_publication WHERE batch_key = $1", [key]);
      expect(rows.rows[0].n).toBe(1);
      expect(await meta()).toEqual(before); // a no-op is not a refresh (D30)

      await writer.query("BEGIN");
      try {
        await writer.query("SELECT * FROM corpus_publication_begin($1, $2, 'curated', 'pgddl-actor')", [batchKey(15), sha("15b")]);
        await expectSqlState(
          writer.query("SELECT * FROM corpus_publication_begin($1, $2, 'curated', 'pgddl-actor')", [batchKey(15), sha("15c")]),
          "SKP08",
          /publication_already_open/,
        );
      } finally {
        await writer.query("ROLLBACK");
      }
      await writer.query("BEGIN");
      try {
        const open = await writer.query(
          "SELECT publication_id FROM corpus_publication_begin($1, $2, 'curated', 'pgddl-actor')",
          [batchKey(15), sha("15d")],
        );
        await expectSqlState(
          writer.query("SELECT corpus_publication_finish($1::uuid, $2::jsonb)", [
            open.rows[0].publication_id,
            JSON.stringify({ ...ZERO_COUNTS, items: 1, promoted: 1 }),
          ]),
          "SKP10",
          /publication_counts_mismatch/,
        );
      } finally {
        await writer.query("ROLLBACK");
      }
      for (const bad of [["/x", h1], [batchKey(15), "not-a-sha"]]) {
        await writer.query("BEGIN");
        await expectSqlState(
          writer.query("SELECT * FROM corpus_publication_begin($1, $2, 'curated', 'pgddl-actor')", bad),
          "SKP09",
          /publication_invalid_argument/,
        );
        await writer.query("ROLLBACK");
      }
      await writer.query("BEGIN");
      await expectSqlState(
        writer.query("SELECT corpus_publication_finish($1::uuid, $2::jsonb)", [first.id, JSON.stringify(ZERO_COUNTS)]),
        "SKP08",
        /publication_not_open/,
      );
      await writer.query("ROLLBACK");
    } finally {
      await writer.end();
    }
    const grants = await admin.query("SELECT count(*)::int AS n FROM corpus_publication_grant");
    expect(grants.rows[0].n).toBe(0);
  });

  it("PG-DDL-16 003: a reused batch key with different content is refused (batch_key_reused)", async () => {
    const key = batchKey(16);
    const h1 = sha(`16a-${key}`);
    const writer = roleClient("corpus_writer", "writer");
    await writer.connect();
    try {
      await publishAs(writer, key, h1, async () => {});
      await writer.query("BEGIN");
      await expectSqlState(
        writer.query("SELECT * FROM corpus_publication_begin($1, $2, 'curated', 'pgddl-actor')", [key, sha(`16b-${key}`)]),
        "SKP01",
        /batch_key_reused/,
      );
      await writer.query("ROLLBACK");
    } finally {
      await writer.end();
    }
    const rows = await admin.query("SELECT input_sha256 FROM corpus_publication WHERE batch_key = $1", [key]);
    expect(rows.rows).toEqual([{ input_sha256: h1 }]);
  });

  it("PG-DDL-17 003: publication audit tables are append-only", async () => {
    const writer = roleClient("corpus_writer", "writer");
    await writer.connect();
    let pubId = "";
    try {
      const pub = await publishAs(
        writer,
        batchKey(17),
        sha(`17-${randomUUID()}`),
        async (pid) => {
          // The item names a row this publication wrote (fix round 1, D2: finish() checks coverage).
          const entity = randomUUID();
          await writer.query(INSERT_JUDGMENT, [entity, "F19 PG-DDL-17 2099", null, null, "quarantined", pid]);
          await writer.query(
            `INSERT INTO corpus_publication_item (publication_id, item_key, entity_type, entity_id, decision, reason, content_sha256)
             VALUES ($1, 'pgddl-17', 'judgment', $2, 'quarantined', 'missing_bench', $3)`,
            [pid, entity, sha("17-item")],
          );
        },
        { ...ZERO_COUNTS, items: 1, quarantined: 1 },
      );
      pubId = pub.id;
      for (const sql of [
        "UPDATE corpus_publication SET actor_id = 'x' WHERE id = $1",
        "DELETE FROM corpus_publication WHERE id = $1",
        "UPDATE corpus_publication_item SET reason = 'x' WHERE publication_id = $1",
        "DELETE FROM corpus_publication_item WHERE publication_id = $1",
      ]) {
        await expectSqlState(writer.query(sql, [pub.id]), "42501");
      }
      await expectSqlState(
        writer.query(
          `INSERT INTO corpus_publication (batch_key, input_sha256, source_kind, actor_id, publisher_session_user)
           VALUES ($1, $2, 'curated', 'x', 'x')`,
          [batchKey(17), sha("17b")],
        ),
        "42501",
      );
      await expectSqlState(
        writer.query(
          `INSERT INTO corpus_publication_item (publication_id, item_key, entity_type, entity_id, decision, content_sha256)
           VALUES ($1, 'pgddl-17b', 'judgment', $2, 'promoted', $3)`,
          [pub.id, randomUUID(), sha("17-late")],
        ),
        "SKP02",
        /publication_required/,
      );
    } finally {
      await writer.end();
    }
    await expectSqlState(
      admin.query("UPDATE corpus_publication SET batch_key = batch_key || 'x' WHERE id = $1", [pubId]),
      "SKP11",
      /corpus_audit_append_only/,
    );
    await expectSqlState(admin.query("DELETE FROM corpus_publication WHERE id = $1", [pubId]), "SKP11");
    await expectSqlState(admin.query("DELETE FROM corpus_publication_item WHERE publication_id = $1", [pubId]), "SKP11");
    await expectSqlState(admin.query("UPDATE corpus_publication_item SET reason = 'x' WHERE publication_id = $1", [pubId]), "SKP11");
    await expectSqlState(admin.query("TRUNCATE corpus_publication_item"), "SKP11");
    await expectSqlState(admin.query("TRUNCATE corpus_publication CASCADE"), "SKP11");
    const items = await admin.query("SELECT count(*)::int AS n FROM corpus_publication_item WHERE publication_id = $1", [pubId]);
    expect(items.rows[0].n).toBe(1);

    const execute = await admin.query(
      `SELECT p.proname, coalesce(r.rolname, 'PUBLIC') AS grantee
       FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
       LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
       WHERE p.proname IN ('corpus_publication_begin', 'corpus_publication_finish')
         AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
       ORDER BY 1, 2`,
    );
    expect(execute.rows).toEqual([
      { proname: "corpus_publication_begin", grantee: "corpus_writer" },
      { proname: "corpus_publication_finish", grantee: "corpus_writer" },
    ]);
  });

  it("PG-DDL-18 003: superuser sessions are exempt from the guard (ruling 2) but cannot publish", async () => {
    const id = randomUUID();
    await admin.query(INSERT_JUDGMENT, [id, "F19 PG-DDL-18 superuser seed 2099", null, null, "promoted", null]);
    const row = await admin.query("SELECT review_status, publication_id FROM judgment WHERE id = $1", [id]);
    expect(row.rows[0]).toEqual({ review_status: "promoted", publication_id: null });

    await admin.query("BEGIN");
    try {
      await expectSqlState(
        admin.query("SELECT * FROM corpus_publication_begin($1, $2, 'curated', 'pgddl-admin')", [batchKey(18), sha("18a")]),
        "SKP07",
        /publication_superuser_refused/,
      );
    } finally {
      await admin.query("ROLLBACK");
    }
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE corpus_writer");
      await expectSqlState(
        admin.query("SELECT * FROM corpus_publication_begin($1, $2, 'curated', 'pgddl-admin')", [batchKey(18), sha("18b")]),
        "SKP07",
        /publication_superuser_refused/,
      );
    } finally {
      await admin.query("ROLLBACK");
    }
    const who = await admin.query("SELECT current_user AS u");
    expect(who.rows[0].u).not.toBe("corpus_writer");
  });

  it("PG-DDL-19 003: the DDL chain re-applies cleanly (001, 002, 003, then again)", async () => {
    for (const file of ddlFiles()) {
      await admin.query(fs.readFileSync(path.join(DDL_DIR, file), "utf8"));
    }
    const guards = await admin.query(
      `SELECT c.relname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname LIKE '%\\_publication\\_guard' AND NOT t.tgisinternal ORDER BY 1`,
    );
    expect(guards.rows.map((r) => r.relname)).toEqual([...CONTRACT_TABLES].sort());
    expect(guards.rows.every((r) => r.tgenabled === "O")).toBe(true);
    const checks = await admin.query(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE conname IN ('treatment_treating_bench_type_check', 'statute_jurisdiction_annex_a_check') ORDER BY 1`,
    );
    expect(checks.rows).toEqual([
      { conname: "statute_jurisdiction_annex_a_check", convalidated: true },
      { conname: "treatment_treating_bench_type_check", convalidated: true },
    ]);
    const naturalKey = await admin.query("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'treatment_natural_key'");
    expect(naturalKey.rows[0].n).toBe(1);
    const inventory = await admin.query("SELECT count(*)::int AS n FROM corpus_contract_relations()");
    expect(inventory.rows[0].n).toBe(29);
    const reader = roleClient("corpus_reader", "reader");
    await reader.connect();
    const readable = await reader.query("SELECT count(*)::int AS n FROM v_judgment");
    await reader.end();
    expect(readable.rows[0].n).toBeGreaterThan(0);
  });

  it("PG-DDL-20 003: corpus_reader sees a published judgment and citation through v_judgment and v_citation, and nothing of the audit", async () => {
    const citation = "2099 SCMR 920020";
    await admin.query("DELETE FROM citation WHERE citation_text = $1", [citation]);
    const id = randomUUID();
    const writer = roleClient("corpus_writer", "writer");
    await writer.connect();
    try {
      await publishAs(writer, batchKey(20), sha(`20-${id}`), async (pid) => {
        const prov = await insertProvenance(writer);
        await writer.query(INSERT_JUDGMENT, [id, "F19 PG-DDL-20 2099", "full", prov, "promoted", pid]);
        await writer.query(
          `INSERT INTO citation (judgment_id, citation_text, reporter, year, page, source_id, review_status, publication_id)
           VALUES ($1, $2, 'SCMR', 2099, 920020, $3, 'promoted', $4)`,
          [id, citation, prov, pid],
        );
      }, "audit-rows");
    } finally {
      await writer.end();
    }
    const reader = roleClient("corpus_reader", "reader");
    await reader.connect();
    try {
      const seen = await reader.query(
        `SELECT j.id, j.bench_type, c.citation_text FROM v_judgment j JOIN v_citation c ON c.judgment_id = j.id
         WHERE c.citation_text = $1`,
        [citation],
      );
      expect(seen.rows).toEqual([{ id, bench_type: "full", citation_text: citation }]);
      for (const table of ["corpus_publication", "corpus_publication_item", "corpus_publication_grant"]) {
        await expectSqlState(reader.query(`SELECT 1 FROM ${table} LIMIT 1`), "42501");
      }
    } finally {
      await reader.end();
    }
  });

  // ---- F19 fix round 1: the re-auditor's attacks D1-D4, as a SET ROLE corpus_writer actor ----------
  it("PG-DDL-21 003 R1 (D1): an unfinished publication cannot commit, SET CONSTRAINTS IMMEDIATE fails closed, and no grant outlives its transaction", async () => {
    const writer = await r1Writer(admin);
    const reader = roleClient("corpus_reader", "reader");
    await reader.connect();
    try {
      // The re-auditor's B3: begin(), a promoted judgment and citation, then COMMIT without items or finish().
      const judgmentId = randomUUID();
      const citation = "2099 SCMR 920021";
      await writer.query("BEGIN");
      const pid = await beginPublication(writer, 21);
      const prov = await insertProvenance(writer);
      await writer.query(INSERT_JUDGMENT, [judgmentId, "F19 PG-DDL-21 2099", "single", prov, "promoted", pid]);
      await writer.query(INSERT_CITATION, [randomUUID(), judgmentId, citation, prov, "promoted", pid]);
      await expectSqlState(writer.query("COMMIT"), "SKP12", /publication_not_finished/);
      expect(await countOf(admin, "SELECT count(*)::int AS n FROM judgment WHERE id = $1", [judgmentId])).toBe(0);
      expect(await countOf(admin, "SELECT count(*)::int AS n FROM corpus_publication WHERE id = $1", [pid])).toBe(0);
      expect(await countOf(admin, "SELECT count(*)::int AS n FROM corpus_publication_grant")).toBe(0);
      expect(await countOf(reader, "SELECT count(*)::int AS n FROM v_citation WHERE citation_text = $1", [citation])).toBe(0);

      // begin() and COMMIT with nothing written is refused too: no unfinished publication, no grant row.
      await writer.query("BEGIN");
      const empty = await beginPublication(writer, 21);
      await expectSqlState(writer.query("COMMIT"), "SKP12", /publication_not_finished/);
      expect(await countOf(admin, "SELECT count(*)::int AS n FROM corpus_publication WHERE id = $1", [empty])).toBe(0);
      expect(await countOf(admin, "SELECT count(*)::int AS n FROM corpus_publication_grant")).toBe(0);

      // SET CONSTRAINTS ALL IMMEDIATE runs the commit checks before finish(): begin() itself fails.
      await writer.query("BEGIN");
      try {
        await writer.query("SET CONSTRAINTS ALL IMMEDIATE");
        await expectSqlState(beginPublication(writer, 21), "SKP12", /publication_not_finished/);
      } finally {
        await writer.query("ROLLBACK");
      }
      // The row check alone, made immediate after begin(): the promoted write fails at once.
      await writer.query("BEGIN");
      try {
        const open = await beginPublication(writer, 21);
        const source = await insertProvenance(writer);
        await writer.query("SET CONSTRAINTS judgment_publication_commit_check IMMEDIATE");
        await expectSqlState(
          writer.query(INSERT_JUDGMENT, [randomUUID(), "F19 PG-DDL-21 immediate 2099", "single", source, "promoted", open]),
          "SKP12",
          /publication_not_finished/,
        );
      } finally {
        await writer.query("ROLLBACK");
      }

      // A finished publication commits, also with every check made immediate just before COMMIT.
      const kept = randomUUID();
      await writer.query("BEGIN");
      try {
        const open = await beginPublication(writer, 21);
        const source = await insertProvenance(writer);
        await writer.query(INSERT_JUDGMENT, [kept, "F19 PG-DDL-21 finished 2099", "single", source, "promoted", open]);
        const counts = await auditRows(writer, open);
        await writer.query("SELECT corpus_publication_finish($1::uuid, $2::jsonb)", [open, JSON.stringify(counts)]);
        await writer.query("SET CONSTRAINTS ALL IMMEDIATE");
        await writer.query("COMMIT");
      } catch (e) {
        await writer.query("ROLLBACK");
        throw e;
      }
      expect(await countOf(reader, "SELECT count(*)::int AS n FROM v_judgment WHERE id = $1", [kept])).toBe(1);

      // A grant left behind by a transaction that ended without finish() (possible before fix round 1;
      // simulated by the superuser, who is exempt) is bound to that transaction's xid: a later
      // transaction can neither write under it nor finish it, and the next finish() clears it.
      const leftover: string = (
        await admin.query(
          `INSERT INTO corpus_publication (batch_key, input_sha256, source_kind, actor_id, publisher_session_user)
           VALUES ($1, $2, 'curated', 'pgddl-leftover', 'pgddl') RETURNING id`,
          [batchKey(21), sha(`21-leftover-${randomUUID()}`)],
        )
      ).rows[0].id;
      const pastXid: string = (await admin.query("SELECT txid_current()::text AS x")).rows[0].x;
      await admin.query("INSERT INTO corpus_publication_grant (xid, publication_id) VALUES ($1::bigint, $2)", [pastXid, leftover]);
      await writer.query("BEGIN");
      try {
        const source = await insertProvenance(writer);
        await expectSqlState(
          inSavepoint(writer, INSERT_JUDGMENT, [randomUUID(), "F19 PG-DDL-21 leftover 2099", "single", source, "promoted", leftover]),
          "SKP02",
          /publication_required/,
        );
        await expectSqlState(
          inSavepoint(writer, "SELECT corpus_publication_finish($1::uuid, $2::jsonb)", [leftover, JSON.stringify(ZERO_COUNTS)]),
          "SKP08",
          /publication_not_open/,
        );
      } finally {
        await writer.query("ROLLBACK");
      }
      await publishAs(writer, batchKey(21), sha(`21-clear-${randomUUID()}`), async () => {});
      expect(await countOf(admin, "SELECT count(*)::int AS n FROM corpus_publication_grant")).toBe(0);
    } finally {
      await reader.end();
      await writer.end();
    }
  });

  it("PG-DDL-22 003 R1 (D2): finish() accepts only an audit that covers exactly the rows the publication wrote", async () => {
    const writer = await r1Writer(admin);
    let page = 922000;
    const judgment = async (pid: string, source: string, status = "promoted"): Promise<string> => {
      const id = randomUUID();
      await writer.query(INSERT_JUDGMENT, [id, "F19 PG-DDL-22 2099", "single", source, status, pid]);
      return id;
    };
    const citation = async (pid: string, source: string, judgmentId: string): Promise<string> => {
      const id = randomUUID();
      page += 1;
      await writer.query(INSERT_CITATION, [id, judgmentId, `2099 SCMR ${page}`, source, "promoted", pid]);
      return id;
    };
    const item = (pid: string, type: string, id: string, decision: string) =>
      writer.query(
        `INSERT INTO corpus_publication_item (publication_id, item_key, entity_type, entity_id, decision, reason, content_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [pid, `${type}:${id}`, type, id, decision, decision === "quarantined" ? "pgddl_held" : null, sha(`22-${type}-${id}`)],
      );
    /** One transaction: begin(), body() writes rows and items and returns its counts; finish() must refuse. */
    const refused = async (message: RegExp, body: (pid: string, source: string) => Promise<Record<string, number>>) => {
      await writer.query("BEGIN");
      try {
        const pid = await beginPublication(writer, 22);
        const source = await insertProvenance(writer);
        const counts = await body(pid, source);
        await expectSqlState(
          writer.query("SELECT corpus_publication_finish($1::uuid, $2::jsonb)", [pid, JSON.stringify(counts)]),
          "SKP10",
          message,
        );
      } finally {
        await writer.query("ROLLBACK");
      }
    };
    try {
      // An earlier, properly audited publication: its rows are not a later publication's to claim.
      let earlier = "";
      await publishAs(writer, batchKey(22), sha(`22-earlier-${randomUUID()}`), async (pid) => {
        earlier = await judgment(pid, await insertProvenance(writer));
      }, "audit-rows");

      // The re-auditor's B6: promoted rows, no items, finish() with all-zero counts.
      await refused(/publication_rows_unaudited/, async (pid, source) => {
        await citation(pid, source, await judgment(pid, source));
        return ZERO_COUNTS;
      });
      // The judgment is audited, its citation is not.
      await refused(/publication_rows_unaudited/, async (pid, source) => {
        const j = await judgment(pid, source);
        await citation(pid, source, j);
        await item(pid, "judgment", j, "promoted");
        return { ...ZERO_COUNTS, items: 1, promoted: 1 };
      });
      // A stamped row in a table no item can name.
      await refused(/publication_rows_unaudited/, async (pid, source) => {
        await writer.query(
          "INSERT INTO court (full_name, source_id, review_status, publication_id) VALUES ($1, $2, 'quarantined', $3)",
          [`F19 PG-DDL-22 Test Court 2099 ${randomUUID()}`, source, pid],
        );
        return ZERO_COUNTS;
      });
      // An item claiming a write that did not happen, and one naming another publication's row.
      await refused(/publication_items_unwritten/, async (pid) => {
        await item(pid, "judgment", randomUUID(), "promoted");
        return { ...ZERO_COUNTS, items: 1, promoted: 1 };
      });
      await refused(/publication_items_unwritten/, async (pid) => {
        await item(pid, "judgment", earlier, "updated");
        return { ...ZERO_COUNTS, items: 1, updated: 1 };
      });
      // An item whose decision contradicts the row: promoted recorded as quarantined, and the reverse.
      await refused(/publication_status_mismatch/, async (pid, source) => {
        await item(pid, "judgment", await judgment(pid, source), "quarantined");
        return { ...ZERO_COUNTS, items: 1, quarantined: 1 };
      });
      await refused(/publication_status_mismatch/, async (pid, source) => {
        await item(pid, "judgment", await judgment(pid, source, "quarantined"), "promoted");
        return { ...ZERO_COUNTS, items: 1, promoted: 1 };
      });

      // Exactly audited: accepted. Afterwards no row can be stamped with that publication any more,
      // so what finish() checked stays true.
      const done = await publishAs(writer, batchKey(22), sha(`22-done-${randomUUID()}`), async (pid) => {
        const source = await insertProvenance(writer);
        await citation(pid, source, await judgment(pid, source));
      }, "audit-rows");
      await expectSqlState(
        writer.query(INSERT_JUDGMENT, [randomUUID(), "F19 PG-DDL-22 late 2099", "single", null, "quarantined", done.id]),
        "SKP02",
        /publication_required/,
      );
      const held = randomUUID();
      await writer.query(INSERT_JUDGMENT, [held, "F19 PG-DDL-22 held 2099", "single", null, "quarantined", null]);
      await expectSqlState(
        writer.query("UPDATE judgment SET publication_id = $1 WHERE id = $2", [done.id, held]),
        "SKP02",
        /publication_required/,
      );
      expect(await countOf(admin, "SELECT count(*)::int AS n FROM judgment WHERE publication_id = $1", [done.id])).toBe(1);
    } finally {
      await writer.end();
    }
  });

  it("PG-DDL-23 003 R1 (D3): promoted citations, treatments, sections and versions need promoted parents, and a promoted parent with promoted dependants cannot be demoted", async () => {
    const writer = await r1Writer(admin);
    const treatmentSql = `INSERT INTO treatment (id, treating_judgment_id, treated_judgment_id, treatment, treating_bench_type,
        confidence, source_id, review_status, publication_id)
      VALUES ($1, $2, $3, $4, 'larger', 0.9, $5, $6, $7)`;
    const statuteSql = `INSERT INTO statute (id, name, jurisdiction, source_id, review_status, publication_id)
      VALUES ($1, $2, 'Federal', $3, $4, $5)`;
    const sectionSql = `INSERT INTO statute_section (id, statute_id, section_number, source_id, review_status, publication_id)
      VALUES ($1, $2, $3, $4, $5, $6)`;
    const versionSql = `INSERT INTO statute_section_version (id, section_id, version_no, effective_from, text,
        version_confidence, source_id, review_status, publication_id)
      VALUES ($1, $2, 1, '2099-01-01', 'Test Act 2099 text', 0.9, $3, $4, $5)`;
    try {
      await writer.query("BEGIN");
      try {
        const pid = await beginPublication(writer, 23);
        const prov = await insertProvenance(writer);
        const promoted = randomUUID();
        const other = randomUUID();
        const benchless = randomUUID();
        await writer.query(INSERT_JUDGMENT, [promoted, "F19 PG-DDL-23 promoted 2099", "larger", prov, "promoted", pid]);
        await writer.query(INSERT_JUDGMENT, [other, "F19 PG-DDL-23 other 2099", "division", prov, "promoted", pid]);
        await writer.query(INSERT_JUDGMENT, [benchless, "F19 PG-DDL-23 bench-less 2099", null, prov, "quarantined", pid]);

        // The re-auditor's B7: a promoted citation under the quarantined, bench-less judgment, and a
        // promoted 'overruled' treatment from it against a promoted judgment (and the reverse edge).
        await expectSqlState(
          inSavepoint(writer, INSERT_CITATION, [randomUUID(), benchless, "2099 SCMR 920231", prov, "promoted", pid]),
          "SKP13",
          /parent_not_promoted/,
        );
        await expectSqlState(
          inSavepoint(writer, treatmentSql, [randomUUID(), benchless, promoted, "overruled", prov, "promoted", pid]),
          "SKP05",
          /treatment_judgment_not_promoted/,
        );
        await expectSqlState(
          inSavepoint(writer, treatmentSql, [randomUUID(), promoted, benchless, "followed", prov, "promoted", pid]),
          "SKP05",
          /treatment_judgment_not_promoted/,
        );
        // Held (quarantined), the same rows are accepted; the reader never sees them.
        await inSavepoint(writer, INSERT_CITATION, [randomUUID(), benchless, "2099 SCMR 920232", prov, "quarantined", pid]);
        await inSavepoint(writer, treatmentSql, [randomUUID(), benchless, promoted, "overruled", prov, "quarantined", pid]);
        // Under promoted judgments they may be promoted.
        const goodCitation = randomUUID();
        const goodTreatment = randomUUID();
        await inSavepoint(writer, INSERT_CITATION, [goodCitation, promoted, "2099 SCMR 920233", prov, "promoted", pid]);
        await inSavepoint(writer, treatmentSql, [goodTreatment, other, promoted, "followed", prov, "promoted", pid]);
        // Moving a promoted citation onto the quarantined judgment is refused the same way.
        await expectSqlState(
          inSavepoint(writer, "UPDATE citation SET judgment_id = $1 WHERE id = $2", [benchless, goodCitation]),
          "SKP13",
          /parent_not_promoted/,
        );

        // The reverse path (D9 in the database): a judgment that promoted rows depend on cannot be
        // quarantined or rejected, even inside a publication; once its dependants are held, it can.
        await expectSqlState(
          inSavepoint(writer, "UPDATE judgment SET review_status = 'quarantined' WHERE id = $1", [promoted]),
          "SKP13",
          /promoted_dependants/,
        );
        await expectSqlState(
          inSavepoint(writer, "UPDATE judgment SET review_status = 'rejected' WHERE id = $1", [other]),
          "SKP13",
          /promoted_dependants/,
        );
        await inSavepoint(writer, "UPDATE citation SET review_status = 'quarantined' WHERE id = $1", [goodCitation]);
        await expectSqlState(
          inSavepoint(writer, "UPDATE judgment SET review_status = 'quarantined' WHERE id = $1", [promoted]),
          "SKP13",
          /promoted_dependants/,
        );
        await inSavepoint(writer, "UPDATE treatment SET review_status = 'quarantined' WHERE id = $1", [goodTreatment]);
        await inSavepoint(writer, "UPDATE judgment SET review_status = 'quarantined' WHERE id = $1", [promoted]);
        await inSavepoint(writer, "UPDATE judgment SET review_status = 'rejected' WHERE id = $1", [other]);

        // The statute chain: statute <- section <- version.
        const heldStatute = randomUUID();
        const liveStatute = randomUUID();
        const heldSection = randomUUID();
        const liveSection = randomUUID();
        await inSavepoint(writer, statuteSql, [heldStatute, `Test Act 2099 held ${randomUUID()}`, prov, "quarantined", pid]);
        await inSavepoint(writer, statuteSql, [liveStatute, `Test Act 2099 live ${randomUUID()}`, prov, "promoted", pid]);
        await expectSqlState(
          inSavepoint(writer, sectionSql, [randomUUID(), heldStatute, "1", prov, "promoted", pid]),
          "SKP13",
          /parent_not_promoted/,
        );
        await inSavepoint(writer, sectionSql, [heldSection, liveStatute, "2", prov, "quarantined", pid]);
        await inSavepoint(writer, sectionSql, [liveSection, liveStatute, "3", prov, "promoted", pid]);
        await expectSqlState(
          inSavepoint(writer, versionSql, [randomUUID(), heldSection, prov, "promoted", pid]),
          "SKP13",
          /parent_not_promoted/,
        );
        await inSavepoint(writer, versionSql, [randomUUID(), liveSection, prov, "promoted", pid]);
        await expectSqlState(
          inSavepoint(writer, "UPDATE statute SET review_status = 'quarantined' WHERE id = $1", [liveStatute]),
          "SKP13",
          /promoted_dependants/,
        );
        await expectSqlState(
          inSavepoint(writer, "UPDATE statute_section SET review_status = 'quarantined' WHERE id = $1", [liveSection]),
          "SKP13",
          /promoted_dependants/,
        );
      } finally {
        await writer.query("ROLLBACK");
      }
    } finally {
      await writer.end();
    }
  });

  it("PG-DDL-24 003 R1 (D4): NaN, infinite and out-of-range confidences are refused", async () => {
    const writer = await r1Writer(admin);
    try {
      await writer.query("BEGIN");
      try {
        const pid = await beginPublication(writer, 24);
        const prov = await insertProvenance(writer);
        const treating = randomUUID();
        const treated = randomUUID();
        await writer.query(INSERT_JUDGMENT, [treating, "F19 PG-DDL-24 treating 2099", "larger", prov, "promoted", pid]);
        await writer.query(INSERT_JUDGMENT, [treated, "F19 PG-DDL-24 treated 2099", "division", prov, "promoted", pid]);
        let anchor = 0;
        const treatment = (confidence: string, status: string) => {
          anchor += 1;
          return inSavepoint(
            writer,
            `INSERT INTO treatment (id, treating_judgment_id, treated_judgment_id, treatment, passage_anchor,
               treating_bench_type, confidence, source_id, review_status, publication_id)
             VALUES ($1, $2, $3, 'followed', $4, 'larger', $5::float8, $6, $7, $8)`,
            [randomUUID(), treating, treated, `para ${anchor}`, confidence, prov, status, pid],
          );
        };
        // The re-auditor's B8: NaN sorts above every number in PostgreSQL, so "< 0.7" let it through.
        for (const bad of ["NaN", "Infinity", "-Infinity", "1.5", "-0.1", "0.69"]) {
          await expectSqlState(treatment(bad, "promoted"), "SKP05", /treatment_confidence/);
        }
        await treatment("0.7", "promoted");
        await treatment("1", "promoted");

        // Whatever the status, every Annex A confidence column holds a number in [0, 1].
        const minimal: Array<[string, string, (bad: string) => unknown[]]> = [
          ["court", "INSERT INTO court (full_name, confidence) VALUES ($1, $2::float8)",
            (bad) => [`F19 PG-DDL-24 Test Court 2099 ${randomUUID()}`, bad]],
          ["judge", "INSERT INTO judge (name, confidence) VALUES ('F19 PG-DDL-24 Test Judge 2099', $1::float8)", (bad) => [bad]],
          ["instrument", "INSERT INTO instrument (title, confidence) VALUES ('Test Act 2099 SRO', $1::float8)", (bad) => [bad]],
          ["statute", "INSERT INTO statute (name, jurisdiction, confidence) VALUES ($1, 'Federal', $2::float8)",
            (bad) => [`Test Act 2099 ${randomUUID()}`, bad]],
          ["statute_section", "INSERT INTO statute_section (section_number, confidence) VALUES ('24', $1::float8)", (bad) => [bad]],
          ["statute_section_version", "INSERT INTO statute_section_version (version_no, confidence) VALUES (1, $1::float8)",
            (bad) => [bad]],
          ["statute_section_version", "INSERT INTO statute_section_version (version_no, version_confidence) VALUES (1, $1::float8)",
            (bad) => [bad]],
          ["judgment", "INSERT INTO judgment (case_title, confidence) VALUES ('F19 PG-DDL-24 2099', $1::float8)", (bad) => [bad]],
          ["citation", "INSERT INTO citation (citation_text, confidence) VALUES ($1, $2::float8)",
            (bad) => [`2099 SCMR 924${randomUUID().slice(0, 4)}`, bad]],
        ];
        for (const bad of ["NaN", "Infinity", "-Infinity", "1.0000001", "-0.000001"]) {
          await expectSqlState(treatment(bad, "quarantined"), "23514");
          for (const [table, sql, args] of minimal) {
            await expectSqlState(inSavepoint(writer, sql, args(bad)), "23514", new RegExp(table));
          }
        }
      } finally {
        await writer.query("ROLLBACK");
      }
    } finally {
      await writer.end();
    }
    const checks = await admin.query(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.convalidated AS valid
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'c' AND a.attname IN ('confidence', 'version_confidence')
         AND c.conrelid = ANY ($1::regclass[])`,
      [CONTRACT_TABLES],
    );
    const found = checks.rows.map((r) => `${r.tbl}.${r.col}:${r.valid}`).sort();
    const expected = [...CONTRACT_TABLES.map((t) => `${t}.confidence:true`), "statute_section_version.version_confidence:true"].sort();
    expect(found).toEqual(expected);
  });

  it("PG-DDL-25 003 R1: a publication runs at READ COMMITTED, so the guard's cross-row checks never read a snapshot older than the publication lock", async () => {
    const a = await r1Writer(admin);
    const b = await r1Writer(admin);
    try {
      // A judgment published by an earlier publication.
      const j = randomUUID();
      await publishAs(a, batchKey(25), sha(`25-j-${j}`), async (pid) => {
        await a.query(INSERT_JUDGMENT, [j, "F19 PG-DDL-25 2099", "single", await insertProvenance(a), "promoted", pid]);
      }, "audit-rows");
      // B takes a REPEATABLE READ snapshot; then A's publication demotes the judgment and commits.
      await b.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      try {
        await b.query("SELECT 1");
        await publishAs(a, batchKey(25), sha(`25-demote-${j}`), async (pid) => {
          await a.query("UPDATE judgment SET review_status = 'quarantined', publication_id = $1 WHERE id = $2", [pid, j]);
        }, "audit-rows");
        // B's snapshot still shows the judgment promoted, from before it waited for the publication
        // lock: it may not publish at all (else its guard checks would read that stale state).
        await expectSqlState(beginPublication(b, 25), "SKP08", /publication_isolation_refused/);
      } finally {
        await b.query("ROLLBACK");
      }
      await b.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      try {
        await expectSqlState(beginPublication(b, 25), "SKP08", /publication_isolation_refused/);
      } finally {
        await b.query("ROLLBACK");
      }
      // At READ COMMITTED every statement sees the demotion: a promoted citation under it is refused.
      await b.query("BEGIN");
      try {
        const pid = await beginPublication(b, 25);
        const prov = await insertProvenance(b);
        await expectSqlState(
          b.query(INSERT_CITATION, [randomUUID(), j, "2099 SCMR 920251", prov, "promoted", pid]),
          "SKP13",
          /parent_not_promoted/,
        );
      } finally {
        await b.query("ROLLBACK");
      }
    } finally {
      await a.end();
      await b.end();
    }
  });
});
