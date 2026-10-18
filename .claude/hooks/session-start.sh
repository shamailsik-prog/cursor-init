#!/bin/bash
# SessionStart hook for Claude Code on the web: installs the npm dependencies of the Next.js app and
# the Cloud Functions package, the same install as .cursor/environment.json and the CI "Install" step.
# Without it a cloud session has no node_modules: lint, typecheck and vitest cannot run, and the
# Next.js 16 guides AGENTS.md says to read (node_modules/next/dist/docs/) are not there.
# Idempotent: a package skips npm ci while its package-lock.json is unchanged since the last install.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# npm ci installs exactly what the lockfile pins and never rewrites it. The stamp lives inside
# node_modules, so deleting node_modules also forces a fresh install.
install_pkg() { # $1 = package directory
  local dir="$1" stamp="$1/node_modules/.claude-session-lock.sha256"
  if [ -d "$dir/node_modules" ] && sha256sum -c --status "$stamp" 2>/dev/null; then
    return 0
  fi
  npm ci --prefix "$dir" --no-audit --no-fund --no-update-notifier --loglevel=error
  sha256sum "$PWD/$dir/package-lock.json" > "$stamp"
}

install_pkg .
install_pkg functions

# The CI gates (ci_gates/*.py) import yaml; CI pins pyyaml 6.0.3.
python3 -c 'import yaml' 2>/dev/null \
  || python3 -m pip install --quiet --disable-pip-version-check --root-user-action=ignore pyyaml==6.0.3

echo "session-start: npm dependencies (app + functions) ready"
