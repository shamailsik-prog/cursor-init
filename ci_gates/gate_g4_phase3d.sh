#!/usr/bin/env bash
# Gate G-4 (Phase 3d) — the P1 AI layer core in Cloud Functions (P3-60..P3-73): the single gateway `callP1`,
# the cost log, the 70/90 alerts, the kill switches, the Opik trace and the five /api/platform/brain routes.
# `npm run gate:g4:phase3d`.
#
# 1. route coverage by domain (check_route_coverage.py): 21 /api/d1 routes, 4 /api/platform/jobs routes and
#    5 /api/platform/brain routes, each exercised by a viaApi test
# 2. disable-every-layer boot checks (functions/test/d1.boot.test.ts and p2.boot.test.ts; no emulator needed).
#    P1 is CORE and has no layer flag (P3-60), so nothing of P1 can be switched off at boot
# 3. the named P1 tests, selected by exact full name (the gate counts them from the name arrays below), under
#    the Auth and Firestore emulators, from p1.units.test.ts, p1.transport.test.ts, p1.gateway.emu.test.ts and
#    p1.api.emu.test.ts:
#      - callP1: the happy-path decision record (row, month total, event, audit), the PKT month boundary, the
#        masking test (no party name, CNIC or mobile reaches the transport, a row, an event, an audit row, the
#        trace, a log line or the result), every P3-61 refusal (all eight block reasons: each row of the refusal
#        table, the not_minimised case, the first-refusal-wins order, the classification guard), the kill-switch
#        flips (a switch set between two calls blocks the second), every bad transport result (failed,
#        transport_error, cost 0, no provider text) and the missing-usage estimate, the alerts at 70 and 90
#        (exactly once, including ten parallel calls crossing 70% together), the failed trace export, the commit
#        failure, and the G-1 forensic test 7 equivalent (a privileged call with no DPA is blocked and traced
#        with classification and no content)
#      - the routes: committeeBrain (input order, access, cross-firm 404, the classification that a caller
#        label may only raise, party-name masking, the output row, the blocked and failed rows, the idempotent
#        replay, the bounded output-write retry), setBudgetAlerts, setAiKillSwitch (a request replaces the
#        whole state), setPlatformAiKillSwitch (platformAdmin only; stops every firm; outranks a firm's own
#        switch) and getAiUsage (the exact response; no firm is shown the operator's uid)
#      - the units behind them: the frozen cost and routing tables, the cost arithmetic, the PKT month key, the
#        Opik self-hosted guard and trace payload by rank, the Gateway transport's fixed error strings, and the
#        refusal of every test seam when NODE_ENV is production
# 4. functions lint at zero warnings (npx eslint --max-warnings 0 functions)
# 5. Gate G-2, cross-firm isolation over all routes (ci_gates/gate_g2.sh; starts its own emulators)
#
# Emulator ports follow gate_g2.sh: in CI the repo firebase.json and demo-sikander; a local run
# gets a temporary config with ephemeral ports and its own demo project.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- callP1 (functions/test/p1.gateway.emu.test.ts) -------------------------------------------------------
GW_SUITE='callP1 (P3-61, P3-63..P3-66, P3-69)'
GW_TESTS=(
  # the decision record and the PKT month boundary (P3-63, P3-64, P3-69)
  'happy path is ok with masked text, a full P3-63 row, the month total, one completed event and one allow audit row; trace disabled'
  'happy path takes monthKey from the injected clock in PKT: 19:00Z on 31 October is November'
  'happy path records a system actor as given'
  # masking (Review Focus 1)
  'masking (Review Focus 1) no party name, CNIC or mobile reaches the transport, the row, the event, the audit row, the trace, a log line or the result'
  # refusals not in the table below (P3-61 steps 2 to 8)
  'refusals (P3-61 steps 2 to 8) a privileged call whose masked text would still be masked again is blocked not_minimised'
  'refusals (P3-61 steps 2 to 8) a privileged call with an executed DPA and a minimised body is allowed'
  'refusals (P3-61 steps 2 to 8) confidential with an executed DPA is allowed'
  'refusals (P3-61 steps 2 to 8) a different model in disabledModels does not block, and a cleared switch re-enables'
  'refusals (P3-61 steps 2 to 8) a disableAll that is not exactly true does not block'
  # the first refusal wins (P3-61)
  'order (P3-61: the first refusal wins) the platform switch outranks the firm switch, policy and the budget'
  'order (P3-61: the first refusal wins) the firm switch outranks policy'
  'order (P3-61: the first refusal wins) policy outranks the price and the budget'
  'order (P3-61: the first refusal wins) the price outranks the budget, and the budget outranks the credentials'
  # a switch set between two calls takes effect on the next call (Review Focus 4)
  'kill switch flips (Review Focus 4) a firm switch set between two calls blocks the second; clearing it re-enables'
  'kill switch flips (Review Focus 4) a platform switch set between two calls blocks the second'
  'kill switch flips (Review Focus 4) a call already in flight when the switch is set completes'
  # step 1: a missing or unknown classification throws (L8473)
  'classification guard (L8473) a missing classification throws and nothing is written'
  'classification guard (L8473) a unknown classification throws and nothing is written'
  'classification guard (L8473) a an inherited key classification throws and nothing is written'
  'classification guard (L8473) a a rank number classification throws and nothing is written'
  # bad transport results (Review Focus 5)
  'transport failures (Review Focus 5) a rejecting transport gives failed, transport_error, cost 0, a failed event, and stores nothing of the error'
  'transport failures (Review Focus 5) a transport that resolves without string text is a transport_error'
  'transport failures (Review Focus 5) through the real Gateway transport against a local server a non-2xx gives failed, transport_error, cost 0 and stores no provider text'
  'transport failures (Review Focus 5) through the real Gateway transport against a local server a 2xx with no choices[0].message.content gives failed, transport_error, cost 0 and stores no provider text'
  'transport failures (Review Focus 5) through the real Gateway transport against a local server a timeout gives failed, transport_error, cost 0 and stores no provider text'
  'transport failures (Review Focus 5) through the real Gateway transport against a local server a thrown fetch (connection refused) gives failed'
  'transport failures (Review Focus 5) through the real Gateway transport against a local server a 2xx with content but no usage is ok with tokensEstimated'
  'usage absent (P3-62) null tokens on both sides: ok, tokensEstimated, each side estimated from the masked text'
  'usage absent (P3-62) one side null: only that side is estimated'
  'PKR (P3-64) with pkrPerUsd 280, a 14000 micro-USD call stores fxPkrPerUsd 280 and costPkr 3.92'
  # alerts at 70 and 90, exactly once (P3-65, Review Focus 2)
  'alerts at 70 and 90 (P3-65, Review Focus 2) crossing 70 writes one alert, one system audit row, one event and one warning; crossing 90 later writes the 90 alert'
  'alerts at 70 and 90 (P3-65, Review Focus 2) one call from 60000 to 95000 writes both alerts'
  'alerts at 70 and 90 (P3-65, Review Focus 2) landing exactly on 70% crosses it; stopping just below does not'
  'alerts at 70 and 90 (P3-65, Review Focus 2) ten parallel calls crossing 70% write exactly one 70 alert, and the total equals the sum of the rows'
  'alerts at 70 and 90 (P3-65, Review Focus 2) decides the crossing on the budget the transaction reads, not the pre-call one'
  'alerts at 70 and 90 (P3-65, Review Focus 2) raising the budget does not re-arm a crossed threshold, and the call still commits'
  'alerts at 70 and 90 (P3-65, Review Focus 2) a blocked or failed call writes no alert and adds nothing to spend'
  # trace and commit failure (P3-63, P3-67)
  'trace (P3-67) a failed export records trace.status failed and logs p1.trace_export_failed with ids only'
  'trace (P3-67) the exported trace carries the usage row id and the trace id'
  "commit failure (P3-63) with failCommit the provider call's text is still returned and p1.usage_log_failed keeps the record"
  # G-1 forensic test 7 (L8505-8506)
  'G-1 forensic 7 equivalent a privileged call with no DPA is blocked, and its exported trace has classification privileged and no input or output'
)
# The refusal table is an it.each: vitest titles each row "'<name, cut to 40 characters>' → blocked '<reason>', <tail>".
# One row per block reason variant (kill_switch_platform, kill_switch_firm, policy_denied, model_unpriced,
# budget_not_set, budget_exhausted, no_credentials); not_minimised is the separate test above.
REFUSAL_PREFIX='refusals (P3-61 steps 2 to 8)'
REFUSAL_TAIL=', no provider call, a blocked row, event and deny audit row'
REFUSAL_TESTS=(
  "'the platform switch with disableAll (…' → blocked 'kill_switch_platform'"
  "'the platform switch naming the routed…' → blocked 'kill_switch_platform'"
  "'the firm switch with disableAll' → blocked 'kill_switch_firm'"
  "'the firm switch naming the routed mod…' → blocked 'kill_switch_firm'"
  "'confidential with no DPA' → blocked 'policy_denied'"
  "'a model with no price' → blocked 'model_unpriced'"
  "'no ai_config at all' → blocked 'budget_not_set'"
  "'an ai_config with no budget' → blocked 'budget_not_set'"
  "'a zero budget' → blocked 'budget_not_set'"
  "'a negative budget' → blocked 'budget_not_set'"
  "'a fractional budget' → blocked 'budget_not_set'"
  "'a string budget' → blocked 'budget_not_set'"
  "'spend exactly at the budget' → blocked 'budget_exhausted'"
  "'spend over the budget' → blocked 'budget_exhausted'"
  "'no transport and no key' → blocked 'no_credentials'"
)

