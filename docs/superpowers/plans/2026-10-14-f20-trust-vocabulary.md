# F20 (+ F22) Trust Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the corpus trust vocabulary fail closed.
- Only a `trusted` source with confidence ≥ 0.5 is promoted.
- Everything else, including a missing or unknown source, is quarantined with a durable reason.
- A citation-free record no longer crashes promotion.

**Architecture:**
- One module, `scraper/trust.py`, owns the vocabulary and the decision.
- The model's CHECK constraint and default come from that module.
- An idempotent upgrade, run only by the schema-owner migrate step, maps legacy values.
- Promotion and the dispatcher call the module instead of comparing strings.
- Promotion still writes `case_law_master` for promoted rows. Moving to Annex A is PR 2 (F19).

**Tech Stack:** Python 3.12, SQLAlchemy 2 async, asyncpg, Postgres 16 (pgvector image), pytest/unittest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-14-f05-f19-f20-authority-corpus-design.md`, sections 1, 3 and 4.

## Global Constraints

- **Trust vocabulary:** exactly `trusted`, `review` and `blocked`. Default `review`. Source: FINAL_2 :252-253.
- **Promotion rule:**
  - `trusted` with confidence ≥ 0.5 → promote.
  - `review` → quarantine, reason `review_source`.
  - `trusted` with confidence < 0.5 → quarantine, reason `low_confidence`.
  - `blocked` → quarantine, reason `blocked_source`.
  - Unknown, None, or a missing or deleted source → quarantine, reason `unknown_source`.
  - No citation → quarantine, reason `citation_missing`.
- **Legacy mapping:** `semi_trusted`, `untrusted` and `quarantined` become `review`. Any other value outside the set also becomes `review`.
- **Who runs the vocabulary DDL:** only `python -m scraper.migrate`, which runs as `MIGRATE_DB_USER`. The API's startup `init_db()` runs as the DML-only runtime role (F30) and must not attempt DDL.
- **Fix only:** no new features, no new HTTP routes, and no scheduling of promotion. Scheduling is F21.
- **Never** skip, xfail or weaken an existing test.
- **Commits** end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DtzafHsrLji6x2SM4jCSWT
  ```

## Review Focus

These are the inputs most likely to hurt a real operator. Each one has a test in the task that owns the code.

1. **An existing deployment with `semi_trusted` rows and the old CHECK.** The upgrade must succeed exactly once. A re-run must be a no-op and must not fail on the new CHECK. *Task 2.*
2. **Seeding runs before the upgrade on an old database.** The old CHECK would reject `review`. Migrate must upgrade before it seeds. *Task 2.*
3. **A source renamed after staging,** where the old `source_site` no longer matches. The source must be resolved through the `source_id` foreign key. *Task 3.*
4. **A deleted source referenced by staging.** The row is quarantined as `unknown_source` and never promoted. *Task 3.*
5. **One bad record in a batch** (no citation, or a DB error on that row). It must not stop or roll back the other records. *Task 3.*

---

### Task 1: The trust module

**Files:**
- Create: `corpus_service/scraper/trust.py`
- Test: `corpus_service/tests/test_trust_policy.py` (pure unit tests, no DB)

**Interfaces:**
- Produces:
  - `TRUST_LEVELS: tuple[str, ...] = ("trusted", "review", "blocked")`
  - `DEFAULT_TRUST_LEVEL = "review"`
  - `PROMOTION_MIN_CONFIDENCE = 0.5`
  - `@dataclass(frozen=True) class PublicationDecision: promote: bool; reason: str | None`
  - `def publication_decision(trust_raw: str | None, confidence: float | None) -> PublicationDecision`
  - `def may_harvest(trust_raw: str | None) -> bool`
  - `def normalise_legacy_trust(value: str | None) -> str`: returns a value in `TRUST_LEVELS`. Legacy and unknown values become `"review"`.
  - `def trust_check_sql() -> str`: returns `"trust_level IN ('trusted','review','blocked')"`, built from `TRUST_LEVELS`.

