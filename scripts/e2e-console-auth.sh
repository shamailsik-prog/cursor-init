#!/usr/bin/env bash
# Run inside `firebase emulators:exec --only auth,firestore,functions`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export SIKANDER_AUTH_MODE=firebase
export SIKANDER_PERSISTENCE_MODE=firestore
export NODE_ENV=development
export FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-demo-sikander}"
export GCLOUD_PROJECT="${GCLOUD_PROJECT:-demo-sikander}"
export NEXT_PUBLIC_FIREBASE_PROJECT_ID="${NEXT_PUBLIC_FIREBASE_PROJECT_ID:-demo-sikander}"
export NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST="${NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST:-127.0.0.1:19099}"

PROJECT="${GCLOUD_PROJECT}"
REGION="asia-south1"
FUNC_HOST="${FIREBASE_FUNCTIONS_EMULATOR_HOST:-127.0.0.1:15001}"
export NEXT_PUBLIC_SIKANDER_FUNCTIONS_API_BASE_URL="http://${FUNC_HOST}/${PROJECT}/${REGION}/api"

eval "$(node scripts/seed-e2e-console-user.mjs)"

PORT="${E2E_CONSOLE_PORT:-43127}"
export PLAYWRIGHT_BASE_URL="http://127.0.0.1:${PORT}"

if OLD_PID="$(lsof -ti:"$PORT" 2>/dev/null || true)"; then
  kill $OLD_PID 2>/dev/null || true
  sleep 1
fi

npm run dev -- --port "$PORT" >/tmp/e2e-next-dev.log 2>&1 &
DEV_PID=$!
cleanup() {
  kill "$DEV_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 90); do
  if curl -sf "${PLAYWRIGHT_BASE_URL}/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -sf "${PLAYWRIGHT_BASE_URL}/" >/dev/null 2>&1; then
  echo "FAIL: Next dev did not become ready on ${PLAYWRIGHT_BASE_URL}" >&2
  tail -40 /tmp/e2e-next-dev.log >&2 || true
  exit 1
fi

npx playwright test tests/e2e/console-auth.spec.ts
