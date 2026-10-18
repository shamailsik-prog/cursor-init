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

- [x] **Task R2-1: spec and plan.** Spec section 7 (rulings 13–26, residuals); this section.
- [x] **Task R2-2: RED tests, committed alone.** The new test files and the `test_i` change, run on 84025e8's code; the failing output recorded below. Expected RED: every M1 probe (no 401 within 1 s for a 1 GB declared body; no 413; no 408; RSS growth), L3 (500), L4 (500), L5 (echoed input), L6 (200 replayed), L7 (200), the new migration (no column). Expected GREEN on 84025e8: the L1 and L2 pins (their RED is the mutant run).
- [x] **Task R2-3: M1 and L4/L5.** Rulings 13–18. GREEN: the body-guard e2e under h11 and httptools, the L4/L5 tests, the structural route test, both F23 files and the F24 files unchanged.
- [x] **Task R2-4: L3.** Ruling 19. GREEN: the four SQLSTATE cases.
- [x] **Task R2-5: L6.** Rulings 20–21. GREEN: key reuse 422, fingerprint stored, legacy NULL row compared by recomputation, migration 003 idempotent.
- [x] **Task R2-6: L7 and L8.** Rulings 22, 25. GREEN: the blank-name cases, unit and e2e.
- [x] **Task R2-7: mutation.** `mutate3.py` (the auditor's, with only its runner path and test list pointed at this branch) over the 11 survivors, then all 44.
- [x] **Task R2-8: verification.** Full suite as CI runs it, G-0, F31 import contract, gitleaks 8.30.1 over `git diff origin/main HEAD`, claim gate on the PR body; README.

### Ledger: round 2

Full logs and the evidence file are in the builder's scratchpad (`evidence-f23-fu.txt`).

**Prototype, before any test (scratch, never committed).** A minimal FastAPI app under uvicorn 0.54.0, a route whose dependency answers 401 with and without `Connection: close`, both HTTP implementations. Without `close`: the 401 came at once, but the connection stayed open while the client trickled one byte a second (still open after 6 s; each byte cancels uvicorn's keep-alive timer), and a 64 MB unauthenticated body was drained to its end (client read 401). With `close`: the connection closed right after the 401 (h11 0.007 s, httptools 0.006 s), 200 of 200 small unauthenticated requests read their 401, and a 64 MB body sent with httpx saw `ReadError`. This decided ruling 16.

**RED (84025e8's code, the new tests, commit 155cc9f).**

| File | Result | Observed |
| --- | --- | --- |
| `test_f23_review_body_guard_e2e.py` | **2 failed** (h11, httptools; 93.9 s) | no answer to an unauthenticated or wrong-key 1 GB declaration, a Content-Length over the cap, a chunked body past the cap, or a stalled body (status None, connection open); 4 x 64 MB unauthenticated bodies grew peak RSS by **1022.3 MB** (h11) and **886.1 MB** (httptools); 64 MB with the key read whole and answered 422; `/api/start`, `/api/stop`, `/admin/sources/{name}/trigger` answered 401 at once, the two review routes never |
| `test_f23_review_hardening_db.py` | **9 failed, 6 passed** (79.9 s) | L3: 40001, 40P01, 55P03, 57014 all 500; L4: lone surrogate in reviewer, reason or a field name 500; L5: a 20,000-character reviewer echoed (> 2 KB), malformed JSON with `input`/`ctx`, a 10 MB reviewer echoed in a 422; L6: another reviewer or reason with the same key 200 replayed, no fingerprint column; L7: blank names accepted. The 6 passing are the L1 and L2 pins (their RED is the mutant run) |
| `test_f23_quarantine_review_rules.py` | **7 failed, 29 passed** (43.5 s) | blank-name bad bodies accepted; through the ASGI app every request asked for body data first and never answered `(None, None, 1)`; both review routes have a body field; 40-entry 422 with input; `request_fingerprint` missing (ImportError: a regression guard) |
| `test_f23_quarantine_review_db.py` with the new drifts | 14 passed | pins; N08 and N09's RED is the mutant run |

The first L2 version failed on 84025e8 for the test's own reason: `pg_stat_activity.query` is cut at 1,024 bytes before `FOR SHARE`. Rewritten to read the waiter's tuple lock from `pg_locks` (RowShareLock); it then passed on 84025e8, as a pin must. The L8 hygiene test, run on 84025e8's rules file: U+202E (Cf) at line 198, U+200B (Cf) at line 199.

**GREEN, per fix.**

| Commit | Fix | Result |
| --- | --- | --- |
| eb49bda | M1, L4, L5 | body-guard e2e **2 passed**; measured h11: 401 at 0.073 s and closed at once, wrong key 0.010 s, over cap 413 at 0.012 s, chunked 413 0.002 s after passing the cap, peak RSS **+0.6 MB**, 408 at **10.07 s**; httptools: 0.027 s, 0.001 s, 0.002 s, 0.001 s, **+0.8 MB**, 408 at **10.03 s**. L4/L5 e2e passed. F23 e2e + every F24 file: 176 passed |
| 127bf45 | L3 | 4 passed (each SQLSTATE produced deterministically, nothing written, retry 200) |
| 36c6fa6 | L6 | 3 passed; F19 publication, F20 trust policy and harvesters, F23 e2e: 87 passed |
| 5e0a196 | L7 | rules + hardening: 51 passed |
| 6d3e340 | L8 | rules 37 passed. The editing tools had turned this round's own `\u` escapes into the characters (Hangul fillers, U+2800, U+2028/9, combining marks, and U+202E/U+200B in the spec); written back as escapes, now guarded by the hygiene test |
| 45ea702 | a Content-Length of non-ASCII digits (found in self-review) | RED (500, None, 0); GREEN (408, close, 1) |
| 935166d | F31 import contract refused `starlette` imports | `fastapi` re-exports used; F31 + rules: 108 passed |
| 380934f, a15a224 | gitleaks generic-api-key misread `length=MAX_BODY_BYTES` | call reordered; exact-value `.gitleaks.toml` entry for the intermediate commits (PR #77 brought the same entry to main byte for byte; its text is frozen) |
| 8daf3dc | round-2 mutant G08 survived (no surrogate reaches the renderer through the body) | the renderer tested directly; G08 killed |
| 8e344ed | under mutant Q01, `test_l3[40P01]` hung instead of failing | every wait on a request bounded; Q01 killed in 131 s |

**Merges.** 2a8ff8e merged main @ 2bf12d5 (#44, no corpus file); 7633dbe merged main @ 53f4450 (F26 #76: `conftest.py`, `import_contract.py`, `requirements.txt`, `requirements-test.txt` appended at the end, the PDF modules), clean, and the venv was updated to the merged `requirements-test.txt`; 0bf5a18 merged main @ 34e158f (#77, F03 #47, F28 follow-up #78: `scraper/tasks/*`, `describe_error` redaction R29), clean, no F23 file and no requirement touched. The quarantine router does not use `describe_error`. 360416d merged main @ f670d62 (F37 #80, F03 docs #79), which touch no `corpus_service`, `ci_gates`, workflow or `.gitleaks.toml` file; G-0, the F31 contract and the F23 rules file were re-run on it (PASSED; 109 passed), and the full-suite run on 8e344ed stands for the corpus code.

**Full suite, as CI runs it.** On 7633dbe + a15a224 (main @ 53f4450): 1068 passed, 157 subtests passed (1251 s). On 8daf3dc (main @ 34e158f merged): **1135 passed, 157 subtests passed** (788 s). On the final code, 8e344ed: **1135 passed, 157 subtests passed**, 0 failed, 0 skipped (1019 s, on the shared 4-core machine, alongside a mutant run). main @ 34e158f collects 1110; this branch adds 25 (7 rules tests, 15 hardening, 2 body-guard, 1 `test_i` drift).

**Mutation.** The auditor's `mutate3.py`, copied with only two lines changed (`RUNNER` to this cluster's runner; `TESTS` to this branch's F23 files), each mutant applied to a scratch copy of the tree and the source restored after it.

*L1, the 11 survivors of the re-audit* (tree 5e0a196; the four F23 files, the uvicorn guard included): **11 killed, 0 survived.**

| Mutant | Killed by |
| --- | --- |
| N08 (`no_qual` always true) | `test_i[when_false]` |
| N09 (`attr_count` always 0) | `test_i[update_of_reason]` |
| Q02 (`reviewed` ignored) | `test_l1_rows_that_are_not_pending_are_409_and_write_nothing` |
| Q03 (`resolution` ignored) | `test_l1_rows_that_are_not_pending_are_409_and_write_nothing` |
| Q05 (`staging_already_promoted` check removed) | `test_l1_two_queue_rows_on_one_staging_row_publish_once` |
| Q07b (advisory lock removed, valid SQL) | `test_l1_two_records_with_one_citation_serialise_on_the_advisory_lock` |
| Q08 (source not re-read under `FOR SHARE`) | `test_l2_the_source_for_share_lock_waits_for_a_concurrent_block` |
| Q09 (`populate_existing` dropped) | `test_l2_the_source_for_share_lock_waits_for_a_concurrent_block` |
| R01 (replay ignores the key's value) | `test_l1_another_key_on_a_promoted_record_is_409_not_a_replay` |
| R02 (citation not trimmed) | `test_l1_a_padded_citation_is_refused_as_already_published` |
| R07 (quarantine-time trust recorded) | `test_l1_the_decision_records_the_trust_read_at_decision_time` |

*Round 2, the new code* (`mutate_r2.py`, the same machinery; tree a15a224; the three F23 files without the uvicorn guard): **22 mutants, 20 killed on the first run, 2 survived.** G08 (the 422 renderer without `backslashreplace`) survived because pydantic's JSON parser refuses a lone surrogate itself (`json_invalid`), so none reaches the renderer through the body; `test_the_422_renderer_encodes_and_bounds_whatever_an_error_carries` (8daf3dc) now tests the renderer directly, and G08 is **killed** by it. G10 (no explicit rollback before the 409 / 503) is **equivalent**: the exception unwinds `get_db`'s session context first, which rolls the transaction back before the response is sent. M01b and R11b are the auditor's M01 and R11 re-expressed for text this round changed (both killed; the originals no longer apply as written).

| Mutant | Killed by |
| --- | --- |
| M01b numbered migrations not run | `test_h`, `test_i` x5, `test_l6_migration_003_*` |
| R11b reject without the admin dependency | `test_bad_ids_keys_and_admin_keys_*[reject]`, `test_no_admin_route_reads_a_body_before_authenticating` |
| G02 declared length over the cap not refused; G03 streamed size not capped; G04 no deadline; G05 `Connection: close` never added; G21 content type not checked | `test_review_routes_answer_before_reading_the_body` |
| G06 raw errors rendered; G07 no bound on the error count | `test_validation_errors_are_bounded_and_never_echo_the_input` x2 |
| G08 lone surrogate not escaped | `test_the_422_renderer_encodes_and_bounds_whatever_an_error_carries` (after 8daf3dc) |
| G09 40001 not mapped; G09b 55P03 as 409; G20 503 without Retry-After | `test_l3_contention_is_409_or_503_after_rollback` |
| G10 no rollback before the answer | equivalent (see above) |
| G11 fingerprint not compared | `test_l6` x2 |
| G12 fingerprint not stored | `test_l6_the_same_key_with_another_body_is_422_not_a_replay` |
| G13 no recomputation for a row without one; G14 migration 003 not listed; G15 003 without its CHECK | `test_l6_migration_003_*` |
| G16 Hangul fillers visible; G17 separators allowed; G18 no visible-character rule | `test_bad_bodies_are_422_*` x2, `test_l7_*` |

*The auditor's other mutants* (killed at 3fd7833), re-run on this branch: **22 of 22 applicable killed** (N12, N13 on a15a224; Q01 after 8e344ed; Q04, Q06, Q07, Q10–Q18, R03–R06, R09, R10, R12 on 8e344ed; the three non-uvicorn F23 files). M01 and R11 no longer apply as written, because this round changed their text; M01b and R11b above are their equivalents and are killed. So all 35 of `mutate3.py`'s mutants are killed on this branch (the re-audit: 24 killed, 11 survived).

*A defect the mutant run found in a new test.* Under Q01 (no row locks), `test_l3[40P01]` hung instead of failing: the request waited on the staging row the test's holder kept until the request returned (seen in `pg_stat_activity`). 8e344ed bounds every wait on a request (`_answered`: after 30 s it releases what the test holds and fails); Q01 is then killed in 131 s by `test_b`, `test_l2` and `test_l3[40P01]`.

**Gates on the merged tree.** `BASE=origin/main bash ci_gates/gate_g0.sh`: `=== Gate G-0 PASSED (static) ===`. F31 import contract: 71 passed (after each merge). gitleaks 8.30.1 over `git diff origin/main HEAD`, repository config and default rules: no leaks. Before every push from a15a224 on, every branch commit was scanned the way `gitleaks git --log-opts=origin/main..HEAD` scans it: the sandbox here refuses a `gitleaks git` command line, so each commit's added lines were placed at their repository paths and scanned with `gitleaks dir` and the branch's `.gitleaks.toml`: 0 findings; the control with main's earlier config finds the one in 155cc9f. Claim gate on the PR body: `PASS: PR phase-claim gate.`
