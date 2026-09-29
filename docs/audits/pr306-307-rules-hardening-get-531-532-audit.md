# Independent phase auditor A–F audit: PR #306 rules hardening + PR #307 GET 531–532

**Auditor:** independent phase auditor (docs-only)  
**#306 @ `e6d237a227da72a140929b5c47807f1471e1d0f0`** (parent `14822d8884955f88689ac96f92893e2375f8b303`)  
**#307 @ `b9f2bfb01b682f9d8c4f3b35449d249a135ebaa4`** (parent `e6d237a`)  
**Evidence:** `/opt/cursor/artifacts/pr306_307_audit.log`  
**Collection table:** `/opt/cursor/artifacts/pr306_307_collection_table.md`  
**Date:** 2026-09-29

## Executive verdict

| PR | Verdict |
|---|---|
| **#306** | **SEALED PASS [PARTIAL]** (`transport_stub=true`; rules/tests only) |
| **#307** | **SEALED PASS [PARTIAL]** (`transport_stub=true`; `frontend_real=true` for 531/532 `/ops`) |

---

## PR #306 summary

- Closes raised-bar asymmetries for **501–530** dedicated `_view` collections (Job E / denyWrite / rules alignment).
- New static `tests/firestore.rules.lattice-dedicated-view-invariants.test.ts`; `npm run test:rules` **151** (47+89+1+14).
- Removed duplicate rule/`it.each` paths only; break tests **506/517** fail `test:rules` when weakened.
- Claim replay **PASS** @ `BASE=14822d8`, `HEAD=e6d237a`.

## PR #307 summary

- GET **531–532** on **529/530**; `route.ts` **+177**; console **+32**; focused **33/313**; isolation **29/29**.
- **531/532** in Job E + denyWrite + dedicated rules (byte match); break tests pass raised bar.
- Claim replay **PASS** @ `BASE=e6d237a`, `HEAD=b9f2bfb`.

## Minors

- **PR306-M1:** Invariant test **skips** views with zero `_view` rule lines (485–500, 503–504) — does not fail on “missing rule for new view number” until a `match` exists.
- **PR307-M2:** `firestore.rules` inserts **531/532** `match` blocks on the **same line** as `_view530` (split across newlines recommended).
- **PR306-M2 / PR307-M3:** Evidence tips **`31bc5a3`**, **`b492293`** not on `origin`.
- **485–500:** No Job E `_view` rows — **pre-existing**; client deny via catch-all + legacy prefix rules (see audit log).
