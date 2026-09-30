#!/usr/bin/env bash
# Gate G-2 — tenant isolation (L18 §10; R-5). `npm run gate:g2`.
#
# Two firms are seeded and every read function of D1-1, D1-2, D3-1, D5-1 and
# D2-1 is attempted cross-firm through web and WhatsApp (tests/g2.cross-firm.test.ts,
# memory and Firestore persistence), plus every P5 callable, every HTTP `api`
# route and every tenant collection in firestore.rules
# (functions/test/g2.cross-firm.test.ts). Both run under the Auth and
# Firestore emulators. The gate prints the coverage table (tested / not built /
# out of scope) and fails on any allowed cross-firm attempt, any read path the
# suites do not list, or a missing suite result.
#
# Ports: in CI (CI set) or with G2_USE_REPO_PORTS=1 the repo firebase.json is
# used. Locally, if any of its emulator ports is taken (another checkout's
# emulators), a temporary config with free ports is written instead
# (functions/README.md "Port notes"); the repo firebase.json is never edited.
#
# After a green run a platform admin records the pass with
# recordGatePass({ gate: "G-2", evidence }); until then onboardFirm refuses a
# second firm (second_firm_forbidden).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${1:-}" = "--inner" ]; then
  out="$2"
  rc=0
  cd "$ROOT" || exit 1
  echo "--- web + WhatsApp read paths (tests/g2.cross-firm.test.ts)"
  G2_COVERAGE_OUT="$out/next.json" npx vitest run tests/g2.cross-firm.test.ts || rc=1
  echo "--- P5 callables, HTTP api, Firestore rules (functions/test/g2.cross-firm.test.ts)"
  (cd "$ROOT/functions" && G2_COVERAGE_OUT="$out/functions.json" npx vitest run test/g2.cross-firm.test.ts) || rc=1
  exit $rc
fi

cd "$ROOT" || exit 1
echo "=== Gate G-2: cross-firm isolation ==="

export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

config="$ROOT/firebase.json"
if [ -z "${CI:-}" ] && [ "${G2_USE_REPO_PORTS:-}" != "1" ]; then
  busy=""
  for p in 18088 19099 4400 4500 9150; do port_busy "$p" && busy="$busy $p"; done
  if [ -n "$busy" ]; then
    free=($(node -e '
      const net = require("node:net")
      const take = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)) }) })
      Promise.all([1, 2, 3, 4, 5].map(take)).then((ps) => console.log(ps.join(" ")))'))
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
    echo "repo emulator ports busy:$busy; using a temporary config (firestore ${free[0]}, auth ${free[2]})"
  fi
fi

npx firebase emulators:exec --config "$config" --only auth,firestore --project demo-sikander \
  "bash \"$ROOT/ci_gates/gate_g2.sh\" --inner \"$out\""
suites_rc=$?

node - "$out" "$suites_rc" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const [out, suitesRc] = process.argv.slice(2)
const problems = []
if (suitesRc !== "0") problems.push(`suite run failed (exit ${suitesRc})`)

const rows = []
for (const suite of ["next", "functions"]) {
  const file = path.join(out, `${suite}.json`)
  if (!fs.existsSync(file)) {
    problems.push(`no coverage from the ${suite} suite (did it run under the emulators?)`)
    continue
  }
  rows.push(...JSON.parse(fs.readFileSync(file, "utf8")).rows)
}

const KNOWN = new Set(["tested", "not_built", "out_of_scope", "global"])
for (const r of rows) {
  if (!KNOWN.has(r.status)) problems.push(`unlisted read path: ${r.path} (${r.status})`)
  if (r.allowed > 0) problems.push(`ALLOWED cross-firm: ${r.path} (${r.allowed} of ${r.attempts})`)
  if (r.status === "tested" && r.attempts === 0) problems.push(`tested with no attempts: ${r.path}`)
}
if (!rows.some((r) => r.suite === "next" && r.status === "tested")) problems.push("no web/WhatsApp read path was tested")
if (!rows.some((r) => r.channel === "callable")) problems.push("no P5 callable was tested")
if (!rows.some((r) => r.channel === "rules" && r.status === "tested")) problems.push("no Firestore rules collection was tested")

const pad = (s, n) => String(s).padEnd(n).slice(0, n)
const line = (c) => `${pad(c[0], 6)} ${pad(c[1], 9)} ${pad(c[2], 10)} ${pad(c[3], 70)} ${pad(c[4], 12)} ${pad(c[5], 8)} ${c[6]}`
const print = (r) => console.log(line([r.service, r.channel, r.mode ?? "", r.path, r.status, r.attempts, r.allowed]))

console.log("\n=== G-2 coverage: web and WhatsApp (D1-1, D1-2, D3-1, D5-1, D2-1) ===")
console.log(line(["svc", "channel", "mode", "read path", "status", "attempts", "allowed"]))
const order = { tested: 0, not_built: 1, out_of_scope: 2, global: 3 }
rows
  .filter((r) => r.suite === "next")
  .sort((a, b) => order[a.status] - order[b.status] || a.service.localeCompare(b.service) || a.path.localeCompare(b.path) || String(a.mode).localeCompare(String(b.mode)))
  .forEach(print)

console.log("\n=== G-2 coverage: P5 identity (callables, HTTP api) ===")
console.log(line(["svc", "channel", "", "function / route", "status", "attempts", "allowed"]))
rows.filter((r) => r.suite === "functions" && r.channel !== "rules").forEach(print)

const rules = rows.filter((r) => r.channel === "rules")
const tested = rules.filter((r) => r.status === "tested")
const global = rules.filter((r) => r.status === "global").map((r) => r.path)
console.log("\n=== G-2 coverage: Firestore rules ===")
console.log(`${tested.length} tenant collections x 6 firm-B roles x {get, list}: ${tested.reduce((n, r) => n + r.attempts, 0)} attempts, ${tested.reduce((n, r) => n + r.allowed, 0)} allowed`)
console.log(`platform-global (reviewed, no tenant data): ${global.join(", ") || "none"}`)

const count = (s) => rows.filter((r) => r.status === s).length
console.log(`\nsummary: ${count("tested")} tested, ${count("not_built")} not built, ${count("out_of_scope")} out of scope, ${count("global")} global`)
if (problems.length) {
  console.log("\nGate G-2: FAIL")
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}
console.log("\nGate G-2: PASS (no cross-firm read allowed on any implemented path)")
NODE
