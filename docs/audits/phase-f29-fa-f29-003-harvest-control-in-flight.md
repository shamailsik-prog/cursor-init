# FA-F29-003 — Harvest-control status exposes in-flight work

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **F29** / **FA-F29-003** (`GET /api/harvest-control` must report in-flight harvest work, not only `paused`)

## Mechanism (this branch)

- **Operator read:** `GET /api/harvest-control` returns `harvest_control.operator_status_async()`: durable `paused` (FA-F29-001), `in_flight` (any running F29-governed job), and `running` counts (`source_runs`, `embed_batches`, `total`).
- **Signal:** counts `scraper_jobs` rows with `status = 'running'` and `job_type` in `incremental` (scheduled source harvest) or `embed` (scheduled embedding batches). These rows are opened by `job_record.start` before Celery work runs and closed on completion; no Celery inspect or broker calls.
- **Out of scope:** mid-harvest cancel (FA-F29-005); corpus lifecycle consumer ticks (`normalise` / `promote` / …) are not harvest-operator work and are not counted.

## RED / GREEN (ledger)

| Step | Evidence | Result |
| --- | --- | --- |
| RED | `6cd27e61` (main after PR #143): `GET /api/harvest-control` returns only `{"paused": bool}` | Operators cannot see work already in flight after stop |
| GREEN | Branch `cursor/f29-harvest-control-in-flight-417d`: `operator_status_async`, `test_f29_harvest_pause_e2e.py::test_harvest_control_reports_in_flight_source_job` | PASS |

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

F29 parent issue remains open for sibling findings (e.g. FA-F29-005 cancel); this slice closes **FA-F29-003** only.
