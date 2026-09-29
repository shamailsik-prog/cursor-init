# Independent phase auditor A–F audit: PR #315 GET 537–538

**Auditor:** independent phase auditor (docs-only)  
**Landed squash SHA:** `7a23ca21ca219eee06802109f471058445efabcf` (PR #315 on `main`)  
**True first parent:** `70c46fd3cd53bb05427cfb85f4c44d03df41343f` (#314 docs)  
**Evidence tip:** `725a11caf47d836d0d810b2ae3164f32dc09b6bf` (`git diff` vs `main` empty)  
**Evidence:** `/opt/cursor/artifacts/pr315_audit.log`  
**Collection table:** `/opt/cursor/artifacts/pr315_collection_table.md`  
**Break tests:** `/opt/cursor/artifacts/break_test_pr315.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #315 @ `7a23ca2`** | **FAIL — PR315-MAJOR-1** |
| **Product slice (537/538 wiring)** | **PARTIAL-accepted** if metadata fixed (`transport_stub=true`) |

---

## PR315-MAJOR-1

Live replay of `ci_gates/check_pr_phase_claims.py` on the **closed PR #315 body** (`origin pr view 315`) with `BASE_SHA=70c46fd` and `HEAD_SHA=7a23ca2` (and evidence tip `725a11c`) **exits 1**:

> PR touches `app/ops`; include at least one concrete `/api/...` fetch-path evidence entry.

The body includes `backend_real` / `frontend_real` / `transport_stub` and coarse `-> app/ops/operator-audit-console.tsx` call-site lines, but **no** `/api/d2/ops-reporting` (or other `/api/...`) path. Under the raised bar, phase audit **FAIL** until metadata is amended and replay is green (same class as PR291-MAJOR-1).

**Fix:** Add machine-readable GET **537/538** fetch-path evidence (e.g. `/api/d2/ops-reporting?view=…`) to PR metadata; re-run claim replay.

---

## What passed (auditor replay)

- **Landing:** `7a23ca2^` = `70c46fd`; **19 files**; no builder-authored `docs/audits/*-audit.md` in squash; `docs/ci/focused-lane-notes.md` is CI notes (PR313-M1), not an audit verdict.
- **Slice:** GET **537–538** on **535/536** parents; `route.ts` **46479** (+460); console **7117** (+32).
- **Rules:** `_view537` / `_view538` each **1×** dedicated `firestore.rules` match; Job E + `denyWritePaths` byte-identical; whitelist **485–500**, **503**, **504** only.
- **Tests:** focused **36/337**; `test:rules` **180/180** on auditor rerun (56+105+1+14); invariants **60/60**; isolation **35/35**; G-0 **[15][16]** PASS; G-1 **10/10**; claim-gate vitest **20/20**; gate-[15] **5/5**; bundle gate **2/2**.
- **frontend_real:** `/ops` L6672–6695 (GET **537/538** after **535/536** @ L6640–6663); dedicated route-wiring `it()` for **537** and **538** assert repository fields + `json.view`.
- **PR313-M1:** `check_focused_lattice_ops_bundle.py` excludes `tests/ops.batch-*`; focused-lane note matches behavior.

## Minors

- **PR315-M2:** First `npm run test:rules` run hit a **45s timeout** on one `persistence.runtime-mode` mega test; immediate rerun **180/180** green (environment load).
- **PR315-M3:** PR body call-site bullets omit concrete line numbers (implementation at L6672–6695).

## After fix

Re-audit for **SEALED PASS [PARTIAL]** @ `7a23ca2` (product code need not change if only metadata is corrected).
