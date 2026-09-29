# Independent phase auditor A–F audit: PR #302 GET 529–530 (+ gate + PR300-M4 dedupe)

**Auditor:** independent phase auditor (docs-only)  
**Landed squash SHA:** `8f008ce6276eac93e19d37c8063cd08f0820de9e` (PR #302 on `main`)  
**True first parent:** `d4ca186e18a043c1584a95bc2f01fb6dbf03f504` (#301 docs seal); verified `git rev-parse 8f008ce^`  
**Pre-squash PR tip (metadata):** `9f51f663d4b0` — **not fetchable** from `origin`; auditor verified **one** commit `d4ca186..origin/main` only  
**Evidence:** `/opt/cursor/artifacts/pr302_audit.log`  
**Collection table:** `/opt/cursor/artifacts/pr302_collection_table.md`  
**Break test:** `/opt/cursor/artifacts/break_test_pr302.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #302 @ `8f008ce`** | **FAIL — PR302-MAJOR-1** |
| **Product (if MAJOR fixed)** | **PARTIAL** (`transport_stub=true`) |

---

## PR302-MAJOR-1 — no dedicated `firestore.rules` for `_view529` / `_view530`

- `tests/firestore.rules.test.ts` lists **529** and **530** collection paths in **both** Job E and `denyWritePaths` (**1×** each per array after PR300-M4 dedupe of duplicate **527/528** strings).
- @ `8f008ce`, `firestore.rules` has **zero** `view529` / `view530` substrings; squash `firestore.rules` diff is **+2** lines that **duplicate** existing **527** and **528** `match` blocks only.
- `npm run test:rules` **106/106** (91 rules + 1 persistence + 14 runtime-mode) still passes because client-write deny is satisfied by **catch-all** policy — **not** by dedicated matches → raised bar **FAIL**.
- Dedicated weaken/break test for **529/530** **blocked** (no rule line to weaken) — see break log.

**Exact fix:** Add dedicated deny-write `match` blocks for the **exact** Job E / `denyWritePaths` strings for **529** and **530**; re-run break test (weaken primary match → `test:rules` must fail); remove spurious duplicate **527/528** rule lines unless deliberately intended.

---

## Summary (parts that pass independent replay)

- **Slice:** GET **529** external distribution audit ledger reconciliation on finalized **527**; GET **530** partner handoff attestation ack on finalized **528** (mirrors prior lattice pairs).
- **Landing:** **19 files** +1073/−63; **no** builder `docs/audits/*audit.md` or `LEGAL_OS_PHASE_VERIFICATION.md` in product squash — **only** `docs/audits/lattice-focused-ops-vitest-bundle.md` under `docs/`.
- **Part A gate:** `ci_gates/check_no_product_phase_audit_docs.sh` → G-0 check **[15]**; `tests/no-product-phase-audit-docs-gate.test.ts` **4/4**; regression `BASE=33acecd HEAD=cdbf6b0` **FAIL** (mixed product+audit doc); `BASE=d4ca186 HEAD=8f008ce` **PASS**.
- **`route.ts`:** 45028 → **45202** (+174); **`operator-audit-console.tsx`:** 6958 → **6990** (+32).
- **parseView / wiring:** identity-only; dedicated wiring `it()` **529** / **530** with `json.view` asserts; parseView title **492–530**.
- **PR300-M4 dedupe:** **527/528** **2×→1×** per array; **0** unique paths removed; **+529/+530** in both arrays.
- **Focused ops:** **32/304**; bundle doc **32** files = runner (was **31/296** @ #300 seal).
- **Isolation:** **27/27** (incl. **527/529**, **528/530**).
- **G-0** incl **[15]**, **G-1**, claim-gate vitest **30/30** @ `8f008ce`.
- **Claim replay:** `check_pr_phase_claims.py` **PASS** @ `BASE=d4ca186`, `HEAD=8f008ce` (PR #302 body).
- **frontend_real:** `/ops` L6545–6558 (**529**), L6564–6568 (**530**) → `/api/d2/ops-reporting`.

## Minors

- **PR302-M2:** G-0 [15] with default `BASE=origin/main` `HEAD=HEAD` on `main` tip → empty diff **PASS**; CI should set merge-base `BASE`/`HEAD`.
- **PR302-M3:** Spurious **527/528** duplicate `match` lines in squash `firestore.rules` diff.
- **PR302-M4:** Evidence tip SHA not on remote; single-commit squash verified only.
