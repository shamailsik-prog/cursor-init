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
        hits = gate.compare_endpoints(manifest, endpoints, "production")
        self.assertTrue(any(f.check == "endpoints" for f in hits))


if __name__ == "__main__":
    unittest.main()