# --- the routes (functions/test/p1.api.emu.test.ts) --------------------------------------------------------
API_SUITE='the /api/platform/brain routes (P3-60, P3-66, P3-70..P3-72)'
API_TESTS=(
  # committeeBrain: input order, access, cross-firm, clearance (P3-70)
  'committeeBrain: input checks (P3-70) the checks run in the stated order: matter, body, purpose, classification, documents, party names'
  'committeeBrain: access (P3-70) partner, associate and clerk members reach the gateway'
  'committeeBrain: access (P3-70) an intern, a client and accounts are refused 403, and a partner who is not a member of the matter too; nothing is called or written'
  "committeeBrain: access (P3-70) a missing matter and another firm's matter are both 404 not_found (existence never leaks)"
  "committeeBrain: access (P3-70) clearance below the matter's own label is 403 clearance"
  'committeeBrain: access (P3-70) clearance below the derived classification is 403 clearance: a caller label above it, or the internal floor over a public clearance'
  'committeeBrain: access (P3-70) a refusal is audited as a deny under ai.call, a success as an allow'
  # committeeBrain: a caller label may only raise the classification (P3-70)
  'committeeBrain: classification (P3-70: matter, caller label, internal floor) an internal matter with no label goes to internal and out'
  'committeeBrain: classification (P3-70: matter, caller label, internal floor) a public matter is floored to internal'
  "committeeBrain: classification (P3-70: matter, caller label, internal floor) a caller label above the matter's raises it: confidential on an internal matter is blocked policy_denied with no DPA"
  "committeeBrain: classification (P3-70: matter, caller label, internal floor) a caller label below the matter's never lowers it: public or internal on a confidential matter stays confidential"
  'committeeBrain: classification (P3-70: matter, caller label, internal floor) with a DPA executed, a confidential call goes out'
  # committeeBrain: masking with the matter's party names (Review Focus 1)
  "committeeBrain: masking (Review Focus 1) the matter's party names (name and names) and the supplied ones are masked in what the transport receives, in the stored output and in the reply; none reaches a row, an event, an audit row or a log line"
  'committeeBrain: masking (Review Focus 1) overlapping names are masked longest first: no surname is left behind'
  "committeeBrain: masking (Review Focus 1) only this firm's party rows for this matter count: another firm's rows on the same matter id are ignored"
  # committeeBrain: the output row, the blocked and failed rows, the idempotent replay, the output-write retry
  'committeeBrain: output (P3-70) an ok call: the response, the committee_outputs row, the usage row and the allow audit row'
  'committeeBrain: output (P3-70) a blocked call is stored and returned with its reason and no text'
  'committeeBrain: output (P3-70) a transport failure is stored and returned as blocked with reason transport_error, no text, and no provider text anywhere'
  'committeeBrain: output (P3-70) replaying the same Idempotency-Key returns the same answer with no second transport call, usage row or output row'
  'committeeBrain: output (P3-70) the output write is retried a transient failure of the first two attempts still gives one row, one allow audit row, one provider call, after waits of 100 and 200 ms'
  'committeeBrain: output (P3-70) the output write is retried after the third failure it rethrows as before: 500 internal, one provider call and its usage row, no output row, a deny audit row'
  'committeeBrain: output (P3-70) the output write is retried an HttpError is a decision, not a transient fault: it is not retried'
  'committeeBrain: output (P3-70) a different Idempotency-Key is a new call'
  # setBudgetAlerts (P3-71)
  'setBudgetAlerts (P3-71) only a partner: associate, clerk, intern, accounts and client are refused 403'
  'setBudgetAlerts (P3-71) a budget set here lets committeeBrain through'
  'setBudgetAlerts (P3-71) is audited as ai.budget.set (an allow on ai_config/{firmId}; a refused value is a deny)'
  # setAiKillSwitch (P3-66)
  'setAiKillSwitch (P3-66) only a partner: associate, clerk, intern, accounts and client are refused 403'
  'setAiKillSwitch (P3-66) a request replaces the whole state: nothing of the earlier switch survives, not even a field this code does not write'
  'setAiKillSwitch (P3-66) disableAll blocks the next committeeBrain call kill_switch_firm; re-enabling lets the next one through'
  "setAiKillSwitch (P3-66) a disabled model blocks only that model's calls"
  'setAiKillSwitch (P3-66) it stops this firm only'
  'setAiKillSwitch (P3-66) is audited as ai.kill_switch.set'
  # setPlatformAiKillSwitch (P3-66)
  'setPlatformAiKillSwitch (P3-66) a caller without the platformAdmin claim gets 403 platform_admin_only, a firm partner included; nothing is stored'
  'setPlatformAiKillSwitch (P3-66) the claim is checked before the body: a bad body from a non-admin is still 403'
  "setPlatformAiKillSwitch (P3-66) with the claim it stores { disableAll, disabledModels, reason, setBy, setAt } at platform/p1 and keeps the doc's other fields"
  'setPlatformAiKillSwitch (P3-66) a request replaces the whole state: nothing of the earlier switch survives, not even a field this code does not write'
  "setPlatformAiKillSwitch (P3-66) every firm's next committeeBrain call is blocked kill_switch_platform, and it outranks the firm's own switch; re-enabling restores them"
  'setPlatformAiKillSwitch (P3-66) is audited as ai.platform_kill_switch.set on platform/p1'
  # getAiUsage (P3-71)
  'getAiUsage (P3-71) only a partner: associate, clerk, intern, accounts and client are refused 403'
  'getAiUsage (P3-71) the default month is the current PKT month: 19:30Z on 31 October is November'
  'getAiUsage (P3-71) the exact response from the month total: spend, PKR to 2 decimal places, percent used to 2 decimal places, calls, tokens'
  'getAiUsage (P3-71) reports the alerts crossed with their creation time, in threshold order, for the month asked'
  'getAiUsage (P3-71) shows both kill switches as views with an ISO setAt, firm and platform'
  "getAiUsage (P3-71) never shows a firm the operator's identity: the platform view says setBy \"platform\", whoever set it, in any firm's response"
  'getAiUsage (P3-71) counts what committeeBrain did, per firm: an ok call, a blocked call and a failed call'
)

