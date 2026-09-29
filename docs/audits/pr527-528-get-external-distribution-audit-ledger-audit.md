# Independent phase auditor A–F audit: PR #300 GET 527–528

**Auditor:** independent phase auditor (docs-only; **not** the builder-authored file voided on `main` by PR527-MAJOR-1)  
**Landed squash SHA:** `cdbf6b000423b3d9c78045effef8979ece397f46` (PR #300)  
**True first parent:** `33acecd57038349e9a325b0ceeaa24e3caf398bd` (#299 docs); `33acecd^` = `d466a2d` (#298)  
**Pre-squash PR tip:** `b19d5a97a95a875b1836e0e601349f06d149caad`  
**Evidence:** `/opt/cursor/artifacts/pr300_audit.log`  
**Collection table:** `/opt/cursor/artifacts/pr300_collection_table.md`  
**Break test:** `/opt/cursor/artifacts/break_test_pr300.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **Product @ `cdbf6b0` (technical A–F)** | **PASS** → **SEALED PASS [PARTIAL]** once this doc replaces void builder self-cert |
| **Phase record until docs merge** | **FAIL — PR527-MAJOR-1** (forged auditor attribution on `main` in product PR #300) |
| **Product** | **PARTIAL** (`transport_stub=true`) |

---

## Summary

- **Slice:** GET **527–528** — external distribution audit ledger (custody on **525**) + partner handoff attestation (closure on **526**); mirrors **515–516** on **513/514**.
- **Landing:** parent `33acecd`; empty `git diff b19d5a9..cdbf6b0`; product squash **17 files** (+1156/−77) incorrectly included builder “auditor” markdown — **void**; remediated by **this** docs PR overwrite.
- **`route.ts`:** 44430 → **45028** (+598).
- **Rules/tests:** **527/528** in **both** Job E and `denyWritePaths`; **`test:rules` 106/106** (91+1+14) — **not** 102/102 claimed in void builder doc.
- **Focused ops:** **31/296**; isolation **25/25**.
- **Fold-ins verified:** **521/522** alternate rule blocks **L244–L245**; Job E **524→528** ascending; parseView title **492–528**.
- **Claim replay:** **PASS** @ `BASE=33acecd`, `HEAD=b19d5a9` / `cdbf6b0`.
- **frontend_real:** `/ops` L6512–6536 → `/api/d2/ops-reporting`.

## Minors

- **PR300-M4:** **527/528** test arrays list **duplicate identical** path strings twice per array (vacuous extra `it.each` cases).
- **PR527-MAJOR-1 fix:** merge this docs PR; seal check = only this write-up + verification row remain for #300/#527–528.

## Gate recommendation

Add CI guard: product diffs must not introduce `docs/audits/*audit.md` or `LEGAL_OS_PHASE_VERIFICATION` “SEALED PASS” rows posing as independent phase auditor (see `/opt/cursor/artifacts/pr300_audit.log` § PR527-MAJOR-1).
