#!/usr/bin/env bash
# Regenerate hash-pinned Python lockfiles (audit F46). Run from anywhere; needs Python 3.12 + pip-tools.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
PY=${PYTHON:-$(command -v python3.12 || command -v python3)}
"$PY" -m pip install --disable-pip-version-check -q pip-tools
"$PY" -m piptools compile --generate-hashes --strip-extras -o requirements.txt requirements.in
"$PY" -m piptools compile --generate-hashes -o requirements-test.txt requirements-test.in
"$PY" scripts/generate_runtime_sbom.py
echo "OK: requirements.txt, requirements-test.txt, runtime-sbom.json"
