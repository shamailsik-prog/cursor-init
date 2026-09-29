# Independent phase auditor A–F audit: PR #325 GET 545–546

**Auditor:** independent phase auditor (docs-only)  
**Landed squash SHA:** `3f8a0b31602ebbd9660b60975ae352dd63fc552b` (PR #325 on `main`)  
**True first parent:** `9ab7a256b1e80bf46ac7e4f2cafa4abc69e1094f` (#324 docs)  
**Evidence tip:** `7474214d02e64d002428e5cc79d4ee627c97be2e` (empty diff vs squash)  
**Evidence:** `/opt/cursor/artifacts/pr325_audit.log`  
**Collection table:** `/opt/cursor/artifacts/pr325_collection_table.md`  
**Break / replay:** `/opt/cursor/artifacts/break_test_pr325.log`, `/opt/cursor/artifacts/replay_pr325.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #325 @ `3f8a0b3`** | **SEALED PASS [PARTIAL]** |
| **Product** | **PARTIAL** (`transport_stub=true`) |

---

## Summary

- **Slice:** GET **545–546** on **543/544** parents; `route.ts` **47512** (+217 vs #324 tip); console **7247** (+33).
- **Landing:** **18 files**, +621/−16; `9ab7a25..main` = **#325 only**; product paths **additions-only** (route/console/rules **0 deletions**).
- **−16 lines:** CI bundle guard/ledger text, invariants describe/constant edits, rules-test array maintenance, one route-wiring mock string — **no 485–544 runtime change**.
- **Fold-ins:** **PR323-M1** — `DEDICATED_VIEW_MAX` **546**; alignment loop **485–546**. **PR323-M3** — ledger History parent labels for 543–544 corrected.
- **Rules:** `_view545` / `_view546`; Job E + denyWrite byte-identical; paths **1464** / **1345** bytes.
- **Tests:** focused **40/361**; `test:rules` **213/213** (**3×** auditor runs; run **1** repositories **5s timeout flake** — **PR325-M1**); invariants **77**; isolation **43**; G-0 **[15][16]** PASS; claim replay **PASS** @ `BASE=9ab7a25`, `HEAD=3f8a0b3` and **`HEAD=7474214`**.

## `test:rules` +11 vs `9ab7a25` (202 → 213)

| File | Δ tests | Notes |
|------|--------:|-------|
| `firestore.rules.lattice-dedicated-view-invariants.test.ts` | **+7** | Loop **+4** (543–546 in alignment `it.each`); break **545/546 +2**; PR545 deny orphan **+1** |
| `firestore.rules.test.ts` | **+4** | Client write deny for **545/546** |
| `ops…lineage-isolation.test.ts` | **+2** | **543/545**, **544/546** pairs |
| `…545-546-frontend-real.test.ts` | **+2** | New file |
| `persistence.route-wiring.test.ts` | **+2** | parseView/wiring for **545/546** |
| `persistence.repositories.test.ts` / `persistence.runtime-mode.test.ts` | **0** | Unchanged |

## Minors

- **PR325-M1:** First of three `test:rules` runs hit **`persistence.repositories.test.ts`** 5s timeout (runs 2–3 **213/213** green).