# --- the units behind P1 (functions/test/p1.units.test.ts, p1.transport.test.ts) ---------------------------
COST_SUITE='P1 cost table (P3-62)'
COST_TESTS=(
  'routes the committee task to Opus at the pinned list price'
  'costMicroUsd is ceil((in x inputPrice + out x outputPrice) / 1000)'
  'the price and routing tables are frozen, so nothing can change a price at run time'
  'costMicroUsd returns null for an unpriced model, including inherited object keys'
  'estimateTokens is ceil(UTF-8 bytes / 3)'
)
MONTH_SUITE='P1 PKT month key (P3-64)'
MONTH_TESTS=(
  'monthKeyPkt rolls over at 19:00 UTC on the last day, the PKT midnight'
)
OPIKCFG_SUITE='P1 Opik configuration (P3-67)'
OPIKCFG_TESTS=(
  'is disabled when unset, unconfirmed, or pointed at Comet'
  'checks unset, then invalid_url, then unconfirmed, then third_party_host'
)
TRACE_SUITE='P1 Opik trace payload (P3-67)'
TRACE_TESTS=(
  'carries content at ranks 0 to 3 and metadata only at rank 4'
  'carries no content for a blocked call, at any rank, and records the reason'
)
TRANSPORT_SUITE='P1 Gateway transport (P3-68)'
TRANSPORT_TESTS=(
  'posts the OpenAI-compatible body with the bearer key and parses text and usage'
  'rejects a non-2xx response with a fixed message that does not echo the provider text'
  'rejects a 200 with no usable choices[0].message.content, with a fixed message'
)
SEAM_SUITE='P1 active transport and test seam (P3-68)'
SEAM_TESTS=(
  'refuses the test seam in production'
)
EXPORTER_SUITE='P1 Opik exporter (P3-67)'
EXPORTER_TESTS=(
  'returns failed on 500 and on 4xx, and never throws'
  'refuses the fetch seam in production'
)

