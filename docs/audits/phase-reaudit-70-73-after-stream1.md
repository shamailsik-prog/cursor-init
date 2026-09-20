# Independent Phase Auditor re-audit: #70-#73 after Stream 1 `/ops` lands (`#79`, `#86`, `#88`, `#90`)

Date: 2026-09-20  
Repo: `shamail-sikander/cursor-init`  
Audited main tip: `3eee096`

## Overall verdict (lead)

**Primary target (#70-#73): PARTIAL (major).**

- `BACKEND_REAL`: **PASS**
- `FRONTEND_REAL`: **PASS** (phase-specific `/ops` action + view call sites are present)
- `transport_stub`: **true** (still caps any DONE/product-complete claim)

**Widened scope verdict (Batch D/E/F remediation lanes): PARTIAL (blocker).**

- `/ops` call sites were added for Batch D/E/F, but the action-lattice paths are not executable as landed because `runApiCallAllowingStatuses` is referenced but not defined in `app/ops/operator-audit-console.tsx`.
- Result: these lanes are not fully reclassified to `FRONTEND_REAL PASS` yet.

## Landing integrity for claimed remediation PRs

Verified on current `origin/main`:

- PR `#79` tip commit `4158eea61a3b` is ancestor of `origin/main`.
- PR `#86` tip commit `f8e8e9321e72` is ancestor of `origin/main`.
- PR `#88` tip commit `fbeba2c0de41` is ancestor of `origin/main`.
- PR `#90` tip commit `835578cb3742` is ancestor of `origin/main`.

## Required per-phase verdicts (#70-#73)

| Phase | backend_real | frontend_real | transport_stub | Final | Severity |
|---|---|---|---|---|---|
| #70 Debt-burndown forecasting + expiry attestation | PASS | PASS | true | PARTIAL | major |
| #71 Burndown recalibration + attestation queue orchestration | PASS | PASS | true | PARTIAL | major |
| #72 Burndown settlement + queue drain | PASS | PASS | true | PARTIAL | major |
| #73 Settlement attestation + queue drain reconciliation | PASS | PASS | true | PARTIAL | major |

## DoD checks requested

### A) BACKEND_REAL

Status: **PASS** for #70-#73.

Evidence:
- Focused API + route tests pass:
  - `tests/api.filings.test.ts`
  - `tests/persistence.route-wiring.test.ts`
- Firestore emulator persistence parity tests pass:
  - `tests/persistence.repositories.test.ts`
  - `tests/persistence.runtime-mode.test.ts`

### B) FRONTEND_REAL (`/ops` fetch call sites, not only base create/dispatch)

Status:
- **#70-#73: PASS**
- **Batch D/E/F remediation lanes: PARTIAL (blocker)** due undefined helper (details below).

#### #70-#73-specific `/ops` action + view call sites are present

In `app/ops/operator-audit-console.tsx`:

- Actions:
  - `set_closure_adjudication_debt_burndown_target`
  - `rebaseline_closure_adjudication_burndown_forecast`
  - `acknowledge_closure_burndown_settlement_drift`
  - `checkpoint_closure_settlement_post_resolution_verification`
- Views:
  - `closure_adjudication_debt_burndown`
  - `closure_burndown_recalibration`
  - `closure_burndown_settlement`
  - `closure_settlement_attestation`

These are wired through real `fetch` path execution via `runApiCallWithStatus` / `runApiCall`.

#### Widened-scope blocker found during re-audit

Batch D/E/F action-lattice functions call `runApiCallAllowingStatuses` repeatedly, but no definition exists in file:

- `runApiCallAllowingStatuses` references: `70`
- definitions found: `0`

`npx tsc --noEmit` reports many `TS2304/TS2552` missing-name errors for this symbol in `app/ops/operator-audit-console.tsx`, confirming action-lattice runtime is not executable as landed.

### C) `transport_stub` cap

Status: **still true**.

Evidence remains in filing transport/persistence surfaces:

- `TODO(firm)` external transport marker
- `blocked_todo_firm`
- `_stub` channels
- `todo_firm_external_transport_blocked`

Therefore, final product classification remains **PARTIAL** even where frontend/backend are otherwise real.

### D) Tests + G-0/G-1

Executed in this re-audit and passed:

1. `npx vitest run tests/api.filings.test.ts tests/api.matters.test.ts tests/api.tenancy.test.ts tests/api.clients.test.ts tests/api.reporting.test.ts tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts`
2. `npx firebase emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts"`
3. `bash ci_gates/gate_g0.sh`
4. `python3 ci_gates/gate_g1.py`

### E) Labels in docs accuracy

This re-audit updates `docs/LEGAL_OS_PHASE_VERIFICATION.md` to:

- move #70-#73 from pending to `frontend_real=PASS` with `transport_stub=true` cap retained.
- mark widened-scope Batch D/E/F `/ops` remediation as **PARTIAL** pending fix for the missing `runApiCallAllowingStatuses` helper and follow-up independent re-audit.

## Secondary verdicts requested: are prior Batch D/E/F FRONTEND_REAL gaps now addressed?

| Batch | Verdict | Severity | Evidence-based note |
|---|---|---|---|
| Batch E (#48-#59) | PARTIAL | blocker | Action + view call sites were added, but action lattice is blocked by undefined `runApiCallAllowingStatuses`; cannot claim full FRONTEND_REAL yet. |
| Batch F (#60-#69) | PARTIAL | blocker | Same blocker as Batch E; rich lattice exists but helper is undefined, so execution path is not complete. |
| Batch D (#38-#47) | PARTIAL | major | New view call sites are present (`/api/p5/tenancy`, `/api/d1/reporting`, `/api/d2/ops-reporting`, committee list); action lane still blocked by undefined helper. |

## Remaining concrete fixes

1. Define and wire `runApiCallAllowingStatuses` (or replace all uses with a defined equivalent around `runApiCallWithStatus`) in `app/ops/operator-audit-console.tsx`.
2. Re-run independent frontend re-audit for Batch D/E/F after helper fix.
3. Keep `transport_stub` cap explicit until firm/external transport is implemented and audited.
