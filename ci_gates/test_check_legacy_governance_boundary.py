#!/usr/bin/env python3
"""Tests for ci_gates/check_legacy_governance_boundary.py (audit F41)."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

import check_legacy_governance_boundary as gate

def _shipped_tree_root() -> Path:
    for key in ("GITHUB_WORKSPACE", "SIKANDER_GATE_TOOL_ROOT", "WORKSPACE_ROOT"):
        raw = __import__("os").environ.get(key)
        if raw:
            return Path(raw).resolve()
    return Path(__file__).resolve().parents[1]


class ShippedTree(unittest.TestCase):
    def test_shipped_tree_passes(self) -> None:
        root = _shipped_tree_root()
        if not (root / gate.MANIFEST).is_file():
            self.skipTest("full tree manifest not present (minimal G-0 e2e copy)")
        failures = gate.run(root)
        self.assertEqual(failures, [], msg="\n".join(failures))


class PlantedTree(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "platform/boundaries").mkdir(parents=True)
        shipped = _shipped_tree_root()
        manifest = json.loads((shipped / gate.MANIFEST).read_text(encoding="utf-8"))
        manifest["frozenMonoliths"] = []
        manifest["spineCouplingBudgets"] = []
        manifest["maxGovernanceAdapterFiles"] = 0
        (self.root / gate.MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
        (self.root / "platform/flags").mkdir(parents=True)
        shutil.copy(shipped / "platform/flags/featureFlags.ts", self.root / "platform/flags/featureFlags.ts")
        (self.root / "app/api/d1").mkdir(parents=True)
        (self.root / "platform/persistence").mkdir(parents=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

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
        (self.root / gate.MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
        monolith = self.root / "app/api/d2/ops-reporting/route.ts"
        monolith.parent.mkdir(parents=True)
        monolith.write_text("a\nb\nc\n", encoding="utf-8")
        failures = gate.run(self.root)
        self.assertTrue(any("exceeds frozen monolith budget" in f for f in failures))


if __name__ == "__main__":
    unittest.main()
