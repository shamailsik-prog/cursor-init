# F28 plan: source failures end as failures

Spec: `docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md` (rulings R1-R20; R16-R20 are the PR #72 review round).
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
