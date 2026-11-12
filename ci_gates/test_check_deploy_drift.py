#!/usr/bin/env python3
"""Planted-mismatch tests for the offline deploy drift comparer. Stdlib only. No network."""
from __future__ import annotations

import ast
import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_deploy_contract as contract
import check_deploy_drift as drift

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "deploy-drift"
PLANTED = "q05-planted-not-a-secret-value"
COMMIT = "commit: 1111111111111111111111111111111111111111"
MEMORY = ("256MiB", "256Mi", "256M")


def _write(path: Path, doc: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


def build_passing(snapshot: Path, manifest: dict, profile: str) -> None:
    snapshot.mkdir(parents=True, exist_ok=True)
    project = contract.profile_gcp_project_id(manifest, profile)
    email = contract.runtime_service_account_email(manifest, profile)
    env = manifest["environments"][profile]["env"]
    listed = []
    for index, fn in enumerate(manifest["functions"]):
        ingress = fn["ingress"]
        if ingress == "env:SIKANDER_INGRESS_SETTINGS":
            ingress = env["SIKANDER_INGRESS_SETTINGS"]
        doc = {
            "name": f"projects/{project}/locations/{fn['region']}/functions/{fn['name']}",
            "environment": "GEN_2",
            "state": "ACTIVE",
            "buildConfig": {"runtime": manifest["runtime"]["nodejs"], "entryPoint": fn["name"]},
            "serviceConfig": {
                "serviceAccountEmail": email,
                "availableMemory": MEMORY[index % 3],
                "timeoutSeconds": fn["timeoutSeconds"],
                "minInstanceCount": fn["minInstances"],
                "maxInstanceCount": fn["maxInstances"],
                "maxInstanceRequestConcurrency": fn["concurrency"],
                "ingressSettings": ingress,
            },
        }
        if fn["name"] == "api":
            doc["serviceConfig"]["environmentVariables"] = {
                "SIKANDER_DEPLOY_PROFILE": env["SIKANDER_DEPLOY_PROFILE"],
                "SIKANDER_INGRESS_SETTINGS": env["SIKANDER_INGRESS_SETTINGS"],
                "TRUSTED_PROXY_HOPS": env["TRUSTED_PROXY_HOPS"],
            }
        _write(snapshot / "functions" / f"{fn['name']}.json", doc)
        listed.append({"name": doc["name"], "environment": "GEN_2", "state": "ACTIVE"})
    _write(snapshot / "functions-list.json", listed)
    member = f"serviceAccount:{email}"
    _write(
        snapshot / "iam-policy.json",
        {
            "bindings": [
                {"role": role["role"], "members": [member]}
                for role in manifest["identities"]["runtime"]["projectRoles"]
            ],
            "etag": "synthetic",
            "version": 1,
        },
    )
    _write(
        snapshot / "runtime-sa-iam-policy.json",
        {
            "bindings": [{"role": "roles/iam.serviceAccountUser", "members": [member]}],
            "etag": "synthetic",
            "version": 1,
        },
    )
    queue_items = []
    for queue in manifest["queues"]:
        retry = queue["retryConfig"]
        doc = {
            "name": f"projects/{project}/locations/{manifest['project']['region']}/queues/{queue['function']}",
            "state": "RUNNING",
            "rateLimits": {
                "maxDispatchesPerSecond": queue["maxDispatchesPerSecond"],
                "maxConcurrentDispatches": queue["maxConcurrentDispatches"],
            },
            "retryConfig": {
                "maxAttempts": retry["maxAttempts"],
                "minBackoff": f"{retry['minBackoffSeconds']}s",
                "maxBackoff": f"{retry['maxBackoffSeconds']}s",
            },
        }
        _write(snapshot / f"queue-{queue['function']}.json", doc)
        queue_items.append({"name": doc["name"], "state": "RUNNING"})
    _write(snapshot / "queues-list.json", queue_items)
    _write(
        snapshot / "services-enabled.json",
        [
            {
                "name": f"projects/{project}/services/{api}",
                "config": {"name": api, "title": "synthetic"},
                "state": "ENABLED",
            }
            for api in manifest["apis"]
        ],
    )
    (snapshot / "provenance.txt").write_text(f"manifest: synthetic\n{COMMIT}\n", encoding="utf-8")


def invoke(args: list[str]) -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            code = drift.main(args)
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
    return code, stdout.getvalue(), stderr.getvalue()


class DriftCases(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = contract.load_manifest(ROOT)
        self.tmp = tempfile.TemporaryDirectory()
        self.snap = Path(self.tmp.name) / "snap"
        build_passing(self.snap, self.manifest, "production")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_snap(self) -> tuple[int, str, str]:
        return invoke(["--profile", "production", "--snapshot", str(self.snap)])

    def assert_fail(self, needle: str) -> str:
        code, out, err = self.run_snap()
        self.assertEqual(code, 1, out + err)
        self.assertIn(needle, out)
        self.assertIn("RESULT: FAIL", out)
        self.assertNotIn(PLANTED, out)
        self.assertNotIn(PLANTED, err)
        return out

    def load_fn(self, name: str) -> dict:
        return json.loads((self.snap / "functions" / f"{name}.json").read_text(encoding="utf-8"))

    def save_fn(self, name: str, doc: dict) -> None:
        _write(self.snap / "functions" / f"{name}.json", doc)

    def test_passing_snapshot(self) -> None:
        code, out, err = self.run_snap()
        self.assertEqual(err, "")
        self.assertEqual(code, 0, out)
        self.assertIn("RESULT: PASS", out)
        self.assertEqual([line for line in out.splitlines() if line.startswith("FAIL ")], [])
        digest = hashlib.sha256((ROOT / "infra" / "deploy-manifest.json").read_bytes()).hexdigest()
        self.assertIn(f"manifest_sha256: {digest}", out)
        self.assertIn("profile: production", out)
        self.assertIn("project_id: sikander-legal-os-prod", out)
        self.assertIn(COMMIT, out)
        self.assertEqual(out.count("INFO not pinned"), 2)
        for path in self.snap.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(self.snap).as_posix()
            file_digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertIn(f"snapshot_sha256 {rel} {file_digest}", out)

    def test_region(self) -> None:
        doc = self.load_fn("health")
        doc["name"] = doc["name"].replace("/locations/asia-south1/", "/locations/europe-west1/")
        self.save_fn("health", doc)
        self.assert_fail("FAIL region health:")

    def test_runtime_nodejs20(self) -> None:
        doc = self.load_fn("health")
        doc["buildConfig"]["runtime"] = "nodejs20"
        self.save_fn("health", doc)
        self.assert_fail("FAIL runtime health:")

    def test_api_ingress_allow_all(self) -> None:
        doc = self.load_fn("api")
        doc["serviceConfig"]["ingressSettings"] = "ALLOW_ALL"
        self.save_fn("api", doc)
        self.assert_fail("FAIL ingress api:")

    def test_non_api_ingress(self) -> None:
        doc = self.load_fn("health")
        doc["serviceConfig"]["ingressSettings"] = "ALLOW_INTERNAL_ONLY"
        self.save_fn("health", doc)
        self.assert_fail("FAIL ingress health:")

    def test_service_account(self) -> None:
        doc = self.load_fn("health")
        doc["serviceConfig"]["serviceAccountEmail"] = "other-service-account"
        self.save_fn("health", doc)
        self.assert_fail("FAIL service-account health:")

    def test_memory_512mi(self) -> None:
        doc = self.load_fn("health")
        doc["serviceConfig"]["availableMemory"] = "512Mi"
        self.save_fn("health", doc)
        self.assert_fail("FAIL memory health:")

    def test_timeout(self) -> None:
        doc = self.load_fn("health")
        doc["serviceConfig"]["timeoutSeconds"] = doc["serviceConfig"]["timeoutSeconds"] + 1
        self.save_fn("health", doc)
        self.assert_fail("FAIL timeout health:")

    def test_max_instances(self) -> None:
        doc = self.load_fn("health")
        doc["serviceConfig"]["maxInstanceCount"] = doc["serviceConfig"]["maxInstanceCount"] + 1
        self.save_fn("health", doc)
        self.assert_fail("FAIL max-instances health:")

    def test_concurrency(self) -> None:
        doc = self.load_fn("health")
        doc["serviceConfig"]["maxInstanceRequestConcurrency"] = 4
        self.save_fn("health", doc)
        self.assert_fail("FAIL concurrency health:")

    def test_missing_function_file(self) -> None:
        (self.snap / "functions" / "health.json").unlink()
        self.assert_fail("FAIL inventory health: file missing: functions/health.json")

    def test_extra_function(self) -> None:
        listing = json.loads((self.snap / "functions-list.json").read_text(encoding="utf-8"))
        listing.append(
            {
                "name": "projects/example-project/locations/asia-south1/functions/plantedExtra",
                "environment": "GEN_2",
            }
        )
        _write(self.snap / "functions-list.json", listing)
        self.assert_fail("FAIL inventory plantedExtra:")

    def test_trusted_proxy_hops_zero(self) -> None:
        doc = self.load_fn("api")
        doc["serviceConfig"]["environmentVariables"]["TRUSTED_PROXY_HOPS"] = "0"
        self.save_fn("api", doc)
        self.assert_fail("FAIL env api: TRUSTED_PROXY_HOPS mismatch")

    def test_extra_project_role(self) -> None:
        policy = json.loads((self.snap / "iam-policy.json").read_text(encoding="utf-8"))
        member = policy["bindings"][0]["members"][0]
        policy["bindings"].append({"role": "roles/editor", "members": [member]})
        _write(self.snap / "iam-policy.json", policy)
        self.assert_fail("FAIL iam runtime-sa: extra role roles/editor")

    def test_missing_project_role(self) -> None:
        policy = json.loads((self.snap / "iam-policy.json").read_text(encoding="utf-8"))
        policy["bindings"] = [b for b in policy["bindings"] if b["role"] != "roles/datastore.user"]
        _write(self.snap / "iam-policy.json", policy)
        self.assert_fail("FAIL iam runtime-sa: missing role roles/datastore.user")

    def test_no_self_act_as(self) -> None:
        _write(self.snap / "runtime-sa-iam-policy.json", {"bindings": [], "etag": "synthetic", "version": 1})
        self.assert_fail("FAIL act-as runtime-sa:")

    def test_queue_max_dispatches(self) -> None:
        path = self.snap / "queue-jobWorker.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["rateLimits"]["maxDispatchesPerSecond"] = 9
        _write(path, doc)
        self.assert_fail("FAIL queue jobWorker: maxDispatchesPerSecond mismatch")

    def test_queue_min_backoff(self) -> None:
        path = self.snap / "queue-jobWorker.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["retryConfig"]["minBackoff"] = "5s"
        _write(path, doc)
        self.assert_fail("FAIL queue jobWorker: minBackoff mismatch")

    def test_api_not_enabled(self) -> None:
        path = self.snap / "services-enabled.json"
        rows = json.loads(path.read_text(encoding="utf-8"))
        kept = [row for row in rows if row["config"]["name"] != "cloudscheduler.googleapis.com"]
        self.assertNotEqual(len(kept), len(rows))
        _write(path, kept)
        self.assert_fail("FAIL apis cloudscheduler.googleapis.com: not enabled")

    def test_provenance_without_commit(self) -> None:
        (self.snap / "provenance.txt").write_text("manifest: synthetic\n", encoding="utf-8")
        self.assert_fail("FAIL provenance provenance.txt: commit: line absent")

    def test_malformed_json(self) -> None:
        (self.snap / "iam-policy.json").write_text("{", encoding="utf-8")
        self.assert_fail("FAIL parse iam-policy.json: JSON parse error")

    def test_ingress_field_removed(self) -> None:
        doc = self.load_fn("health")
        del doc["serviceConfig"]["ingressSettings"]
        self.save_fn("health", doc)
        self.assert_fail("field missing: serviceConfig.ingressSettings")

    def test_unknown_memory_unit(self) -> None:
        doc = self.load_fn("healthLive")
        doc["serviceConfig"]["availableMemory"] = "256Gi"
        self.save_fn("healthLive", doc)
        self.assert_fail("FAIL memory healthLive: unknown unit")

    def test_unknown_profile_exits_2(self) -> None:
        code, out, err = invoke(["--profile", "local", "--snapshot", str(self.snap)])
        self.assertEqual(code, 2)
        self.assertNotIn("RESULT: PASS", out)
        self.assertNotIn(PLANTED, out)
        self.assertNotIn(PLANTED, err)

    def test_secret_not_leaked(self) -> None:
        doc = self.load_fn("api")
        doc["serviceConfig"]["environmentVariables"]["SIKANDER_PLANTED_SECRET"] = PLANTED
        self.save_fn("api", doc)
        code, out, err = self.run_snap()
        self.assertEqual(code, 0, out + err)
        self.assertIn("RESULT: PASS", out)
        self.assertNotIn(PLANTED, out)
        self.assertNotIn(PLANTED, err)
        doc["serviceConfig"]["environmentVariables"]["TRUSTED_PROXY_HOPS"] = "0"
        self.save_fn("api", doc)
        code, out, err = self.run_snap()
        self.assertEqual(code, 1, out + err)
        self.assertIn("FAIL env api:", out)
        self.assertNotIn(PLANTED, out)
        self.assertNotIn(PLANTED, err)


class StaticAndFixtures(unittest.TestCase):
    def test_no_network_or_process_calls(self) -> None:
        source = (Path(__file__).resolve().parent / "check_deploy_drift.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        forbidden = {"subprocess", "socket", "urllib", "http", "requests", "google"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertNotIn(alias.name.split(".")[0], forbidden, alias.name)
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                self.assertNotIn(module.split(".")[0], forbidden, module)
            elif isinstance(node, ast.Attribute) and node.attr in {"system", "popen"}:
                self.fail(f"attribute {node.attr}")

    def test_fixtures_labelled_synthetic(self) -> None:
        readme = (FIXTURES / "README.md").read_text(encoding="utf-8")
        self.assertIn("synthetic", readme)
        function = json.loads((FIXTURES / "function.json").read_text(encoding="utf-8"))
        self.assertEqual(function["environment"], "GEN_2")
        self.assertEqual(function["buildConfig"]["runtime"], "nodejs22")
        self.assertEqual(function["serviceConfig"]["availableMemory"], "256Mi")
        policy = json.loads((FIXTURES / "iam-policy.json").read_text(encoding="utf-8"))
        self.assertEqual(policy["bindings"][0]["role"], "roles/datastore.user")
        self.assertEqual(policy["etag"], "synthetic")
        queue = json.loads((FIXTURES / "queue.json").read_text(encoding="utf-8"))
        self.assertEqual(queue["rateLimits"]["maxDispatchesPerSecond"], 5)
        self.assertEqual(queue["retryConfig"]["minBackoff"], "10s")
        services = json.loads((FIXTURES / "services-enabled.json").read_text(encoding="utf-8"))
        self.assertEqual(services[0]["config"]["name"], "run.googleapis.com")
        self.assertEqual(services[0]["config"]["title"], "synthetic")


if __name__ == "__main__":
    unittest.main()
