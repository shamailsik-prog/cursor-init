# Independent phase auditor A–F audit: PR #291 GET 519–520

**Auditor:** independent phase auditor (docs-only)  
**Landed squash SHA:** `026a2ac1a34059d07d7518faee4a4613fe1b964c` (PR #291 on `main`)  
**True first parent:** `05128f320b9168e542811e574ba6090d4d8a4921` (#290 docs seal)  
**Pre-squash PR tip:** `05d7d3ba98847bffb0c018802b16cfaed613d04b`  
**Evidence:** `/opt/cursor/artifacts/pr291_audit.log`  
**Collection table:** `/opt/cursor/artifacts/pr291_collection_table.md`  
**Break test:** `/opt/cursor/artifacts/break_test_pr291.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #291 @ `026a2ac`** | **FAIL** |
| **Product (implementation)** | **PARTIAL** (`transport_stub=true`; backend + `/ops` wiring present) |

---

## PR291-MAJOR-1 (process metadata)

Live replay of `ci_gates/check_pr_phase_claims.py` against the **verbatim** PR #291 title/body from `origin pr view 291` with `BASE_SHA=05128f320b9168e542811e574ba6090d4d8a4921` and `HEAD_SHA=026a2ac1a34059d07d7518faee4a4613fe1b964c` (also `HEAD=05d7d3b`) exits **1**:

> PR metadata must include action-name→call-site evidence for /ops (e.g. `set_backup_owner -> app/ops/operator-audit-console.tsx`).

PR #291 declares `frontend_real=true` and changes `app/ops/operator-audit-console.tsx`, but the body only references the lattice function name and `/api/d2/ops-reporting` paths — not the required `-> app/ops/operator-audit-console.tsx` arrows. Builder evidence incorrectly listed `check_pr_phase_claims PASS`.

**Fix:** Amend metadata with view-name→call-site lines for GET **519** and **520** (same pattern as prior TB lattice product PRs), then re-run claim replay exit **0** before a **SEALED PASS** docs row.

---

## What passed (implementation A–F except E claim replay)

- **Slice:** GET **519–520** partner-delivery receipt freeze-override seal verification on **517/518** parents (same lattice step as **507/508** on **505/506**).
- **Landing:** squash parent `05128f3`; empty `git diff 05d7d3b..026a2ac`; 15 files +1144/−25; no policy-file drift in squash.
- **`route.ts`:** 41761 → **42438** (+677); **`operator-audit-console.tsx`:** 6309 → **6440** (+131).
- **Collections:** dedicated `_view519` / `_view520`; present in **both** Job E `TB_ACK_RECON_PD_FREEZE_SEAL_DEDICATED_VIEW_COLLECTIONS` and `denyWritePaths` (strings match `firestore.rules`).
- **`parseView`:** identity-only; wiring + `it.each` cover **519/520**.
- **Focused ops:** **27 files, 264/264**; bundle ledger matches runner `FILES[@]`.
- **`test:rules`:** **72/72** @ `05128f3` → **76/76** @ `026a2ac` (61/1/14); additions only.
- **Isolation:** **17/17** (incl. **517/519**, **518/520**).
- **G-0 / G-1 / claim-gate vitest:** PASS (**10/10**, **20/20**).
- **frontend_real:** `/ops` L5993–L6017 → `/api/d2/ops-reporting` for views **519** and **520**.
- **Break test:** weakening `_view520` deny caused **3** expected vitest failures; rules reverted.

## Minors

- Job E dedicated-array diff replaces duplicate **517/518** variant entries with **519/520** (not a denyWrite shrink for **517/518**).
- **485–487** dedicated `_viewNNN` deny tests still absent (pre-existing).
