#!/usr/bin/env bash
# Gate G-4 (Phase 3a close) — P2 job engine core. `npm run gate:g4:phase3a`.
#
# 1. route coverage by domain (check_route_coverage.py): 20 /api/d1 routes and 4 /api/platform/jobs routes,
#    each exercised by a viaApi test
# 2. disable-every-layer boot checks (functions/test/d1.boot.test.ts and p2.boot.test.ts; no emulator needed)
# 3. the five "P2 invariant" tests of p2.jobs-invariants.emu.test.ts and the two registry-discipline tests of
#    p2.registry-discipline.emu.test.ts, selected by exact full name, under the Auth and Firestore emulators
# 4. functions lint at zero warnings (npx eslint --max-warnings 0 functions)
# 5. Gate G-2, cross-firm isolation over all routes (ci_gates/gate_g2.sh; starts its own emulators)
#
# Emulator ports follow gate_g2.sh: in CI the repo firebase.json and demo-sikander; a local run
# gets a temporary config with ephemeral ports and its own demo project.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

INV_SUITE='P2 job engine invariants (P3-4, P3-6..P3-8)'
REG_SUITE='Registry-version discipline (P3-20)'
INV_TESTS=(
  'P2 invariant: duplicate delivery commits the effect exactly once'
  'P2 invariant: a lease that expires mid-handler is reclaimed and the stale commit is discarded'
  'P2 invariant: a failing job retries at 1s, 5s and 25s, then dead-letters with job.deadLettered'
  'P2 invariant: enqueue is idempotent and a job exists iff its transaction committed'
  'P2 invariant: skewed clocks never dispatch a job twice in one sweep or run a fifth attempt'
)
REG_TESTS=(
  'registry discipline: a product transaction that writes a registry collection without bumpRegistryVersion is reported'
  'registry discipline: loadRegistry reads exactly the collections in REGISTRY_SCOPE'
)

if [ "${1:-}" = "--inner" ]; then
  cd "$ROOT/functions"
  # vitest exits 0 when -t matches nothing (renamed test) or the emulator suites are skipped, so the
  # JSON result must show exactly the seven named tests passed and nothing failed. The tests are
  # selected by their exact full names (anchored, escaped), and the JSON check repeats the names,
  # so a renamed or swapped test fails the gate. G4C_FILTER exists only to prove this can fail.
  json="$2/invariants.json"
  esc() { printf '%s' "$1" | sed 's/[][\\.*^$()+?{}|]/\\&/g'; }
  names=()
  filter=""
  for t in "${INV_TESTS[@]}"; do names+=("$INV_SUITE $t"); done
  for t in "${REG_TESTS[@]}"; do names+=("$REG_SUITE $t"); done
  for n in "${names[@]}"; do filter="${filter:+$filter|}^$(esc "$n")\$"; done
  npx vitest run test/p2.jobs-invariants.emu.test.ts test/p2.registry-discipline.emu.test.ts -t "${G4C_FILTER:-$filter}" --reporter=json --outputFile="$json" || true
  EXPECTED="$(printf '%s\n' "${names[@]}")" node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    console.log(`job-engine invariants: ${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped`)
    const passed = r.testResults.flatMap((f) => f.assertionResults).filter((a) => a.status === "passed").map((a) => a.fullName).sort()
    const want = process.env.EXPECTED.split("\n").sort()
    const exact = passed.length === want.length && passed.every((n, i) => n === want[i])
    if (!exact) console.log("passed tests are not exactly the seven named invariants:", JSON.stringify(passed))
    process.exit(r.numPassedTests === 7 && r.numFailedTests === 0 && exact ? 0 : 1)' "$json"
  exit $?
fi

echo "=== Gate G-4 (Phase 3a): P2 job engine core ==="

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
routes_out="$out/routes.txt"
echo "--- [1] every D1 and platform/jobs route is exercised by a test"
python3 ci_gates/check_route_coverage.py functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "d1 routes found: 20; d1 entries in the route table: 20" "$routes_out" || { echo "expected 20 d1 routes"; exit 1; }
python3 ci_gates/check_route_coverage.py --domain platform/jobs functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "platform/jobs routes found: 4; platform/jobs entries in the route table: 4" "$routes_out" || { echo "expected 4 platform/jobs routes"; exit 1; }

export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
export NODE_OPTIONS="--disable-warning=DEP0040${NODE_OPTIONS:+ $NODE_OPTIONS}"

echo "--- [2] boot with every layer flag off"
(cd "$ROOT/functions" && npx vitest run test/d1.boot.test.ts test/p2.boot.test.ts)

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

echo "--- [3] job-engine invariants and registry discipline (emulators)"
npx firebase emulators:exec --config "$config" --only auth,firestore --project "$project" \
  "bash \"$ROOT/ci_gates/gate_g4_phase3a.sh\" --inner \"$out\""

echo "--- [4] functions lint, zero warnings"
npx eslint --max-warnings 0 functions

echo "--- [5] Gate G-2 over all routes"
bash "$ROOT/ci_gates/gate_g2.sh"

echo "=== Gate G-4 (Phase 3a): PASSED ==="
