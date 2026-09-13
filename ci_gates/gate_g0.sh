#!/usr/bin/env bash
# Gate G-0 — Foundations — static half. Every check FAILS the build; no WARN-only checks.
# Usage: ./ci_gates/gate_g0.sh            (static)
#        SIKANDER_LIVE=1 ./ci_gates/gate_g0.sh   (also runs the live Firestore/Postgres checks if present)
set -u
fail=0
APP_DIRS="services platform core layers web mobile src"
existing_dirs=""; for d in $APP_DIRS; do [ -d "$d" ] && existing_dirs="$existing_dirs $d"; done

echo "=== Gate G-0: Foundations (static) ==="

echo "[1] fee-guard"
if grep -R -n -E "calculateCourtFee|getFeeRule|insertFeeMemo|courtFeeBasis" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' --include='*.sql' --include='*.json' --include='*.rules' . 2>/dev/null | grep -v node_modules | grep -v '\.git/' | grep -v 'ci_gates/' | grep -v 'CORRECTION_LOG.md'; then
  echo "FAIL: court-fee identifiers found (E-15)"; fail=1; else echo "PASS"; fi

echo "[2] scraper-guard (app repository: no Playwright/Puppeteer anywhere; no exemption for D3-3 or L4.9)"
if [ -n "$existing_dirs" ] && grep -R -n -i -E "playwright|puppeteer" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' --include='package.json' --include='requirements.txt' $existing_dirs 2>/dev/null | grep -v node_modules; then
  echo "FAIL: scraper library in the app repository (N1 / L17.12 — corpus harvest is a separate repo)"; fail=1; else echo "PASS"; fi

echo "[3] provider-guard (AI/OCR/STT/TTS SDK imports only under platform/committeeBrain or platform/p1)"
if [ -n "$existing_dirs" ] && grep -R -n -E "from ['\"](openai|@anthropic-ai/sdk|@google/generative-ai|groq-sdk|elevenlabs|@google-cloud/vision)['\"]|import (openai|anthropic|google\.generativeai|groq|elevenlabs)" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' $existing_dirs 2>/dev/null | grep -v node_modules | grep -v -E "platform/(committeeBrain|p1)"; then
  echo "FAIL: provider SDK imported outside P1"; fail=1; else echo "PASS"; fi

echo "[4] duplicate-route guard"
python3 ci_gates/check_duplicate_routes.py || fail=1

echo "[5] Phase 0 files present"
for f in firestore.rules data/courts.json data/documentTypes.json postgres/ddl/001_corpus_contract.sql postgres/ddl/002_platform.sql; do
  [ -f "$f" ] || { echo "FAIL: missing $f"; fail=1; }; done

echo "[6] prefix-fixture-guard"
python3 ci_gates/validate_case_numbers.py || fail=1

echo "[7] seed-clone-guard"
python3 ci_gates/check_159_types.py || fail=1

echo "[8] embedding-lock-guard (DDL dimension = corpus_metadata seed)"
if [ -f postgres/ddl/001_corpus_contract.sql ]; then
  dim_col=$(grep -o -E "vector\([0-9]+\)" postgres/ddl/001_corpus_contract.sql | head -1 | tr -dc '0-9')
  dim_meta=$(grep -o -E "'embedding_dim','[0-9]+'" postgres/ddl/001_corpus_contract.sql | tr -dc '0-9')
  if [ "$dim_col" != "$dim_meta" ] || [ -z "$dim_col" ] || [ "$dim_col" -gt 2000 ]; then echo "FAIL: vector dim ($dim_col) != corpus_metadata ($dim_meta) or > 2000"; fail=1; else echo "PASS ($dim_col)"; fi
  grep -q "USING hnsw" postgres/ddl/001_corpus_contract.sql || { echo "FAIL: HNSW index missing"; fail=1; }
fi

echo "[9] classification-rank-guard (no string comparison of classification labels)"
if grep -R -n -E "classification\s*[<>]=?\s*(OLD|NEW)\.classification|NEW\.classification\s*<\s*OLD\.classification" --include='*.sql' --include='*.ts' --include='*.py' . 2>/dev/null | grep -v ci_gates; then
  echo "FAIL: classification compared as text — use classification_rank"; fail=1; else echo "PASS"; fi

echo "[10] firestore rules cover every Phase 0 collection"
if [ -f firestore.rules ]; then
  for c in firms users matter_members clients matters documents document_versions entities entity_aliases merge_events evidence_items custody_events propositions drafts draft_versions change_proposals master_versions routing_queue follow_ups intimation_register notifications jobs api_keys audit_log; do
    grep -q "match /$c/" firestore.rules || { echo "FAIL: no rule for $c"; fail=1; }; done
  grep -q "allow read, write: if false" firestore.rules || { echo "FAIL: no default deny"; fail=1; }
fi

if [ "${SIKANDER_LIVE:-0}" = "1" ] && [ -x ci_gates/gate_g0_live.sh ]; then ./ci_gates/gate_g0_live.sh || fail=1; fi

if [ $fail -ne 0 ]; then echo "=== Gate G-0 FAILED ==="; exit 1; fi
echo "=== Gate G-0 PASSED (static) ==="
