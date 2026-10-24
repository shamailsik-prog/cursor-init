#!/usr/bin/env python3
"""Tests for ci_gates/check_deploy_contract.py (F32)."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

import check_deploy_contract as gate

ROOT = Path(__file__).resolve().parents[1]


class ShippedTree(unittest.TestCase):
    def test_shipped_tree_passes_static(self) -> None:
        manifest = gate.load_manifest(ROOT)
        findings = gate.run_static(ROOT, manifest)
        self.assertEqual(findings, [], msg="\n".join(f"{f.check}: {f.message}" for f in findings))


class PlantedMismatch(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for rel in (
            "infra/deploy-manifest.json",
            "infra/terraform",
            "infra/render_terraform.py",
            "functions/src/index.ts",
            "functions/package.json",
            "firebase.json",
            "firestore.indexes.json",
            "firestore.rules",
            "app/api/p1/committee-brain/route.ts",
            "app/api/d1/documents/route.ts",
            "docs/deploy/RELEASE_RUNBOOK.md",
        ):
            src = ROOT / rel
            dst = self.root / rel
            if src.is_dir():
                shutil.copytree(src, dst, dirs_exist_ok=True)
            elif src.is_file():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def findings(self, mutate) -> list[gate.Finding]:
        mutate()
        manifest = gate.load_manifest(self.root)
        return gate.run_static(self.root, manifest)

    def assert_check(self, check_id: str, mutate) -> None:
        hits = [f for f in self.findings(mutate) if f.check == check_id]
        self.assertTrue(hits, f"expected FAIL [{check_id}]")

    def test_exports_missing_manifest_function(self) -> None:
        def m() -> None:
            p = self.root / "infra/deploy-manifest.json"
            data = json.loads(p.read_text())
            data["functions"].append({"name": "phantomFn", "kind": "https"})
            p.write_text(json.dumps(data, indent=2) + "\n")

        self.assert_check("exports", m)

    def test_exports_extra_export_not_in_manifest(self) -> None:
        def m() -> None:
            idx = self.root / "functions/src/index.ts"
            text = idx.read_text()
            idx.write_text(text + '\nexport { health as jobworker } from "./health"\n')

        self.assert_check("exports", m)

    def test_wrong_region_in_manifest(self) -> None:
        def m() -> None:
            p = self.root / "infra/deploy-manifest.json"
            data = json.loads(p.read_text())
            data["project"]["region"] = "europe-west1"
            p.write_text(json.dumps(data, indent=2) + "\n")

        self.assert_check("manifest", m)

    def test_missing_ttl_override(self) -> None:
        def m() -> None:
            p = self.root / "firestore.indexes.json"
            data = json.loads(p.read_text())
            data["fieldOverrides"] = [o for o in data.get("fieldOverrides", []) if o.get("collectionGroup") != "counters"]
            p.write_text(json.dumps(data, indent=2) + "\n")

        self.assert_check("ttl", m)

    def test_allow_all_in_production_profile(self) -> None:
        def m() -> None:
            p = self.root / "infra/deploy-manifest.json"
            data = json.loads(p.read_text())
            data["environments"]["production"]["env"]["SIKANDER_INGRESS_SETTINGS"] = "ALLOW_ALL"
            p.write_text(json.dumps(data, indent=2) + "\n")

        self.assert_check("environments", m)

    def test_staging_differs_from_production(self) -> None:
        def m() -> None:
            p = self.root / "infra/deploy-manifest.json"
            data = json.loads(p.read_text())
            data["environments"]["staging"]["env"]["TRUSTED_PROXY_HOPS"] = "2"
            p.write_text(json.dumps(data, indent=2) + "\n")

        self.assert_check("environments", m)

    def test_wrong_next_max_duration(self) -> None:
        def m() -> None:
            p = self.root / "app/api/p1/committee-brain/route.ts"
            p.write_text(p.read_text().replace("export const maxDuration = 130", "export const maxDuration = 60"))

        self.assert_check("next", m)

    def test_primitive_iam_role(self) -> None:
        def m() -> None:
            p = self.root / "infra/deploy-manifest.json"
            data = json.loads(p.read_text())
            data["identities"]["runtime"]["projectRoles"].append("roles/editor")
            p.write_text(json.dumps(data, indent=2) + "\n")

        self.assert_check("iam", m)

    def test_terraform_drift(self) -> None:
        def m() -> None:
            p = self.root / "infra/terraform/iam.tf"
            if p.exists():
                p.write_text(p.read_text() + "\n# drift\n")

        self.assert_check("terraform", m)

    def test_runbook_order(self) -> None:
        def m() -> None:
            p = self.root / "docs/deploy/RELEASE_RUNBOOK.md"
            text = p.read_text()
            p.write_text(text.replace("deploy-preflight", "deploy-preflight-PLACEHOLDER").replace("firebase deploy", "EARLY firebase deploy"))

        self.assert_check("runbook", m)


class BundleTier(unittest.TestCase):
    def test_compare_endpoints_wrong_max_instances(self) -> None:
        manifest = gate.load_manifest(ROOT)
        endpoints = {"api": {"maxInstances": 999, "region": ["asia-south1"]}}
        hits = gate.compare_endpoints(manifest, endpoints, "production", {})
        self.assertTrue(any(f.check == "endpoints" for f in hits))

    def test_compare_endpoints_firestore_document_path(self) -> None:
        manifest = gate.load_manifest(ROOT)
        endpoints = {
            "onJobCreated": {
                "region": ["asia-south1"],
                "eventTrigger": {
                    "eventFilterPathPatterns": {"document": "client/{jobId}"},
                    "retry": True,
                },
            }
        }
        hits = gate.compare_endpoints(manifest, endpoints, "production", {})
        self.assertTrue(any("document" in f.message for f in hits))

    def test_compare_endpoints_schedule_frequency(self) -> None:
        manifest = gate.load_manifest(ROOT)
        endpoints = {
            "jobSweeper": {
                "region": ["asia-south1"],
                "scheduleTrigger": {"schedule": "every 24 hours"},
            }
        }
        hits = gate.compare_endpoints(manifest, endpoints, "production", {})
        self.assertTrue(any("schedule" in f.message for f in hits))

    def test_compare_endpoints_queue_rate_limits(self) -> None:
        manifest = gate.load_manifest(ROOT)
        endpoints = {
            "jobWorker": {
                "region": ["asia-south1"],
                "taskQueueTrigger": {"rateLimits": {"maxConcurrentDispatches": 10, "maxDispatchesPerSecond": 500}},
            }
        }
        hits = gate.compare_endpoints(manifest, endpoints, "production", {})
        self.assertTrue(any("maxDispatchesPerSecond" in f.message for f in hits))

    def test_compare_endpoints_job_worker_task_retry_config(self) -> None:
        manifest = gate.load_manifest(ROOT)
        endpoints = {
            "jobWorker": {
                "region": ["asia-south1"],
                "taskQueueTrigger": {
                    "rateLimits": {"maxConcurrentDispatches": 10, "maxDispatchesPerSecond": 5},
                    "retryConfig": {"maxAttempts": 1, "minBackoffSeconds": 10, "maxBackoffSeconds": 60},
                },
            }
        }
        hits = gate.compare_endpoints(manifest, endpoints, "production", {})
        self.assertTrue(any("retryConfig" in f.message for f in hits))

    def test_compare_endpoints_fails_when_manifest_queue_omits_retry_config(self) -> None:
        manifest = json.loads(json.dumps(gate.load_manifest(ROOT)))
        for q in manifest.get("queues", []):
            if q.get("function") == "jobWorker":
                q.pop("retryConfig", None)
        endpoints = {
            "jobWorker": {
                "region": ["asia-south1"],
                "taskQueueTrigger": {
                    "rateLimits": {"maxConcurrentDispatches": 10, "maxDispatchesPerSecond": 5},
                    "retryConfig": {"maxAttempts": 3, "minBackoffSeconds": 10, "maxBackoffSeconds": 60},
                },
            }
        }
        hits = gate.compare_endpoints(manifest, endpoints, "staging", {})
        self.assertTrue(any("retryConfig" in f.message and "manifest" in f.message.lower() for f in hits))


class ProfileProjectId(unittest.TestCase):
    def test_production_env_path_does_not_fall_back_to_demo_project(self) -> None:
        manifest = gate.load_manifest(ROOT)
        prod_id = manifest["environments"]["production"].get("gcpProjectId")
        staging_id = manifest["environments"]["staging"]["gcpProjectId"]
        self.assertIsNotNone(prod_id)
        self.assertNotEqual(prod_id, staging_id)
        hits = gate.check_canonical_deploy_env_path(
            ROOT,
            manifest,
            "production",
            str(ROOT / "functions" / f".env.{prod_id}"),
        )
        self.assertEqual(hits, [])
        wrong = gate.check_canonical_deploy_env_path(
            ROOT,
            manifest,
            "production",
            str(ROOT / "functions" / f".env.{staging_id}"),
        )
        self.assertTrue(wrong)

    def test_bundle_rejects_project_id_mismatch_for_profile(self) -> None:
        manifest = gate.load_manifest(ROOT)
        staging_id = manifest["environments"]["staging"]["gcpProjectId"]
        hits = gate.check_profile_project_id(manifest, "staging", "wrong-project-id")
        self.assertTrue(hits)
        self.assertEqual(gate.check_profile_project_id(manifest, "staging", staging_id), [])


class RunbookEnvSource(unittest.TestCase):
    def test_release_runbook_does_not_derive_env_from_manifest(self) -> None:
        text = (ROOT / "docs/deploy/RELEASE_RUNBOOK.md").read_text(encoding="utf-8")
        self.assertNotIn("print-env", text)

    def test_manifest_runbook_steps_do_not_derive_env_from_manifest(self) -> None:
        manifest = gate.load_manifest(ROOT)
        steps = manifest.get("runbook", {}).get("orderedSteps", [])
        joined = " ".join(steps).lower()
        self.assertNotIn("print-env", joined)

    def test_runbook_gate_catches_print_env_prefix_abbreviation(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        try:
            shutil.copytree(ROOT / "infra", root / "infra")
            (root / "docs/deploy").mkdir(parents=True, exist_ok=True)
            (root / "docs/deploy/RELEASE_RUNBOOK.md").write_text(
                "terraform apply stage 1\nuse print-e for env\nbash scripts/deploy-preflight.sh\nfirebase deploy\n",
                encoding="utf-8",
            )
            manifest = gate.load_manifest(root)
            hits = gate._check_runbook(root, manifest)
            self.assertTrue(any(f.check == "runbook" and "print-e" in f.message.lower() for f in hits))
        finally:
            tmp.cleanup()


class EnvFileParsing(unittest.TestCase):
    def test_parse_dotenv_last_wins(self) -> None:
        parsed = gate.parse_dotenv("SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB\nSIKANDER_INGRESS_SETTINGS=ALLOW_ALL\n")
        self.assertEqual(parsed["SIKANDER_INGRESS_SETTINGS"], "ALLOW_ALL")

    def test_check_env_file_ignores_commented_values(self) -> None:
        manifest = gate.load_manifest(ROOT)
        text = "# SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB\nSIKANDER_INGRESS_SETTINGS=ALLOW_ALL\nTRUSTED_PROXY_HOPS=0\n"
        hits = gate.check_env_file(manifest, "staging", text)
        self.assertTrue(hits)

    def test_bundle_requires_env_file(self) -> None:
        self.assertEqual(gate.main(["--bundle", "--profile", "staging", "--project-id", "demo-sikander"]), 1)

    def test_check_env_file_rejects_unknown_keys(self) -> None:
        manifest = gate.load_manifest(ROOT)
        text = "SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB\nTRUSTED_PROXY_HOPS=1\nEXTRA=1\n"
        hits = gate.check_env_file(manifest, "staging", text)
        self.assertTrue(any("unknown" in f.message for f in hits))

    def test_cli_rejects_print_env_flag_abbreviation(self) -> None:
        with self.assertRaises(SystemExit):
            gate.main(["--print-e"])


class TaskQueueRetry(unittest.TestCase):
    def test_compare_endpoints_job_worker_max_doublings(self) -> None:
        manifest = gate.load_manifest(ROOT)
        endpoints = {
            "jobWorker": {
                "region": ["asia-south1"],
                "taskQueueTrigger": {
                    "rateLimits": {"maxConcurrentDispatches": 10, "maxDispatchesPerSecond": 5},
                    "retryConfig": {
                        "maxAttempts": 3,
                        "minBackoffSeconds": 10,
                        "maxBackoffSeconds": 60,
                        "maxDoublings": 5,
                        "maxRetrySeconds": None,
                    },
                },
            }
        }
        hits = gate.compare_endpoints(manifest, endpoints, "staging", {})
        self.assertTrue(any("retryConfig" in f.message for f in hits))


class FirebaseJson(unittest.TestCase):
    def test_missing_indexes_key_fails(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        try:
            shutil.copytree(ROOT / "infra", root / "infra")
            shutil.copy2(ROOT / "firebase.json", root / "firebase.json")
            shutil.copy2(ROOT / "firestore.indexes.json", root / "firestore.indexes.json")
            shutil.copytree(ROOT / "functions/src", root / "functions/src")
            shutil.copytree(ROOT / "app", root / "app")
            shutil.copy2(ROOT / "firestore.rules", root / "firestore.rules")
            (root / "docs/deploy").mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / "docs/deploy/RELEASE_RUNBOOK.md", root / "docs/deploy/RELEASE_RUNBOOK.md")
            data = json.loads((root / "firebase.json").read_text())
            data["firestore"].pop("indexes", None)
            (root / "firebase.json").write_text(json.dumps(data, indent=2) + "\n")
            manifest = gate.load_manifest(root)
            hits = gate.run_static(root, manifest)
            self.assertTrue(any(f.check == "firebase-json" and "indexes" in f.message for f in hits))
        finally:
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
