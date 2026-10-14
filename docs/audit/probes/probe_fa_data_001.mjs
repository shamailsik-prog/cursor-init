/**
 * FA-DATA-001 runtime probe — classification downgrade bypass and declassify() path.
 * Exit 0 only when plain UPDATE downgrades are blocked, session GUC bypass is blocked,
 * and declassify() exists. Run in CI via `npm run probe:fa-data-001` (requires pgvector).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ddlPath = path.join(repoRoot, "postgres/ddl/001_corpus_contract.sql");
const platformPath = path.join(repoRoot, "postgres/ddl/002_platform.sql");
const url = process.env.SIKANDER_POSTGRES_URL;

if (!url) {
  console.error("SIKANDER_POSTGRES_URL is required");
  process.exit(2);
}

const JUDGMENT_ID = "00000000-0000-0000-0000-000000000001";
const failures = [];

function fail(msg) {
  failures.push(msg);
  console.error("FAIL:", msg);
}

const admin = new pg.Client({ connectionString: url });
await admin.connect();

try {
  const corpus = fs.readFileSync(ddlPath, "utf8");
  const platform = fs.readFileSync(platformPath, "utf8");
  await admin.query(corpus);
  await admin.query(platform);
  await admin.query(
    `DO $$ BEGIN
       CREATE ROLE app_writer LOGIN PASSWORD 'x';
     EXCEPTION WHEN duplicate_object THEN
       ALTER ROLE app_writer LOGIN PASSWORD 'x';
     END $$;
     GRANT SELECT, INSERT, UPDATE ON judgment TO app_writer;
     GRANT SELECT ON classification_rank TO app_writer;
     ALTER ROLE corpus_declassify LOGIN PASSWORD 'declass';`,
  );

  await admin.query("DELETE FROM judgment WHERE id = $1", [JUDGMENT_ID]);
  await admin.query(
    `INSERT INTO judgment (id, case_title, classification, review_status)
     VALUES ($1, 'Probe v State', 'privileged', 'promoted')`,
    [JUDGMENT_ID],
  );

  const writerUrl = new URL(url);
  writerUrl.username = "app_writer";
  writerUrl.password = "x";
  const writer = new pg.Client({ connectionString: writerUrl.toString() });
  await writer.connect();

  try {
    await writer.query(
      `UPDATE judgment SET classification = 'public' WHERE id = $1`,
      [JUDGMENT_ID],
    );
    fail("A plain downgrade by app_writer: ALLOWED (unexpected)");
  } catch (e) {
    console.log("A plain downgrade by app_writer: REJECTED ->", e.message);
  }

  await writer.query("SET app.declassify_reason = 'anything'");
  try {
    await writer.query(
      `UPDATE judgment SET classification = 'public' WHERE id = $1`,
      [JUDGMENT_ID],
    );
    fail("B app_writer after SET app.declassify_reason: DOWNGRADE ALLOWED");
  } catch (e) {
    console.log("B session GUC bypass: REJECTED ->", e.message);
  }

  const row = await admin.query(
    "SELECT classification FROM judgment WHERE id = $1",
    [JUDGMENT_ID],
  );
  console.log("row after bypass attempts:", JSON.stringify(row.rows));

  if (row.rows[0]?.classification !== "privileged") {
    fail(`classification changed to ${row.rows[0]?.classification} (expected privileged)`);
  }

  const proc = await admin.query(
    "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'declassify'",
  );
  console.log("declassify() exists:", proc.rows[0].n);
  if (proc.rows[0].n < 1) {
    fail("declassify() function missing");
  }

  await writer.end();
} finally {
  await admin.end();
}

if (failures.length) {
  console.error("\nProbe FA-DATA-001: FAILED (" + failures.length + " check(s))");
  console.error(
    "Pre-remediation behaviour: step B allowed DOWNGRADE via SET app.declassify_reason.",
  );
  process.exit(1);
}

console.log("\nProbe FA-DATA-001: PASSED (bypass blocked; declassify() present)");
process.exit(0);
