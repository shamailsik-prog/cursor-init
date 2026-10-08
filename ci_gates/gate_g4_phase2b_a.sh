#!/usr/bin/env bash
# Gate G-4 (Phase 2b-A close) — entity review queue and confirmMerge (L17.2). `npm run gate:g4:phase2b-a`.
#
# 1. every /api/d1 route (20: 14 from 2a, 6 entity) is exercised by a viaApi test (check_route_coverage.py)
# 2. disable-every-layer boot check (functions/test/d1.boot.test.ts; no emulator needed)
# 3. the two "L17.2 invariant" tests of d1.entity-invariants.emu.test.ts, selected by exact name, under the Auth and
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
  # vitest exits 0 when -t matches nothing (renamed test) or the emulator suite is skipped, so the
  # JSON result must show exactly the two named tests passed and nothing failed. The tests are
  # selected by their exact full names (anchored, escaped), and the JSON check repeats the names,
  # so a renamed or swapped test fails the gate. G4B_FILTER exists only to prove this can fail.
  json="$2/invariants.json"
  suite='L17.2 conflict invariants (P2-18, P2-30, P2-41)'
  t1='L17.2 invariant: confirmMerge turns a key review into FLAG and a contradicted resolution into check_stale'
  t2='L17.2 invariant: a rejected or disputed pair is never confirmed identity'
  esc() { printf '%s' "$1" | sed 's/[][\\.*^$()+?{}|]/\\&/g'; }
  filter="^$(esc "$suite $t1")\$|^$(esc "$suite $t2")\$"
  npx vitest run test/d1.entity-invariants.emu.test.ts -t "${G4B_FILTER:-$filter}" --reporter=json --outputFile="$json" || true
  EXPECT_1="$suite $t1" EXPECT_2="$suite $t2" node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    console.log(`L17.2 invariants: ${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped`)
    const passed = r.testResults.flatMap((f) => f.assertionResults).filter((a) => a.status === "passed").map((a) => a.fullName).sort()
    const want = [process.env.EXPECT_1, process.env.EXPECT_2].sort()
    const exact = passed.length === 2 && passed.every((n, i) => n === want[i])
    if (!exact) console.log("passed tests are not exactly the two named invariants:", JSON.stringify(passed))
    process.exit(r.numPassedTests === 2 && r.numFailedTests === 0 && exact ? 0 : 1)' "$json"
  exit $?
fi

echo "=== Gate G-4 (Phase 2b-A): entity review and confirmMerge ==="

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
routes_out="$out/routes.txt"
echo "--- [1] every D1 route is exercised by a test"
python3 ci_gates/check_route_coverage.py functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "d1 routes found: 20; d1 entries in the route table: 20" "$routes_out" || { echo "expected 20 d1 routes (14 + 6 entity)"; exit 1; }

export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
export NODE_OPTIONS="--disable-warning=DEP0040${NODE_OPTIONS:+ $NODE_OPTIONS}"

echo "--- [2] boot with every layer flag off"
(cd "$ROOT/functions" && npx vitest run test/d1.boot.test.ts)

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

echo "--- [3] L17.2 invariant tests (emulators)"
npx firebase emulators:exec --config "$config" --only auth,firestore --project "$project" \
  "bash \"$ROOT/ci_gates/gate_g4_phase2b_a.sh\" --inner \"$out\""

echo "--- [4] Gate G-2 over all routes"
bash "$ROOT/ci_gates/gate_g2.sh"

echo "=== Gate G-4 (Phase 2b-A): PASSED ==="
