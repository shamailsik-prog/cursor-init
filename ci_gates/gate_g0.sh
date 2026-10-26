#!/usr/bin/env bash
# Gate G-0 — Foundations — static half. Every check FAILS the build; no WARN-only checks.
# Usage: ./ci_gates/gate_g0.sh            (static)
#        SIKANDER_LIVE=1 ./ci_gates/gate_g0.sh   (also runs the live Firestore/Postgres checks if present)
set -u
fail=0

echo "=== Gate G-0: Foundations (static) ==="

echo "[1] fee-guard"
if grep -R -n -E "calculateCourtFee|getFeeRule|insertFeeMemo|courtFeeBasis" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' --include='*.sql' --include='*.json' --include='*.rules' . 2>/dev/null | grep -v node_modules | grep -v '\.git/' | grep -v '/\.eve/' | grep -v 'ci_gates/' | grep -v 'CORRECTION_LOG.md' | grep -v 'corpus_service/'; then
  echo "FAIL: court-fee identifiers found (E-15)"; fail=1; else echo "PASS"; fi

echo "[2] scraper-guard (full tree; FA-D3C-001 file:symbol allowlist + stale-entry check)"
python3 ci_gates/check_scraper_libraries.py || fail=1
python3 ci_gates/check_fetch_allowlist.py || fail=1

echo "[3] provider-guard (full tree; P1-only; FA-D3C-002 file:symbol allowlist + stale-entry check)"
python3 ci_gates/check_provider_imports.py || fail=1

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

echo "[9] classification-guard (ranks, not labels; P1 calls carry classification)"
if grep -R -n -E "classification\s*[<>]=?\s*(OLD|NEW)\.classification|NEW\.classification\s*<\s*OLD\.classification" --include='*.sql' --include='*.ts' --include='*.py' . 2>/dev/null | grep -v ci_gates | grep -v '/\.eve/' | grep -v 'corpus_service/'; then
  echo "FAIL: classification compared as text — use classification_rank"; fail=1; else echo "PASS rank-compare"; fi
python3 ci_gates/check_classification_calls.py || fail=1

echo "[10] firestore rules cover every Phase 0 collection"
if [ -f firestore.rules ]; then
  for c in firms users matter_members clients matters documents document_versions entities entity_aliases merge_events evidence_items custody_events propositions drafts draft_versions change_proposals master_versions routing_queue follow_ups intimation_register notifications jobs api_keys audit_log conflict_checks conflict_events matter_parties matter_events entity_links counters events transliteration_map; do
    grep -q "match /$c/" firestore.rules || { echo "FAIL: no rule for $c"; fail=1; }; done
  grep -q "allow read, write: if false" firestore.rules || { echo "FAIL: no default deny"; fail=1; }
fi

echo "[11] master-write-guard (P6 only)"
python3 ci_gates/check_master_writes.py || fail=1

echo "[12] idempotency-guard"
python3 ci_gates/check_idempotency.py || fail=1

echo "[13] pagination-guard"
python3 ci_gates/check_pagination.py || fail=1

echo "[14] /ops helper-resolution guard"
python3 ci_gates/check_ops_helper_resolution.py || fail=1

echo "[15] product + phase-audit-doc mixing guard"
bash ci_gates/check_no_product_phase_audit_docs.sh || fail=1

echo "[16] focused lattice ops vitest bundle parity guard"
python3 ci_gates/check_focused_lattice_ops_bundle.py || fail=1

echo "[17] committee-brain eval record guard (audit F17: no model, routing, policy, grounding-rules or eval-set change without a matching evaluation record)"
python3 ci_gates/check_committee_eval_record.py || fail=1

echo "[18] frozen-install guard (audit F39: every lockfile matches its manifest, npm pinned, install surfaces use npm ci; the gates job adds --npm-ci)"
python3 ci_gates/check_lockfiles.py || fail=1

echo "[19] next-ai-egress guard (audit F18: no AI SDK, provider SDK, provider key or provider host in the Next/eve runtime; no deploy surface hands a provider key to it)"
python3 ci_gates/check_next_ai_egress.py || fail=1

echo "[20] deploy-contract guard (audit F32: manifest, firebase.json, indexes TTL, alerts, Next maxDuration, terraform drift)"
python3 ci_gates/check_deploy_contract.py || fail=1

echo "[21] p1-transport-import guard (audit F34 R1-003: only the granted send sites may import a P1 transport)"
python3 ci_gates/check_p1_transport_imports.py || fail=1

echo "[22] data-inventory guard (audit F42: every Firestore collection, object prefix and Postgres table or view is inventoried with its classification, key, retention class, deleter and acknowledgement)"
python3 ci_gates/check_data_inventory.py || fail=1
python3 ci_gates/test_check_data_inventory.py >/dev/null 2>&1 || { echo "FAIL: ci_gates/test_check_data_inventory.py"; fail=1; }

echo "[23] legacy-governance boundary guard (audit F41: quarantine budgets and active-product import barrier for LEGACY_GOVERNANCE_CHAINS)"
python3 ci_gates/check_legacy_governance_boundary.py || fail=1
python3 ci_gates/test_check_legacy_governance_boundary.py >/dev/null 2>&1 || { echo "FAIL: ci_gates/test_check_legacy_governance_boundary.py"; fail=1; }

if [ "${SIKANDER_LIVE:-0}" = "1" ] && [ -x ci_gates/gate_g0_live.sh ]; then ./ci_gates/gate_g0_live.sh || fail=1; fi

if [ $fail -ne 0 ]; then echo "=== Gate G-0 FAILED ==="; exit 1; fi
echo "=== Gate G-0 PASSED (static) ==="
