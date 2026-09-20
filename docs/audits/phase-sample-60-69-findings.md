# Legal OS Phase Auditor Findings: PR #60-#69 (Batch F)

Date: 2026-09-20  
Auditor stance: independent forensic verification, strict DoD enforcement, no feature-expansion assumptions.

## Overall verdict

**PARTIAL (blocker severity)** for "COMPLETE product" classification.

### Blocking findings (lead)

1. **FRONTEND_REAL fails for this batch as claimed governance actions.**  
   `/ops` currently exercises only `view=closure_compliance_digests` from this batch family and does not drive the full #60-#69 governance action set.
2. **Transport placeholder policy still caps completion.**  
   Filing transport remains explicitly stub/TODO-gated (`TODO(firm)`, `_stub`, `blocked_todo_firm`), so COMPLETE/product-done claims remain disallowed.
3. **Claim-language drift exists in #66-#69 metadata.**  
   PR titles/bodies present these as "scaffold" slices, while merged deltas include substantive route + repository + test behavior.

## Scope audited

1. PR #60 -> merge commit `72cc388`
2. PR #61 -> merge commit `625ccc5`
3. PR #62 -> merge commit `ab9cdca`
4. PR #63 -> merge commit `5b2bd06`
5. PR #64 -> merge commit `5f0651e`
6. PR #65 -> merge commit `8733a06`
7. PR #66 -> merge commit `c598fc9`
8. PR #67 -> merge commit `1a3dd2c`
9. PR #68 -> merge commit `f563876`
10. PR #69 -> merge commit `15254ca`

Primary references:
- `app/api/d4/filings/route.ts`
- `app/ops/operator-audit-console.tsx`
- `platform/persistence/filingEscalationExpiryAndWatchDigests.ts`
- `platform/persistence/filingEscalationLifecycleAndReaffirmation.ts`
- `platform/persistence/filingEscalationClosureCompliance.ts`
- `platform/persistence/filingEscalationClosureAttestationExceptions.ts`
- `platform/persistence/filingEscalationClosureAttestationDisputes.ts`
- `platform/persistence/filingEscalationClosureExceptionAdjudication.ts`
- `platform/persistence/filingEscalationClosureAdjudicationQuorum.ts`
- `platform/persistence/filingEscalationClosureAdjudicationSloSafeguards.ts`
- `platform/persistence/filingEscalationClosureSloDebtSafeguardExpiry.ts`
- `platform/persistence/spineRepositories.ts`
- `platform/persistence/firestoreSpineRepositories.ts`
- `platform/spine/store.ts`
- `firestore.rules`
- `tests/api.filings.test.ts`
- `tests/persistence.route-wiring.test.ts`
- `tests/persistence.repositories.test.ts`
- `tests/persistence.runtime-mode.test.ts`

## Verdict table

| PR | Claimed focus | SHA landed on `main` | BACKEND_REAL | FRONTEND_REAL (`/ops`) | transport_stub | Verdict | Severity |
|---|---|---|---|---|---|---|---|
| #60 | Remediation expiry + rollover breach watch | Yes (`72cc388`) | PASS | FAIL (no `/ops` action coverage) | true | PARTIAL | blocker |
| #61 | Remediation lifecycle + reaffirmation SLA | Yes (`625ccc5`) | PASS | FAIL (no `/ops` action coverage) | true | PARTIAL | blocker |
| #62 | Closure compliance digest + follow-up queue | Yes (`ab9cdca`) | PASS | FAIL (only digest read is wired; queue actions absent in `/ops`) | true | PARTIAL | blocker |
| #63 | Closure SLA windows + auto-assignment | Yes (`5b2bd06`) | PASS | FAIL (not driven in `/ops`) | true | PARTIAL | blocker |
| #64 | Closure attestation + SLA exception digest | Yes (`5f0651e`) | PASS | FAIL (not driven in `/ops`) | true | PARTIAL | blocker |
| #65 | Attestation dispute + exception expiry enforcement | Yes (`8733a06`) | PASS | FAIL (not driven in `/ops`) | true | PARTIAL | blocker |
| #66 | Exception adjudication + enforcement rebalance | Yes (`c598fc9`) | PASS | FAIL (not driven in `/ops`) | true | PARTIAL | blocker |
| #67 | Panel quorum + rebalance execution | Yes (`1a3dd2c`) | PASS | FAIL (not driven in `/ops`) | true | PARTIAL | blocker |
| #68 | Adjudication SLO + rebalance safeguards | Yes (`f563876`) | PASS | FAIL (not driven in `/ops`) | true | PARTIAL | blocker |
| #69 | SLO debt remediation + safeguard expiry | Yes (`15254ca`) | PASS | FAIL (not driven in `/ops`) | true | PARTIAL | blocker |

