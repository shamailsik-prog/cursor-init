#!/usr/bin/env bash
# Gate G-2 — tenant isolation (L18 §10; R-5). `npm run gate:g2`.
#
# Two firms are seeded and every read function of D1-1, D1-2, D3-1, D5-1 and
# D2-1 is attempted cross-firm through web and WhatsApp (tests/g2.cross-firm.test.ts,
# memory and Firestore persistence), plus every HTTP `api` route (the only entry
# point to the P5 operations: no callables are deployed) and every tenant
# collection in firestore.rules
# (functions/test/g2.cross-firm.test.ts). Both run under the Auth and
# Firestore emulators. The gate prints the coverage table (tested / not built /
# out of scope) and fails on any allowed cross-firm attempt, any read path the
# suites do not list, or a missing suite result.
#
# Ports and project: in CI (CI set) the repo firebase.json and demo-sikander
# are used; a local run uses a demo-g2-<random> project. Every local run writes
# a temporary config with ephemeral ports (all five held at once while
# picked, so they are distinct and were free), so concurrent emulators of
# other checkouts or sessions cannot collide with it (functions/README.md
# "Port notes"); the repo firebase.json is never edited.
#
# A green run prints `counts: {...}` and an `evidence: {...}` line (also written
# to G2_EVIDENCE_OUT when set). A platform admin records the pass from a CI run
# with recordGatePass({ gate: "G-2", evidence }); until then onboardFirm refuses
# a second firm (second_firm_forbidden). A pass covers its commit: re-run and
# re-record when the WhatsApp webhook, D5-1 web research or Postgres RLS lands.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${1:-}" = "--inner" ]; then
  out="$2"
  rc=0
  cd "$ROOT" || exit 1
  echo "--- web + WhatsApp read paths (tests/g2.cross-firm.test.ts)"
  G2_COVERAGE_OUT="$out/next.json" npx vitest run tests/g2.cross-firm.test.ts || rc=1
  echo "--- P5 HTTP api, Firestore rules (functions/test/g2.cross-firm.test.ts)"
  (cd "$ROOT/functions" && G2_GATE=1 G2_COVERAGE_OUT="$out/functions.json" npx vitest run test/g2.cross-firm.test.ts) || rc=1
  exit $rc
fi

cd "$ROOT" || exit 1
echo "=== Gate G-2: cross-firm isolation ==="

export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
# firebase-tools and the Firebase client SDK import punycode (DEP0040 on every process start).
export NODE_OPTIONS="--disable-warning=DEP0040${NODE_OPTIONS:+ $NODE_OPTIONS}"
export no_proxy="$NO_PROXY"

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

config="$ROOT/firebase.json"
project="demo-sikander"
if [ -z "${CI:-}" ]; then
  # A demo project of its own, so concurrent local runs share no emulator hub
  # or project state (demo-* ids never reach a real project).
  project="demo-g2-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
  # Every local run gets its own ports: node binds each on :0 (the kernel hands
  # out a free ephemeral port), reads it and releases it, and the config is
  # written from those. No check-then-start window on the shared repo ports.
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
  echo "local run: temporary emulator config (firestore ${free[0]}, auth ${free[2]}), project $project"
fi

npx firebase emulators:exec --config "$config" --only auth,firestore --project "$project" \
  "bash \"$ROOT/ci_gates/gate_g2.sh\" --inner \"$out\""
suites_rc=$?

commit_sha="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo "")"
run_url=""
if [ -n "${GITHUB_RUN_ID:-}" ]; then run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"; fi

node - "$out" "$suites_rc" "$commit_sha" "$run_url" "${G2_EVIDENCE_OUT:-}" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const [out, suitesRc, commitSha, runUrl, evidenceOut] = process.argv.slice(2)
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
// U-1: the HTTP api is the only entry point to the P5 operations (no callables are deployed)
if (!rows.some((r) => r.suite === "functions" && r.channel === "http" && r.status === "tested")) problems.push("no P5 HTTP api route was tested")
if (!rows.some((r) => r.channel === "rules" && r.status === "tested")) problems.push("no Firestore rules collection was tested")
// Every web/WhatsApp path must have run in both persistence modes.
const nextTested = rows.filter((r) => r.suite === "next" && r.status === "tested")
for (const p of new Set(nextTested.map((r) => r.path))) {
  for (const mode of ["memory", "firestore"]) {
    if (!nextTested.some((r) => r.path === p && r.mode === mode)) problems.push(`no ${mode}-mode run of ${p}`)
  }
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n)
const line = (c) => `${pad(c[0], 6)} ${pad(c[1], 9)} ${pad(c[2], 10)} ${pad(c[3], 70)} ${pad(c[4], 12)} ${pad(c[5], 8)} ${c[6]}`
const print = (r) => console.log(line([r.service, r.channel, r.mode ?? "", r.path, r.status, r.attempts, r.allowed]))

console.log("\n=== G-2 coverage: web and WhatsApp (D1-1, D1-2, D3-1, D5-1, D2-1; P5 tenancy) ===")
console.log(line(["svc", "channel", "mode", "read path", "status", "attempts", "allowed"]))
const order = { tested: 0, not_built: 1, out_of_scope: 2, global: 3 }
rows
  .filter((r) => r.suite === "next")
  .sort((a, b) => order[a.status] - order[b.status] || a.service.localeCompare(b.service) || a.path.localeCompare(b.path) || String(a.mode).localeCompare(String(b.mode)))
  .forEach(print)

console.log("\n=== G-2 coverage: P5 identity (HTTP api) ===")
console.log(line(["svc", "channel", "", "function / route", "status", "attempts", "allowed"]))
rows.filter((r) => r.suite === "functions" && r.channel !== "rules").forEach(print)

const rules = rows.filter((r) => r.channel === "rules")
const tested = rules.filter((r) => r.status === "tested")
const global = rules.filter((r) => r.status === "global").map((r) => r.path)
console.log("\n=== G-2 coverage: Firestore rules ===")
console.log(`${tested.length} tenant collections x 6 firm-B roles x {get, list}: ${tested.reduce((n, r) => n + r.attempts, 0)} attempts, ${tested.reduce((n, r) => n + r.allowed, 0)} allowed`)
console.log(`platform-global (reviewed, no tenant data): ${global.join(", ") || "none"}`)

const count = (s) => rows.filter((r) => r.status === s).length
const counts = {
  tested: count("tested"),
  notBuilt: count("not_built"),
  outOfScope: count("out_of_scope"),
  global: count("global"),
  allowed: rows.reduce((n, r) => n + r.allowed, 0),
}
console.log(`\nsummary: ${counts.tested} tested, ${counts.notBuilt} not built, ${counts.outOfScope} out of scope, ${counts.global} global, ${counts.allowed} allowed`)
console.log(`counts: ${JSON.stringify(counts)}`)
if (problems.length) {
  console.log("\nGate G-2: FAIL")
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}
// The evidence recordGatePass({ gate: "G-2", evidence }) takes (functions/src/p5/gates.ts). A
// local run has no CI run URL: record a pass only from a CI run (its URL proves the run).
const evidence = {
  summary: `gate:g2 PASS: ${counts.tested} tested, ${counts.allowed} allowed, ${counts.notBuilt} not built`,
  commitSha,
  runUrl: runUrl || null,
  counts,
}
console.log(`evidence: ${JSON.stringify(evidence)}`)
if (evidenceOut) fs.writeFileSync(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`)
console.log("\nGate G-2: PASS (no cross-firm read allowed on any implemented path)")
NODE
