# F28 plan: source failures end as failures

Spec: `docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md` (rulings R1-R14).
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
