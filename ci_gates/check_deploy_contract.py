#!/usr/bin/env python3
"""F32: static and bundle deploy-contract gate."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

PRIMITIVE_ROLES = {"roles/owner", "roles/editor", "roles/viewer"}
EXPORT_RE = re.compile(r"^\s*export\s+\{([^}]+)\}\s+from", re.M)
ERROR_EVENT_RE = re.compile(r'\.error\(\s*["\']([a-z][a-z0-9_.]+)["\']')
MAX_DURATION_RE = re.compile(r"export\s+const\s+maxDuration\s*=\s*(\d+)")


@dataclass(frozen=True)
class Finding:
    check: str
    message: str


def load_manifest(root: Path) -> dict:
    path = root / "infra/deploy-manifest.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("manifestVersion") != 1:
        raise SystemExit("FAIL [manifest] manifestVersion must be 1")
    return data


def _fail(check: str, message: str) -> Finding:
    return Finding(check, message)


def parse_index_exports(root: Path) -> set[str]:
    text = (root / "functions/src/index.ts").read_text(encoding="utf-8")
    names: set[str] = set()
    for block in EXPORT_RE.findall(text):
        for part in block.split(","):
            part = part.strip()
            if not part:
                continue
            if " as " in part:
                part = part.split(" as ")[-1].strip()
            names.add(part)
    return names


def run_static(root: Path, manifest: dict) -> list[Finding]:
    findings: list[Finding] = []
    findings.extend(_check_manifest_shape(manifest))
    findings.extend(_check_exports(root, manifest))
    findings.extend(_check_functions(manifest))
    findings.extend(_check_queues(manifest))
    findings.extend(_check_firebase_json(root, manifest))
    findings.extend(_check_ttl(root, manifest))
    findings.extend(_check_ttl_writers(root, manifest))
    findings.extend(_check_rules_ttl(root, manifest))
    findings.extend(_check_alerts(root, manifest))
    findings.extend(_check_alert_lines(root, manifest))
    findings.extend(_check_environments(manifest))
    findings.extend(_check_next(root, manifest))
    findings.extend(_check_iam(manifest))
    findings.extend(_check_runbook(root, manifest))
    findings.extend(_check_terraform(root, manifest))
    return findings


def _check_manifest_shape(manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    if manifest.get("project", {}).get("region") != "asia-south1":
        out.append(_fail("manifest", "project.region must be asia-south1"))
    if manifest.get("project", {}).get("database", {}).get("location") != "asia-south1":
        out.append(_fail("manifest", "database.location must be asia-south1"))
    return out


def _check_exports(root: Path, manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    manifest_names = {f["name"] for f in manifest.get("functions", [])}
    export_names = parse_index_exports(root)
    for name in sorted(manifest_names - export_names):
        out.append(_fail("exports", f"manifest function {name} is not exported from functions/src/index.ts"))
    for name in sorted(export_names - manifest_names):
        out.append(_fail("exports", f"export {name} is missing from the manifest"))
    return out


def _check_functions(manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    for fn in manifest.get("functions", []):
        for key in ("name", "region", "memory", "timeoutSeconds", "maxInstances", "serviceAccount", "ingress"):
            if key not in fn:
                out.append(_fail("functions", f"{fn.get('name', '?')} missing {key}"))
    return out


def _check_queues(manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    workers = [f for f in manifest.get("functions", []) if f.get("kind") == "taskQueue"]
    queues = manifest.get("queues", [])
    if len(workers) != len(queues):
        out.append(_fail("queues", "queue count must match taskQueue functions"))
    return out


def _check_firebase_json(root: Path, manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    fb = json.loads((root / "firebase.json").read_text(encoding="utf-8"))
    if fb.get("firestore", {}).get("location") != manifest["project"]["database"]["location"]:
        out.append(_fail("firebase-json", "firestore.location mismatch"))
    if fb.get("functions", {}).get("runtime") != manifest["runtime"]["nodejs"]:
        out.append(_fail("firebase-json", "functions.runtime mismatch"))
    return out


def _check_ttl(root: Path, manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    indexes = json.loads((root / "firestore.indexes.json").read_text(encoding="utf-8"))
    overrides = indexes.get("fieldOverrides", [])
    for ttl in manifest.get("firestore", {}).get("ttl", []):
        match = next(
            (o for o in overrides if o.get("collectionGroup") == ttl["collectionGroup"] and o.get("fieldPath") == ttl["fieldPath"]),
            None,
        )
        if not match or not match.get("ttl"):
            out.append(_fail("ttl", f"missing ttl override for {ttl['collectionGroup']}.{ttl['fieldPath']}"))
    return out


def _check_ttl_writers(root: Path, manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    declared = {w for t in manifest.get("firestore", {}).get("ttl", []) for w in t.get("writers", [])}
    for writer in declared:
        if not (root / writer).is_file():
            out.append(_fail("ttl-writers", f"TTL writer missing: {writer}"))
    return out


def _check_rules_ttl(root: Path, manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    rules = (root / "firestore.rules").read_text(encoding="utf-8")
    for ttl in manifest.get("firestore", {}).get("ttl", []):
        cg = ttl["collectionGroup"]
        m = re.search(rf"match\s+/{re.escape(cg)}/[^{{]+\{{([^}}]+)\}}", rules, re.S)
        if not m:
            continue
        body = m.group(1)
        if re.search(r"allow\s+read", body) and "if false" not in body:
            out.append(_fail("rules", f"TTL collection {cg} must not be client-readable"))
    return out


def _scan_expires_at_files(root: Path) -> set[str]:
    hits: set[str] = set()
    for base in (root / "functions/src", root / "platform/http"):
        if not base.is_dir():
            continue
        for path in base.rglob("*.ts"):
            if "expiresAt" in path.read_text(encoding="utf-8", errors="ignore"):
                hits.add(path.relative_to(root).as_posix())
    return hits


def _check_unclassified_expires_at(root: Path, manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    writers = {w for t in manifest.get("firestore", {}).get("ttl", []) for w in t.get("writers", [])}
    exempt = {e["path"] for e in manifest.get("firestore", {}).get("ttlExemptions", [])}
    for rel_str in _scan_expires_at_files(root):
        if rel_str not in writers and rel_str not in exempt:
            out.append(_fail("ttl", f"unclassified expiresAt writer {rel_str}"))
    return out


def _check_alerts(root: Path, manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    for policy in manifest.get("alerts", {}).get("policies", []):
        event = policy["event"]
        rb = root / policy["runbook"]
        if not rb.is_file():
            out.append(_fail("alerts", f"runbook missing for {event}"))
            continue
        if event not in rb.read_text(encoding="utf-8"):
            out.append(_fail("alerts", f"event {event} not mentioned in runbook"))
        for rel in policy.get("files", []):
            fp = root / rel
            if not fp.is_file() or event not in fp.read_text(encoding="utf-8"):
                out.append(_fail("alert-lines", f"event {event} not found in {rel}"))
    return out


def _check_alert_lines(root: Path, manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    registered = {p["event"] for p in manifest.get("alerts", {}).get("policies", [])}
    registered |= {e["event"] for e in manifest.get("alerts", {}).get("exemptions", [])}
    src = root / "functions/src"
    for path in src.rglob("*.ts"):
        text = path.read_text(encoding="utf-8", errors="ignore")
        for event in ERROR_EVENT_RE.findall(text):
            if event not in registered:
                out.append(_fail("alert-lines", f"unregistered ERROR event {event} in {path.relative_to(root)}"))
    return out


def _check_environments(manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    envs = manifest.get("environments", {})
    prod = envs.get("production", {}).get("env", {})
    stg = envs.get("staging", {}).get("env", {})
    if prod.get("SIKANDER_INGRESS_SETTINGS") == "ALLOW_ALL":
        out.append(_fail("environments", "production profile must not use ALLOW_ALL"))
    if prod != stg:
        out.append(_fail("environments", "staging and production contract env must match"))
    return out


def _check_next(root: Path, manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    for route in manifest.get("next", {}).get("routes", []):
        fp = root / route["file"]
        if not fp.is_file():
            out.append(_fail("next", f"missing route file {route['file']}"))
            continue
        m = MAX_DURATION_RE.search(fp.read_text(encoding="utf-8"))
        if not m or int(m.group(1)) != route["maxDuration"]:
            out.append(_fail("next", f"maxDuration mismatch in {route['file']}"))
    listed = {r["file"] for r in manifest.get("next", {}).get("routes", [])}
    for path in (root / "app").rglob("route.ts"):
        rel = path.relative_to(root).as_posix()
        text = path.read_text(encoding="utf-8")
        if MAX_DURATION_RE.search(text) and rel not in listed:
            out.append(_fail("next", f"route exports maxDuration but is not listed: {rel}"))
    return out


def _check_iam(manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    for role in manifest.get("identities", {}).get("runtime", {}).get("projectRoles", []):
        role_id = role.get("role") if isinstance(role, dict) else role
        if role_id in PRIMITIVE_ROLES:
            out.append(_fail("iam", f"primitive role forbidden: {role_id}"))
    return out


def _check_runbook(root: Path, manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    rb_path = root / "docs/deploy/RELEASE_RUNBOOK.md"
    if not rb_path.is_file():
        return [_fail("runbook", "docs/deploy/RELEASE_RUNBOOK.md missing")]
    text = rb_path.read_text(encoding="utf-8").lower()
    steps = manifest.get("runbook", {}).get("orderedSteps", [])
    pos = -1
    for step in steps:
        key = step.lower()
        idx = text.find(key)
        if idx < 0 or idx < pos:
            out.append(_fail("runbook", f"runbook step out of order or missing: {step}"))
        pos = idx
    if "firebase deploy" in text and "deploy-preflight" in text:
        if text.find("firebase deploy") < text.find("deploy-preflight"):
            out.append(_fail("runbook", "firebase deploy must follow deploy-preflight"))
    return out


def _check_terraform(root: Path, manifest: dict) -> list[Finding]:
    out: list[Finding] = []
    render = root / "infra/render_terraform.py"
    if not render.is_file():
        return [_fail("terraform", "infra/render_terraform.py missing")]
    proc = subprocess.run([sys.executable, str(render), "--check"], cwd=root, capture_output=True, text=True)
    if proc.returncode != 0:
        out.append(_fail("terraform", proc.stdout.strip() or proc.stderr.strip() or "terraform drift"))
    return out


def compare_endpoints(manifest: dict, endpoints: dict, profile: str) -> list[Finding]:
    out: list[Finding] = []
    env = manifest.get("environments", {}).get(profile, {}).get("env", {})
    by_name = {f["name"]: f for f in manifest.get("functions", [])}
    for name, spec in by_name.items():
        ep = endpoints.get(name)
        if not ep:
            out.append(_fail("endpoints", f"missing endpoint {name} in bundle"))
            continue
        if ep.get("region") != [spec["region"]]:
            out.append(_fail("endpoints", f"{name} region mismatch"))
        if ep.get("maxInstances") != spec.get("maxInstances"):
            out.append(_fail("endpoints", f"{name} maxInstances mismatch"))
        if ep.get("timeoutSeconds") != spec.get("timeoutSeconds"):
            out.append(_fail("endpoints", f"{name} timeout mismatch"))
        if ep.get("availableMemoryMb") != 256:
            out.append(_fail("endpoints", f"{name} memory mismatch"))
        if ep.get("concurrency") != spec.get("concurrency"):
            out.append(_fail("endpoints", f"{name} concurrency mismatch"))
        if ep.get("minInstances") != spec.get("minInstances"):
            out.append(_fail("endpoints", f"{name} minInstances mismatch"))
        if ep.get("serviceAccountEmail") != spec.get("serviceAccount"):
            out.append(_fail("endpoints", f"{name} service account mismatch"))
        ingress = spec.get("ingress")
        expected_ingress = env.get("SIKANDER_INGRESS_SETTINGS", "ALLOW_ALL") if ingress == "env:SIKANDER_INGRESS_SETTINGS" else ingress
        if ep.get("ingressSettings") != expected_ingress:
            out.append(_fail("endpoints", f"{name} ingress mismatch"))
        if name == "jobWorker":
            inv = (ep.get("taskQueueTrigger") or {}).get("invoker")
            if inv != spec.get("invoker"):
                out.append(_fail("endpoints", "jobWorker invoker mismatch"))
    for extra in set(endpoints) - set(by_name):
        out.append(_fail("endpoints", f"unexpected export in bundle: {extra}"))
    return out


def check_env_file(manifest: dict, profile: str, text: str) -> list[Finding]:
    out: list[Finding] = []
    expected = manifest.get("environments", {}).get(profile, {}).get("env", {})
    for key, value in expected.items():
        if f"{key}={value}" not in text.replace(" ", "") and f'{key}="{value}"' not in text:
            if not re.search(rf"^{re.escape(key)}={re.escape(value)}\s*$", text, re.M):
                out.append(_fail("env-file", f"missing or wrong {key} for profile {profile}"))
    return out


def print_env(manifest: dict, profile: str) -> str:
    env = manifest.get("environments", {}).get(profile, {}).get("env", {})
    lines = [f"{k}={v}" for k, v in sorted(env.items())]
    return "\n".join(lines) + ("\n" if lines else "")


def load_endpoints_dump(root: Path, manifest: dict, profile: str) -> dict:
    script = root / "functions/scripts/dump-endpoints.cjs"
    env = os.environ.copy()
    env.update(manifest.get("environments", {}).get(profile, {}).get("env", {}))
    raw = subprocess.check_output(["node", str(script)], cwd=root / "functions", text=True, env=env)
    return json.loads(raw)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", action="store_true")
    parser.add_argument("--profile", default="production")
    parser.add_argument("--env-file")
    parser.add_argument("--print-env", nargs="?", const="production")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    manifest = load_manifest(root)
    if args.print_env is not None:
        profile = args.print_env if isinstance(args.print_env, str) else "production"
        sys.stdout.write(print_env(manifest, profile))
        return 0
    findings = run_static(root, manifest)
    findings.extend(_check_unclassified_expires_at(root, manifest))
    if args.bundle:
        findings.extend(compare_endpoints(manifest, load_endpoints_dump(root, manifest, args.profile), args.profile))
        if args.env_file:
            findings.extend(check_env_file(manifest, args.profile, Path(args.env_file).read_text(encoding="utf-8")))
    if findings:
        for f in findings:
            print(f"FAIL [{f.check}] {f.message}")
        return 1
    print("PASS: deploy contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
