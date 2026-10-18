# F23 Auditable Quarantine Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a reviewer's promote or reject of a quarantined record is one locked, state-checked transaction that publishes at most once under a stable identity, refuses blocked and unknown sources, records who decided what, why, from which state, in an append-only table, writes the embedding outbox row in the same transaction, and answers 404 / 409 instead of a false "promoted".

**Architecture:**
- `corpus_service/scraper/routers/quarantine.py` owns the transition (promote and reject), the request model, the deterministic publication id and the 404 / 409 mapping. It stays the only reviewed manual writer of `case_law_master` (`tests/test_trust_policy.py` allowlist, unchanged).
- `corpus_service/scraper/models.py` gains `QuarantineDecision` (table `quarantine_decisions`), created by `create_all` like every application table.
- `corpus_service/scraper/trust.py` gains `human_review_decision` (F20 vocabulary, fail closed).
- `corpus_service/scraper/quarantine_ledger.py` owns the append-only trigger DDL: an `after_create` listener on the table creates it with the table, and `corpus_service/migrations/002_quarantine_decisions.py` (run by `scraper/migrate.py` from `NUMBERED_MIGRATIONS`) repairs it.
- Source resolution and the citation lock key are reused from `scraper/tasks/promotion.py` (imported, not edited).

**Tech Stack:** Python 3.12 (CI and local venv), FastAPI 0.142.2, SQLAlchemy 2.1.3 asyncio, asyncpg 0.32.0, httpx 0.28.1, pytest 9.1.1, Postgres 16 + pgvector (CI: `pgvector/pgvector:pg16`; locally a private cluster on 127.0.0.1:55451 under `/tmp/f23-pg`).

**Spec:** `docs/superpowers/specs/2026-10-18-f23-auditable-quarantine-promotion-design.md`

## Global Constraints

