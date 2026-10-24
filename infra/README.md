# Infrastructure projection (F32)

`deploy-manifest.json` is the source of truth for the production deployment contract. `render_terraform.py` generates `terraform/*.tf` for GCP resources that `firebase deploy` does not manage (IAM, Firestore database location, alert policies). Regenerate after manifest edits:

```bash
python3 infra/render_terraform.py --write
python3 infra/render_terraform.py --check
```

CI compares committed Terraform to the renderer output (`ci_gates/check_deploy_contract.py`).
