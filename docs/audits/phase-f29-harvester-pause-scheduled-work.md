# F29 — Harvester start/stop governs scheduled work

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **F29** (`docs/audit/2026-10-13-forensic-audit.md`)

## Mechanism

- **Operator control:** `POST /api/stop` and `POST /api/start` call `scraper.harvest_control.pause()` / `resume()`, which write or remove `harvest.stopped` under the shared state directory (same path the dashboard used before F29).
- **Consumers:** `scraper.tasks.dispatcher._run_async` skips with `harvest_paused` when paused; `scraper.tasks.embeddings.process_embedding_queue_task` returns a skipped batch summary with `reason: harvest_paused`.
- **Observability:** `GET /api/harvest-control` (admin) reports `{"paused": bool}`.

In-flight Celery work is not cancelled mid-harvest; stop prevents new scheduled harvest and embedding batches from doing work. Manual `POST /admin/sources/{name}/trigger` still enqueues `run_source_job`, which respects the same pause flag.

## RED / GREEN (ledger)

| Step | Command / evidence | Result |
| --- | --- | --- |
| RED | `3759a3cf` (main): `harvest.stopped` written by `/api/stop`; `dispatcher._run_async` and `process_embedding_queue_task` never read it | Operator stop is UI-only against beat-fired `run_source_job` / `process-embeddings` |
| GREEN | `corpus_service/tests/test_f29_harvest_pause_e2e.py` + `test_f29_harvest_pause_rules.py` on this branch | PASS |

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
| classification | PARTIAL (corpus harvest control slice; not COMPLETE while transport_stub=true) |

no COMPLETE/product-done claim