- Do not edit `scraper/tasks/*` (F28 owns `dispatcher.py` and `embeddings.py`), `scraper/net/*` or `tests/test_f25_*` (PR #67), F24's `routers/search.py`, `routers/export.py`, `public_corpus.py`, `requirements*.txt`, the Dockerfile (F31), `config.py`, `main.py`, `init.sql`, `migrations/001_initial.py`, `app/api/**`, or the platform files of PRs #44 and #47.
- Shared files change additively only: `models.py` (one class), `trust.py` (one function), `conftest.py` (one table name), `migrate.py` (the numbered-migration call).
- Never skip or weaken a test. No existing test expectation changes.
- Synthetic data only; citations are 2099-dated.
- The e2e file imports no module main lacks, so it fails on main by behaviour.

## Review Focus

- The queue row is locked `FOR UPDATE` before any decision; only a pending row is decided; the loser of a race gets 409.
- Nothing is written on any refusal (404, 409, 422); the record stays pending.
- The published id is deterministic and recorded on the decision, the staging row and the response.
- The decision table is append-only in the database (trigger), not just in code.
- `blocked` and unknown sources are refused at decision time, from the staging row's current source.
- The outbox row is in the same transaction and exactly once.

### Task 1: Spec and plan

- [x] Write the spec with rulings, steelman and devil's advocate, bias check and residuals.
- [x] Write this plan.

### Task 2: RED e2e on main's sources

- [x] `corpus_service/tests/test_f23_quarantine_review_db.py`: (a)-(f) through the real app, real admin key, migrate, the runtime role, real promotion-made quarantine rows and real Postgres.
- [x] Run it on main's code; record the failing output below.

### Task 3: Trust decision and model

- [x] `trust.human_review_decision(trust_raw) -> PublicationDecision`: trusted / review promote; blocked -> `blocked_source`; anything else -> `unknown_source`.
- [x] `models.QuarantineDecision` with the columns, CHECKs and unique key of spec ruling 5.

### Task 4: Append-only DDL, migration 002 and the migrate call

- [x] `scraper/quarantine_ledger.py`: the function and trigger DDL in the table's schema, `is_current`, the `after_create` listener (attached in `models.py`) and `ensure_append_only`. (Added after the first version, which had the DDL in the migration only: see the ledger, "Defect: triggers only from the migration".)
- [x] `migrations/002_quarantine_decisions.py`: idempotent `upgrade(conn)` calling `ensure_append_only`.
- [x] `scraper/migrate.py`: `NUMBERED_MIGRATIONS = ("002_quarantine_decisions",)`, loaded by path, run in the upgrade transaction; a missing file or `upgrade` stops migrate.
- [x] `tests/conftest.py`: add `quarantine_decisions` to `ORM_TABLES`.

### Task 5: The transition

- [x] Request model (reviewer, reason; `extra = forbid`), `Idempotency-Key` validation, UUID path ids.
- [x] Promote: lock queue row, pending check / replay, lock staging, resolve and share-lock source, trust decision, citation lock and collision check, write master row (deterministic id), outbox row, staging lineage, queue review columns, decision row; commit; IntegrityError -> 409.
- [x] Reject: lock queue row, pending check / replay, snapshot staging and trust evidence, write decision and queue review columns; commit.

### Task 6: More e2e guards and the unit tests

- [x] e2e (e) gains a record staged under a family label (`SindhHighCourt` for `SindhHighCourtPublic`); (g) the identity backstop; (h) migration 002.
- [x] `corpus_service/tests/test_f23_quarantine_review_rules.py`: `human_review_decision` on every value; the deterministic id formula; `quarantine_ledger.is_current` and the DDL; 422 / 401 for bad bodies, keys, ids and admin keys before any database use.

### Task 7: Docs

- [x] Corpus README: the review transition, the decision table, the outbox hand-off.

### Task 8: Verification

- [x] The new e2e and unit files GREEN; the full corpus_service suite the way CI runs it (before and after merging the newer `origin/main`).
- [x] Mutation check of the F23 tests (17 source mutants).
- [x] `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [x] gitleaks over the diff.
- [x] The claim gate on the PR body.

## Ledger (RED / GREEN evidence)

Commands run from the repository root with `scratchpad/f23-pytest.sh` (Python 3.12 venv from `requirements-test.txt`, `CI=1`, `CORPUS_TEST_DATABASE_URL` on the private PG16 + pgvector cluster, Annex A 001/003/004 applied twice to `corpus_ci` exactly as the CI job does). Full logs and the evidence file are in the builder's scratchpad (`evidence-f23.txt`).

### Baseline (main @ f3bbcc9)

`python -m pytest corpus_service/tests -q`: **559 passed, 157 subtests passed** (455 s).

### RED, first record (main's sources + the e2e file as first written, commit ac56392)

`python -m pytest corpus_service/tests/test_f23_quarantine_review_db.py -q -rA`: **6 failed** (16.5 s), every one on an assertion about behaviour:

| Test | Observed on main | Expected |
| --- | --- | --- |
| (a) repeated approval | uncited record promoted twice: statuses (200, 200), **2 master rows**, no decision table; cited duplicate: (200, **500**) | (200, 409) `already_resolved`, 1 row, 1 decision; (200, 409) `citation_already_published` |
| (b) racing decisions | promote vs promote: [200, **500**], resolution still `pending`, no decision; promote vs reject: [200, **404**] (no reject route), resolution `pending` | [200, 409] `already_resolved`, one decision, resolution `approved` / `rejected` |
| (c) missing records | unknown id **200** (`{"error": "not found"}`), malformed id **500**, queue row without staging **200** (`{"message": "promoted"}`) | 404, 422, 409 `staging_record_missing` |
| (d) decision record | `no quarantine_decisions table: the promotion left no decision record` | the decision row with reviewer, reason, prior and new state |
| (e) untrusted source | blocked, later-blocked and unknown sources all **200**, each with a master row, no longer pending | 409 `source_not_promotable` (`blocked_source` / `unknown_source`), nothing written |
| (f) outbox | statuses (200, **500**, **500**, **404**), **0 outbox rows** | (200, 200, 409, 200), exactly one pending `embedding_queue` row named by the decision |

### RED, final record (pristine main tree + the final test files)

`git archive origin/main corpus_service postgres` (main @ f3bbcc9) extracted to a scratch directory, main's own `conftest.py`, the final `test_f23_quarantine_review_db.py` copied in:

`python -m pytest corpus_service/tests/test_f23_quarantine_review_db.py -q -rfE`: **8 failed** (33.9 s), all behavioural. (a)-(d) and (f) as above; (e) as above plus the family-labelled record published as `SindhHighCourt` (the label) instead of `SindhHighCourtPublic`; (g) the identity collision **200** with a second master row written; (h) `no quarantine_decisions table after migrate`.

`python -m pytest corpus_service/tests/test_f23_quarantine_review_rules.py -q`: collection `ImportError: cannot import name 'human_review_decision' from 'scraper.trust'`. That is not a behavioural RED; the unit file is a regression guard.

### GREEN

| Run | Tree | Result |
| --- | --- | --- |
| F23 e2e (a)-(f), first implementation | branch | 6 passed (17.7 s) |
| (h) first run | branch | **failed**: `pg_trigger.tgenabled` arrives as bytes (`b'O'`) through asyncpg, so the idempotency check never matched and every migrate would have recreated the triggers. Fixed with `tgenabled::text`; 1 passed |
| both F23 files after the ledger refactor | branch | **39 passed** (27.6 s): 8 e2e + 31 unit |
| full `corpus_service/tests`, as CI runs it | branch on main @ f3bbcc9 | **598 passed, 157 subtests passed** (382 s); main's 559 + 39 |
| full `corpus_service/tests`, as CI runs it | branch merged with main @ 7364b2b (F25 #67, FA-D5 #69, gitleaks #70) | **832 passed, 157 subtests passed** (445 s) |
| full `corpus_service/tests` | main @ 7364b2b alone (`git archive`), for the count | 793 passed, 157 subtests passed (631 s): the merged branch is main's 793 + F23's 39 |

No test was skipped, and no existing test expectation changed.

### Defect: triggers only from the migration

Reading the F20 tests showed that `test_b` and `test_j` build a "today's tables" legacy schema with `create_all` as the superuser and hand only the nine pre-F23 tables to a non-superuser migration role. With the trigger DDL in migration 002 alone, that role cannot add triggers to a table it does not own. Confirmed by removing the `after_create` listener and running `test_f20_trust_policy_db.py`, `test_f19_publication_db.py` and the F23 e2e: **2 failed, 76 passed**, both `scraper.migrate failed ... permission denied for table quarantine_decisions`. With the listener (the triggers are made with the table, whoever creates it) every one passes, and migration 002 stays as the repair path.

### Mutation check

17 source mutants, each run against both F23 files, the source restored after each (`scratchpad/f23_mutate.py`): **17 killed, 0 survived**.

| Mutant | Killed by |
| --- | --- |
| M01 no queue-row `FOR UPDATE` | (b) |
| M02 no pending check | (a) (b) (d) (f) |
| M03 trust check skipped | (e) |
| M04 no outbox row | (d) (f) |
| M05 migration 002 not run | (h) |
| M06 replay ignores the `Idempotency-Key` | (a) (b) (f) |
| M07 random publication id | (d) (f) (g) |
| M08 staging label as `source_site` | (e) |
| M09 no citation collision check | (a) |
| M10 `IntegrityError` not mapped to 409 | (g) |
| M11 no staging lineage | (d) |
| M12 append-only state never current | (h), unit |
| M13 reviewer not on the queue row | (d) |
| M14 `new_state` = prior state | (d) |
| M15 reject leaves the queue unresolved | (d) |
| M16 review sources refused | (a) (b) (d) (e) (f) (g), unit |
| M17 unknown source allowed | (e), 19 unit cases |

M05 and M12 were re-run after the ledger refactor (both killed). Not mutated: the source row's `FOR SHARE` lock, which no test can observe deterministically.

### Verification

- Full suite on the merged tree: 832 passed, 157 subtests passed (above).
- `BASE=origin/main bash ci_gates/gate_g0.sh`: `=== Gate G-0 PASSED (static) ===`.
- gitleaks 8.30.1 over `git diff origin/main HEAD` (the F23 changes only), with the repository's `.gitleaks.toml` and with the default rules: no leaks found.
- Claim gate (`ci_gates/check_pr_phase_claims.py`) on the PR body: PASS.
