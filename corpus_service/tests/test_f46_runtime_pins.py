"""Audit F46: production runtime lockfiles, image digests, and CI gate."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_f46_gate_passes_on_shipped_tree():
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "ci_gates" / "check_corpus_runtime_pins.py"), "--root", str(REPO_ROOT)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_requirements_test_is_production_superset():
    sys.path.insert(0, str(REPO_ROOT / "ci_gates"))
    from check_corpus_runtime_pins import parse_locked_requirements

    prod, _ = parse_locked_requirements((REPO_ROOT / "corpus_service" / "requirements.txt").read_text(encoding="utf-8"))
    test, _ = parse_locked_requirements(
        (REPO_ROOT / "corpus_service" / "requirements-test.txt").read_text(encoding="utf-8")
    )
    for name, ver in prod.items():
        assert test.get(name) == ver, (name, ver, test.get(name))
