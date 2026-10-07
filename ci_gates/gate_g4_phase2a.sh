#!/usr/bin/env bash
# Gate G-4 (Phase 2a close) — matter spine and Module 6 conflict engine. `npm run gate:g4:phase2a`.
#
# 1. every /api/d1 route is exercised by a test (check_route_coverage.py)
# 2. disable-every-layer boot check (functions/test/d1.boot.test.ts; no emulator needed)
# 3. forensic test 3 (two "Muhammad Ali" clients, same CNIC: never CLEAR) under the Auth and
#    Firestore emulators
# 4. Gate G-2, cross-firm isolation over all routes (ci_gates/gate_g2.sh; starts its own emulators)
#
# Emulator ports follow gate_g2.sh: in CI the repo firebase.json and demo-sikander; a local run
# gets a temporary config with ephemeral ports and its own demo project.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "${1:-}" = "--inner" ]; then
  cd "$ROOT/functions"
  npx vitest run test/d1.conflict.emu.test.ts -t "forensic test 3"
  exit 0
fi

echo "=== Gate G-4 (Phase 2a): matter spine and conflict engine ==="

echo "--- [1] every D1 route is exercised by a test"
python3 ci_gates/check_route_coverage.py functions/src/http/router.ts functions/test

export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
export NODE_OPTIONS="--disable-warning=DEP0040${NODE_OPTIONS:+ $NODE_OPTIONS}"

echo "--- [2] boot with every layer flag off"
(cd "$ROOT/functions" && npx vitest run test/d1.boot.test.ts)

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
config="$ROOT/firebase.json"
project="demo-sikander"
if [ -z "${CI:-}" ]; then
  project="demo-g4-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
  free=($(node -e '
    const net = require("node:net")
    const servers = []
    const take = () => new Promise((ok) => { const s = net.createServer(); servers.push(s); s.listen(0, "127.0.0.1", () => ok(s.address().port)) })
    Promise.all([1, 2, 3, 4, 5].map(take)).then((ps) => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))).then(() => console.log(ps.join(" "))))'))
  config="$out/firebase.json"
  cat >"$config" <<JSON
{
  "firestore": { "rules": "$ROOT/firestore.rules" },
  "emulators": {
    "firestore": { "port": ${free[0]}, "host": "127.0.0.1", "websocketPort": ${free[1]} },
    "auth": { "port": ${free[2]}, "host": "127.0.0.1" },
    "hub": { "port": ${free[3]}, "host": "127.0.0.1" },
    "logging": { "port": ${free[4]}, "host": "127.0.0.1" },
    "ui": { "enabled": false }
  }
}
JSON
fi

echo "--- [3] forensic test 3 (emulators)"
npx firebase emulators:exec --config "$config" --only auth,firestore --project "$project" \
  "bash \"$ROOT/ci_gates/gate_g4_phase2a.sh\" --inner"

echo "--- [4] Gate G-2 over all routes"
bash "$ROOT/ci_gates/gate_g2.sh"

echo "=== Gate G-4 (Phase 2a): PASSED ==="
