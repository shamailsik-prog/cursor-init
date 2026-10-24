# Infrastructure projection (F32)

`deploy-manifest.json` is the source of truth for the production deployment contract. `render_terraform.py` generates `terraform/*.tf` for GCP resources that `firebase deploy` does not manage (IAM, Firestore database location, alert policies). Regenerate after manifest edits:

```bash
python3 infra/render_terraform.py --write
python3 infra/render_terraform.py --check
```

CI compares committed Terraform to the renderer output (`ci_gates/check_deploy_contract.py`).

Alert policies (audit F43 R1): one `google_monitoring_alert_policy` per event in `alerts.policies`, each with exactly one log-match condition (`resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.event="<event>"`), `notification_rate_limit` 300 s, `auto_close` 1800 s, the runbook in `documentation`, and the on-call channel. Every registered ERROR line must carry `event: "<event>"` as the last field of its structured data (firebase-functions writes an ERROR line's message as a stack trace, so the message never equals the event); `functions/test/deploy-contract-alert-runtime.test.ts` enforces it. A policy's optional `labels` (`{ "page_id": "pageId" }`) become `label_extractors` (`EXTRACT(jsonPayload.<field>)`), which makes the rate limit apply per label value. `--check` and `--write` refuse output with a single-quoted string, a policy with more or fewer than one condition, or one without a rate limit. `terraform validate` is not run here (no binary in the repo's environment).
