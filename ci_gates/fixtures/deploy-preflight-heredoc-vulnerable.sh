#!/usr/bin/env bash
# Regression fixture: pre-R4-003 deploy-preflight embedded Python with shell interpolation.
# DO NOT use in production; tests assert this pattern is exploitable.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE="${1:?profile}"
PROJECT_ID="${2:?project-id}"
cd "$ROOT"
python3 - <<PY
import sys
from pathlib import Path
sys.path.insert(0, str(Path("ci_gates")))
import check_deploy_contract as gate

manifest = gate.load_manifest(Path("."))
failures = gate.check_profile_project_id(manifest, "$PROFILE", "$PROJECT_ID")
if failures:
    for f in failures:
        print(f"FAIL [{f.check}] {f.message}")
    sys.exit(1)
PY
