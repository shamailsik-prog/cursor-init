# Legal OS phase verification status (audited sample: PR #34-#37 and #70-#73)

Last updated: 2026-09-20  
Source of truth: forensic audit docs plus post-audit operator UI wiring on `main` lineage.

## Executive verdict

No audited sample phase qualifies as **DONE product**.

- `backend_real`: PASS across #34-#37 and #70-#73.
- `frontend_real`: PASS for #34-#37 via `/ops`, but FAIL for #70-#73-specific governance actions/views.
- `transport_stub`: still true because filing transport remains `TODO(firm)` + `_stub` + `blocked_todo_firm`.

Because `transport_stub=true`, final status remains **PARTIAL** for all sampled phases.

## Label-based summary (required on every closure claim)

| PR | Claimed phase | Claimed merge SHA | Landed on `main` | backend_real | frontend_real | transport_stub | Final classification | Severity |
|---|---|---|---|---|---|---|---|---|
| #34 | Firestore-backed runtime mode switch | `27d594f` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #35 | Firestore write-path parity (documents/filings/workflow) | `3a60438` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #36 | Workflow timeline + OCR job persistence | `aebefbb` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #37 | Drafts + Court Ops persistence | `45cacaf` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #70 | Debt-burndown forecasting + expiry attestation | `0e2d397` | Yes | PASS | FAIL (no `/ops` call sites for phase-specific actions/views) | true | PARTIAL | blocker |
| #71 | Burndown recalibration + attestation queue orchestration | `ca564d8` | Yes | PASS | FAIL (no `/ops` call sites for phase-specific actions/views) | true | PARTIAL | blocker |
| #72 | Burndown settlement + queue drain | `65b1615` | Yes | PASS | FAIL (no `/ops` call sites for phase-specific actions/views) | true | PARTIAL | blocker |
| #73 | Settlement attestation + queue drain reconciliation | `3a1812c` | Yes | PASS | FAIL (no `/ops` call sites for phase-specific actions/views) | true | PARTIAL | blocker |

## Re-audit correction (independent, 2026-09-20)

- `/ops` is real and calls audited endpoint families (`/api/d1/documents`, `/api/d1/document-workflow`, `/api/d4/drafts`, `/api/d2/court-ops`, `/api/d4/filings`).
- However, the #70-#73 closure-governance action/view families in `app/api/d4/filings/route.ts` are not invoked from `/ops`.
- Therefore, `frontend_real` cannot be marked PASS for #70-#73 yet.
- COMPLETE claim hard-fail remains enforced while transport stubs exist via:
  - `ci_gates/check_pr_phase_claims.py`
  - `.github/workflows/pr-phase-claim-gate.yml`

## Blocking conditions for DONE classification

1. **Transport placeholder remains active**
   - `platform/persistence/filingDispatchQueue.ts` still carries `TODO(firm)` for external transport.
   - `_stub` channels and `blocked_todo_firm` remain in filing operational models.
2. **Claim hygiene must stay machine-enforced**
   - "scaffold-only" narrative is invalid when route/tests changed.
   - "COMPLETE/product-done" is invalid while filing transport stubs remain.

## Required gate behavior (hard fail)

The repository now includes a lightweight PR metadata gate:

- Script: `ci_gates/check_pr_phase_claims.py`
- Workflow: `.github/workflows/pr-phase-claim-gate.yml`

The gate fails when either condition is true:

1. PR metadata claims scaffold/docs-only or no runtime changes while `app/api/**` or `tests/**` changed.
2. PR metadata claims `COMPLETE`/`product-done` while transport stubs still exist.

## Verification checklist for future COMPLETE claims

1. **Merge/SHA integrity**
   - Confirm PR is merged.
   - Confirm claimed SHA is on `main`.
2. **Backend reality**
   - Inspect merge diff for route actions/views, repository wiring, Firestore rules, and tests.
3. **Runtime evidence**
   - Run focused route tests + persistence suites + `gate_g0` + `gate_g1`.
4. **Frontend reality**
   - Verify a user-facing TSX path executes the touched APIs (minimum `/ops` route or richer product UI).
   - Capture walkthrough evidence.
5. **Transport-stub policy**
   - Scan for `TODO(firm)`, `_stub`, and `blocked_todo_firm` in filing transport paths.
   - If any remain, classification is capped at PARTIAL and COMPLETE/product-done claims must fail.
6. **PR metadata gate**
   - Ensure `ci_gates/check_pr_phase_claims.py` passes before merge.
7. **Audit publication**
   - Publish verdict, evidence paths, command list, failed checks, and remediation.

