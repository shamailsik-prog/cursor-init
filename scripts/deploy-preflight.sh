#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="staging"
PROJECT_ID=""
ENV_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --project-id) PROJECT_ID="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: --project-id is required (Firebase project id; deploy env is functions/.env.<projectId>)" >&2
  exit 2
fi
CANONICAL="$ROOT/functions/.env.$PROJECT_ID"
if [ ! -f "$CANONICAL" ]; then
  echo "ERROR: missing deploy env file $CANONICAL (the file firebase deploy reads)" >&2
  exit 2
fi
if [ -n "$ENV_FILE" ]; then
  if [ "$(realpath "$ENV_FILE")" != "$(realpath "$CANONICAL")" ]; then
    echo "ERROR: --env-file must be functions/.env.$PROJECT_ID (got $ENV_FILE)" >&2
    exit 2
  fi
fi
ENV_FILE="$CANONICAL"
cd "$ROOT/functions"
node build.mjs
cd "$ROOT"
python3 ci_gates/check_deploy_contract.py
python3 ci_gates/check_deploy_contract.py --bundle --profile "$PROFILE" --env-file "$ENV_FILE"
echo "manifest: $(python3 -c 'import hashlib,pathlib; p=pathlib.Path("infra/deploy-manifest.json"); print(hashlib.sha256(p.read_bytes()).hexdigest()[:12])')"
echo "commit: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
