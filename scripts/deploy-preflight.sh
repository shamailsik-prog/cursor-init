#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="staging"
ENV_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: --env-file is required and must point at functions/.env.<projectId> (or an equivalent deploy env file)" >&2
  exit 2
fi
cd "$ROOT/functions"
node build.mjs
cd "$ROOT"
python3 ci_gates/check_deploy_contract.py
python3 ci_gates/check_deploy_contract.py --bundle --profile "$PROFILE" --env-file "$ENV_FILE"
echo "manifest: $(python3 -c 'import hashlib,pathlib; p=pathlib.Path("infra/deploy-manifest.json"); print(hashlib.sha256(p.read_bytes()).hexdigest()[:12])')"
echo "commit: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
