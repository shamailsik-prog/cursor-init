# Phase audit — F44 dependency-aware health

Finding **F44** (issue #30): health endpoints could stay HTTP-green while Firestore,
the job queue, or (corpus) PostgreSQL were unavailable.

## RED / GREEN (ledger)

| State | Evidence | Result |
| --- | --- | --- |
| RED | `f0b6100` (main after #147): `functions/src/health.ts` returned HTTP 200 whenever the F32 deploy contract passed, without probing Firestore or Cloud Tasks; `corpus_service/scraper/main.py` returned HTTP 200 with `status: degraded` when PostgreSQL failed | Load balancers and smoke checks could mark the control plane healthy during dependency outages |
| GREEN | Branch `cursor/f44-health-dependencies-7179`: deployed `GET /health` on the `health` function runs bounded Firestore (`jobs` limit-1) and `jobWorker` queue (`cloudtasks.googleapis.com` GET) probes, returns HTTP 503 with `dependencies` when any fail; corpus `GET /health` returns HTTP 503 with `dependencies.postgres: failed` when the DB probe fails | `functions/test/health.test.ts` (F44 cases) and `corpus_service/tests/test_security_hardening.py` |

## Readiness vs liveness

| Surface | Route | Role |
| --- | --- | --- |
| Cloud Functions | `GET /health` on export `health` | **Readiness** — deploy contract + Firestore + `jobWorker` Cloud Tasks queue; HTTP 503 when any required check fails |
| Cloud Functions | (none) | **Liveness** — implicit; the instance must serve HTTP |
| Corpus API | `GET /health` | **Readiness** — PostgreSQL `case_law_master` count probe; HTTP 503 when the DB probe fails |
| Corpus API | (none) | **Liveness** — implicit; uvicorn must serve HTTP |

## Scope note

This closes F44 only (dependency-aware readiness). It does not add corpus Celery/Redis
probes, object-store telemetry, or recursive vault enumeration changes (left to later findings).

| Claim | Value |
| --- | --- |
| OR-1..OR-4 | unchanged |
| backend_real | false |
| frontend_real | false |
| transport_stub | true |
