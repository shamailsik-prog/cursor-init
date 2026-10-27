#!/usr/bin/env bash
# Audit F48: run only on Node 24+ (CI eve-toolchain job or local eve activation).
set -euo pipefail

need_major="${EVE_NODE_MAJOR:-24}"
actual_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$actual_major" != "$need_major" ]]; then
  echo "eve-toolchain-check: need Node ${need_major}.x (eve engines); got $(node -v)" >&2
  echo "Use .nvmrc.eve / agent/.nvmrc (24) — production .nvmrc stays 22 for Functions and CI." >&2
  exit 1
fi

# Frozen install on the eve toolchain; npm 11 on Node 24 warns on devEngines but installs the same tree (F39).
npm ci
# Prove the eve CLI runs on Node 24. `eve info` evaluates agent/agent.ts and currently fails on Node 24
# (Next ESM extension resolution); orchestration is out of scope for F48.
eve_ver="$(npm exec eve -- --version)"
echo "eve-toolchain-check: OK on $(node -v) (eve ${eve_ver})"
