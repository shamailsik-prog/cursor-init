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

M05 and M12 were re-run after the ledger refactor (both killed). Not mutated: the source row's `FOR SHARE` lock, which no test can observe deterministically. *Corrected in round 2 (spec ruling 24): that was wrong; the wait is visible in `pg_stat_activity`, and `test_l2_*` now observes it and kills mutants Q08 and Q09.*

### Verification

- Full suite on the merged tree: 832 passed, 157 subtests passed (above).
- `BASE=origin/main bash ci_gates/gate_g0.sh`: `=== Gate G-0 PASSED (static) ===`.
- gitleaks 8.30.1 over `git diff origin/main HEAD` (the F23 changes only), with the repository's `.gitleaks.toml` and with the default rules: no leaks found.
- Claim gate (`ci_gates/check_pr_phase_claims.py`) on the PR body: PASS.

## Review round (Copilot)

Threads on PR #74: Copilot 4305754687 (HIGH: `is_current` accepts a WHEN (false) or `UPDATE OF reason` row trigger), Cursor Bugbot 4305785492 and 4305785497 (the RED commit's expectations: `'A'`, WHEN and column list), Cursor Bugbot 4305801306 (HIGH: the Cursor Agent's `'{}'::int2vector`). Spec section 6 has the rulings (R1 exact attribute comparison and rebuild from nothing; R2 ENABLE ALWAYS; R3 the agent's commits).

### Tasks

