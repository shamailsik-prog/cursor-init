#!/usr/bin/env bash
# Functions mutation testing: `npm run mutation` in functions/ (or
# `npm run mutation:functions` at the repo root). Starts STRYKER_EMULATOR_SETS
# (default 3) independent Auth + Firestore emulator sets on ephemeral ports and
# runs StrykerJS with one test-runner process per set (stryker.config.mjs).
set -euo pipefail
FN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export STRYKER_EMULATOR_SETS="${STRYKER_EMULATOR_SETS:-3}"
STRYKER_EMULATOR_LOCKS="$(mktemp -d)"
export STRYKER_EMULATOR_LOCKS
trap 'rm -rf "$STRYKER_EMULATOR_LOCKS"' EXIT
# A demo-* project id of its own: never a real project, no state shared with other runs.
export EMU_PROJECT="demo-mut-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
# Stryker runs the suites from a copy at .stryker-tmp/sandbox-*/, one level
# deeper than functions/. test/p5.role.test.ts reads ../../platform/spine/store.ts
# relative to its own directory, which from the sandbox is .stryker-tmp/platform:
# point that at the repository's platform/ (read-only use; removed on exit).
mkdir -p "$FN/.stryker-tmp"
ln -sfn "$FN/../platform" "$FN/.stryker-tmp/platform"
trap 'rm -rf "$STRYKER_EMULATOR_LOCKS"; rm -f "$FN/.stryker-tmp/platform"; rmdir "$FN/.stryker-tmp" 2>/dev/null || true' EXIT
bash "$FN/scripts/with-emulators.sh" "$STRYKER_EMULATOR_SETS" \
  bash -c 'cd "$1" && exec npx stryker run stryker.config.mjs "${@:2}"' _ "$FN" "$@"
