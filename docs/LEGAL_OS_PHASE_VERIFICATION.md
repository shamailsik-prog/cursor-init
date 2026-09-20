# Legal OS phase verification status (audited sample: PR #34-#37, #38-#47, and #70-#73)

Last updated: 2026-09-20  
Source of truth: forensic audit docs plus post-audit operator UI wiring on `main` lineage.

## Executive verdict

No audited sample phase currently qualifies as **DONE product**.

- `backend_real`: PASS across #34-#47 and #70-#73.
- `frontend_real`: mixed. `/ops` covers several operational APIs, but tenancy/client/reporting/ops-reporting coverage remains incomplete.
- `transport_stub`: still true because filing transport remains `TODO(firm)` + `_stub` + `blocked_todo_firm`.

Because `transport_stub=true`, final status remains **PARTIAL** for all sampled phases.

## Label-based summary (required on every closure claim)

| PR | Claimed phase | Claimed merge SHA | Landed on `main` | backend_real | frontend_real | transport_stub | Final classification | Severity |
|---|---|---|---|---|---|---|---|---|
| #34 | Firestore-backed runtime mode switch | `27d594f` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #35 | Firestore write-path parity (documents/filings/workflow) | `3a60438` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #36 | Workflow timeline + OCR job persistence | `aebefbb` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #37 | Drafts + Court Ops persistence | `45cacaf` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #70 | Debt-burndown forecasting + expiry attestation | `0e2d397` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | blocker |
| #71 | Burndown recalibration + attestation queue orchestration | `ca564d8` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | blocker |
| #72 | Burndown settlement + queue drain | `65b1615` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | blocker |
| #73 | Settlement attestation + queue drain reconciliation | `3a1812c` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | blocker |

## Batch D append: PR #38-#47

| PR | Claimed phase | Claimed merge SHA | Landed on `main` | backend_real | frontend_real | transport_stub | Final classification | Severity |
|---|---|---|---|---|---|---|---|---|
| #38 | Follow-up source persistence | `f78abce` | Yes | PASS | FAIL (no UI for follow-up/intimation source actions) | true | PARTIAL | major |
| #39 | Membership persistence | `f93ec73` | Yes | PASS | PASS (`/ops` route family) | true | PARTIAL | blocker |
| #40 | Tenancy membership | `2a411b5` | Yes | PASS | FAIL (no `/api/p5/tenancy` UI caller) | true | PARTIAL | major |
| #41 | Tenancy audit | `e0ee204` | Yes | PASS | FAIL (no `/api/p5/tenancy` UI caller) | true | PARTIAL | major |
| #42 | Entity/client persistence | `b895247` | Yes | PASS | FAIL (no `/api/d1/clients` UI caller) | true | PARTIAL | major |
| #43 | Audit write-through non-tenancy | `9ed9195` | Yes | PASS | PARTIAL (most touched APIs in `/ops`, not `/api/d1/clients`) | true | PARTIAL | blocker |
| #44 | Committee-brain output persistence | `a48f868` | Yes | PASS | PARTIAL (Foundation console POST only) | true | PARTIAL | major |
| #45 | Matter/client reporting + search index | `2d2d0a8` | Yes | PASS | FAIL (no `/api/d1/reporting` UI caller) | true | PARTIAL | major |
| #46 | Draft template analytics | `b896b60` | Yes | PASS | PASS (`/ops` templates + compose + drafts views) | true | PARTIAL | major |
| #47 | Workflow ops reporting | `be269a9` | Yes | PASS | FAIL (no `/api/d2/ops-reporting` UI caller) | true | PARTIAL | major |

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

