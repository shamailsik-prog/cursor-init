# F27 plan: leased embedding claims, operation identity, receipts, retry timing, dead letters

Spec: `docs/superpowers/specs/2026-10-18-f27-leased-embedding-claims-design.md` (rulings R1-R16).
Branch: `claude/remediate-f27` from origin/main f670d62. Evidence log: scratchpad `evidence-f27.txt`.

## Tasks

1. **Spec and plan** (this file). Commit, push.
2. **RED tests**, written against database state and provider call counts only, so they run on main's code and fail by assertion:
   - `corpus_service/tests/test_f27_embedding_claims_e2e.py`: the `process-embeddings` beat entry, its task run in process (`Task.apply`), real Postgres. Missing and malformed rows and the window; retry timing and the dead letter; two concurrent batches in two threads over 120 rows; a re-queued unchanged operation; a record changed during the call; a crash left in the database (expired lease, `started` receipt); alerts; the runtime role; migration 004 on a pre-F27 queue.
   - `corpus_service/tests/test_f27_embedding_prefork_e2e.py`: a real `celery worker --pool=prefork` (F28's filesystem broker harness). Two children over the same 50 rows; a child killed (SIGKILL) while its store transaction waits, after the provider answered.
   - `corpus_service/tests/test_f27_embedding_rules.py`: operation identity, backoff, text checks, the lease against Celery's time limit (no database).
   - Run each on main's code and record the failing output below. Commit, push.
3. **Model and migration**: `EmbeddingQueue` columns, CHECKs and indexes; `EmbeddingAttempt`; `migrations/004_embedding_queue_leases.py`; the entry in `scraper/migrate.py`; `embedding_attempts` in the test fixture's `ORM_TABLES`.
4. **`scraper/tasks/embeddings.py`**: reclaim (R3), claim (R1, R2), reuse (R6), receipts (R5), store under the record lock (R7), retry timing (R8), dead letters (R9), give-back on abnormal exit (R10), alerts (R11), summary (R12).
5. **GREEN**: the F27 files, the F28 files unchanged, then the full suite as CI runs it (CI=1, real PG 16 + pgvector, Annex A twice). G-0, the F31 import contract, gitleaks, the claim gate.
6. **Mutation check**: at least 10 mutants on the claim, the lease, the operation id, the receipt, the retry timing and the dead letter, one at a time on a scratch copy.
7. **README** (corpus service): the queue states, the receipts, the requeue procedure, the migration.

## RED / GREEN ledger

Filled in as the work runs; exact commands and counts are in the evidence log.

Environment: Python 3.12.3 venv from `corpus_service/requirements-test.txt` only; PostgreSQL 16.13 + pgvector 0.6.0 on 127.0.0.1:55571 with the Annex A DDL (001, 003, 004) applied twice to the server database (all six psql runs rc=0); every e2e test also applies Annex A twice to its own database before `python -m scraper.migrate`. `CI=1 CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@127.0.0.1:55571/corpus_ci` throughout. Machine load average 15-20 on 4 cores.

Merges: origin/main a9a5256 (#81, F26) was merged as 6a75c21 before the RED run; the coordinator then reported #82 (F23, migration 003) and #83 merged, and origin/main 957fe26 was merged as 21315ca, still before any code change. Migration 004 stays independent of 003.

| Step | Command | Result |
| --- | --- | --- |
| Baseline, main 957fe26 (git-archive export) | `python -m pytest corpus_service/tests -q` | **1168 passed**, 3 warnings, 157 subtests, 0 skipped, 24 min 14 s |
| RED unit, main code | `python -m pytest corpus_service/tests/test_f27_embedding_rules.py -q` | **17 failed**: `embeddings` has no `operation_id`, `retry_delay_seconds`, `text_problem`, `SUPPORTED_MODELS`, `LEASE_SECONDS`, `BATCH_SIZE`, `BACKLOG_ALERT_SECONDS` |
| RED in process, main code | `python -m pytest corpus_service/tests/test_f27_embedding_claims_e2e.py -q` | **10 failed**: missing-record window `[(50, 50, 0, None)] x 3` (claimed, missing, completed, dead_lettered); unusable rows paid `{1: 2, '  ': 1, '  -- . -- ; --': 1, 900: 1}`; failed row retried by the next batch (2 calls); two threads: 50 rows paid more than once; unchanged re-queue paid twice; stale vector stored; no alerts; no receipts; r3 and r14 error (no lease column, no receipt table) |
| RED prefork, main code | `python -m pytest corpus_service/tests/test_f27_embedding_prefork_e2e.py -q` | **2 failed**: 99 requests for 50 rows, 49 rows paid twice (a9a5256); 100 requests, all 50 paid twice (957fe26); after a SIGKILL after the answer: `('FAILURE', 'WorkerLostError', ('pending', 0), [])` and the next batch paid again (2 requests), no receipt |
| RED, added R10 tests, main code | `-k r10` on the in-process file | **2 failed**: a database-failed row left `('pending', 0)` with nothing kept; an interrupted request left no receipt |
| GREEN unit | rules file | **17 passed** |
| GREEN in process | claims file | **10 passed** (first run), then **12 passed** with the R10 tests |
| GREEN prefork, attempt 1 | prefork file | 1 failed, 1 passed: claims 38 and 12, every row requested once. The test had assumed the second simultaneous claim finds nothing; SKIP LOCKED splits the window. Expectation corrected to the spec's property (disjoint claims covering the 50); no code change |
| GREEN prefork | prefork file | **2 passed** (claims [0, 50] in the next run; 50 requests for 50 rows) |
| F28 files, unchanged | the five `test_f28_*` files | **145 passed** |
| Gate G-0 | `BASE=origin/main bash ci_gates/gate_g0.sh` | `=== Gate G-0 PASSED (static) ===` (provider guard: the allowlisted `embeddings.py:openai` entry verified) |
| RED / GREEN, R2 fencing test (added) | `-k r2_` on the in-process file | main: error, no `lease_owner` column (no main equivalent); branch: **1 passed** |
| GREEN full suite at f278051 (+ README) | `python -m pytest corpus_service/tests -q` | **1197 passed**, 3 warnings, 157 subtests, 0 skipped, 24 min 08 s (main 1168 + the 29 F27 tests collected then) |
| GREEN full suite at 94d95f6 (the last code and test commit; later commits are documentation) | same | **1200 passed**, 3 warnings, 157 subtests, 0 skipped, 22 min 26 s (main 1168 + 32 F27 tests: 17 unit, 13 in process, 2 prefork) |
| F31 runtime smoke (not required: no dependency added; run because it executes `scraper.migrate` with 004) | `CORPUS_TEST_DATABASE_URL=... bash corpus_service/tests/e2e/runtime_smoke.sh` | clean venv from `requirements.txt` (80 distributions): every check PASS, `== F31 runtime smoke: all checks passed`, rc 0 |
| Compose e2e (`store_security_e2e.sh`, `upgrade_e2e.sh`) | | NOT DEMONSTRATED here: no Docker daemon in this session; CI's compose job runs them |

## Mutation check

`scratchpad/f27_mutants.py`: one mutant at a time on a scratch copy of the branch (never the worktree), `pytest -x` on the named files against real Postgres, the file restored after each.

| Mutant | Target | Result (first test that failed) |
| --- | --- | --- |
| M01 claim takes rows already leased | claim | killed (r3: the live batch's row was claimed) |
| M02 claim changes nothing (main's select) | claim | killed (r9: every run fails on its fences) |
| M03 claim without `FOR UPDATE SKIP LOCKED` | claim | killed only by the prefork concurrency test (one batch `LeaseLost`); the threaded in-process test does not catch it |
| M04 lease 0 s | lease | killed (unit pin); M04b behavioural tests only: killed (prefork kill test, reclaimed at once) |
| M05 reclaim ignores expiry | lease | killed (r3) |
| M06 / M06b no reclaim | lease | M06 invalid (indentation error in my snippet); M06b killed (r3) |
| M07 / M07b writes not fenced on the token | lease | M07 invalid (untyped parameter, a SQL error); M07b killed (r2 fencing) |
| M08 / M08b operation id ignores the text | operation id | killed (unit formula pin); M08b behavioural only: killed (r6) |
| M09 / M09b operation id ignores the model | operation id | killed (unit formula pin); M09b: killed (r6's stored operation against the spec formula) |
| M10 store skips the operation check | operation id | killed (r7: stale vector stored) |
| M11 no reuse of a stored operation | operation id | killed (r6: paid twice) |
| M12 `answered` not committed before the store | receipt | killed (r2: receipt `interrupted`) |
| M13 answered vector not held | receipt | killed (r2) |
| M14 `started` not committed before the request | receipt | first run hung (r2's stand-in self-deadlocks on the uncommitted row lock); with the R10 interruption test first: killed (no receipt) |
| M15 no reuse of a held vector | receipt | killed (r3) |
| M16 no backoff | retry timing | killed (r8) |
| M17 backoff off by one | retry timing | killed (r8: delays 600, 1200, 2400, 3600) |
| M18 claim ignores `next_attempt_at` | retry timing | killed (r8) |
| M19 `max_attempts` off by one | dead letter | killed (r8) |
| M20 missing record left pending | dead letter | killed (r9 window) |
| M21 no text checks | dead letter | killed (unit; e2e r9 covers it too) |
| M22 unknown table not dead-lettered | dead letter | killed (r9 unusable rows) |
| M23 interruption charged | give-back | killed (F28's own r26 test, unchanged) |
| M24 no release | give-back | killed (F28's own r26 test) |

Every valid mutant was killed; none survived.

## Rulings added while going GREEN

- The prefork concurrency expectation was corrected (see the ledger): SKIP LOCKED guarantees disjoint claims, not that one claim takes the whole window. Spec R1 now says so.
- Three tests were added because the mutation plan showed gaps: R10's charge-and-give-back with the held vector, R10's `interrupted` receipt, and R2's fencing.

## Review round 1 (PR #87)

Threads: Codex P2 4307196399 (reclaim dead-letters a row on its last attempt with its paid answer held); Bugbot 4307237209 (its duplicate); Bugbot 4307214719 (give-back labels a charged receipt `interrupted`); Bugbot 4307214725 (a failed batch skips its alerts); Bugbot 4307237211 (Autofix c2266ae's `finally` lets an alert error replace the batch's own). Spec amendments: R3, R10, R11, R12, residuals.

Foreign commits (Cursor Bugbot Autofix), each reviewed and merged, never rebased:
- c2266ae: the R10 half (charged row's `started` receipt becomes `failed` with the row's error type; `interrupted` only when uncharged) is correct and covered by the RED test; kept. The R11 half (alerts in a `finally` on the batch's own session) let an alert error replace the batch's exception; replaced (merge 3a353c6, test 37af993, fix bb02611).
- 6cbed24: the same reclaim rule as bb02611, but it skipped the orphan-receipt sweep whenever nothing expired and queried per row, so bb02611's version was kept in the merge (3a9f29e). Its success-path alert containment was right and was adopted test-first (444c631).

| Step | Result |
| --- | --- |
| RED, fa56eee code (d51dd41, 7ba1cac) | prefork SIGKILL after the answer, last attempt: `('dead_letter', 5, 'max_attempts')`, receipt `answered` with the vector held, 1 request in total (stranded); first attempt: `('pending', 1, 'lease_expired')` (charged although paid). In process, last attempt: `dead_letter`, vector stranded, 0 requests; text changed since the answer: the stale vector held forever; `started` only: passes (pin). Charged receipt: `('interrupted', no error type)` against row `('pending', 1, 'IntegrityError')`. Failed batch: `alerts: []`. |
| RED, merge with c2266ae (37af993) | an alert query that fails (22012) replaced the batch's IntegrityError: Celery and the record got `DBAPIError` |
| RED, bb02611 (444c631's test) | a successful batch was turned into a FAILURE by an alert query that fails |
| GREEN | F27 unit + in-process: 37 passed; prefork F27 (concurrency, kill at the first and the last attempt) + F28's five files unchanged: 148 passed (before 444c631); after 444c631: prefork + F28 embedding cases 9 passed |

Round-1 mutants (each snippet checked to occur once and to compile before the run; scratch copy; `pytest -x`): all **10 killed**.

| Mutant | Killed by |
| --- | --- |
| RR1-M1 the reclaim's unconditional charge restored | in-process R3 (row 2's paid answer charged, not stored) |
| RR1-M2 spare any row with a held answer, without matching its current operation | in-process R3 |
| RR1-M3 no supersede of stale held answers | text-changed test (stale vector still held) |
| RR1-M4 a charged receipt labelled `interrupted` | charged-failure receipt test |
| RR1-M5 a failed batch skips its alerts | failed-batch alerts test (`alerts: []`) |
| RR1-M6 an alert error not contained | alert-failure test (DBAPIError replaced the batch's IntegrityError) |
| RR1-M05 reclaim ignores expiry (restructured reclaim) | in-process R3 |
| RR1-M06b no reclaim (restructured reclaim) | in-process R3 |
| M23 interruption charged / M24 no release (give-back restructured) | F28's own unchanged r26 test |
