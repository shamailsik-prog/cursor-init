# Independent phase auditor A–F audit: PR #327 GET 547–548

**Auditor:** independent phase auditor (docs-only)  
**Landed squash SHA:** `9a236cb17261d210c2d935593533ae23e7203127` (PR #327 on `main`)  
**True first parent:** `4c190332372f6b68c5e48c292f59948efeacfc80` (#326 docs-only)  
**Evidence tip:** `b74c28525cfd7e60877cef852eea931915563e8f` (empty diff vs squash)  
**Evidence:** `/opt/cursor/artifacts/pr327_audit.log`  
**Collection table:** `/opt/cursor/artifacts/pr327_collection_table.md`  
**Break / replay:** `/opt/cursor/artifacts/break_test_pr327.log`, `/opt/cursor/artifacts/replay_pr327.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #327 @ `9a236cb`** | **SEALED PASS [PARTIAL]** |
| **Product** | **PARTIAL** (`transport_stub=true`) |

---

## Summary

- **Slice:** GET **547–548** on **545/546** parents; `route.ts` **47734** (+222 vs #326 tip); console **7280** (+33).
- **Landing:** **19 files**, +600/−10; `4c19033..main` = **#327 only**; product route/console/rules **0 deletions**.
- **−10:** bundle guard text (**5**), invariants MAX/describe (**2**), ledger header (**1**), **PR325-M1** repositories `it` timeout (**1**), route-wiring mock label (**1**).
- **Rules:** `_view547` **1354 B**, `_view548` **1236 B**; Job E + denyWrite byte-identical; `DEDICATED_VIEW_MAX` **548**.
- **Tests:** focused **41/367**; `test:rules` **221/221 ×3**; invariants **81**; isolation **45**; G-0 **[15][16]** PASS; claim replay **PASS**.
- **frontend_real:** `/ops` **547** L6839–6852, **548** L6853–6865; PR body **`GET /api/d2/ops-reporting`** evidence matches.

## `test:rules` +8 vs `4c19033` (213 → 221)

| File in `npm run test:rules` | Parent | Squash | Δ |
|---|---:|---:|---:|
| `firestore.rules.lattice-dedicated-view-invariants.test.ts` | 77 | 81 | **+4** (alignment **547/548 +2**; break guard **+2**) |
| `firestore.rules.test.ts` | 121 | 125 | **+4** (client deny **547/548**) |
| `persistence.runtime-mode.test.ts` | 14 | 14 | 0 |
| `persistence.repositories.test.ts` | 1 | 1 | 0 (timeout **10_000 ms** only) |

## PR325-M1

**Closed:** all three auditor `test:rules` runs **221/221** green; no repositories round-trip timeout after **10_000 ms** `it` timeout.