## What passed

### A) SHA integrity and main-branch landing

- All claimed SHAs are present on `origin/main`.
- Each merge introduces corresponding route/persistence/test deltas for the claimed slice.
- #63 single-truth check: introduction commit for closure SLA windows + auto-assignment is unique on main lineage (`1135f20`), with no alternate parallel implementation commit found.

Evidence artifact:
- `/opt/cursor/artifacts/phase-f-60-69-merge-deltas.log`

### B) Backend reality checks

- #60-#69 are fully wired through:
  - `/api/d4/filings` views/actions
  - runtime store model additions
  - memory + Firestore repository adapters
  - Firestore rules updates
  - focused API/route/repository/runtime tests
- Contrary to "scaffold-only" language in several PR bodies, merged code contains executable behavior and persistence updates.

### C) Test and gate evidence (current branch vs updated `main`)

Executed and passed:
- `npx vitest run tests/api.filings.test.ts tests/persistence.route-wiring.test.ts`
- `npx firebase emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts"`
- `bash ci_gates/gate_g0.sh`
- `python3 ci_gates/gate_g1.py`

Artifacts:
- `/opt/cursor/artifacts/phase-f-60-69-focused-tests.log`
- `/opt/cursor/artifacts/phase-f-60-69-emulator-tests.log`
- `/opt/cursor/artifacts/phase-f-60-69-gate-g0.log`
- `/opt/cursor/artifacts/phase-f-60-69-gate-g1.log`

## What failed / incomplete vs DoD

### 1) FRONTEND_REAL fails for #60-#69 governance actions (DoD-B fail)

- `/ops` has one batch-related governance read (`closure_compliance_digests`) but does not execute the #60-#69 action/view lattice (reaffirmation SLA acknowledgment, follow-up queue lifecycle, adjudication/quorum/SLO/safeguard controls, debt-remediation operations).
- This is insufficient for "COMPLETE product phase" classification for the full batch.

### 2) transport_stub remains true (DoD-C cap)

- Filing transport still includes TODO/stub enforcement semantics:
  - `TODO(firm): external court submission transport is not enabled in this environment`
  - `externalDispatchState: "blocked_todo_firm"`
  - `_stub` transport channels

### 3) Metadata-to-implementation drift (governance risk)

- PR #66-#69 copy repeatedly uses "Scaffold ..." framing.
- Merge deltas for those same PRs include concrete route/repository/test expansions.
- This is an auditability/process mismatch that should be gate-enforced.

## Concrete remediation

1. **Do not mark Batch F as COMPLETE product.** Keep classification at PARTIAL while DoD-B/DoD-C blockers remain.
2. **Expand `/ops` (or equivalent user path)** to execute each #60-#69 governance action family, not just one digest read.
3. **Keep/strengthen metadata drift gate** (`ci_gates/check_pr_phase_claims.py`) so scaffold/docs-only claims fail if route/test runtime surfaces changed.
4. **Maintain transport-stub hard cap**: any COMPLETE/product-done claim must fail while filing transport remains TODO/stub.