- [ ] **Step 1:** Write tests for every row of the promotion rule. The exact cases:
  - `("trusted", 0.5)` → promote.
  - `("trusted", 0.49)` → `low_confidence`.
  - `("trusted", None)` → `low_confidence`.
  - `("review", 0.99)` → `review_source`.
  - `("blocked", 0.99)` → `blocked_source`.
  - `(None, 0.99)`, `("", 0.99)`, `("semi_trusted", 0.99)` and `("TRUSTED", 0.99)` → `unknown_source`. Matching is exact: case and whitespace are not normalised.

  Also cover:
  - `may_harvest`: `trusted` and `review` are True. `blocked`, `None` and `"x"` are False.
  - `normalise_legacy_trust`: covers the mapping table above.
- [ ] **Step 2:** Run `python -m pytest corpus_service/tests/test_trust_policy.py -q`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `trust.py`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(F20): fail-closed trust vocabulary module`.

### Task 2: Model, seeds and the idempotent upgrade

**Files:**
- Modify: `corpus_service/scraper/models.py`
  - :128: build the CHECK from `trust_check_sql()`.
  - :167: default `"review"` and `server_default 'review'`.
- Modify: `corpus_service/scraper/database.py`:
  - Seeds: `semi_trusted` becomes `review`.
  - Split `init_db()` into `create_schema()` (extensions and `create_all`) and `seed_data()`. `init_db()` keeps its current behaviour for API startup.
  - Add `async def upgrade_trust_vocabulary(conn) -> None`, which is idempotent:
    1. Drop the CHECK `ck_trust_level_values` if it exists.
    2. Run `UPDATE scraper_sources SET trust_level='review' WHERE trust_level NOT IN (...)`.
    3. Add the new CHECK.
    4. `ALTER COLUMN trust_level SET DEFAULT 'review'`.
- Modify: `corpus_service/scraper/migrate.py`. The order is `create_schema` → `upgrade_trust_vocabulary` → `seed_data`.
- Test: `corpus_service/tests/test_f20_trust_policy_db.py` (real Postgres; see Task 4 for the fixture).

**Interfaces:** consumes Task 1.

- [ ] **Step 1:** Write the DB tests.
  - **(a) New schema:** inserting `semi_trusted`, `untrusted`, `quarantined` or `''` raises an integrity error. A row inserted without `trust_level` reads back `review`.
  - **(b) Legacy schema.** The legacy tables are built as on main:
    1. Use the old CHECK string literally: `trust_level IN ('trusted','semi_trusted','untrusted','quarantined')`, default `trusted`.
    2. Insert rows with each legacy value.
    3. Run the migrate path twice.

    Expected: the values are mapped, the new CHECK and default are in place, and the second run makes no change.
  - **(c) Seeding.** After migrate, every seeded source has a value in `TRUST_LEVELS`.
- [ ] **Step 2:** Run against the database. Expected: FAIL on (a) and (b).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(F20): trust CHECK and default from the module; idempotent legacy upgrade in migrate`.

### Task 3: Promotion and the dispatcher

**Files:**
- Modify: `corpus_service/scraper/tasks/promotion.py`.
  - Import `select` once at module level. This fixes F22.
  - Resolve each record's source in this order:
    1. `ScraperSource.id == st.source_id`
    2. `source_name == (st.parsing_metadata or {}).get("source_name")`
    3. `source_name == st.source_site`
  - Decide with `publication_decision(src.trust_level if src else None, st.confidence_score)`.
  - Quarantine with a `QuarantineQueue` row whose `reason` is the decision reason. The existing columns carry the source fields. Set `st.quarantined = True`.
  - A record with no `extracted_citation` is quarantined as `citation_missing` **before** the duplicate check.
  - Process each record inside its own SAVEPOINT (`async with db.begin_nested()`) and commit once per record. On an exception, log `promotion.record_failed` with the staging id and the exception class name only, roll back that record, and continue.
  - Keep the existing `CaseLawMaster` write and the embedding enqueue for promoted rows. PR 2 changes those.
  - Return `{"promoted": n, "quarantined": n, "failed": n}`. Check its callers: `grep -rn promote_staging_records corpus_service`. If a caller expects an int, keep returning `promoted` and log the counts instead. Record which you chose in the commit.
