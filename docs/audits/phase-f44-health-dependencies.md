# Phase audit — F44 dependency-aware health

Finding **F44** (issue #30): health endpoints could stay HTTP-green while Firestore,
the job queue, or (corpus) PostgreSQL were unavailable.

## RED / GREEN (ledger)

| State | Evidence | Result |
| --- | --- | --- |
| RED | `f0b6100` (main after #147): `functions/src/health.ts` returned HTTP 200 whenever the F32 deploy contract passed, without probing Firestore or Cloud Tasks; `corpus_service/scraper/main.py` returned HTTP 200 with `status: degraded` when PostgreSQL failed | Load balancers and smoke checks could mark the control plane healthy during dependency outages |
| GREEN (PR #148 initial) | Deployed `GET /health` on `health` runs Firestore + `jobWorker` queue probes → HTTP 503 with `dependencies`; corpus `/health` → HTTP 503 when PostgreSQL fails | `functions/test/health.test.ts`, `corpus_service/tests/test_security_hardening.py` |
| RED (re-audit FA-F44-001..004) | No separate liveness route; corpus readiness still walked the vault and `COUNT(*)`; no DB probe timeout; runtime SA lacked `roles/cloudtasks.viewer` for queue GET → permanent readiness 503 in prod | Re-audit **FAIL 8.0/10** |
| GREEN (PR #148 residuals) | `healthLive` + corpus `/health/live` (no I/O); corpus readiness uses `SELECT 1` + 2s timeout and cached telemetry only; `infra/deploy-manifest.json` + `infra/terraform/iam.tf` grant `roles/cloudtasks.viewer` | `functions/test/health.liveness.test.ts`, `corpus_service/tests/test_f44_health_readiness.py`, deploy gate |

## Readiness vs liveness

| Surface | Route | Role |
| --- | --- | --- |
| Cloud Functions | `GET` on export `health` | **Readiness** — deploy contract + Firestore + `jobWorker` Cloud Tasks queue (`cloudtasks.googleapis.com` GET); HTTP 503 when any required check fails |
| Cloud Functions | `GET` on export `healthLive` | **Liveness** — `{ status: "ok", probe: "liveness" }`; no metadata, contract or dependency I/O |
| Corpus API | `GET /health` | **Readiness** — bounded PostgreSQL `SELECT 1` (2s timeout); telemetry fields from background cache only |
| Corpus API | `GET /health/live` | **Liveness** — no database or vault I/O |

## FA-F44-004 IAM evidence

| Artifact | Grant |
| --- | --- |
| `infra/deploy-manifest.json` → `identities.runtime.projectRoles` | `roles/cloudtasks.viewer` — "F44 readiness: GET jobWorker queue from health probe" |
| `infra/terraform/iam.tf` | `google_project_iam_member.runtime_4` binds the same role to `sikander-functions@` |

## Scope note

F44 only. Corpus Celery/Redis readiness, object-store telemetry, and FA-F44-005 (dashboard cache semantics) are out of scope unless trivial.

| Claim | Value |
| --- | --- |
| OR-1..OR-4 | unchanged |
| backend_real | false |
| frontend_real | false |
| transport_stub | true |
