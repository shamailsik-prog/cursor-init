# Independent phase auditor A–F audit: PR #287 GET 517–518

**Auditor:** independent phase auditor (docs-only)  
**Product squash SHA:** `d5ca261efdc8d01ce124646e3cc838dae69b399e` (PR #287)  
**Integration / seal SHA:** `c21e1e8635d85f9f22cb3b56c124926e058a1d57` (PR #287 + PR #289 PR287-MAJOR-1)  
**Parent SHA (product):** `cd09ad168e565a4c14cf88bf66b1717d5652656c` (#286 docs)  
**Fix:** `18c8cafd19e8073020bbb64b97b0ba4e0763ec0c` (#288 FAIL ledger) → PR **#289**  
**Evidence:** `/opt/cursor/artifacts/pr287_audit.log` (initial FAIL), `/opt/cursor/artifacts/pr287_reaudit.log` (re-audit)  
**Collection table:** `/opt/cursor/artifacts/pr287_collection_table.md`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #287 @ `d5ca261` (initial)** | **FAIL** (PR287-MAJOR-1) |
| **Re-audit @ `c21e1e8`** | **SEALED PASS** |
| **Product** | **PARTIAL** (`transport_stub=true`) |

## Initial audit summary (@ `d5ca261`)

- **Slice:** GET **517–518** outbound registry attestation ledger on **515/516**; dedicated `_view517` / `_view518`.
- **FAIL — PR287-MAJOR-1:** `denyWritePaths` omitted **517/518** while Job E TB array included them.

## Re-audit after PR #289 (@ `c21e1e8`)

- **Fix:** `tests/firestore.rules.test.ts` **+2** `denyWritePaths` entries; paths match `firestore.rules` **L213–L214**.
- **`test:rules`:** **72/72** (57/1/14); break test on `_view518` → **3** failures (reverted).
- **Focused ops:** **26/257**; G-0/G-1; claim-gate **20/20**; #289 process replay **PASS** (flags false, truthful); #287 product replay still **PASS** @ `d5ca261`.
- **Regression:** wiring **517/518** `it()` and `/ops` **5867–5891** unchanged.

## Folded minor

- **506** identity-array reorder (same slice set).
- Bundle doc header still says **25 files** while runner and file list include **26** (file 517–518 FE test) — cosmetic doc drift only.
