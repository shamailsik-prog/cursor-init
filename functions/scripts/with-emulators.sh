#!/usr/bin/env bash
# Run a command under N independent Auth + Firestore emulator sets, each on
# its own ephemeral ports (functions/README.md "Port notes"); the repo
# firebase.json is never edited.
#
#   bash functions/scripts/with-emulators.sh <N> <command...>
#
# Set k (0-based) is exported to the command as EMU_<k>_FIRESTORE and
# EMU_<k>_AUTH (host:port); set 0 is also the plain FIRESTORE_EMULATOR_HOST /
# FIREBASE_AUTH_EMULATOR_HOST the command sees. The sets are nested
# `firebase emulators:exec` calls (one per set), so they share nothing: no
# data, no hub. StrykerJS uses this to give every test-runner worker its own
# emulators (functions/test/setup/stryker-emulators.ts), so concurrent mutant
# runs cannot see each other's singleton docs (platform/bootstrap, gates).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$ROOT/functions/scripts/with-emulators.sh"

if [ "${1:-}" = "--level" ]; then
  # Inside emulators:exec for set $2 of $3: record its hosts, then nest the next set.
  k="$2"; n="$3"; shift 3
  export "EMU_${k}_FIRESTORE=$FIRESTORE_EMULATOR_HOST" "EMU_${k}_AUTH=$FIREBASE_AUTH_EMULATOR_HOST"
  if [ "$((k + 1))" -lt "$n" ]; then
    exec bash "$SELF" --start "$((k + 1))" "$n" "$@"
  fi
  export FIRESTORE_EMULATOR_HOST="$EMU_0_FIRESTORE" FIREBASE_AUTH_EMULATOR_HOST="$EMU_0_AUTH"
  exec "$@"
fi

if [ "${1:-}" = "--start" ]; then
  k="$2"; n="$3"; shift 3
else
  n="${1:?usage: with-emulators.sh <N> <command...>}"; shift
  k=0
fi

export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
export NODE_OPTIONS="--disable-warning=DEP0040${NODE_OPTIONS:+ $NODE_OPTIONS}"
project="${EMU_PROJECT:-demo-mutation}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
free=($(node -e '
  const net = require("node:net")
  const servers = []
  const take = () => new Promise((ok) => { const s = net.createServer(); servers.push(s); s.listen(0, "127.0.0.1", () => ok(s.address().port)) })
  Promise.all([1, 2, 3, 4, 5].map(take)).then((ps) => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))).then(() => console.log(ps.join(" "))))'))
cat >"$tmp/firebase.json" <<JSON
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
echo "emulator set $k/$n: firestore ${free[0]}, auth ${free[2]}, project $project" >&2

quoted="$(printf '%q ' "$@")"
cd "$ROOT"
npx firebase emulators:exec --config "$tmp/firebase.json" --only auth,firestore --project "$project" \
  "bash $(printf '%q' "$SELF") --level $k $n $quoted"
