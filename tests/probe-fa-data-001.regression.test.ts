/**
 * Documents FA-DATA-001 probe behaviour: vulnerable DDL (pre-remediation) fails the probe;
 * current Annex A DDL passes. Runs only when SIKANDER_POSTGRES_URL is set (postgres-ddl CI job).
 */
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const postgresUrl = process.env.SIKANDER_POSTGRES_URL;
const suite = postgresUrl ? describe : describe.skip;

const VULNERABLE_TRIGGER = `
CREATE OR REPLACE FUNCTION enforce_monotonic_classification() RETURNS TRIGGER AS $$
DECLARE old_rank SMALLINT; new_rank SMALLINT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.classification IS DISTINCT FROM OLD.classification THEN
    SELECT rank INTO old_rank FROM classification_rank WHERE label = OLD.classification;
    SELECT rank INTO new_rank FROM classification_rank WHERE label = NEW.classification;
    IF new_rank IS NULL THEN RAISE EXCEPTION 'Unknown classification %', NEW.classification; END IF;
    IF new_rank < old_rank AND current_setting('app.declassify_reason', true) IS NULL THEN
      RAISE EXCEPTION 'Classification downgrade rejected: use declassify() with a partner reason';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
`;

suite("probe FA-DATA-001 regression (before vs after)", () => {
  it("probe passes on remediated DDL", () => {
    const out = execSync("npm run probe:fa-data-001", {
      encoding: "utf8",
      env: { ...process.env, SIKANDER_POSTGRES_URL: postgresUrl },
    });
    expect(out).toMatch(/Probe FA-DATA-001: PASSED/);
  });

  it("probe fails when vulnerable GUC bypass trigger is restored", async () => {
    const pg = await import("pg");
    const admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
    try {
      await admin.query(VULNERABLE_TRIGGER);
      let failed = false;
      try {
        execSync("npm run probe:fa-data-001", {
          encoding: "utf8",
          env: { ...process.env, SIKANDER_POSTGRES_URL: postgresUrl },
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const ddl = fs.readFileSync(
        path.join(process.cwd(), "postgres/ddl/001_corpus_contract.sql"),
        "utf8",
      );
      const match = ddl.match(
        /CREATE OR REPLACE FUNCTION enforce_monotonic_classification\(\)[\s\S]*?END; \$\$ LANGUAGE plpgsql;/,
      );
      if (match) await admin.query(match[0]);
      await admin.end();
    }
  });
});