if [ "${1:-}" = "--inner" ]; then
  cd "$ROOT/functions"
  # vitest exits 0 when -t matches nothing (renamed test) or the emulator suites are skipped, so the
  # JSON result must show exactly the named tests passed (as many as the arrays above hold, so no
  # literal count can drift) and nothing failed. The tests are selected by their exact full names
  # (anchored, escaped), and the JSON check repeats the names, so a renamed or swapped test fails the
  # gate. G4D_FILTER exists only to prove this can fail.
  json="$2/p1.json"
  esc() { printf '%s' "$1" | sed 's/[][\\.*^$()+?{}|]/\\&/g'; }
  names=()
  filter=""
  for t in "${GW_TESTS[@]}"; do names+=("$GW_SUITE $t"); done
  for t in "${REFUSAL_TESTS[@]}"; do names+=("$GW_SUITE $REFUSAL_PREFIX $t$REFUSAL_TAIL"); done
  for t in "${API_TESTS[@]}"; do names+=("$API_SUITE $t"); done
  for t in "${COST_TESTS[@]}"; do names+=("$COST_SUITE $t"); done
  for t in "${MONTH_TESTS[@]}"; do names+=("$MONTH_SUITE $t"); done
  for t in "${OPIKCFG_TESTS[@]}"; do names+=("$OPIKCFG_SUITE $t"); done
  for t in "${TRACE_TESTS[@]}"; do names+=("$TRACE_SUITE $t"); done
  for t in "${TRANSPORT_TESTS[@]}"; do names+=("$TRANSPORT_SUITE $t"); done
  for t in "${SEAM_TESTS[@]}"; do names+=("$SEAM_SUITE $t"); done
  for t in "${EXPORTER_TESTS[@]}"; do names+=("$EXPORTER_SUITE $t"); done
  for n in "${names[@]}"; do filter="${filter:+$filter|}^$(esc "$n")\$"; done
  npx vitest run test/p1.units.test.ts test/p1.transport.test.ts test/p1.gateway.emu.test.ts test/p1.api.emu.test.ts -t "${G4D_FILTER:-$filter}" --reporter=json --outputFile="$json" || true
  EXPECTED="$(printf '%s\n' "${names[@]}")" EXPECTED_COUNT="${#names[@]}" node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    console.log(`P1 gateway, routes and units: ${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped`)
    const passed = r.testResults.flatMap((f) => f.assertionResults).filter((a) => a.status === "passed").map((a) => a.fullName).sort()
    const want = process.env.EXPECTED.split("\n").sort()
    const count = Number(process.env.EXPECTED_COUNT)
    const exact = want.length === count && passed.length === count && passed.every((n, i) => n === want[i])
    if (!exact) console.log(`passed tests are not exactly the ${count} named tests:`, JSON.stringify(passed))
    process.exit(r.numPassedTests === count && r.numFailedTests === 0 && exact ? 0 : 1)' "$json"
  exit $?
