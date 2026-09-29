# Independent phase auditor A–F audit: PR #296 GET 523–524

**Auditor:** independent phase auditor (docs-only)  
**Integration / seal SHA:** `53cad4a00713dc4c06535c730335a8093d36df8a` (`origin/main` after post-land fix)  
**Landed squash SHA:** `691b211a439ad2f2df4a8b3e9475be86d2aa8783` (PR #296)  
**True first parent:** `0356805ab69de09b754cf0c052401dabd44a9540e` (#295 docs); `0356805^` = `d3c4452` (#294)  
**Pre-squash PR tip:** `ac4136006159050a7f052e9e59c453552a9c005b`  
**Evidence:** `/opt/cursor/artifacts/pr296_audit.log`  
**Collection table:** `/opt/cursor/artifacts/pr296_collection_table.md`  
**Break test:** `/opt/cursor/artifacts/break_test_pr296.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #296 @ `691b211` (squash)** | **FAIL** — **PR296-MAJOR-1** (Job E only for **523/524**; same class as **PR287-MAJOR-1**) |
| **Seal @ `53cad4a`** | **SEALED PASS** |
| **Product** | **PARTIAL** (`transport_stub=true`) |

---

## Summary

- **Slice:** GET **523–524** external transport receipt acknowledgment on finalized **521/522** (mirrors **511–512** on **509/510**).
- **Landing:** squash parent `0356805`; empty `git diff ac41360..691b211`; **16 files** +1141/−12; post-land **`53cad4a`** adds **+2** `denyWritePaths` only (`git diff ac41360..main`).
- **`route.ts`:** 43174 → **43796** (+622); **`operator-audit-console.tsx`:** 6571 → **6699** (+128).
- **Collections:** dedicated `_view523` / `_view524` @ rules **L247–L248** with alternate matches **L249–L250**; in **both** Job E and `denyWritePaths` @ **`53cad4a`**.
- **Focused ops:** **29 files, 280/280**; bundle ledger matches runner.
- **`test:rules`:** **87/87** @ `0356805` → **91/91** @ `53cad4a` (76+1+14); runtime-mode stays **14**.
- **Isolation:** **21/21** incl. **521/523**, **522/524**.
- **Claim replay:** PR #296 body **PASS** @ `BASE=0356805`, `HEAD=ac41360`, `691b211`, `53cad4a`.
- **frontend_real:** `/ops` L6256–6280 → `/api/d2/ops-reporting`.

## Minors

- **PR296-PROCESS-1:** Builder self-caught **PR296-MAJOR-1** via direct-to-main `53cad4a` (additions-only; prefer PR trail like #287/#289).
- **521/522** Job E alternate strings still catch-all-only; **523/524** alternates have named `match` blocks (PA fold-in from #294 narrative).
- CM miscount: **75** vs **76** firestore.rules tests; **15** vs **14** runtime-mode tests.
