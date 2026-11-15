#!/usr/bin/env bash
# Gate G-3 — master owned (Layer 18 §10; L17.5). `npm run gate:g3`.
#
# Proves, without a staging or production database:
#   grants — 009_p6_master.sql grants master writes only to p6_service
#   approval — a substantive proposal needs a partner; model and autonomous actors are refused
#   version/diff — apply writes a version row and a diff, and masterWritten is true only after commit
#   rollback — rollback restores the prior snapshot and records a new version
#   non-P6 writer — a store opened as any other role is refused
#   learners — LEARNERS_ENABLED stays false, and a run is refused until G-3 has passed
# The master-write guard is the same check as G-0 [11]: a learner write outside P6 fails.
# Postgres exercise of 009, when SIKANDER_POSTGRES_URL is set, is tests/p6.master.pg.test.ts
# (npm run test:postgres-ddl). That is still not a staging proof.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "=== Gate G-3: master owned (Layer 18 §10) ==="
npx vitest run tests/p6.g3.test.ts
python3 ci_gates/check_master_writes.py
echo "Gate G-3: PASS"
