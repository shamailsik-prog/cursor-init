#!/usr/bin/env bash
# Gate G-4 (Phase 3c) — auto-confirm materialisation (O-28) on the P2 job engine, with the 3b saga and engine
# invariants it depends on. `npm run gate:g4:phase3c`.
#
# 1. route coverage by domain (check_route_coverage.py): 21 /api/d1 routes and 4 /api/platform/jobs routes,
#    each exercised by a viaApi test
# 2. disable-every-layer boot checks (functions/test/d1.boot.test.ts and p2.boot.test.ts; no emulator needed)
# 3. forty-two tests selected by exact full name (the gate counts them from the name arrays below), under
#    the Auth and Firestore emulators: the four saga invariants and the two O-46 openMatter refusals of
#    d1.entity-unmerge.emu.test.ts, the five "P2 invariant"
#    tests of p2.jobs-invariants.emu.test.ts, the two registry-discipline tests of p2.registry-discipline.emu.test.ts,
#    the back-off and head-of-line sweeper tests of p2.jobs-sweeper.emu.test.ts (O-36) and the long-handler load
#    test of p2.jobs-load.emu.test.ts (P3-37), the thirteen auto-confirm tests of d1.entity-autoconfirm.emu.test.ts
#    (P3-42..P3-50: four; P3-53..P3-58: nine, among them the four cases of the in-transaction re-check, the retry that
#    never reaches fenced_step_limit, the audit row, the deterministic event id and the two flag tests), and the
#    thirteen progress tests of f38-autoconfirm-progress.e2e.emu.test.ts (audit F38: more than 2,000 ineligible head
#    pairs never starve the eligible ones, the backlog alert, crash and retry, fencing, the flag mid-continuation and
#    at the checkpoint, rechecks, cross-firm isolation, and the straddling, unnameable-row and concurrent cases)
# 4. functions lint at zero warnings (npx eslint --max-warnings 0 functions)
# 5. Gate G-2, cross-firm isolation over all routes (ci_gates/gate_g2.sh; starts its own emulators)
#
# Emulator ports follow gate_g2.sh: in CI the repo firebase.json and demo-sikander; a local run
# gets a temporary config with ephemeral ports and its own demo project.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SAGA_SUITE='unmergeEntity and the un-merge saga (P3-24..P3-33)'
SAGA_TESTS=(
  'starts the saga: event reverted, rows in progress, one saga job per collection, the pair reads as unresolved identity'
  'the jobs finish the saga: links reopened as disputed, relying checks stale, entity.unmerged once, even when delivered twice'
  'the links job may finish last or first: the completion is the same'
  'a dead-lettered saga job leaves the pair in progress; only a partner retries it, and the retry finishes the saga'
  'openMatter refuses a cleared check that relied on a link being un-merged: 409 unmerge_in_progress, nothing written; check_stale once the checks job ran (P3-40, O-46)'
  'openMatter refuses it even when the re-screen at open finds nothing new (O-46: every review item resolved before the un-merge)'
)
SWEEP_SUITE='P2 sweeper (P3-8)'
SWEEP_TESTS=(
  'each sweeper re-dispatch backs off: 60 s, 120 s, 240 s, 480 s, then capped at 600 s (P3-35)'
  'head-of-line (O-36): 120 rows dispatched 10 s ago do not hide the 30 eligible rows behind them'
)
AUTO_SUITE='auto-confirm materialisation (P3-42..P3-50, O-28)'
AUTO_TESTS=(
  'materialises an aged undisputed pair: a system merge event, rows confirmed, entity.confirmed once, registry bumped; a second run writes nothing'
  'leaves alone a pair younger than 30 days, a disputed pair, a rejected pair, and every pair when the L17.2 layer is off'
  'an auto-confirmed pair is un-mergeable (a late dispute is no longer possible); the saga reopens it as disputed and no later run confirms it again'
  'more pairs than one step holds are all materialised, each once'
  'P3-58(a): an aged row with a young sibling for another key is admitted by the scan and rejected in the transaction; nothing is written'
  'P3-58(b): a confirmed row plus an aged candidate row is admitted by the scan and rejected in the transaction; nothing is written'
  'P3-58(c): a dispute that lands between the scan and the step is rejected in the transaction; nothing is written'
  'P3-58(d): a row with an un-merge in progress is admitted by the scan and rejected in the transaction; nothing is written'
  'P3-53: a retry after three committed steps with more than 480 pairs waiting never reaches fenced_step_limit, and every pair gets exactly one merge event across both attempts and the next day'
  'P3-54: each materialised pair writes one system entity.confirm audit row that targets its merge event'
  'P3-57: the merge event id is derived from firm, pair and sorted link ids, and a pair whose event already exists is left alone'
  'P3-56: L17.2 switched off between two steps stops every later step from writing'
  'P3-56: a failed flag read fails the attempt with the retryable flag_read_failed, and the retry materialises the pair'
)
F38_SUITE='F38 auto-confirm progress (audit F38)'
F38_TESTS=(
  'F38 RED/GREEN: more than 2,000 ineligible head pairs never starve the eligible pairs behind them'
  'F38 alert: a stale backlog logs autoconfirm.backlog_stale and records it; the run that drains it logs autoconfirm.backlog_cleared'
  'F38 alert: the stale state is recorded on the progress doc while the backlog waits'
  "F38 the period's last continuation leaves the rest to the next day and says so (autoconfirm.backlog_remaining)"
  'F38 crash and retry: a failed checkpoint and a continuation failing mid-run are retried; one continuation each; duplicates are dropped; every pair confirmed once'
  'F38 fencing: a continuation attempt whose lease is reclaimed mid-run commits nothing after it loses the fence'
  'F38 flag off mid-continuation: that step and the rest write nothing, no further continuation, and the next run resumes after the last committed step'
  'F38 flag off at the checkpoint: nothing is checkpointed and no continuation is enqueued'
  'F38 rechecks: a repaired pair is confirmed when its recheck falls due, a pair that left the backlog loses its record, a record not yet due is not re-read'
  "F38 cross-firm: one firm's chain never touches another firm's rows, records or progress; the same pair id defers separately per firm"
  'F38 a pair whose rows straddle the cursor is judged whole each time and confirmed once'
  'F38 rows that cannot name a pair are passed over and counted, and never starve the pairs behind them'
  "F38 two periods' chains of one firm at once: every pair confirmed once and both chains end"
)
LOAD_SUITE='P2 long-handler load test (P3-37, O-36)'
LOAD_TESTS=(
  "250 jobs, 240 s handlers, 10 FIFO slots: every job done, none starved, tasks within the P3-35 schedule and at most 1/5 of the fixed-grace control's"
)
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
  # JSON result must show exactly the named tests passed (as many as the arrays above hold, so no
  # literal count can drift) and nothing failed. The tests are selected by their exact full names
  # (anchored, escaped), and the JSON check repeats the names, so a renamed or swapped test fails the
  # gate. G4C_FILTER exists only to prove this can fail.
  json="$2/invariants.json"
  esc() { printf '%s' "$1" | sed 's/[][\\.*^$()+?{}|]/\\&/g'; }
  names=()
  filter=""
  for t in "${SAGA_TESTS[@]}"; do names+=("$SAGA_SUITE $t"); done
  for t in "${INV_TESTS[@]}"; do names+=("$INV_SUITE $t"); done
  for t in "${REG_TESTS[@]}"; do names+=("$REG_SUITE $t"); done
  for t in "${SWEEP_TESTS[@]}"; do names+=("$SWEEP_SUITE $t"); done
  for t in "${LOAD_TESTS[@]}"; do names+=("$LOAD_SUITE $t"); done
  for t in "${AUTO_TESTS[@]}"; do names+=("$AUTO_SUITE $t"); done
  for t in "${F38_TESTS[@]}"; do names+=("$F38_SUITE $t"); done
  for n in "${names[@]}"; do filter="${filter:+$filter|}^$(esc "$n")\$"; done
  npx vitest run test/d1.entity-unmerge.emu.test.ts test/p2.jobs-invariants.emu.test.ts test/p2.registry-discipline.emu.test.ts test/p2.jobs-sweeper.emu.test.ts test/p2.jobs-load.emu.test.ts test/d1.entity-autoconfirm.emu.test.ts test/f38-autoconfirm-progress.e2e.emu.test.ts -t "${G4C_FILTER:-$filter}" --reporter=json --outputFile="$json" || true
  EXPECTED="$(printf '%s\n' "${names[@]}")" EXPECTED_COUNT="${#names[@]}" node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    console.log(`saga and job-engine invariants: ${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped`)
    const passed = r.testResults.flatMap((f) => f.assertionResults).filter((a) => a.status === "passed").map((a) => a.fullName).sort()
    const want = process.env.EXPECTED.split("\n").sort()
    const count = Number(process.env.EXPECTED_COUNT)
    const exact = want.length === count && passed.length === count && passed.every((n, i) => n === want[i])
    if (!exact) console.log(`passed tests are not exactly the ${count} named tests:`, JSON.stringify(passed))
    process.exit(r.numPassedTests === count && r.numFailedTests === 0 && exact ? 0 : 1)' "$json"
  exit $?
fi

echo "=== Gate G-4 (Phase 3c): auto-confirm materialisation ==="

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
routes_out="$out/routes.txt"
echo "--- [1] every D1 and platform/jobs route is exercised by a test"
python3 ci_gates/check_route_coverage.py functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "d1 routes found: 21; d1 entries in the route table: 21" "$routes_out" || { echo "expected 21 d1 routes (20 + unmergeEntity from 3b)"; exit 1; }
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

echo "--- [3] saga invariants, job-engine invariants and registry discipline (emulators)"
npx firebase emulators:exec --config "$config" --only auth,firestore --project "$project" \
  "bash \"$ROOT/ci_gates/gate_g4_phase3c.sh\" --inner \"$out\""

echo "--- [4] functions lint, zero warnings"
npx eslint --max-warnings 0 functions

echo "--- [5] Gate G-2 over all routes"
bash "$ROOT/ci_gates/gate_g2.sh"

echo "=== Gate G-4 (Phase 3c): PASSED ==="
