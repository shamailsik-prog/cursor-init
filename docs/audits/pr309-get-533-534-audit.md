# Independent phase auditor A–F audit: PR #309 GET 533–534 (+ PR306-M1 + PR307-M2)

**Auditor:** independent phase auditor (docs-only)  
**Landed squash SHA:** `792a7ed112d605d599667b23b94bd8d144db7012` (PR #309 on `main`)  
**True first parent:** `e40685512c55ef353a5fb9e1592c957ccf855c15` (#308 docs); `e406855^` = `b9f2bfb` (#307)  
**Evidence:** `/opt/cursor/artifacts/pr309_audit.log`  
**Collection table:** `/opt/cursor/artifacts/pr309_collection_table.md`  
**Break test:** `/opt/cursor/artifacts/break_test_pr309.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #309 @ `792a7ed`** | **SEALED PASS [PARTIAL]** |
| **Product** | **PARTIAL** (`transport_stub=true`; `frontend_real=true` for 533/534 `/ops`) |

---

## Summary

- **Slice:** GET **533–534** on outbound-registry attestation ledger parents **531/532**; `route.ts` **45559** (+180 vs #308 tip); console **7053** (+31).
- **Fold-ins:** **PR306-M1** — `LATTICE_DEDICATED_VIEW_ARRAY_WITHOUT_RULES_MATCH_WHITELIST` = **485–500**, **503**, **504** only; missing rule for **501** fails invariant. **PR307-M2** — `_view530`–`_view532` on separate rule lines **215–217**; **533/534** on **218–219**.
- **Rules:** **501–502**, **505–534** each **1×** dedicated match + Job E + denyWrite (byte-identical).
- **Tests:** focused **34/321**; `test:rules` **163** (51+97+1+14); isolation **31/31**; G-0 **[15]** PASS; G-1 **10/10**; claim-gate **20/20**; gate-[15] **5/5**.
- **Claim replay:** **PASS** @ `BASE=e406855`, `HEAD=792a7ed` (live PR #309 body).
- **frontend_real:** `/ops` L6609–6631 for **533/534**.

## Minors

- **PR309-M1:** Invariant missing-rule check keys off **Job E** only (not `denyWritePaths`-only entries).
- **PR309-M2:** Evidence tip **`bed86ff`** not fetchable from `origin`.
