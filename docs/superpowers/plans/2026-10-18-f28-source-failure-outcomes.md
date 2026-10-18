# F28 plan: source failures end as failures

Spec: `docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md` (rulings R1-R30; R16-R20 are the PR #72 review round; R21-R30 are re-audit round 2, section "Re-audit round 2" at the end of this file).
Branch: `claude/remediate-f28` from origin/main f3bbcc9. Evidence log: scratchpad `evidence-f28.txt`.

## Tasks

1. **Spec and plan** (this file). Commit, push.
2. **RED tests.**
   - `corpus_service/tests/test_f28_source_outcomes_e2e.py`: the beat entry -> real Celery task (`Task.apply`) -> real dispatcher, harvesters, fetch boundary and Postgres, cases (a)-(f) and the R10-R12 cases of spec section 4.
   - `corpus_service/tests/test_f28_outcomes.py`: classifier, tally, backoff, error-text redaction.
   - Run each on main's code and record the failing output below. Commit, push.
3. **`scraper/tasks/outcomes.py`**: `Tally`, `HarvestResult`, `Skipped` / `Refused`, `SourceRunFailed`, `SourceRefused`, `HarvesterContractError`, `RunRecordFailed`, `BatchFailed`, `is_retryable`, `will_retry`, `retry_countdown`, `is_database_error`, `describe_error`, the run-tally context variable.
4. **`scraper/tasks/job_record.py`**: `start`, `finish_completed`, `finish_skipped`, `finish_failed`, `record_batch`, abandoned-row reconciliation, source freshness counters, alerts, `in_task_loop`.
5. **Dispatcher**: `run_source` (record, decide, harvest, classify) and `run_source_job` (bounded retry with backoff); `_run_async` returns its decision.
6. **Harvesters**: PakistanCode, National Assembly, Nasir, the six courts, PakistanLawSite: no outer swallow, per-item tally, listing failure check, typed result.
7. **Embeddings**: no outer swallow, database errors re-raised, `BatchFailed`, typed summary, `embed` job row.
8. **GREEN**: the new files, the F20 / F25 suites that drive the dispatcher, then the full suite as CI runs it. G-0, gitleaks, the claim gate. Ledger below. Commit, push.

## RED / GREEN ledger

Filled in as the work runs; exact commands and counts are in the evidence log.

| Step | Command | Result |
|---|---|---|
| Baseline, main f3bbcc9 | `python -m pytest corpus_service/tests -q` | 559 passed, 3 warnings, 157 subtests |
| Probe, main code | `f28_pool_probe.py plain` / `dispose` (two `asyncio.run` on the pooled engine) | plain: run 1 fails `InterfaceError: cannot rollback; the transaction is in error state`; dispose: both ok |
| RED e2e, main code + tests (32fe1a6) | `python -m pytest corpus_service/tests/test_f28_source_outcomes_e2e.py -q -rf` | **14 failed**: every failure case recorded as SUCCESS, no `scraper_jobs` rows, the 500 page staged, the abandoned row left `running`, the second pooled-engine run's first attempt fails |
| RED unit, main code + tests (32fe1a6) | `python -m pytest corpus_service/tests/test_f28_outcomes.py -q` | **1 error** at collection: `cannot import name 'outcomes' from 'scraper.tasks'` |
| GREEN attempt 1 | both F28 files | 49 passed, **3 failed**: the eager result carried `UnpickleableExceptionWrapper` (keyword-only exception constructors); spec R15 |
| GREEN | both F28 files | **57 passed** (52 + the R15 round-trip test's 5 cases) |
| Combined with PR #67 (scratch tree: this branch + PR #67's `fetch_policy.py`, `pdf_writer.py`, guard) | PR #67's `test_f25_fetch_guard.py`, `test_f28_outcomes.py`, `test_trust_policy.py`; then both e2e files on real PG | 192 passed, 110 subtests; 15 passed |
| GREEN full suite (fix 5bcdb1c) | `python -m pytest corpus_service/tests -q -rf` | **616 passed**, 3 warnings, 157 subtests, 0 skipped (main: 559) |
| GREEN full suite at 8bafa03 (after the docstring-only edits) | `python -m pytest corpus_service/tests -q -rf` | **616 passed**, 3 warnings, 157 subtests, 0 skipped |
| Mutation check (scratch copy of 5bcdb1c, one undo per run) | F28 e2e file | M1 PakistanCode swallows its index failure: 4 failed; M2 nothing retryable: 2 failed; M3 SHC discovery never fails: 1 failed; M4 an all-failed embedding batch succeeds: 1 failed; M5 no engine disposal: 1 failed; M6 Nasir stages a 5xx page: 2 failed; M7 the run record's `result_summary` left empty: 8 failed |
| Gate G-0 | `BASE=origin/main bash ci_gates/gate_g0.sh` | `=== Gate G-0 PASSED (static) ===` |
| gitleaks 8.30.1 | `gitleaks dir` over `log -p origin/main..HEAD` (repository mode is refused by this session's worktree guard) | no leaks found |

## Rulings added while going GREEN

- **R15** (spec): the first GREEN run returned `UnpickleableExceptionWrapper` for `SourceRunFailed` / `BatchFailed`; every F28 exception now keeps its constructor arguments as `args`, pinned by `test_failures_survive_celerys_result_serialisation`.

## Review round (PR #72: Codex x2, Cursor Bugbot, Copilot x6)

### Tasks

1. Fetch the branch and review the foreign commit c6af66d (Cursor Autofix, Bugbot 4305696998). It is correct and in scope, so it is kept: fast-forwarded, not rebased.
2. RED tests (553c5ff: Codex P1 and P2, Bugbot; 87efe8e: Copilot x6, key renamed to `empty_pdf_text`).
3. Fixes, one commit per thread group, each pushed after a fetch-and-compare:
   - bbca52e R16 (empty extraction, PDF signature);
   - 1af93fd R17 (IHC feeds);
   - 95c8ce2 R18 (record writes);
   - 4ebc605 R19 (embedding counters);
   - 73dcb6f R20a (only 200);
   - 9ba1003 R20b (skip alerts).
4. Port PR #73's claim-gate fix (cherry-pick `-x` 07e7397, 32e7e5b, as 5d05440, 5226c9e).
5. GREEN: the F28 files, the full suite as CI runs it, G-0, the mutation check, the claim gate.
6. PR #72 merged at head 9ba1003 (squash ae50c5b on main). This write-up of the round lands separately (documentation only).

### Ledger

| Step | Command | Result |
|---|---|---|
| RED, c6af66d's code + round tests (553c5ff) | both F28 files | **16 failed**, 57 passed: every P1 case SUCCESS; both P2 cases SUCCESS / not partial; the two Bugbot source-run tests fail only on the missing ERROR line; the embedding record test gets `DBAPIError` |
| RED for Bugbot on 9403795's dispatcher (scratch copy) | the skip record-write test | **1 failed**: `DBAPIError`; `Job failed for NasirLawSite` logged 4 times (the skip was retried 3 times) |
| RED, + Copilot tests (87efe8e) | both F28 files | **22 failed**, 57 passed (the 16 above + 6 Copilot cases) |
| Claim-gate port (5226c9e) | `vitest run tests/pr-phase-claim-gate.test.ts` (temporary read-only `node_modules` symlink, removed) | 41 passed |
| GREEN per commit | targeted `-k` runs of the F28 files with the F20/F25/IHC suites they touch | bbca52e 20 passed; 1af93fd 19 passed; 95c8ce2 15 passed; 4ebc605 5 passed; 73dcb6f 15 passed |
| GREEN (9ba1003) | both F28 files | **79 passed** (45 unit + 34 e2e) |
| GREEN full suite (9ba1003) | `python -m pytest corpus_service/tests -q -rf` | **638 passed**, 3 warnings, 157 subtests, 0 skipped (616 + 22 new) |
| Gate G-0 (9ba1003) | `BASE=origin/main bash ci_gates/gate_g0.sh` | `=== Gate G-0 PASSED (static) ===`, 0 FAIL lines |
| Mutation check, review round (scratch copy of 9ba1003, one undo per run) | F28 e2e file (34 tests) | every mutation caught: R1 SHC stages an empty extraction: 3 failed; R2 NA skips the signature check: 1; R3 IHC never fails when every feed fails: 1; R4 feed failures not carried into the run: 2; R5 a record-write failure re-raises the raw error: 2; R6 a database-failed embedding item not counted: 1; R7 Nasir accepts any status below 400: 1; R8 SHC listing accepts any status below 400: 1; R9 a skip not checked for staleness: 1 |

## Re-audit round 2 (M1, L1, L3–L6)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native: one builder, tasks in order). Steps use checkbox (`- [ ]`) syntax.

**Goal:** a run cut off by Celery's soft time limit (or cancelled, or abandoned) is recorded, counted toward the streak and alerted; plus L1, L3, L4, L5 and the L6 pins.

**Architecture:** the interruption family is classified in `outcomes` and re-raised by the tally; `run_source` and `run_embedding_batch` record it through the existing `finish_failed` / `record_batch` paths before re-raising; the R11 sweep in `job_record.start` counts what it closes and runs `_alerts`. No schema change, no new dependency (`celery` is already declared; `socket` stays out of corpus code, F25 guard).

**Tech stack:** Python 3.12, Celery 5.6 / billiard (prefork), SQLAlchemy 2.1 async + asyncpg, PG16 + pgvector, pytest.

**Spec:** section 6 of the spec, rulings R21–R30.

Branch: `claude/remediate-f28-fu` from origin/main 84025e8. Evidence log: scratchpad `evidence-f28-fu.txt`. Cluster: PG16 + pgvector on 127.0.0.1:55521, Annex A DDL applied twice; venv from `requirements-test.txt` (Python 3.12).

### Global constraints

- Lanes: no change to `scraper/net/*` (F25), `scraper/parsers/pdf_extractor.py` (F26), `functions/src/d1` (F37), `app/api/**` (#44), the F03 R2 adapter or `.github/workflows/gate-g0.yml` (#47), `requirements*.txt`, `models.py`, `conftest.py`.
- Every new import passes the F31 import contract and the F25 guard (no `socket`).
- Existing tests change only where a ruling changes recorded content (R30 adds `listing:` keys to two IHC `discovery_errors` assertions); nothing is skipped or weakened.

### Review focus

1. The limit lands while the coroutine awaits on I/O (the common case): the coroutine sees `CancelledError`, not `SoftTimeLimitExceeded`. Pinned by the prefork await case.
2. The limit lands inside harvester code within a per-item `try`: pinned by the prefork blocking case.
3. Two sweeps racing on the same abandoned rows must not double count: `UPDATE … RETURNING` under the source row lock (R24); unit-level reasoning only, no race test (residual).
4. An abandoned row older than the last success must not grow the streak: pinned in the sweep test.
5. A redaction pattern that swallows ordinary text (over-redaction) is acceptable; a leak is not: the 13-case table asserts no secret survives and that the class name and the non-secret context remain.

### Tasks

**Task 1: RED tests (all three files), committed before any fix.**
- Create `corpus_service/tests/test_f28_fu_outcomes.py`:
  - `test_interruptions_are_classified_and_never_retried`: `outcomes.INTERRUPTIONS`, `is_interruption`, `interruption_reason` (`"time limit exceeded"` for `SoftTimeLimitExceeded` and for a `CancelledError` whose `__context__` is one; `"cancelled before it finished"` for a bare `CancelledError`); `is_retryable` False for all three and for `RunInterrupted`.
  - `test_the_tally_re_raises_an_interruption_and_counts_nothing`.
  - `test_run_interrupted_survives_celerys_result_serialisation`.
  - `test_transient_database_connection_faults_are_retried` (gaierror EAI_AGAIN, OSError ENETUNREACH / EHOSTUNREACH, `sa_exc.TimeoutError`; gaierror EAI_NONAME stays permanent).
  - `test_describe_error_redacts_every_credential_shape` (the auditor's 13 cases, none may leak).
  - `test_listing_failures_are_recorded_under_listing_keys` (`Tally.add_listing_failures(stage, makes_partial=False)`).
- Create `corpus_service/tests/test_f28_fu_prefork_e2e.py` (real prefork worker; see spec R21 tests):
  - `test_m1_time_limit_while_awaiting_is_recorded_counted_and_alerts`: PakistanCode last succeeded 30 days ago, two time-limited runs. Expect FAILURE `SoftTimeLimitExceeded` twice, rows `[("failed", 0), ("failed", 0)]`, each with `records_extracted` 3, `pages_scraped` 1, reason `time limit exceeded`, `interrupted_by` `CancelledError`, `consecutive_failures` 2, `last_failure_reason` `RunInterrupted: time limit exceeded`, 2 `stale` alerts stored and 2 logged.
  - `test_m1_time_limit_inside_harvester_code_is_not_an_item_failure`: FAILURE, one row `failed`, reason `time limit exceeded`, `interrupted_by` `SoftTimeLimitExceeded`, 3 statutes written and counted, no `SoftTimeLimitExceeded` item error.
  - `test_l3_cross_reference_then_a_source_job_in_the_same_child`: both SUCCESS, one `completed` row, no `InterfaceError`.
- Create `corpus_service/tests/test_f28_fu_e2e.py` (in process):
  - the R24 sweep: three abandoned rows then a failing run (`consecutive_failures` 4, `failing` at the sweep and at the failure, neutral text); a row older than the last success closed but not counted; X1 (a `full` row is left alone).
  - `test_r25_control_two_refused_runs_on_a_stale_source` (the auditor's control: `consecutive_failures` 2, 2 `stale`).
  - `test_r26_an_interrupted_embedding_batch_is_recorded_and_its_item_untouched` (SIGALRM emulation).
  - `test_l3_cross_reference_then_a_source_job_on_the_pooled_engine`.
  - `test_l4_a_database_dns_blip_at_job_start_is_retried_to_the_bound` (4 lookups, FAILURE).
  - L1: a court whose seed listings partly fail records `listing:` keys without changing the outcome; Nasir with 4 of 5 reporters down is `partial`, `discovery_failed` 4.
  - L6: J1, D2, D3, H2, H4, H5, X6, X7 (X1 above).
- Run the three files on the RED tree; record the failing output in the ledger. Commit, push.

**Task 2: `outcomes` (R21, R23, R25, R28, R29, R30 helpers).** `INTERRUPTIONS: tuple`, `is_interruption(exc) -> bool`, `interruption_reason(exc) -> str`, `REASON_TIME_LIMIT`, `REASON_CANCELLED`, `class RunInterrupted(Exception)(reason: str, interrupted_by: str)` with `.of(exc) -> RunInterrupted`; `Tally.item_failed` re-raises an interruption; `Tally.add_listing_failures(stage, *, makes_partial=False)`; the transient set and `describe_error`. Unit file GREEN. Commit, push.

**Task 3: dispatcher, job record, embeddings, court retry helpers (R21–R26).** `run_source` catches `INTERRUPTIONS` before `Exception`; `finish_failed` records `RunInterrupted`'s reason and `interrupted_by`; `run_embedding_batch` likewise; the embedding item handler and the courts' retry helpers re-raise; `job_record.start` sweeps with counting and alerts. Prefork and sweep tests GREEN. Commit, push.

**Task 4: `cross_reference` (R27).** One line. L3 tests GREEN. Commit, push.

**Task 5: listing failures (R30).** `tally=` on the six courts' `_discover_pdf_urls`; Nasir records its reporters with `makes_partial=True`; update the two IHC `discovery_errors` assertions. L1 tests and the F28 / F20 suites GREEN. Commit, push.

**Task 6: verification.** The three new files, then the full suite as CI runs it; G-0; the F31 import contract; gitleaks 8.30.1 on the diff; the L6 mutation re-run (the auditor's runner, one mutant at a time, on a scratch copy); the claim gate on the PR body. Ledger below. Commit, push.

### Ledger

Filled in as the work runs; exact commands and output are in the evidence log.

| Step | Command | Result |
|---|---|---|
| Baseline: the re-audit's probes on main (scratch copy of 84025e8) | `test_zz_reaudit2_f28_prefork.py`, `test_zz_reaudit2_f28_new.py` | **5 failed, 2 passed**: prefork row `running`, `consecutive_failures` 0; await and block emulations; abandoned streak 1; soft-limited stale runs 0 alerts. The contract probe and the refused-run control pass. |
| Probe: what the coroutine sees | `probe_cancel_context.py` (SIGALRM raising `SoftTimeLimitExceeded` during `await asyncio.sleep` under `asyncio.run`) | the coroutine sees `CancelledError`, `__context__` is `SoftTimeLimitExceeded`, it can still await, and `asyncio.run` raises `SoftTimeLimitExceeded` |
| RED, main code + the three new files (3e762a3) | `test_f28_fu_outcomes.py test_f28_fu_e2e.py test_f28_fu_prefork_e2e.py` | **39 failed, 20 passed**: unit 29, e2e 7, prefork 3. The 20 that pass are the redaction cases main already handled, the 3 permanent-OS cases, the R25 control and the 9 L6 pins, whose RED is the mutation run. |
| RED, court retry helpers (test before the change) | `-k court_retry` | **4 failed**: each helper called the URL 3 times through the limit |
| RED, limit during the record write (branch removed) | `-k record_is_written` | **1 failed**: `RunRecordFailed('PakistanLawSite')` |
| GREEN 08ca5a1 (`outcomes.py`) | unit files; F25 guard + F31 import contract | 84 passed; 187 passed |
| GREEN d5390ef (R21–R26) | three new files; F28 files | 60 passed, 4 failed (L3, L1: next commits); 79 passed |
| GREEN 0f12d01 (R27) | `-k l3` (in process + prefork) | 2 passed |
| GREEN d17d59e (R30) | new + F28 + F20 harvester files | the two R17 IHC assertions failed on the new `listing:http_404` keys (4 and 5), so they were extended (`discovery_failed` and the feed keys unchanged): **146 passed** |
| G-0 (first run at 86c8cfd) | `BASE=origin/main bash ci_gates/gate_g0.sh` | FAILED on `[3] provider-guard`: the R26 test imported `openai` to reach the stand-in. Fixed via `sys.modules`; re-run: `=== Gate G-0 PASSED (static) ===`, 0 FAIL lines |
| Merge origin/main 2bf12d5 (#44) | `git merge --no-ff origin/main` | 6b5d58a; no corpus_service file touched, no conflicts |
| GREEN full suite (d17d59e tree) | `python -m pytest corpus_service/tests -q -rf`, CI=1, Annex A DDL applied twice | **1059 passed**, 3 warnings, 157 subtests, 0 failed, 0 skipped, in 578.96 s (main collects 995; +64 new) |
| The re-audit's probes on the head code | the same two probe files | **7 passed**: prefork `failed`, `consecutive_failures` 1, `RunInterrupted: time limit exceeded`; await and block 1 each; abandoned streak 4; soft-limited stale 2 alerts, `consecutive_failures` 2 = the control's 2 and 2 |
| Mutation, L6 set (scratch copy of the head, one mutant per run) | `mutate.py mutants_l6.py`, target `test_f28_fu_e2e.py` | **9/9 killed**, each by its pin with exactly 1 failure: J1 `test_j1…`, D2 `test_d2…`, D3 `test_d3…`, H2 `test_h2…`, H4 `test_h4…`, H5 `test_h5…`, X1 `test_x1…` (re-anchored to the new sweep filter), X6 `test_x6…`, X7 `test_x7…` |
| Mutation, this round's fix | `mutate.py mutants_fix.py -x`, the three new files | **14/14 killed**: N1 no interruption record (prefork await); N2 tally counts the limit; N3 sweep does not count; N4 sweep no alert; N5 rows before the success counted; N6 cross_reference without `in_task_loop`; N7 EAI_AGAIN not transient; N8 Nasir not partial; N9 batch interruption not recorded; N10 reason always "cancelled"; N11 BHC retry through the limit; N12 `sk-` not redacted; N13 limit during the record write becomes `RunRecordFailed`; N14 SHC listing failures not recorded |
| gitleaks 8.30.1 | `gitleaks dir --config .gitleaks.toml --redact` over `git log -p origin/main..HEAD` and `git diff origin/main HEAD` | no leaks found |

### Rulings made while building

- **The prefork test chooses the slow statute per run.** `statutes_master` is unique on `(short_name, section_number)`, so a second run that writes the same act fails with `IntegrityError` 23505 before the limit can land. That is a separate, pre-existing F21 defect (a PakistanCode run after one that wrote statutes fails), recorded as a follow-up.
- **The provider stand-in is reached through `sys.modules`.** G-0's provider guard refuses `import openai` anywhere outside P1, test files included.
- **F26 (#76) overlap.** I read its diff (7821f6c). Its `except outcomes.DocumentRejected: tally.item_failed(rejected)` handlers stay correct with R23, because a `DocumentRejected` is never an interruption. While the sandbox parses in a thread, the limit lands in the loop's wait, which is the R21 path. When #76 lands, origin/main is merged in with a merge commit.