- Modify: `corpus_service/scraper/tasks/dispatcher.py:27`. Replace the `blocked` string test with `if not may_harvest(source.trust_level): log and skip`.
- Test: add cases (c)–(e) to `test_f20_trust_policy_db.py`.

**Interfaces:** consumes Task 1's `publication_decision` and `may_harvest`.

- [ ] **Step 1:** Write the tests. Seed sources and normalised staging rows, then run the real `promote_staging_records()`.
  - **(c) Promotion outcomes:**

    | Staged row | Outcome |
    |---|---|
    | trusted, confidence 0.5 | promoted (one `case_law_master` row) |
    | trusted, 0.49 | quarantined `low_confidence` |
    | review | quarantined `review_source` |
    | blocked | quarantined `blocked_source` |
    | `source_site` names no source | quarantined `unknown_source` |
    | source deleted after staging | quarantined `unknown_source` |
    | source renamed after staging (`source_id` set, `source_site` = old name) | resolved through the FK; promoted if trusted |

    Nothing quarantined appears in `case_law_master`.
  - **(d)** A trusted 0.9 row with `extracted_citation = None` is quarantined as `citation_missing`, with no exception. A good row in the same batch is still promoted.
  - **(e)** The dispatcher's `_run_async` for a `blocked` source and for a source with an unknown trust value returns without calling any harvester. Monkeypatch the harvester import to fail if it is called.
- [ ] **Step 2:** Run against **main's** `promotion.py` and `dispatcher.py`: check out those two files from `origin/main` in a scratch copy. Expected: FAIL.
  - `semi_trusted`/unknown rows are promoted.
  - The citation-free row raises `UnboundLocalError`.
  - The dispatcher calls the harvester for an unknown trust value.

  Save the output as `f20-red.log`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS. Save the output as `f20-green.log`.
- [ ] **Step 5:** Commit: `fix(F20,F22): promotion decides through the trust module; per-record isolation; dispatcher uses may_harvest`.

### Task 4: Real-Postgres test fixture and CI

**Files:**
- Modify: `corpus_service/tests/conftest.py`.
  - Read `CORPUS_TEST_DATABASE_URL`.
  - If `CI` is set and the URL is missing, `pytest.exit("CORPUS_TEST_DATABASE_URL required in CI", returncode=1)`. Outside CI, the DB tests skip with a clear reason.
  - Point the app's engine at the URL for DB tests.
  - Each DB test module uses a fresh schema or database, created and dropped by the fixture, so the tests are isolated and repeatable.
- Modify: `.github/workflows/gate-g0.yml`, `corpus-service` job.
  - Add a `services: postgres` entry: `pgvector/pgvector:pg16`, pinned by digest if the other jobs pin by digest, with a healthcheck.
  - Set the env `CORPUS_TEST_DATABASE_URL`.
  - The job's pytest invocation must include the new files.
- Modify: `corpus_service/README.md`, so the trust levels match the code.

- [ ] **Step 1:** Run the full corpus pytest locally against a private Postgres (your own dockerd, private socket, unique names). Expected: all pass, including the 59 or 61 existing tests.
- [ ] **Step 2:** Run with `CI=1` and no URL. Expected: exit code 1 with the message.
- [ ] **Step 3:** Commit: `test(F20): real-Postgres fixture for corpus DB tests; CI service`.

### Task 5: Verification and PR

- [ ] Run:
  - `python -m pytest corpus_service -q`, with the DB.
  - `npm run gate:g0`.
  - gitleaks on the branch.
  - The compose policy suite (`python -m pytest ci_gates/test_check_compose_policy.py`), to show it is unaffected.
  - The store e2e, only if `models.py` or seeds affect it. Check whether `corpus_service/tests/e2e/store_security_e2e.sh` asserts trust values.
- [ ] Push `claude/remediate-f20-trust` and open a **draft** PR titled `fix(F20,F22): fail-closed corpus trust vocabulary`. The body must include:
  - the finding → change → e2e mapping;
  - the RED/GREEN evidence;
  - the flags table: `backend_real` true, `frontend_real` false, `transport_stub` true;
  - the line "Not a COMPLETE / product-done claim.";
  - a note that GitHub Actions is billing-blocked, if it still is.
- [ ] Do not merge. An independent re-audit comes first.
