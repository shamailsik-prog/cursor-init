#!/usr/bin/env python3
"""Render infra/terraform/*.tf from infra/deploy-manifest.json."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ALLOWED = {
    "terraform",
    "provider",
    "variable",
    "resource",
    "output",
    "data",
}

# Audit F43 R1 (FA-F43-R1-001; spec R15, R16). Each registered ERROR line carries `event: "<name>"` in its structured
# data, and each event gets a log-based alert policy of its own: a log-match condition must be its policy's only
# condition, and a log-match policy requires a notification rate limit.
EVENT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$")
LABEL_KEY = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
PAYLOAD_FIELD = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
# Second-generation functions log under Cloud Run revisions (spec R11a).
RUNTIME_RESOURCE_TYPE = "cloud_run_revision"
NOTIFICATION_RATE_LIMIT = "300s"
AUTO_CLOSE = "1800s"


def hcl_string(value: str) -> str:
    """A double-quoted HCL string literal: backslash, quote and control characters escaped, `${` and `%{` doubled."""
    out = []
    for ch in value:
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    return '"' + "".join(out).replace("${", "$${").replace("%{", "%%{") + '"'


def logging_string(value: str) -> str:
    """A double-quoted Cloud Logging query string: embedded quotation marks and backslashes escaped."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def event_filter(event: str) -> str:
    """The log filter of one registered event: its ERROR lines, by the structured `event` field (spec R15)."""
    if not EVENT_NAME.match(event):
        raise ValueError(f"alert event name not renderable: {event!r}")
    return f"resource.type={logging_string(RUNTIME_RESOURCE_TYPE)} AND severity={logging_string('ERROR')} AND jsonPayload.event={logging_string(event)}"


def policy_resource_name(event: str) -> str:
    return "log_" + re.sub(r"[^A-Za-z0-9_]", "_", event)


def render_alert_policy(policy: dict) -> str:
    event = policy["event"]
    name = policy_resource_name(event)
    labels = policy.get("labels") or {}
    extractor_lines = []
    for key, field in sorted(labels.items()):
        if not LABEL_KEY.match(key) or not PAYLOAD_FIELD.match(field):
            raise ValueError(f"alert label not renderable for {event}: {key!r} -> {field!r}")
        extractor_lines.append(f"        {key} = {hcl_string(f'EXTRACT(jsonPayload.{field})')}")
    extractors = ("\n      label_extractors = {\n" + "\n".join(extractor_lines) + "\n      }") if extractor_lines else ""
    return f'''resource "google_monitoring_alert_policy" "{name}" {{
  display_name = {hcl_string(f"ERROR log event {event}")}
  combiner     = "OR"
  conditions {{
    display_name = {hcl_string(event)}
    condition_matched_log {{
      filter = {hcl_string(event_filter(event))}{extractors}
    }}
  }}
  alert_strategy {{
    notification_rate_limit {{
      period = {hcl_string(NOTIFICATION_RATE_LIMIT)}
    }}
    auto_close = {hcl_string(AUTO_CLOSE)}
  }}
  documentation {{
    content   = {hcl_string("Runbook: " + policy["runbook"])}
    mime_type = "text/markdown"
  }}
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}}'''


def render_alert_policies(policies: list[dict]) -> str:
    functions = [p for p in policies if p.get("surface", "functions") == "functions"]
    names = [policy_resource_name(p["event"]) for p in functions]
    if len(set(names)) != len(names):
        raise ValueError("two alert events render to the same resource name")
    return "\n\n".join(render_alert_policy(p) for p in functions)


def render(manifest: dict) -> dict[str, str]:
    roles = manifest["identities"]["runtime"]["projectRoles"]
    role_blocks = "\n".join(
        f'resource "google_project_iam_member" "runtime_{i}" {{\n  project = var.project_id\n  role    = "{r["role"]}"\n  member  = "serviceAccount:${{google_service_account.runtime.email}}"\n}}'
        for i, r in enumerate(roles)
    )
    alert_policies = render_alert_policies(manifest.get("alerts", {}).get("policies", []))
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


def _strip_strings(text: str) -> tuple[str, list[str]]:
    """The text with every double-quoted string blanked (escapes honoured), and the problems found while lexing."""
    out: list[str] = []
    errors: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '"':
            j = i + 1
            while j < len(text) and text[j] != '"':
                if text[j] == "\n":
                    errors.append("newline inside a quoted string")
                    break
                j += 2 if text[j] == "\\" else 1
            out.append('""')
            i = j + 1
            continue
        if ch == "'":
            errors.append("single-quoted string (HCL strings are double-quoted)")
        out.append(ch)
        i += 1
    return "".join(out), errors


def validate_hcl(text: str) -> list[str]:
    errors: list[str] = []
    stripped, lex_errors = _strip_strings(text)
    errors.extend(lex_errors)
    if stripped.count("{") != stripped.count("}"):
        errors.append("unbalanced braces")
    for line in text.splitlines():
        if "roles/owner" in line or "roles/editor" in line:
            errors.append("primitive role in terraform output")
    errors.extend(_validate_alert_policies(text))
    return errors


def _validate_alert_policies(text: str) -> list[str]:
    """Spec R16: every log-match policy has exactly one condition and a notification rate limit."""
    errors: list[str] = []
    for m in re.finditer(r'^resource "google_monitoring_alert_policy" "([^"]+)" \{\n(.*?)^\}', text, re.M | re.S):
        name, body = m.group(1), m.group(2)
        if body.count("conditions {") != 1:
            errors.append(f"alert policy {name}: {body.count('conditions {')} conditions (a log-match policy has exactly one)")
        if body.count("condition_matched_log {") != 1:
            errors.append(f"alert policy {name}: expected exactly one condition_matched_log")
        if "notification_rate_limit {" not in body:
            errors.append(f"alert policy {name}: no notification_rate_limit (required for a log-match policy)")
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
    invalid = [f"{name}: {err}" for name, content in rendered.items() for err in validate_hcl(content)]
    if invalid:
        # Spec R17: --check (G-0 [20]) and --write refuse output Terraform would reject.
        print("\n".join(invalid))
        return 1
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