fi

echo "=== Gate G-4 (Phase 3d): the P1 AI layer core ==="

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
routes_out="$out/routes.txt"
echo "--- [1] every D1, platform/jobs and platform/brain route is exercised by a test"
python3 ci_gates/check_route_coverage.py functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "d1 routes found: 21; d1 entries in the route table: 21" "$routes_out" || { echo "expected 21 d1 routes (20 + unmergeEntity from 3b)"; exit 1; }
python3 ci_gates/check_route_coverage.py --domain platform/jobs functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "platform/jobs routes found: 4; platform/jobs entries in the route table: 4" "$routes_out" || { echo "expected 4 platform/jobs routes"; exit 1; }
python3 ci_gates/check_route_coverage.py --domain platform/brain functions/src/http/router.ts functions/test | tee "$routes_out"
grep -q "platform/brain routes found: 5; platform/brain entries in the route table: 5" "$routes_out" || { echo "expected 5 platform/brain routes (committeeBrain, getAiUsage, setBudgetAlerts, setAiKillSwitch, setPlatformAiKillSwitch)"; exit 1; }

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

echo "--- [3] P1 gateway, cost log, alerts, kill switches, trace and routes (emulators)"
npx firebase emulators:exec --config "$config" --only auth,firestore --project "$project" \
  "bash \"$ROOT/ci_gates/gate_g4_phase3d.sh\" --inner \"$out\""

echo "--- [4] functions lint, zero warnings"
npx eslint --max-warnings 0 functions

echo "--- [5] Gate G-2 over all routes"
bash "$ROOT/ci_gates/gate_g2.sh"

echo "=== Gate G-4 (Phase 3d): PASSED ==="
