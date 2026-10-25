#!/usr/bin/env python3
"""Render infra/terraform/*.tf from infra/deploy-manifest.json."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

def _tf_policy_id(event: str) -> str:
    return "log_" + event.replace(".", "_")


def _log_alert_filter(event: str) -> str:
    # Double-quoted HCL; match structured `event` (firebase-functions 6.6+ stack-traces `message` on ERROR).
    inner = f'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.event="{event}"'
    return inner.replace('"', '\\"')


def _render_alert_policy(policy: dict) -> str:
    event = policy["event"]
    filt = _log_alert_filter(event)
    return f'''resource "google_monitoring_alert_policy" "{_tf_policy_id(event)}" {{
  display_name = "{event}"
  combiner     = "OR"
  conditions {{
    display_name = "{event}"
    condition_matched_log {{
      filter = "{filt}"
    }}
  }}
  alert_strategy {{
    notification_rate_limit {{
      period = "300s"
    }}
  }}
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}}'''


ALLOWED = {
    "terraform",
    "provider",
    "variable",
    "resource",
    "output",
    "data",
}


def render(manifest: dict) -> dict[str, str]:
    roles = manifest["identities"]["runtime"]["projectRoles"]
    role_blocks = "\n".join(
        f'resource "google_project_iam_member" "runtime_{i}" {{\n  project = var.project_id\n  role    = "{r["role"]}"\n  member  = "serviceAccount:${{google_service_account.runtime.email}}"\n}}'
        for i, r in enumerate(roles)
    )
    alerts = manifest.get("alerts", {}).get("policies", [])
    alert_policies = "\n\n".join(_render_alert_policy(a) for a in alerts)
    files = {
        "variables.tf": 'variable "project_id" { type = string }\nvariable "oncall_email" { type = string }\n',
        "iam.tf": f'''resource "google_service_account" "runtime" {{
  account_id   = "sikander-functions"
  display_name = "Sikander Cloud Functions runtime"
}}

{role_blocks}

resource "google_service_account_iam_member" "runtime_self_user" {{
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${{google_service_account.runtime.email}}"
}}
''',
        "database.tf": f'''resource "google_firestore_database" "default" {{
  project     = var.project_id
  name        = "(default)"
  location_id = "{manifest["project"]["database"]["location"]}"
  type        = "FIRESTORE_NATIVE"
}}
''',
        "alerts.tf": f'''resource "google_monitoring_notification_channel" "oncall" {{
  display_name = "On-call email"
  type         = "email"
  labels = {{
    email_address = var.oncall_email
  }}
}}

{alert_policies}
''',
    }
    return files


def validate_hcl(text: str) -> list[str]:
    errors: list[str] = []
    if text.count("{") != text.count("}"):
        errors.append("unbalanced braces")
    for line in text.splitlines():
        if "roles/owner" in line or "roles/editor" in line:
            errors.append("primitive role in terraform output")
        if "filter =" in line and "filter = '" in line:
            errors.append("log alert filter must use double-quoted HCL strings")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "infra/deploy-manifest.json").read_text(encoding="utf-8"))
    rendered = render(manifest)
    out_dir = root / "infra/terraform"
    if args.check:
        drift = []
        for name, content in rendered.items():
            path = out_dir / name
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                drift.append(name)
        if drift:
            print(f"terraform drift in: {', '.join(drift)}")
            return 1
        return 0
    if args.write:
        out_dir.mkdir(parents=True, exist_ok=True)
        for name, content in rendered.items():
            (out_dir / name).write_text(content, encoding="utf-8")
        return 0
    for content in rendered.values():
        for err in validate_hcl(content):
            print(err)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
