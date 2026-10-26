#!/usr/bin/env python3
"""Tests for ci_gates/check_legacy_governance_boundary.py (audit F41)."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

import check_legacy_governance_boundary as gate

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _shipped_tree_root() -> Path:
    for key in ("GITHUB_WORKSPACE", "SIKANDER_GATE_TOOL_ROOT", "WORKSPACE_ROOT"):
        raw = __import__("os").environ.get(key)
        if raw:
            return Path(raw).resolve()
    return Path(__file__).resolve().parents[1]


class ShippedTree(unittest.TestCase):
    def test_shipped_tree_passes(self) -> None:
        root = _shipped_tree_root()
        manifest = root / gate.MANIFEST
        if not manifest.is_file():
            self.skipTest("full tree manifest not present (minimal G-0 e2e copy)")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        if data.get("listedBudgetPathsMustExist") is False:
            self.skipTest("minimal G-0 e2e manifest (not full-tree enforcement)")
        failures = gate.run(root)
        self.assertEqual(failures, [], msg="\n".join(failures))


class PlantedTree(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "platform/boundaries").mkdir(parents=True)
        shipped = _shipped_tree_root()
        manifest_path = shipped / gate.MANIFEST
        if manifest_path.is_file() and json.loads(manifest_path.read_text()).get("listedBudgetPathsMustExist"):
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        else:
            manifest = json.loads(
                (FIXTURES / "legacy_governance_quarantine_g0_e2e.json").read_text(encoding="utf-8")
            )
        manifest["listedBudgetPathsMustExist"] = False
        manifest["frozenMonoliths"] = []
        manifest["spineCouplingBudgets"] = []
        manifest["quarantineFolderBudgets"] = []
        manifest["maxGovernanceAdapterFiles"] = 999
        manifest["maxGovernanceAdapterTotalLines"] = 999999
        manifest["maxGovernanceAdapterLinesPerFile"] = 999999
        (self.root / gate.MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
        (self.root / "platform/flags").mkdir(parents=True)
        shutil.copy(shipped / "platform/flags/featureFlags.ts", self.root / "platform/flags/featureFlags.ts")
        (self.root / "app/api/d1").mkdir(parents=True)
        (self.root / "platform/persistence").mkdir(parents=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write_manifest(self, manifest: dict) -> None:
        (self.root / gate.MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")

    def test_active_product_cannot_import_governance_adapter(self) -> None:
        gov = self.root / "platform/persistence/workflowOpsExampleGovernance.ts"
        gov.write_text("export const x = 1\n", encoding="utf-8")
        route = self.root / "app/api/d1/bad-route.ts"
        route.write_text(
            'import { x } from "@/platform/persistence/workflowOpsExampleGovernance"\nexport {}\n',
            encoding="utf-8",
        )
        failures = gate.run(self.root)
        self.assertTrue(any("bad-route.ts" in f for f in failures))

    def test_monolith_line_budget(self) -> None:
        manifest = json.loads((self.root / gate.MANIFEST).read_text(encoding="utf-8"))
        manifest["frozenMonoliths"] = [{"path": "app/api/d2/ops-reporting/route.ts", "maxLines": 2}]
        self._write_manifest(manifest)
        monolith = self.root / "app/api/d2/ops-reporting/route.ts"
        monolith.parent.mkdir(parents=True)
        monolith.write_text("a\nb\nc\n", encoding="utf-8")
        failures = gate.run(self.root)
        self.assertTrue(any("exceeds frozen monolith budget" in f for f in failures))

    def test_e4_new_file_in_quarantine_folder(self) -> None:
        manifest = json.loads((self.root / gate.MANIFEST).read_text(encoding="utf-8"))
        manifest["quarantineFolderBudgets"] = [
            {"prefix": "app/api/d4/filings/", "maxTotalLines": 100, "maxSourceFiles": 1}
        ]
        self._write_manifest(manifest)
        folder = self.root / "app/api/d4/filings"
        folder.mkdir(parents=True)
        (folder / "route.ts").write_text("x\n" * 10, encoding="utf-8")
        (folder / "escape.ts").write_text("y\n" * 5000, encoding="utf-8")
        failures = gate.run(self.root)
        self.assertTrue(
            any("app/api/d4/filings/" in f and ("file cap" in f or "folder budget" in f) for f in failures)
        )

    def test_e5b_missing_listed_budget_path(self) -> None:
        manifest = json.loads((self.root / gate.MANIFEST).read_text(encoding="utf-8"))
        manifest["listedBudgetPathsMustExist"] = True
        manifest["frozenMonoliths"] = [{"path": "app/api/d4/filings/route.ts", "maxLines": 100}]
        self._write_manifest(manifest)
        failures = gate.run(self.root)
        self.assertTrue(any("listed frozen monolith budget path is missing" in f for f in failures))

    def test_e7_adapter_per_file_size(self) -> None:
        manifest = json.loads((self.root / gate.MANIFEST).read_text(encoding="utf-8"))
        manifest["maxGovernanceAdapterFiles"] = 10
        manifest["maxGovernanceAdapterTotalLines"] = 10000
        manifest["maxGovernanceAdapterLinesPerFile"] = 3
        self._write_manifest(manifest)
        gov = self.root / "platform/persistence/workflowOpsFatGovernance.ts"
        gov.write_text("line\n" * 8, encoding="utf-8")
        failures = gate.run(self.root)
        self.assertTrue(any("exceeds per-adapter budget" in f for f in failures))

    def test_recursive_adapter_subdirectory(self) -> None:
        manifest = json.loads((self.root / gate.MANIFEST).read_text(encoding="utf-8"))
        manifest["maxGovernanceAdapterFiles"] = 0
        self._write_manifest(manifest)
        nested = self.root / "platform/persistence/legacy/nested"
        nested.mkdir(parents=True)
        (nested / "workflowOpsNestedGovernance.ts").write_text("export {}\n", encoding="utf-8")
        failures = gate.run(self.root)
        self.assertTrue(any("exceed cap 0" in f for f in failures))


if __name__ == "__main__":
    unittest.main()
