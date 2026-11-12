#!/usr/bin/env python3
"""Offline drift comparer: a read-only JSON snapshot vs infra/deploy-manifest.json.

Reads JSON files only. No network and no gcloud. Does not import subprocess, socket,
urllib, http, requests, or google, and does not call os.system or os.popen.
Never prints the value of an environment variable outside the three contract keys,
and prefers not to print those values either.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

from check_deploy_contract import load_manifest, profile_gcp_project_id, runtime_service_account_email

CONTRACT_ENV_KEYS = (
    "SIKANDER_DEPLOY_PROFILE",
    "SIKANDER_INGRESS_SETTINGS",
    "TRUSTED_PROXY_HOPS",
)
_MEM = re.compile(r"^([0-9]+)(MiB|Mi|M)$")
_LOCATION = re.compile(r"/locations/([^/]+)/")
_MISSING = object()
# Missing file or a real JSON parse error. Distinct from json.loads("null"), which is None.
_BAD_JSON = object()


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, str]] = []

    def add(self, status: str, check: str, subject: str, reason: str) -> None:
        self.rows.append((status, check, subject, reason))

    def fail(self, check: str, subject: str, reason: str) -> None:
        self.add("FAIL", check, subject, reason)

    def ok(self, check: str, subject: str, reason: str) -> None:
        self.add("PASS", check, subject, reason)

    def info(self, check: str, subject: str, reason: str) -> None:
        self.add("INFO", check, subject, reason)


def _dig(obj: object, path: str) -> object:
    current = obj
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return _MISSING
        current = current[part]
    return current


def _require(report: Report, obj: object, path: str, check: str, subject: str, typ: type) -> object | None:
    value = _dig(obj, path)
    if value is _MISSING:
        report.fail(check, subject, f"field missing: {path}")
        return None
    if typ is int:
        if isinstance(value, bool) or not isinstance(value, int):
            report.fail(check, subject, f"field wrong type: {path}")
            return None
        return value
    if not isinstance(value, typ):
        report.fail(check, subject, f"field wrong type: {path}")
        return None
    return value


def _norm_memory(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    match = _MEM.fullmatch(value)
    if not match:
        return None
    return f"{match.group(1)}MiB"


def _function_name(raw: str) -> str:
    if "/functions/" in raw:
        return raw.split("/functions/", 1)[1]
    return raw


def _read_bytes(snapshot: Path, rel: str, report: Report, hashes: list[tuple[str, str]]) -> bytes | None:
    path = snapshot / rel
    if not path.is_file():
        report.fail("parse", rel, "file missing")
        return None
    data = path.read_bytes()
    hashes.append((rel, hashlib.sha256(data).hexdigest()))
    return data


def _parse_json(data: bytes, rel: str, report: Report) -> object:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        report.fail("parse", rel, "JSON parse error")
        return _BAD_JSON


def _roles_for_member(policy: object, member: str, report: Report, check: str, subject: str) -> set[str] | None:
    if not isinstance(policy, dict):
        report.fail(check, subject, "field wrong type: bindings")
        return None
    bindings = policy.get("bindings")
    if not isinstance(bindings, list):
        report.fail(check, subject, "field missing: bindings")
        return None
    roles: set[str] = set()
    for binding in bindings:
        if not isinstance(binding, dict):
            report.fail(check, subject, "field wrong type: bindings")
            return None
        role = binding.get("role")
        members = binding.get("members")
        if not isinstance(role, str) or not isinstance(members, list) or not all(isinstance(m, str) for m in members):
            report.fail(check, subject, "field wrong type: bindings.role")
            return None
        if member in members:
            roles.add(role)
    return roles


def _enabled_api_names(doc: object, report: Report) -> set[str] | None:
    if isinstance(doc, list):
        items = doc
    elif isinstance(doc, dict) and isinstance(doc.get("services"), list):
        items = doc["services"]
    else:
        report.fail("apis", "services-enabled.json", "field wrong type: services-enabled.json")
        return None
    names: set[str] = set()
    for item in items:
        if isinstance(item, str):
            names.add(item.rsplit("/", 1)[-1])
            continue
        if not isinstance(item, dict):
            report.fail("apis", "services-enabled.json", "field wrong type: services")
            return None
        config = item.get("config")
        if isinstance(config, dict) and isinstance(config.get("name"), str):
            names.add(config["name"])
        raw_name = item.get("name")
        if isinstance(raw_name, str):
            names.add(raw_name.rsplit("/", 1)[-1])
    return names


def _expected_ingress(spec: dict, manifest: dict, profile: str) -> str | None:
    ingress = spec.get("ingress")
    if not isinstance(ingress, str):
        return None
    if ingress == "env:SIKANDER_INGRESS_SETTINGS":
        env = manifest.get("environments", {}).get(profile, {}).get("env", {})
        value = env.get("SIKANDER_INGRESS_SETTINGS") if isinstance(env, dict) else None
        if not isinstance(value, str):
            return None
        return value
    return ingress


def _check_function(doc: object, spec: dict, manifest: dict, profile: str, sa_email: str, report: Report) -> None:
    name = spec.get("name")
    if not isinstance(name, str):
        report.fail("inventory", "function", "field missing: name")
        return
    if not isinstance(doc, dict):
        report.fail("parse", f"functions/{name}.json", "field wrong type: function")
        return
    raw_name = _require(report, doc, "name", "region", name, str)
    if isinstance(raw_name, str):
        match = _LOCATION.search(raw_name)
        if not match:
            report.fail("region", name, "field missing: name locations segment")
        elif match.group(1) != spec.get("region"):
            report.fail("region", name, "region mismatch")
        else:
            report.ok("region", name, "region match")
    environment = _require(report, doc, "environment", "environment", name, str)
    if isinstance(environment, str):
        if environment != "GEN_2":
            report.fail("environment", name, "environment mismatch")
        else:
            report.ok("environment", name, "GEN_2")
    runtime = _require(report, doc, "buildConfig.runtime", "runtime", name, str)
    if isinstance(runtime, str):
        if runtime != manifest.get("runtime", {}).get("nodejs"):
            report.fail("runtime", name, "runtime mismatch")
        else:
            report.ok("runtime", name, "runtime match")
    memory = _dig(doc, "serviceConfig.availableMemory")
    if memory is _MISSING:
        report.fail("memory", name, "field missing: serviceConfig.availableMemory")
    elif not isinstance(memory, str):
        report.fail("memory", name, "field wrong type: serviceConfig.availableMemory")
    else:
        got = _norm_memory(memory)
        want = _norm_memory(spec.get("memory"))
        if got is None or want is None:
            report.fail("memory", name, "unknown unit")
        elif got != want:
            report.fail("memory", name, "normalised mismatch")
        else:
            report.ok("memory", name, "normalised match")
    for snap_path, manifest_key, check in (
        ("serviceConfig.timeoutSeconds", "timeoutSeconds", "timeout"),
        ("serviceConfig.minInstanceCount", "minInstances", "min-instances"),
        ("serviceConfig.maxInstanceCount", "maxInstances", "max-instances"),
        ("serviceConfig.maxInstanceRequestConcurrency", "concurrency", "concurrency"),
    ):
        got_n = _require(report, doc, snap_path, check, name, int)
        if isinstance(got_n, int) and got_n == spec.get(manifest_key):
            report.ok(check, name, "match")
        elif isinstance(got_n, int):
            report.fail(check, name, "mismatch")
    want_sa = spec.get("serviceAccount")
    if isinstance(want_sa, str) and want_sa.endswith("@"):
        want_sa = sa_email
    got_sa = _require(report, doc, "serviceConfig.serviceAccountEmail", "service-account", name, str)
    if isinstance(got_sa, str):
        if got_sa != want_sa:
            report.fail("service-account", name, "service account mismatch")
        else:
            report.ok("service-account", name, "service account match")
    expected_ingress = _expected_ingress(spec, manifest, profile)
    got_ingress = _require(report, doc, "serviceConfig.ingressSettings", "ingress", name, str)
    if isinstance(got_ingress, str):
        if expected_ingress is None:
            report.fail("ingress", name, "field missing: environments ingress")
        elif got_ingress != expected_ingress:
            report.fail("ingress", name, "ingress mismatch")
        else:
            report.ok("ingress", name, "ingress match")
    if name != "api":
        return
    env = _dig(doc, "serviceConfig.environmentVariables")
    if not isinstance(env, dict):
        report.fail("env", "api", "field missing: serviceConfig.environmentVariables")
        return
    expected_env = manifest.get("environments", {}).get(profile, {}).get("env", {})
    if not isinstance(expected_env, dict):
        report.fail("env", "api", "field missing: environments env")
        return
    for key in CONTRACT_ENV_KEYS:
        if key not in env:
            report.fail("env", "api", f"field missing: serviceConfig.environmentVariables.{key}")
            continue
        got_env = env[key]
        if not isinstance(got_env, str):
            report.fail("env", "api", f"field wrong type: serviceConfig.environmentVariables.{key}")
            continue
        if got_env != expected_env.get(key):
            report.fail("env", "api", f"{key} mismatch")
        else:
            report.ok("env", "api", f"{key} match")


def _check_inventory(listing: object, functions: list, report: Report) -> None:
    if not isinstance(listing, list):
        report.fail("inventory", "functions-list.json", "field wrong type: functions-list.json")
        return
    names: list[str] = []
    for item in listing:
        raw = item if isinstance(item, str) else item.get("name") if isinstance(item, dict) else _MISSING
        if not isinstance(raw, str):
            report.fail("inventory", "functions-list.json", "field missing: name")
            return
        names.append(_function_name(raw))
    got = set(names)
    want = {fn.get("name") for fn in functions if isinstance(fn, dict)}
    extras = sorted(n for n in got - want if isinstance(n, str))
    missing = sorted(n for n in want - got if isinstance(n, str))
    for extra in extras:
        report.fail("inventory", extra, "deployed function not in the manifest")
    for name in missing:
        report.fail("inventory", name, "manifest function missing from functions-list.json")
    if not extras and not missing and len(names) == len(got):
        report.ok("inventory", "functions-list", "exact manifest set")
    elif not extras and not missing:
        report.fail("inventory", "functions-list", "duplicate function name")


def _check_iam(policy: object, manifest: dict, sa_email: str, report: Report) -> None:
    member = f"serviceAccount:{sa_email}"
    got = _roles_for_member(policy, member, report, "iam", "runtime-sa")
    if got is None:
        return
    declared = manifest.get("identities", {}).get("runtime", {}).get("projectRoles", [])
    if not isinstance(declared, list):
        report.fail("iam", "runtime-sa", "field missing: identities.runtime.projectRoles")
        return
    want: set[str] = set()
    for role in declared:
        role_id = role.get("role") if isinstance(role, dict) else role
        if not isinstance(role_id, str):
            report.fail("iam", "runtime-sa", "field wrong type: projectRoles.role")
            return
        want.add(role_id)
    for role in sorted(want - got):
        report.fail("iam", "runtime-sa", f"missing role {role}")
    for role in sorted(got - want):
        report.fail("iam", "runtime-sa", f"extra role {role}")
    if got == want:
        report.ok("iam", "runtime-sa", "project roles match")


def _check_act_as(policy: object, sa_email: str, report: Report) -> None:
    member = f"serviceAccount:{sa_email}"
    got = _roles_for_member(policy, member, report, "act-as", "runtime-sa")
    if got is None:
        return
    if "roles/iam.serviceAccountUser" not in got:
        report.fail("act-as", "runtime-sa", "roles/iam.serviceAccountUser not granted to the runtime service account")
    else:
        report.ok("act-as", "runtime-sa", "self actAs granted")


def _check_queue(doc: object, spec: dict, report: Report) -> None:
    name = spec.get("function")
    if not isinstance(name, str):
        report.fail("queue", "queue", "field missing: function")
        return
    if not isinstance(doc, dict):
        report.fail("queue", name, "field wrong type: queue")
        return
    retry = spec.get("retryConfig")
    if not isinstance(retry, dict):
        report.fail("queue", name, "field missing: retryConfig")
        return
    for key in ("maxConcurrentDispatches", "maxDispatchesPerSecond"):
        got = _require(report, doc, f"rateLimits.{key}", "queue", name, int)
        if isinstance(got, int) and got == spec.get(key):
            report.ok("queue", name, f"{key} match")
        elif isinstance(got, int):
            report.fail("queue", name, f"{key} mismatch")
    got_attempts = _require(report, doc, "retryConfig.maxAttempts", "queue", name, int)
    if isinstance(got_attempts, int) and got_attempts == retry.get("maxAttempts"):
        report.ok("queue", name, "maxAttempts match")
    elif isinstance(got_attempts, int):
        report.fail("queue", name, "maxAttempts mismatch")
    for snap_key, manifest_key in (("minBackoff", "minBackoffSeconds"), ("maxBackoff", "maxBackoffSeconds")):
        seconds = retry.get(manifest_key)
        if seconds is None:
            report.info("queue", name, manifest_key)
            continue
        got = _dig(doc, f"retryConfig.{snap_key}")
        if got is _MISSING:
            report.fail("queue", name, f"field missing: retryConfig.{snap_key}")
            continue
        if not isinstance(got, str):
            report.fail("queue", name, f"field wrong type: retryConfig.{snap_key}")
            continue
        if got != f"{int(seconds)}s":
            report.fail("queue", name, f"{snap_key} mismatch")
        else:
            report.ok("queue", name, f"{snap_key} match")
    for key in ("maxDoublings", "maxRetrySeconds"):
        if retry.get(key) is None:
            report.info("queue", name, key)


def _check_apis(doc: object, manifest: dict, report: Report) -> None:
    names = _enabled_api_names(doc, report)
    if names is None:
        return
    apis = manifest.get("apis")
    if not isinstance(apis, list):
        report.fail("apis", "manifest", "field missing: apis")
        return
    for api in apis:
        if not isinstance(api, str):
            report.fail("apis", "manifest", "field wrong type: apis")
            continue
        if api not in names:
            report.fail("apis", api, "not enabled")
        else:
            report.ok("apis", api, "enabled")


def _expected_rels(functions: list, queues: list) -> list[str]:
    rels = ["provenance.txt", "functions-list.json"]
    for fn in functions:
        if isinstance(fn, dict) and isinstance(fn.get("name"), str):
            rels.append(f"functions/{fn['name']}.json")
    rels.extend(["iam-policy.json", "runtime-sa-iam-policy.json", "queues-list.json"])
    for queue in queues:
        if isinstance(queue, dict) and isinstance(queue.get("function"), str):
            rels.append(f"queue-{queue['function']}.json")
    rels.append("services-enabled.json")
    return rels


def _emit(manifest_sha: str, profile: str, project_id: str, hashes: list[tuple[str, str]], commit_line: str | None, report: Report) -> int:
    lines = [
        f"manifest_sha256: {manifest_sha}",
        f"profile: {profile}",
        f"project_id: {project_id}",
    ]
    for rel, digest in hashes:
        lines.append(f"snapshot_sha256 {rel} {digest}")
    if commit_line is not None:
        lines.append(commit_line)
    fails = 0
    checks = 0
    for status, check, subject, reason in report.rows:
        if status == "INFO":
            lines.append(f"INFO not pinned {check} {subject}: {reason}")
            continue
        lines.append(f"{status} {check} {subject}: {reason}")
        checks += 1
        if status == "FAIL":
            fails += 1
    if fails:
        lines.append(f"RESULT: FAIL ({fails} of {checks})")
        code = 1
    else:
        lines.append(f"RESULT: PASS ({checks} checks)")
        code = 0
    sys.stdout.write("\n".join(lines) + "\n")
    return code


def compare(snapshot: Path, manifest: dict, profile: str, manifest_sha: str, project_id: str) -> int:
    report = Report()
    hashes: list[tuple[str, str]] = []
    functions = manifest.get("functions")
    queues = manifest.get("queues")
    if not isinstance(functions, list) or not isinstance(queues, list):
        report.fail("manifest", profile, "field missing: functions")
        return _emit(manifest_sha, profile, project_id, hashes, None, report)
    sa_email = runtime_service_account_email(manifest, profile)
    parsed: dict[str, object] = {}
    commit_line: str | None = None
    for rel in _expected_rels(functions, queues):
        data = _read_bytes(snapshot, rel, report, hashes)
        if data is None:
            parsed[rel] = _BAD_JSON
            continue
        if rel == "provenance.txt":
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                report.fail("provenance", "provenance.txt", "unreadable")
                parsed[rel] = _BAD_JSON
                continue
            for line in text.splitlines():
                if line.startswith("commit:"):
                    commit_line = line
                    break
            if commit_line is None:
                report.fail("provenance", "provenance.txt", "commit: line absent")
            else:
                report.ok("provenance", "provenance.txt", "commit line present")
            parsed[rel] = text
            continue
        parsed[rel] = _parse_json(data, rel, report)
    listing = parsed["functions-list.json"]
    if listing is not _BAD_JSON:
        _check_inventory(listing, functions, report)
    for fn in functions:
        if not isinstance(fn, dict) or not isinstance(fn.get("name"), str):
            report.fail("inventory", "function", "field missing: name")
            continue
        rel = f"functions/{fn['name']}.json"
        doc = parsed[rel]
        if doc is _BAD_JSON:
            if (snapshot / rel).is_file():
                continue
            report.fail("inventory", fn["name"], f"file missing: {rel}")
            continue
        _check_function(doc, fn, manifest, profile, sa_email, report)
    iam = parsed["iam-policy.json"]
    if iam is not _BAD_JSON:
        _check_iam(iam, manifest, sa_email, report)
    act = parsed["runtime-sa-iam-policy.json"]
    if act is not _BAD_JSON:
        _check_act_as(act, sa_email, report)
    queues_list = parsed["queues-list.json"]
    if queues_list is not _BAD_JSON and not isinstance(queues_list, list):
        report.fail("parse", "queues-list.json", "field wrong type: queues-list.json")
    for queue in queues:
        if not isinstance(queue, dict) or not isinstance(queue.get("function"), str):
            report.fail("queue", "queue", "field missing: function")
            continue
        rel = f"queue-{queue['function']}.json"
        doc = parsed[rel]
        if doc is _BAD_JSON:
            continue
        _check_queue(doc, queue, report)
    services = parsed["services-enabled.json"]
    if services is not _BAD_JSON:
        _check_apis(services, manifest, report)
    return _emit(manifest_sha, profile, project_id, hashes, commit_line, report)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False, prog="check_deploy_drift.py")
    parser.add_argument("--profile", required=True, choices=("staging", "production"))
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--manifest", default=None)
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    if args.manifest:
        manifest_path = Path(args.manifest)
        try:
            manifest_bytes = manifest_path.read_bytes()
            manifest = json.loads(manifest_bytes.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            sys.stdout.write("FAIL manifest manifest: JSON parse error\nRESULT: FAIL (1 of 1)\n")
            return 1
        if manifest.get("manifestVersion") != 1:
            sys.stdout.write("FAIL manifest manifest: field missing: manifestVersion\nRESULT: FAIL (1 of 1)\n")
            return 1
    else:
        manifest_path = root / "infra" / "deploy-manifest.json"
        try:
            manifest_bytes = manifest_path.read_bytes()
        except OSError:
            sys.stdout.write("FAIL manifest manifest: file missing\nRESULT: FAIL (1 of 1)\n")
            return 1
        manifest = load_manifest(root)
    project_id = profile_gcp_project_id(manifest, args.profile)
    if not isinstance(project_id, str) or not project_id:
        sys.stdout.write("FAIL manifest profile: field missing: gcpProjectId\nRESULT: FAIL (1 of 1)\n")
        return 1
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    try:
        return compare(Path(args.snapshot), manifest, args.profile, manifest_sha, project_id)
    except Exception as exc:
        sys.stdout.write(f"FAIL tool drift: internal error {type(exc).__name__}\nRESULT: FAIL (1 of 1)\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