- [x] RED: e2e `test_i` (5 drift cases) and `test_h` expecting `'A'`, run on 869d041's code, committed alone (747ae02).
- [x] Reproduce the CI failure of the agent's 2549328 locally; revert it with a new commit (36a7559).
- [x] Fix on top of the agent's bd93eec (e8c1d45): exact function and trigger attributes, rebuild with `DROP FUNCTION ... CASCADE`, ENABLE ALWAYS; unit cases rewritten (29 single-attribute drifts, all of the agent's included).
- [x] Mutation check of the new check (6 mutants).
- [x] Merge main @ ae50c5b (F28 #72, claim gate #73); full suite, G-0, gitleaks, claim gate.

### Ledger: RED (review round)

`python -m pytest corpus_service/tests/test_f23_quarantine_review_db.py -q -rfE -k "test_h or test_i"` on 747ae02 (the code of 869d041): **6 failed**, all behavioural.

| Case | Observed |
| --- | --- |
| `when_false`, `update_of_reason` | migrate logs `quarantine_decisions append-only trigger already current; nothing to upgrade` and leaves the drifted trigger (the runtime role's UPDATE was `allowed` before migrate, and stays so) |
| `for_each_statement`, `no_op_function` | repaired (tgtype / body checks), but both triggers are `'O'`: a superuser session in `session_replication_role = replica` gets UPDATE, DELETE and TRUNCATE `allowed` |
| `replica_mode` | the same replica-mode bypass with no drift at all |
| `test_h` | triggers `'O'`, expected `'A'` |

### Ledger: the Cursor Agent's commits

| Commit | Local result (CI=1, real PG16, git archive of the commit) | CI | Action |
| --- | --- | --- | --- |
| 2549328 | F23 files: **6 failed, 31 passed, 7 errors**, every one `migrate failed ... invalid input syntax for type smallint: "{}"` (`SELECT '{}'::int2vector` fails the same way on its own) | `corpus_service pytest` failure; `policy-e2e` failure at step 8 (compose `store_security_e2e.sh`), which passed on 869d041 | reverted by 36a7559 |
| bd93eec | F23 files: 44 passed | n/a | kept; e8c1d45 builds on it and supersedes its check |

### Ledger: GREEN (review round)

| Run | Tree | Result |
| --- | --- | --- |
| F23 e2e | e8c1d45 | 13 passed (8 + `test_i` x5) |
| F23 unit | e8c1d45 | 31 passed |
| both F23 files | e8c1d45 | **44 passed** (94 s) |
| full `corpus_service/tests`, as CI runs it | 57a2bb0 (e8c1d45 merged with main @ ae50c5b) | **916 passed, 157 subtests passed** (1129 s; 872 + 44), no skips |
| collection count | main @ ae50c5b alone | 872 tests: the branch adds F23's 44 |

### Ledger: mutation (review round)

`scratchpad/f23_mutate_r2.py`, run against `test_h`, `test_i` and the two ledger unit tests: **6 killed, 0 survived**.

| Mutant | Killed by |
| --- | --- |
| N1 WHEN clause not compared | unit (`test_i[when_false]` alone does not isolate it: the recreated trigger is also `'O'`, which forces the rebuild) |
| N2 column list not compared | unit (same reason) |
| N3 ENABLE ALWAYS statements removed | `test_h`, `test_i` x5, unit |
| N4 function body not compared | `test_i[no_op_function]`, unit |
| N5 `tgtype` not compared | unit |
| N6 enabled flag not compared | unit |

### Verification (review round)

- `BASE=origin/main bash ci_gates/gate_g0.sh` at 57a2bb0: `=== Gate G-0 PASSED (static) ===`.
- gitleaks 8.30.1 over `git diff origin/main` (the F23 changes only), with the repository's `.gitleaks.toml` and with the default rules: no leaks found.
- Claim gate (`ci_gates/check_pr_phase_claims.py` as merged with #73) on the updated PR body: `PASS: PR phase-claim gate.`

## Re-audit round 2 (M1, L1–L8)

Spec section 7, rulings 13–26. Branch `claude/remediate-f23-fu` from `origin/main` @ 84025e8. Local runs: Python 3.12 venv from `requirements-test.txt` (plus the two pins this round adds), `CI=1`, a private PG16 + pgvector cluster on 127.0.0.1:55531 with Annex A 001/003/004 applied twice to `corpus_ci`, as the CI job does (`scratchpad/f23fu-pytest.sh`).

**Goal:** the review routes refuse an unauthenticated, oversized or stalled body before reading it, never echo input in a 422, map contention to 409 / 503, refuse a reused `Idempotency-Key` with another body, refuse visually blank names, and the 11 surviving mutants are killed.

**Files:**
- `corpus_service/scraper/routers/quarantine.py`: the routes take `Request` (no body field) behind `Depends(require_admin_api_key)` listed first; `ReviewRoute(APIRoute)` (route class of the two POST routes: own 422 rendering, `Connection: close` while the body is incomplete); `read_review_body(request) -> ReviewDecisionIn` (content type, `MAX_BODY_BYTES = 32768`, `BODY_READ_SECONDS = 10`, `model_validate_json`); `request_fingerprint(decision, reviewer, reason) -> str`; the SQLSTATE map; the visible-character rule.
- `corpus_service/scraper/models.py`: `QuarantineDecision.request_fingerprint` and its CHECK (additive).
- `corpus_service/migrations/003_quarantine_decision_fingerprint.py` (new) and `scraper/migrate.py` (`NUMBERED_MIGRATIONS` gains it).
- `corpus_service/requirements-test.txt`: `uvicorn==0.54.0`, `httptools==0.7.1` (inserted after `httpx`, away from #76's lines at the end).
- Tests: `tests/test_f23_review_body_guard_e2e.py` (new, real uvicorn), `tests/test_f23_review_hardening_db.py` (new, real Postgres), `tests/test_f23_quarantine_review_db.py` (`test_i` drifts re-enabled ALWAYS, `origin_enabled` drift), `tests/test_f23_quarantine_review_rules.py` (L7, L4/L5 renderer, fingerprint, structural route test, L8 escapes).
- `corpus_service/README.md` (review section).
- Not touched: `scraper/main.py`, `scraper/auth.py`, `scraper/tasks/*`, `scraper/net/*`, F24's modules, `tests/conftest.py`, `requirements.txt`, `functions/src/d1`, `app/api/**`, the PDF extractor and `tests/fixtures`.

### Tasks

- [ ] **Task R2-1: spec and plan.** Spec section 7 (rulings 13–26, residuals); this section.
- [ ] **Task R2-2: RED tests, committed alone.** The new test files and the `test_i` change, run on 84025e8's code; the failing output recorded below. Expected RED: every M1 probe (no 401 within 1 s for a 1 GB declared body; no 413; no 408; RSS growth), L3 (500), L4 (500), L5 (echoed input), L6 (200 replayed), L7 (200), the new migration (no column). Expected GREEN on 84025e8: the L1 and L2 pins (their RED is the mutant run).
- [ ] **Task R2-3: M1 and L4/L5.** Rulings 13–18. GREEN: the body-guard e2e under h11 and httptools, the L4/L5 tests, the structural route test, both F23 files and the F24 files unchanged.
- [ ] **Task R2-4: L3.** Ruling 19. GREEN: the four SQLSTATE cases.
- [ ] **Task R2-5: L6.** Rulings 20–21. GREEN: key reuse 422, fingerprint stored, legacy NULL row compared by recomputation, migration 003 idempotent.
- [ ] **Task R2-6: L7 and L8.** Rulings 22, 25. GREEN: the blank-name cases, unit and e2e.
- [ ] **Task R2-7: mutation.** `mutate3.py` (the auditor's, with only its runner path and test list pointed at this branch) over the 11 survivors, then all 44.
- [ ] **Task R2-8: verification.** Full suite as CI runs it, G-0, F31 import contract, gitleaks 8.30.1 over `git diff origin/main HEAD`, claim gate on the PR body; README.

### Ledger: round 2
