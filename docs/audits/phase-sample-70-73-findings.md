# Legal OS Phase Auditor Findings: PR #70-#73 (Batch B)

Date: 2026-09-20  
Auditor stance: independent forensic verification, strict DoD enforcement.

## Overall verdict

**PARTIAL (blocker severity)** for "complete phase" status.  
Reason: backend implementation is real and extensive, but no UI path exercises these governance APIs and filing transport remains TODO/stub-bound. That fails complete-product DoD.

## Scope audited

5. PR #70 -> merge commit `0e2d397`  
6. PR #71 -> merge commit `ca564d8`  
7. PR #72 -> merge commit `65b1615`  
8. PR #73 -> merge commit `3a1812c`

Key files audited:
- `app/api/d4/filings/route.ts`
- `platform/persistence/filingEscalationClosureDebtBurndownExpiryAttestations.ts`
- `platform/persistence/filingEscalationClosureBurndownRecalibrationQueueOrchestration.ts`
- `platform/persistence/filingEscalationClosureBurndownSettlementQueueDrainGovernance.ts`
- `platform/persistence/filingEscalationClosureSettlementAttestationQueueDrainReconciliationGovernance.ts`
- `platform/persistence/spineRepositories.ts`
- `platform/persistence/firestoreSpineRepositories.ts`
- `platform/spine/store.ts`
- `firestore.rules`
- `tests/api.filings.test.ts`
- `tests/persistence.route-wiring.test.ts`
- `tests/persistence.repositories.test.ts`
- `tests/persistence.runtime-mode.test.ts`

## Verdict table

| PR | Claimed focus | SHA landed on `main` | BACKEND_REAL | FRONTEND_REAL | Silent stubs/TODO | Verdict | Severity |
|---|---|---|---|---|---|---|---|
| #70 | Debt-burndown forecasting + expiry attestation | Yes (`0e2d397`) | PASS | FAIL | Filing transport still TODO/stub in same route family | PARTIAL | blocker |
| #71 | Burndown recalibration + attestation queue orchestration | Yes (`ca564d8`) | PASS | FAIL | Filing transport still TODO/stub in same route family | PARTIAL | blocker |
| #72 | Burndown settlement + queue drain | Yes (`65b1615`) | PASS | FAIL | Filing transport still TODO/stub in same route family | PARTIAL | blocker |
| #73 | Settlement attestation + queue drain reconciliation | Yes (`3a1812c`) | PASS | FAIL | Filing transport still TODO/stub in same route family | PARTIAL | blocker |

## What passed

### A) Backend reality checks

All four PR slices are materially implemented, not empty scaffolds:

- `app/api/d4/filings/route.ts` gained concrete `view=` and `action=` handlers for each claimed governance phase.
- New governance models/validators exist in dedicated persistence modules listed above.
- Memory + Firestore adapters are wired in:
  - `platform/persistence/spineRepositories.ts`
  - `platform/persistence/firestoreSpineRepositories.ts`
- Runtime store maps added in `platform/spine/store.ts`.
- Firestore rules updated for new collections in `firestore.rules`.
- Tests were expanded in:
  - `tests/api.filings.test.ts`
  - `tests/persistence.route-wiring.test.ts`
  - `tests/persistence.repositories.test.ts`
  - `tests/persistence.runtime-mode.test.ts`

### B) Test and gate evidence (current `main`)

Executed and passed:
- `npx vitest run tests/api.filings.test.ts tests/persistence.route-wiring.test.ts`
- `npx firebase emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts"`
- `bash ci_gates/gate_g0.sh`
- `python3 ci_gates/gate_g1.py`

Artifacts:
- `/opt/cursor/artifacts/phase-audit-focused-tests.log`
- `/opt/cursor/artifacts/phase-audit-emulator-tests.log`
- `/opt/cursor/artifacts/phase-audit-g0.log`
- `/opt/cursor/artifacts/phase-audit-g1.log`

### C) SHA/landing verification

- All claimed SHAs exist on `main` and map to merged PRs.
- Evidence artifact:
  - `/opt/cursor/artifacts/phase-audit-pr-sha-evidence.log`

## What failed / incomplete vs DoD

### 1) FRONTEND_REAL not present for audited API surfaces (DoD-B fail)

- No TSX frontend integration found for `/api/d4/filings` governance views/actions.
- Current user-facing console references other APIs only and does not exercise these governance flows.

Evidence artifact:
- `/opt/cursor/artifacts/phase-audit-frontend-evidence.log`

### 2) Silent placeholder transport remains in filing operations (DoD-C fail)

- Same operational family still contains:
  - `_stub` transport channels
  - `blocked_todo_firm` dispatch state
  - explicit `TODO(firm)` note for external court submission transport

Evidence artifact:
- `/opt/cursor/artifacts/phase-audit-stub-evidence.log`

### 3) Process/governance inconsistency (major risk)

- PR #72/#73 descriptions state scaffold-only/no runtime behavior changes, but merge commits contain large route/repository/test deltas.
- This is not a code defect by itself, but it degrades auditability and release confidence.

Evidence:
- PR metadata in `/opt/cursor/artifacts/phase-audit-pr-sha-evidence.log`
- Commit diffstats from `65b1615` and `3a1812c` show substantial code/test additions.

## Concrete fix recommendations

1. **Do not mark these phases "complete product"** until at least one operator UI flow drives these APIs end-to-end.
2. **Gate completion on transport readiness status**:
   - if transport remains stubbed, phase must be tagged `PLACEHOLDER` explicitly.
3. **Harden PR metadata discipline**:
   - require PR body checklist item confirming whether runtime behavior changed.
   - block merge if "scaffold-only" is declared but route or tests changed.
4. **Add post-merge evidence bundle policy**:
   - required: API contract replay, emulator-backed persistence proof, G-0/G-1 outputs, UI walkthrough (if claiming full DONE).

