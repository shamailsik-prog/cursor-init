# FA-F29-001 — Durable DB harvest pause flag

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **F29** / **FA-F29-001** (pause flag must be in PostgreSQL, not a host-local file)

## Mechanism (this branch)

- **Operator control:** `POST /api/stop` and `POST /api/start` call `harvest_control.pause_async()` / `resume_async()`, which upsert the singleton row `harvest_operator_state` (`id = 'global'`, column `paused`).
- **Consumers:** unchanged entry points — `harvest_control.is_paused_async()` / sync `is_paused()` for Celery — read the same row transactionally via `SessionLocal`.
- **Legacy:** a pre-upgrade `harvest.stopped` file is adopted into the DB on first read and removed; new pauses do not create the file.

## RED / GREEN (ledger)

| Step | Evidence | Result |
| --- | --- | --- |
| RED | `db2b0607` (main after PR #141): `scraper/harvest_control.py` gates on `(state_dir() / "harvest.stopped").exists()` | Pause is container-local; fails F29 durable-control acceptance |
| GREEN | Branch `cursor/f29-db-harvest-pause-a256`: migration `006_harvest_operator_state`, model `HarvestOperatorState`, `test_f29_harvest_pause_*.py` | PASS |

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

no COMPLETE/product-done claim
