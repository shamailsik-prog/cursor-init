# Legal OS Phase Auditor Findings: PR #34-#37 (Batch A)

Date: 2026-09-20  
Auditor stance: independent forensic verification, no assumption of completeness.

## Overall verdict

**PARTIAL (major severity)** for the batch as "complete product phases."  
Reason: backend persistence slices are real and test-covered, but there is no user-facing UI wiring for these APIs, and filing transport remains explicit TODO/stub in the same operational surface.

## Scope audited

1. PR #34 -> merge commit `27d594f`  
2. PR #35 -> merge commit `3a60438`  
3. PR #36 -> merge commit `aebefbb`  
4. PR #37 -> merge commit `45cacaf`

Primary references:
- `app/api/d1/matters/route.ts`
- `app/api/d1/documents/route.ts`
- `app/api/d1/document-workflow/route.ts`
- `app/api/d2/court-ops/route.ts`
- `app/api/d4/drafts/route.ts`
- `app/api/d4/filings/route.ts`
- `platform/persistence/runtimeRepositories.ts`
- `platform/persistence/spineRepositories.ts`
- `platform/persistence/firestoreSpineRepositories.ts`
- `tests/api.*`
- `tests/persistence.*`
- `firestore.rules`

## Verdict table

| PR | Claimed focus | SHA landed on `main` | BACKEND_REAL | FRONTEND_REAL | Silent stubs/TODO | Verdict | Severity |
|---|---|---|---|---|---|---|---|
| #34 | Firestore runtime mode switch | Yes (`27d594f`) | PASS | FAIL | N/A in this commit diff | PARTIAL | major |
| #35 | Firestore write-path parity (documents/filings/workflow) | Yes (`3a60438`) | PASS | FAIL | Filing flow still stubbed transport surface | PARTIAL | major |
| #36 | Workflow timeline + OCR job persistence | Yes (`aebefbb`) | PASS | FAIL | No new stubs introduced in diff | PARTIAL | major |
| #37 | Drafts + Court Ops persistence | Yes (`45cacaf`) | PASS | FAIL | No new stubs introduced in diff | PARTIAL | major |

## What passed

### A) Backend reality checks

- Runtime mode selector exists and is used by audited routes (`platform/persistence/runtimeRepositories.ts` and route imports/calls).
- Route actions/views are implemented for claimed areas:
  - document ingest/list write-through
  - workflow transition/reviewer actions + timeline read
  - draft compose/list write-through
  - court-ops resolve lifecycle write-through
  - filing package create/decide write-through
- Memory + Firestore repository surfaces are present for claimed entities in:
  - `platform/persistence/spineRepositories.ts`
  - `platform/persistence/firestoreSpineRepositories.ts`
- Firestore rules include relevant collections and deny direct writes where expected (`firestore.rules`).

### B) Test and gate evidence (current `main`)

Executed and passed:
- `npx vitest run tests/api.documents.test.ts tests/api.document-workflow.test.ts tests/api.drafts.test.ts tests/api.court-ops.test.ts tests/api.filings.test.ts tests/persistence.route-wiring.test.ts`
- `npx firebase emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts"`
- `bash ci_gates/gate_g0.sh`
- `python3 ci_gates/gate_g1.py`

Artifacts:
- `/opt/cursor/artifacts/phase-audit-focused-tests.log`
- `/opt/cursor/artifacts/phase-audit-emulator-tests.log`
- `/opt/cursor/artifacts/phase-audit-g0.log`
- `/opt/cursor/artifacts/phase-audit-g1.log`

### C) SHA/landing verification

- PR metadata and merge ancestry validated:
  - `/opt/cursor/artifacts/phase-audit-pr-sha-evidence.log`

## What failed / incomplete vs DoD

### 1) FRONTEND_REAL is missing (DoD-B fail for complete product claim)

- No TSX UI wiring was found to call audited APIs (`/api/d1/documents`, `/api/d1/document-workflow`, `/api/d4/filings`, `/api/d4/drafts`, `/api/d2/court-ops`).
- Repo-wide matches for those routes are in API route handlers, tests, and roadmap docs, not user-facing UI components.

Evidence artifact:
- `/opt/cursor/artifacts/phase-audit-frontend-evidence.log`

Impact:
- These are backend-complete slices, not end-user complete product phases.

### 2) Filing transport remains explicit placeholder (DoD-C fail for full completion)

- `platform/persistence/filingDispatchQueue.ts` contains:
  - `TODO(firm): external court submission transport is not enabled in this environment`
  - `externalDispatchState: "blocked_todo_firm"`
- Filing route/request models still encode `_stub` channels in operational actions:
  - `efiling_portal_stub`
  - `physical_counter_stub`
  - `courier_stub`
  - `operator_followup_stub`

Evidence artifact:
- `/opt/cursor/artifacts/phase-audit-stub-evidence.log`

Impact:
- Filing-related completion claims should be treated as **PLACEHOLDER-integrated** until non-stub transport path exists or explicit non-production status is documented in phase gates.

## Concrete fix recommendations

1. **Reclassify these four phases publicly as backend persistence phases** unless UI surfaces are added and verified.
2. **Add explicit release-gate labels**: `backend_real=true`, `frontend_real=false`, `transport_stub=true` to avoid "complete" overstatement.
3. **Implement minimal operator UI flows** that exercise each claimed API slice and capture deterministic evidence (video/screens + API payload assertions).
4. **Replace or hard-fail stub filing transport states**:
   - either real transport adapter integration, or
   - explicit phase status `placeholder` with blocking gate that prevents "complete" marking.
5. **Require emulator-backed persistence suites in phase closure checklist** before marking complete.

