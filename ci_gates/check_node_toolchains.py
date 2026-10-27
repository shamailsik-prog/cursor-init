#!/usr/bin/env python3
"""Audit F48: optional eve (Node 24) split from production console/Functions (Node 22).

Static guard (Gate G-0 check [25]): manifests, nvm pins, workflow env and a dedicated eve CI job
must declare the dual toolchain. Dynamic eve execution is proven in the separate `eve-toolchain`
workflow job (Node 24) via scripts/eve-toolchain-check.sh.

Usage: python3 ci_gates/check_node_toolchains.py [--root DIR]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

PRODUCTION_NODE = "22"
EVE_NODE = "24"
WORKFLOW = Path(".github/workflows/gate-g0.yml")
EVE_SCRIPT = Path("scripts/eve-toolchain-check.sh")


def _read_trimmed(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def _engines_node(manifest: Path) -> str | None:
    doc = json.loads(manifest.read_text(encoding="utf-8"))
    engines = doc.get("engines") or {}
    node = engines.get("node")
    if node is None:
        return None
    return str(node).strip().strip('"')


def run(root: Path) -> list[str]:
    problems: list[str] = []

    nvm = root / ".nvmrc"
    nvm_eve = root / ".nvmrc.eve"
    agent_nvm = root / "agent" / ".nvmrc"
    root_pkg = root / "package.json"
    functions_pkg = root / "functions" / "package.json"
    workflow = root / WORKFLOW
    eve_script = root / EVE_SCRIPT

    for path in (nvm, nvm_eve, agent_nvm, root_pkg, functions_pkg, workflow, eve_script):
        if not path.is_file():
            problems.append(f"missing required file: {path}")

    if problems:
        return problems

    if _read_trimmed(nvm) != PRODUCTION_NODE:
        problems.append(f".nvmrc must be {PRODUCTION_NODE} (console/Functions/CI); got {_read_trimmed(nvm)!r}")
    if _read_trimmed(nvm_eve) != EVE_NODE:
        problems.append(f".nvmrc.eve must be {EVE_NODE} (optional eve); got {_read_trimmed(nvm_eve)!r}")
    if _read_trimmed(agent_nvm) != EVE_NODE:
        problems.append(f"agent/.nvmrc must be {EVE_NODE}; got {_read_trimmed(agent_nvm)!r}")

    root_node = _engines_node(root_pkg)
    if root_node != PRODUCTION_NODE:
        problems.append(f"package.json engines.node must be {PRODUCTION_NODE!r}; got {root_node!r}")

    fn_node = _engines_node(functions_pkg)
    if fn_node != PRODUCTION_NODE:
        problems.append(f"functions/package.json engines.node must be {PRODUCTION_NODE!r}; got {fn_node!r}")

    wf = workflow.read_text(encoding="utf-8")
    if not re.search(r'^\s*NODE_VERSION:\s*["\']22["\']', wf, re.M):
        problems.append(f"{WORKFLOW} must set env NODE_VERSION to 22 for production jobs")
    if not re.search(r'^\s*EVE_NODE_VERSION:\s*["\']24["\']', wf, re.M):
        problems.append(f"{WORKFLOW} must set env EVE_NODE_VERSION to 24 for the optional eve job")

    if "eve-toolchain:" not in wf:
        problems.append(f"{WORKFLOW} must define an eve-toolchain job (Node 24, optional eve path)")
    if "node-version: ${{ env.EVE_NODE_VERSION }}" not in wf:
        problems.append(f"{WORKFLOW} eve-toolchain job must use node-version: ${{ env.EVE_NODE_VERSION }}")

    if "scripts/eve-toolchain-check.sh" not in wf:
        problems.append(f"{WORKFLOW} eve-toolchain job must run scripts/eve-toolchain-check.sh")

    readme = root / "README.md"
    if readme.is_file():
        text = readme.read_text(encoding="utf-8")
        if "Node 22" not in text or "Node 24" not in text:
            problems.append("README.md must document both Node 22 (production) and Node 24 (eve)")
        if ".nvmrc.eve" not in text:
            problems.append("README.md must mention .nvmrc.eve for the optional eve toolchain")

    root_scripts = json.loads(root_pkg.read_text(encoding="utf-8")).get("scripts") or {}
    if root_scripts.get("gate:node-toolchains") != "python3 ci_gates/check_node_toolchains.py":
        problems.append('package.json scripts.gate:node-toolchains must run check_node_toolchains.py')
    if root_scripts.get("eve:toolchain-check") != "bash scripts/eve-toolchain-check.sh":
        problems.append('package.json scripts.eve:toolchain-check must run scripts/eve-toolchain-check.sh')

    if not eve_script.read_text(encoding="utf-8").strip():
        problems.append(f"{EVE_SCRIPT} must not be empty")

    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("."), help="repository root")
    args = parser.parse_args()
    root = args.root.resolve()
    problems = run(root)
    if problems:
        for item in problems:
            print(f"FAIL: {item}", file=sys.stderr)
        return 1
    print("PASS: F48 node toolchain split (production 22, optional eve 24)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
