# Independent Phase Auditor RE-AUDIT after helper fix PR #99

Date: 2026-09-20  
Repo: `shamail-sikander/cursor-init`  
Requested helper-fix SHA: `8ba7dbaa804f3cab12fb6eb874b7c6c29a367932`

## Overall verdict (lead)

**Frontend helper/lattice re-audit: PASS for required Batch D/E/F and #70-#73 call paths.**

- `BACKEND_REAL`: PASS for sampled lanes in this re-audit run.
- `FRONTEND_REAL`: PASS for Batch D/E/F and #70-#73 (`/ops` call sites are executable with the helper now defined/wired).
- `transport_stub`: true, so product-level classification remains **PARTIAL (major)** and cannot be promoted to DONE.

**Blockers:** no remaining frontend helper/lattice blocker found.  
**Remaining product blocker:** external filing transport still fail-closed by explicit stub policy (`TODO(firm)`, `_stub`, `blocked_todo_firm`, `todo_firm_external_transport_blocked`).

## 0) Tip and ancestry confirmation

- `git fetch origin main` pulled `origin/main` to `8ba7dbaa804f3cab12fb6eb874b7c6c29a367932`.
- `origin/main` equals the requested SHA exactly.
- `git show --no-patch` confirms it is merge commit `Merge pull request #99 from cursor/phase-auditor-remediation-4cb8`.
- `git merge-base --is-ancestor 8ba7d... origin/main` and `... HEAD` both return success (`0`).

## 1) Must verify: helper defined/imported/used and no undefined refs in `operator-audit-console.tsx`

Result: **PASS**

- `app/ops/api-call-helpers.ts` exports `runApiCallAllowingStatuses(...)`.
- `app/ops/operator-audit-console.tsx` imports it as `runApiCallAllowingStatusesImpl`.
- `app/ops/operator-audit-console.tsx` defines local wrapper `runApiCallAllowingStatuses(...)` and routes execution through `runApiCallAllowingStatusesImpl`.
- Targeted `tsc` grep (`npx tsc --noEmit | rg "operator-audit-console.tsx"`) returns no symbol/type errors for this file.

## 2) Must verify: Batch D (#38-#47) FRONTEND_REAL call sites executable via helper

Result: **PASS (frontend lane)**  
Severity: **major** only because transport stub cap still applies product-wide.

Evidence in `/ops`:

- Action lattice uses `runApiCallAllowingStatuses` for:
  - source actions (`confirm_engagement`, `record_case_number`) via `/api/d1/matters`
  - client entity create/conflict-check via `/api/d1/clients`
  - tenancy role update via `/api/p5/tenancy`
  - committee write via `/api/p1/committee-brain`
- Read-side call sites remain wired for:
  - tenancy session/users/memberships/audit (`/api/p5/tenancy`)
  - clients (`/api/d1/clients`)
  - reporting (`/api/d1/reporting`)
  - ops-reporting (`/api/d2/ops-reporting`)
  - committee list (`/api/p1/committee-brain`)

## 3) Must verify: Batch E (#48-#59) FRONTEND_REAL filing/escalation actions executable

Result: **PASS (frontend lane)**  
Severity: **major** (transport-stub-capped final classification).

- `runBatchEActionLattice()` now executes through `runApiCallAllowingStatuses` across the filing/escalation action set (annexure checkpoints, submission receipt/reconciliation, exception lifecycle, ownership/waiver/policy controls, delivery + digest cleanup).
- Calls execute against real route path `/api/d4/filings` (not string-only placeholders).

## 4) Must verify: Batch F (#60-#69) FRONTEND_REAL governance lattice executable

Result: **PASS (frontend lane)**  
Severity: **major** (transport-stub-capped final classification).

- `runBatchFGovernanceLattice()` uses `runApiCallAllowingStatuses` throughout closure governance:
  - SLA window + auto-assignment controls
  - follow-up assignment/claim/resolve lanes
  - attestation/dispute/adjudication controls
  - adjudication SLO governance and debt remediation
  - rebalance safeguards and expiry reconciliation controls
- Calls execute against real route path `/api/d4/filings`.

## 5) Must verify: #70-#73 status + transport cap

Result: **PASS for FRONTEND_REAL/BACKEND_REAL; PARTIAL final due transport policy**

Per-phase verdicts:

| Phase | backend_real | frontend_real | transport_stub | Final | Severity |
|---|---|---|---|---|---|
| #70 Debt-burndown forecasting + expiry attestation | PASS | PASS | true | PARTIAL | major |
| #71 Burndown recalibration + attestation queue orchestration | PASS | PASS | true | PARTIAL | major |
| #72 Burndown settlement + queue drain | PASS | PASS | true | PARTIAL | major |
| #73 Settlement attestation + queue drain reconciliation | PASS | PASS | true | PARTIAL | major |

## 6) Tests + G-0/G-1 (as feasible)

### Executed and passing

1. `npx vitest run tests/api.filings.test.ts tests/api.matters.test.ts tests/api.tenancy.test.ts tests/api.clients.test.ts tests/api.reporting.test.ts tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts tests/ops.batch-d-frontend-real.test.ts tests/ops.api-call-helpers.test.ts`
   - Result: 9 files, 92 tests passed.

2. `npx firebase emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts"`
   - Result: 2 files, 15 tests passed.

3. `bash ci_gates/gate_g0.sh`
   - Result: PASS.

4. `python3 ci_gates/gate_g1.py`
   - Result: PASS (10 tests).

### Additional compiler signal

- Whole-repo `npx tsc --noEmit` still reports pre-existing unrelated errors outside this scope.
- Re-audit criterion here was helper/lattice undefined-ref regression in `operator-audit-console.tsx`; targeted grep over compiler output shows no errors for that file.

## Batch verdicts requested

| Batch | Verdict | Severity | Rationale |
|---|---|---|---|
| Batch D (#38-#47) | PASS (frontend lane) / PARTIAL (final product) | major | Helper is now defined/wired and action+view call sites execute through `/ops`; final product still capped by transport stubs. |
| Batch E (#48-#59) | PASS (frontend lane) / PARTIAL (final product) | major | Filing/escalation action lattice now executable via helper; final product remains capped by transport stubs. |
| Batch F (#60-#69) | PASS (frontend lane) / PARTIAL (final product) | major | Governance lattice now executable via helper; final product remains capped by transport stubs. |

## Remaining concrete fixes (outside this helper re-audit scope)

1. Implement firm/external filing transport (remove fail-closed TODO boundary) to clear the `transport_stub` cap.
2. Keep claim-hygiene gate (`ci_gates/check_pr_phase_claims.py`) enforced so COMPLETE/product-done claims fail while stub markers remain.
