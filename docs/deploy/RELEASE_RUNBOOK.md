# Release runbook (F32 deploy contract)

Operators run this before promoting Functions to staging or production. Live deploy steps are **NOT DEMONSTRATED** in CI.

## Ordered steps

1. **terraform apply stage 1** — `infra/terraform`: APIs, service accounts, IAM, Firestore database import, alert policies. Use `-var project_id=PROJECT_ID -var oncall_email=you@example.com`.
2. **write functions/.env from print-env** — `python3 ci_gates/check_deploy_contract.py --print-env production > functions/.env.PROJECT_ID`
3. **bash scripts/deploy-preflight.sh** — builds the bundle and runs the static and bundle deploy-contract gate with `--profile` and `--env-file`.
4. **firebase deploy** — after preflight passes.
5. **terraform apply stage 2** — load balancer front end after the `api` Cloud Run service exists.
6. **set SIKANDER_FUNCTIONS_API_BASE_URL on Vercel** — the external HTTPS URL of the load balancer, never a `run.app` or `cloudfunctions.net` URL once ingress is restricted.

## Contract alerts

- `deploy.contract_violation` — unsafe ingress/proxy combination or missing required env at Functions load; fix `SIKANDER_INGRESS_SETTINGS` and `TRUSTED_PROXY_HOPS` in `functions/.env.<projectId>` before redeploying.

## Registered ERROR log events (Cloud Monitoring)

`deploy.contract_violation`, `p1.reservation_exceeded`, `p1.usage_log_failed`, `p1.receipt_record_failed`, `p1.overhead_learned`, `p1.overhead_anomaly`, `p1.reconcile_failed`, `p1.reconcile_quarantined`, `p1.reconcile_failure_uncounted`, `p1.reconcile_pass_failed`, `autoconfirm.backlog_stale`, `job.deadLettered`, `audit.outbox_backlog_stale`, `audit.outbox_dead_lettered`, `audit.outbox_row_dead_lettered`, `audit.outbox_reconcile_failed`, `audit.outbox_sweep_failed`.

See also `functions/src/p1/README.md` and `functions/src/p2/README.md` for operator detail on P1 and job runtime alerts.
