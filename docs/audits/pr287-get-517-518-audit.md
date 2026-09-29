# Independent phase auditor A–F audit: PR #287 GET 517–518

**Auditor:** independent phase auditor (docs-only)  
**Landed squash SHA:** `d5ca261efdc8d01ce124646e3cc838dae69b399e` (PR #287 on `main`)  
**Parent SHA:** `cd09ad168e565a4c14cf88bf66b1717d5652656c` (#286 docs)  
**Evidence tip:** `a5392b85a7e97205b80e113b5f7f1125368e3f8a`  
**Evidence:** `/opt/cursor/artifacts/pr287_audit.log`  
**Collection table:** `/opt/cursor/artifacts/pr287_collection_table.md`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #287 @ `d5ca261`** | **FAIL** |
| **Product (if remediated)** | **PARTIAL** (`transport_stub=true`) |

## Summary

- **Slice:** GET **517–518** outbound registry attestation ledger on **515/516** (analogue of **505/506** on **503/504**); dedicated `_view517` / `_view518`.
- **Landing:** tip patch empty; **15-file** squash; no ROADMAP / agent policy drift in squash.
- **Lattice / FE / isolation / gates:** green (26/257 focused ops, 14→**16/16** isolation, G-0/G-1, claim replay PASS).
- **Blocker class major:** `denyWritePaths` in `tests/firestore.rules.test.ts` omits **517/518** while Job E dedicated array includes them — breaks checklist D and **515/516** parity.

## PR287-MAJOR-1 fix

Add `…_tb_ack_recon_pd_freeze_seal_view517` and `…_view518` collection paths to the `denyWritePaths` array (same pattern as **515/516**), re-run `npm run test:rules`.

## Folded minor

- **506** identity-array reorder: same slice set, **506** placed after **505** (not dropped).
