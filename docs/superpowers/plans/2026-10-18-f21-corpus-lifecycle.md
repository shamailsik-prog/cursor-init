# F21 plan: corpus lifecycle, registered consumers, completion boundary

Spec: `docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md` (rulings R1-R16). Branch `claude/remediate-f21` from `origin/main` @ c02ebbc. Test-driven: every behaviour change starts with a failing test, recorded in the ledger (section 3) with the exact command and count. Anything not run is marked NOT DEMONSTRATED.

Environment: one Python 3.12 venv from `corpus_service/requirements-test.txt`; PostgreSQL 16 + pgvector on 127.0.0.1:55591 (own cluster under `/tmp/f21-pg`, run as the `postgres` OS user), database `corpus_ci` with the Annex A DDL applied twice, as the CI corpus job does; `CI=1`, `CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://postgres:***@127.0.0.1:55591/corpus_ci`. Main's tree for RED runs is an export of c02ebbc (`git archive`), not a second worktree.

## 1. Tasks

1. **RED e2e** `tests/test_f21_corpus_lifecycle_e2e.py` (a)-(h) against the target behaviour; run on main's export, record the failures and the per-state counts main leaves.
2. **RED rules** `tests/test_f21_corpus_lifecycle_rules.py`: transition table, `move()`, CHECK SQL, beat entries, direct-write gate and its mutants, single-writer scan.
3. **Model + migration 005** (R1, R3, R5, R13): columns, CHECKs, index, transition model, job-type CHECK; `migrate.py` list; conftest `ORM_TABLES`.
4. **`scraper/tasks/lifecycle.py`** (R2, R3, R5): vocabulary, `move()`, run-job binding.
5. **Harvesters** (R12): PakistanCode and NationalAssembly to `statutes_staging`; routes `staging`; court labels removed; `job_id` stamped; dispatcher binds the run job.
6. **Normaliser** `scraper/tasks/normalise.py` (R6).
7. **Gate** in `scraper/tasks/promotion.py` (R7): lifecycle moves in `_decide` / `_quarantine_after_error`; statute decision; claim-based `gate_batch`; interruptions re-raised (R4).
8. **Retrieval projection** `scraper/publication/retrieval.py` and **publish consumer** `scraper/tasks/publish.py` (R8, R9, R10).
9. **Reconciler** `scraper/tasks/reconcile.py` (R11) with its CLI.
10. **Consumers and beat** `scraper/tasks/corpus_pipeline.py` + `celery_app.py` (R4, R5); `job_record.record_consumer_run`.
11. **Changed expectations** in the four existing tests the spec names; F20 allowlist entry for `scraper.publication.retrieval`.
12. **README** runbook section; spec ledger cross-check.
13. **Verification**: full corpus suite as CI runs it; G-0; F31 import contract; F31 runtime smoke (runtime imports change); mutation (at least 12 mutants); gitleaks; claim gate on the PR body.

## 2. Decisions taken while planning

| # | Decision | Reason |
| --- | --- | --- |
| D1 | `promote_staging_records()` keeps its signature, selector and blocking `FOR UPDATE` (F20 test_h pins that it waits on a locked row); the scheduled gate is a new claim loop that shares `_decide` | F19/F20 suites must pass unchanged; the claim loop needs `SKIP LOCKED` |
| D2 | Lifecycle moves are written inside `_decide` and `_quarantine_after_error`, so both the legacy routine and the consumer keep state and flags together; a legacy row staged `normalised = true` at `parsed` is first moved `parsed` → `normalised` (reason `normalised_by_writer`) | one decision path, no drift between flags and state |
| D3 | Every master-table access of the lifecycle lives in `scraper/publication/retrieval.py`, the one new entry on F20's writer allowlist | the F20 scanner allowlists by module |
| D4 | Consumer tasks live in one module (`corpus_pipeline.py`) that `celery_app` imports; the logic modules import no Celery | `promotion.py` is imported by the API (F23's route); keep Celery task objects out of it |
| D5 | Tests run the four lifecycle beat entries per tick, not `process-embeddings` | the flow stops at the outbox row (brief); no provider |

## 3. RED/GREEN ledger

(filled in as the work proceeds; each row gives the command, the tree and the counts)
