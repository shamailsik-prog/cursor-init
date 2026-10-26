# FA-F29-005 — Cancel in-flight harvest work on operator stop

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **F29** / **FA-F29-005** (in-flight harvest batches are not cancelled on stop)

## Mechanism (this branch)

- **Operator stop:** `POST /api/stop` → `harvest_control.pause_async()` sets `harvest_operator_state.paused`, then `cancel_in_flight_harvest_work_async()` closes every `scraper_jobs` row still `running` with `job_type` in `incremental` or `embed` as `cancelled` (`result_summary.reason = harvest_stopped_by_operator`).
- **Celery:** distinct `celery_task_id` values get `app.control.revoke(..., terminate=False)` (cooperative; no hard kill). Failures to reach the broker are logged and do not block the DB cancel.
- **Workers:** long embedding batches call `cooperative_cancel_if_paused_async()` between claimed rows; source runs map `HarvestOperatorPaused` to `finish_skipped` and `_close` ignores finishes when the row is no longer `running` (operator cancel wins).
- **Unchanged:** FA-F29-001 pause flag, FA-F29-003 `GET /api/harvest-control` shape (`paused`, `in_flight`, `running`); corpus lifecycle beat tasks are not cancelled.

## RED / GREEN (ledger)

| Step | Evidence | Result |
| --- | --- | --- |
| RED | `8275906a` (main after PR #144): `pause_async()` only set `paused`; running `scraper_jobs` stayed `running` until natural completion or the 2 h abandon sweep | Stop hides new work but in-flight rows remain |
| GREEN | Branch `cursor/fa-f29-005-cancel-in-flight-harvest-e1c9`: `cancel_in_flight_harvest_work_async`, `test_f29_harvest_pause_e2e.py::test_pause_cancels_in_flight_harvest_jobs` | PASS |

## Focused verification

```bash
export CORPUS_TEST_DATABASE_URL='postgresql+asyncpg://<superuser>@<host>:5432/postgres'
cd corpus_service
PYTHONPATH=. python -m pytest tests/test_f29_harvest_pause_rules.py tests/test_f29_harvest_pause_e2e.py -q
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| OR-1..OR-4 | unchanged |

This slice closes **FA-F29-005** only; F29 parent close is for ME after review.
