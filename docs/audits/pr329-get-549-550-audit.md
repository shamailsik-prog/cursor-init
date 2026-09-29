# Independent phase auditor A–F audit: PR #329 GET 549–550

**Auditor:** independent phase auditor (docs-only)  
**Landed squash SHA:** `134a0a15284951f2f15350892f9ede88b64b7032` (PR #329 on `main`)  
**True first parent:** `a81b40f2772ba48aa5642180fc2746ee45d6efcc` (#328 docs-only)  
**Evidence tip:** `origin/evidence/get-549-550` (empty diff vs squash)  
**Evidence:** `/opt/cursor/artifacts/pr329_audit.log`  
**Collection table:** `/opt/cursor/artifacts/pr329_collection_table.md`  
**Break / replay:** `/opt/cursor/artifacts/break_test_pr329.log`, `/opt/cursor/artifacts/replay_pr329.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #329 @ `134a0a1`** | **FAIL — PR329-MAJOR-1** |
| **Product** | **PARTIAL** (`transport_stub=true`; would seal but for isolation gap) |

---

## Summary

- **Slice:** GET **549–550** on **547/548** parents; `route.ts` **47906** (+172 vs #328 tip); console **7312** (+32).
- **Landing:** **18 files**, +528/−12; `a81b40f..main` = **#329 only**; product route/console/rules **0 deletions**.
- **−12:** bundle guard strings (**5**), invariants MAX/describe (**2**), ledger header (**1**), isolation **title renames only** (**2**), route-wiring parseView title (**1**), denyWritePaths bracket formatting (**1**).
- **Rules:** `_view549` **1403 B**, `_view550` **1299 B**; Job E + denyWrite byte-identical; `DEDICATED_VIEW_MAX` **550**.
- **Tests (green but incomplete):** focused **42/371**; `test:rules` **229/229 ×3**; invariants **85**; G-0 **[15][16]** PASS; claim replay **PASS**.
- **frontend_real:** `/ops` GET **549** L6871–6884, **550** L6885–6898; PR body matches.

## PR329-MAJOR-1 — isolation dead code (PR311-MAJOR-1 class)

In `tests/ops.pr-tb-ack-recon-lattice-dedicated-collection-lineage-isolation.test.ts`, two new `it()` blocks for **547/549** and **548/550** were placed **inside** the `vi.mock("@/platform/spine/runtimeStore", …)` factory **after** `return { getRuntimeStore: … }` (lines **40–72**). They never register as tests; **vitest count stays 45**, not **47**.

Renamed cases **545/547/549** and **546/548/550** still call `seedAndGet` with **`U["545"]`/`U["547"]`** and **`U["546"]`/`U["548"]`** only — **549/550 store separation is not exercised**.

**Fix:** Move the two blocks into the main `describe`; add real pairwise seeds for **547 vs 549** and **548 vs 550** (or extend `seedAndGet` URLs); expect **47** isolation tests.

## `test:rules` +8 vs `a81b40f` (221 → 229)

| File in `npm run test:rules` | Parent | Squash | Δ |
|---|---:|---:|---:|
| `firestore.rules.lattice-dedicated-view-invariants.test.ts` | 81 | 85 | **+4** (alignment **549/550 +2**; break guard **+2**) |
| `firestore.rules.test.ts` | 125 | 129 | **+4** (client deny **549/550**) |
| `persistence.runtime-mode.test.ts` | 14 | 14 | 0 |
| `persistence.repositories.test.ts` | 1 | 1 | 0 |

## Minors

- Isolation **titles** over-claim **549/550** while URLs still target parent pairs only (misleading even after MAJOR fix unless titles corrected).
