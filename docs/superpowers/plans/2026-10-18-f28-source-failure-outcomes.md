# F28 plan: source failures end as failures

Spec: `docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md` (rulings R1-R15).
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
