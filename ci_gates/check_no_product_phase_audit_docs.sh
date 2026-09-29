#!/usr/bin/env bash
# Fail when a PR mixes product code changes with phase-audit documentation edits.
# Product paths: app/, platform/, tests/
# Blocked docs: docs/audits/*audit.md, docs/LEGAL_OS_PHASE_VERIFICATION.md
set -euo pipefail

BASE="${BASE:-origin/main}"
HEAD="${HEAD:-HEAD}"

if ! git rev-parse --verify "${BASE}^{commit}" >/dev/null 2>&1; then
  echo "FAIL: base ref ${BASE} is not a valid commit"
  exit 1
fi

if ! git rev-parse --verify "${HEAD}^{commit}" >/dev/null 2>&1; then
  echo "FAIL: head ref ${HEAD} is not a valid commit"
  exit 1
fi

DIFF_BASE="$(git merge-base "${BASE}" "${HEAD}")"
mapfile -t changed < <(git diff --name-only "${DIFF_BASE}..${HEAD}")

touches_product=0
touches_blocked_doc=0
blocked_hits=()

for path in "${changed[@]}"; do
  case "$path" in
    app/*|platform/*|tests/*)
      touches_product=1
      ;;
  esac
  case "$path" in
    docs/LEGAL_OS_PHASE_VERIFICATION.md)
      touches_blocked_doc=1
      blocked_hits+=("$path")
      ;;
    docs/audits/*audit.md)
      touches_blocked_doc=1
      blocked_hits+=("$path")
      ;;
  esac
done

if [[ $touches_product -eq 1 && $touches_blocked_doc -eq 1 ]]; then
  echo "FAIL: product paths (app/, platform/, tests/) cannot change in the same PR as phase audit docs"
  printf '  blocked doc(s):\n'
  for hit in "${blocked_hits[@]}"; do
    echo "    - $hit"
  done
  exit 1
fi

echo "PASS: no product + phase-audit-doc mixing (${DIFF_BASE}..${HEAD})"
exit 0
