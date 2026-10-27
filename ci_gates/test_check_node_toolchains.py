#!/usr/bin/env python3
"""Unit tests for ci_gates/check_node_toolchains.py."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from check_node_toolchains import run


def _shipped_tree_root() -> Path:
    for key in ("GITHUB_WORKSPACE", "SIKANDER_GATE_TOOL_ROOT", "WORKSPACE_ROOT"):
        raw = os.environ.get(key)
        if raw:
            return Path(raw).resolve()
    return Path(__file__).resolve().parents[1]


def _write_min_tree(root: Path, *, root_node: str = "22", eve_nvm: str = "24") -> None:
    (root / ".nvmrc").write_text("22\n", encoding="utf-8")
    (root / ".nvmrc.eve").write_text(f"{eve_nvm}\n", encoding="utf-8")
    (root / "agent").mkdir(parents=True, exist_ok=True)
    (root / "agent" / ".nvmrc").write_text(f"{eve_nvm}\n", encoding="utf-8")
    (root / "functions").mkdir(parents=True, exist_ok=True)
    (root / "functions" / "package.json").write_text(
        json.dumps({"engines": {"node": root_node}}),
        encoding="utf-8",
    )
    (root / "package.json").write_text(
        json.dumps(
            {
                "engines": {"node": root_node},
                "scripts": {
                    "gate:node-toolchains": "python3 ci_gates/check_node_toolchains.py",
                    "eve:toolchain-check": "bash scripts/eve-toolchain-check.sh",
                },
            }
        ),
        encoding="utf-8",
    )
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    (root / "scripts" / "eve-toolchain-check.sh").write_text("#!/bin/bash\n", encoding="utf-8")
    (root / "README.md").write_text(
        "Node 22 for CI. Node 24 for eve. See .nvmrc.eve.\n",
        encoding="utf-8",
    )
    wf_dir = root / ".github" / "workflows"
    wf_dir.mkdir(parents=True, exist_ok=True)
    (wf_dir / "gate-g0.yml").write_text(
        "env:\n"
        '  NODE_VERSION: "22"\n'
        '  EVE_NODE_VERSION: "24"\n'
        "jobs:\n"
        "  eve-toolchain:\n"
        "    steps:\n"
        "      - run: bash scripts/eve-toolchain-check.sh\n"
        "      - uses: actions/setup-node\n"
        "        with:\n"
        "          node-version: ${{ env.EVE_NODE_VERSION }}\n",
        encoding="utf-8",
    )


class TestNodeToolchains(unittest.TestCase):
    def test_shipped_tree_passes(self) -> None:
        self.assertEqual(run(_shipped_tree_root()), [])

    def test_wrong_functions_node_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_min_tree(root, root_node="24")
            problems = run(root)
            self.assertTrue(any("functions/package.json" in p for p in problems))

    def test_missing_eve_job_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_min_tree(root)
            wf = root / ".github/workflows/gate-g0.yml"
            wf.write_text(wf.read_text(encoding="utf-8").replace("eve-toolchain:", "eve-missing:"), encoding="utf-8")
            problems = run(root)
            self.assertTrue(any("eve-toolchain job" in p for p in problems))


if __name__ == "__main__":
    unittest.main()
