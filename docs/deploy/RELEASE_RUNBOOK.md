# Release runbook (F32 deploy contract)

Operators run this before promoting Functions to staging or production. Live deploy steps are **NOT DEMONSTRATED** in CI.

## Ordered steps

1. **terraform apply stage 1** — `infra/terraform`: APIs, service accounts, IAM, Firestore database import, alert policies. Use `-var project_id=PROJECT_ID -var oncall_email=you@example.com`.
2. **write functions/.env.<projectId> ingress and proxy settings** — edit the deploy env file Firebase reads at deploy time (`functions/.env.PROJECT_ID`). Set `SIKANDER_INGRESS_SETTINGS` and `TRUSTED_PROXY_HOPS` to the values your environment policy requires (staging/production use GCLB ingress with at least one trusted proxy hop). Do not generate this file from the manifest; it must reflect what you will deploy.
3. **bash scripts/deploy-preflight.sh --profile staging|production --project-id PROJECT_ID** — `PROJECT_ID` must match the manifest `environments.<profile>.gcpProjectId` (staging and production use different GCP projects). Builds the bundle and runs the static and bundle deploy-contract gate against `functions/.env.PROJECT_ID` only.
4. **firebase deploy** — after preflight passes.
5. **terraform apply stage 2** — load balancer front end after the `api` Cloud Run service exists.
6. **set SIKANDER_FUNCTIONS_API_BASE_URL on Vercel** — the external HTTPS URL of the load balancer, never a `run.app` or `cloudfunctions.net` URL once ingress is restricted.
7. **set the research corpus reader secrets on Vercel** — audit FA-D5-003 (`infra/deploy-manifest.json` `next.corpusResearch`). On the firm's corpus database, after `15-apply-annex-a.sh` has applied 005 and `20-provision-roles.sh` has run, create a login that is a member of `corpus_research_reader` and `corpus_clients` only (`corpus_service/README.md`, "The research reader login"). On Vercel set `SIKANDER_CORPUS_RESEARCH_READER_URL` (its DSN, `sslmode=verify-full`), `SIKANDER_CORPUS_RESEARCH_READER_CA` (the PEM CA) and `SIKANDER_CORPUS_MAX_STALENESS_HOURS`; leave `SIKANDER_RESEARCH_CORPUS` unset. Without them WhatsApp `/research` answers 503 `corpus_unavailable`.

## Contract alerts

- `deploy.contract_violation` — unsafe ingress/proxy combination or missing required env at Functions load; fix `SIKANDER_INGRESS_SETTINGS` and `TRUSTED_PROXY_HOPS` in `functions/.env.<projectId>` before redeploying.

## Registered ERROR log events (Cloud Monitoring)

`deploy.contract_violation`, `p1.reservation_exceeded`, `p1.usage_log_failed`, `p1.receipt_record_failed`, `p1.overhead_learned`, `p1.overhead_anomaly`, `p1.reconcile_failed`, `p1.reconcile_quarantined`, `p1.reconcile_failure_uncounted`, `p1.reconcile_pass_failed`, `autoconfirm.backlog_stale`, `job.deadLettered`, `audit.outbox_backlog_stale`, `audit.outbox_dead_lettered`, `audit.outbox_row_dead_lettered`, `audit.outbox_reconcile_failed`, `audit.outbox_sweep_failed`.

See also `functions/src/p1/README.md` and `functions/src/p2/README.md` for operator detail on P1 and job runtime alerts.
