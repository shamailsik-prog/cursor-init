#!/usr/bin/env bash
# Regression fixture: deploy-preflight.sh at 012be148 (heredoc + CANONICAL uses attacker project-id).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE="${1:?profile}"
PROJECT_ID="${2:?project-id}"
CANONICAL="$ROOT/functions/.env.$PROJECT_ID"
if [ ! -f "$CANONICAL" ]; then
  echo "ERROR: missing deploy env file $CANONICAL" >&2
  exit 2
fi
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
