# Legal OS independent re-audit: phases #34-#37 and #70-#73 (PR #77 remediation check)

Date: 2026-09-20  
Auditor stance: independent re-audit, no trust in prior self-reporting.

## Overall verdict

- **PR #77 remediation is only partially correct.**
- **COMPLETE hard-fail gate exists and works for tested cases.**
- **`frontend_real` is defensible for #34-#37, but not for #70-#73.**
- Final phase outcomes remain capped at **PARTIAL** while filing transport stubs remain active.

## Claimed remediation check (PR #77)

| Claim | Result | Notes |
|---|---|---|
| 1) Audit findings docs integrated | PASS | `docs/audits/phase-sample-34-37-findings.md`, `docs/audits/phase-sample-70-73-findings.md`, and `docs/LEGAL_OS_PHASE_VERIFICATION.md` are present and updated. |
| 2) Labels backend_real / frontend_real / transport_stub; phases reclassified PARTIAL | PARTIAL | Labels exist in docs, but `frontend_real` is overstated for #70-#73. |
| 3) Minimal `/ops` UI + walkthrough doc + walkthrough video artifact | PARTIAL | `/ops` exists and calls real APIs; walkthrough doc exists; PR #77 links a video artifact, but it was not independently replayed in this run. |
| 4) COMPLETE hard-fail while filing transport stubs remain | PASS | `ci_gates/check_pr_phase_claims.py` blocks COMPLETE/product-done claims when stubs exist; probe run confirms failure behavior. |
| 5) Scaffold-only claim gate when `app/api` or `tests` change | PASS | Script + workflow wiring is present and fails a synthetic scaffold-only claim against a commit range with route/test deltas. |

## Per-phase verdicts (required output)

| Phase | backend_real | frontend_real | transport_stub | Verdict | Severity |
|---|---|---|---|---|---|
| #34 | PASS | PASS | true | PARTIAL | major |
| #35 | PASS | PASS | true | PARTIAL | major |
| #36 | PASS | PASS | true | PARTIAL | major |
| #37 | PASS | PASS | true | PARTIAL | major |
| #70 | PASS | FAIL | true | PARTIAL | blocker |
| #71 | PASS | FAIL | true | PARTIAL | blocker |
| #72 | PASS | FAIL | true | PARTIAL | blocker |
| #73 | PASS | FAIL | true | PARTIAL | blocker |

## DoD checks

### A) BACKEND_REAL

Status: **PASS** for all eight phases.

Evidence:
- Focused API suites pass:
  - `tests/api.documents.test.ts`
  - `tests/api.document-workflow.test.ts`
  - `tests/api.drafts.test.ts`
  - `tests/api.court-ops.test.ts`
  - `tests/api.filings.test.ts`
  - `tests/persistence.route-wiring.test.ts`
- Firestore emulator persistence suites pass:
  - `tests/persistence.repositories.test.ts`
  - `tests/persistence.runtime-mode.test.ts`
- Gates pass:
  - `bash ci_gates/gate_g0.sh`
  - `python3 ci_gates/gate_g1.py`

### B) FRONTEND_REAL

Status: **mixed (PASS for #34-#37, FAIL for #70-#73)**.

What is real:
- `/ops` is a real client route (`app/ops/page.tsx` + `app/ops/operator-audit-console.tsx`), linked from foundation console (`app/foundation-console.tsx`).
- `/ops` uses real `fetch` calls into:
  - `/api/d1/documents`
  - `/api/d1/document-workflow`
  - `/api/d4/drafts`
  - `/api/d2/court-ops`
  - `/api/d4/filings`

Why #70-#73 still fail frontend_real:
- The phase-specific closure-governance actions/views for #70-#73 exist in `app/api/d4/filings/route.ts` (e.g., burndown recalibration/settlement/attestation actions), but there are **no call sites for those actions/views in `/ops`**.
- Current `/ops` filings coverage is limited to create/approve/dispatch and high-level governance reads (`view=dispatch`, `view=closure_compliance_digests`), not the #70-#73 action families.

Video artifact note:
- PR #77 body includes a walkthrough video artifact link.
- This re-audit did not independently replay and validate that video content frame-by-frame; verdicts rely on code-level call-site audit plus automated tests.

### C) Stub policy / COMPLETE claim discipline

Status: **PASS** for policy enforcement, **PARTIAL** for product completion.

- Filing transport stubs remain explicit (`TODO(firm)`, `_stub`, `blocked_todo_firm`).
- Docs classify sampled phases as PARTIAL rather than DONE.
- COMPLETE/product-done claims are blocked by claim gate logic while stubs remain.

### D) Labels and roadmap accuracy

Status: **PARTIAL**.

- Roadmap and verification docs now include `backend_real` / `frontend_real` / `transport_stub` framing.
- But they currently present `frontend_real` as PASS across #70-#73, which is not supported by current `/ops` call coverage.

### E) PR claim gate effectiveness and bypass review

Status: **PASS with minor residual bypass risk**.

What works:
- Workflow `.github/workflows/pr-phase-claim-gate.yml` executes `ci_gates/check_pr_phase_claims.py` on PR open/edit/sync/reopen.
- Gate blocks:
  1. scaffold/docs-only claims when `app/api/**` or `tests/**` changed.
  2. COMPLETE/product-done claims while filing transport stubs remain.

Residual risk (minor):
- COMPLETE detection is phrase-based regex; unusual wording that avoids current phrases may evade the check.
- This is a claim-hygiene edge case, not a transport-policy bypass in the tested wording.

## Concrete remaining fixes

1. **Correct docs for #70-#73 frontend status**
   - Mark `frontend_real` as FAIL (or explicitly partial) until UI calls those specific governance actions/views.
2. **If claiming frontend_real for #70-#73**
   - Add `/ops` controls that invoke #70-#73 specific actions/views in `app/api/d4/filings/route.ts`.
   - Publish deterministic walkthrough evidence for those exact calls.
3. **Harden claim-gate COMPLETE regex (optional but recommended)**
   - Expand phrase coverage (`fully complete`, `done`, `production complete`, etc.) or use structured PR metadata instead of free-text regex.

## Evidence logs produced in this re-audit run

- `/opt/cursor/artifacts/reaudit-focused-vitest.log`
- `/opt/cursor/artifacts/reaudit-emulator-vitest.log`
- `/opt/cursor/artifacts/reaudit-gate-g0.log`
- `/opt/cursor/artifacts/reaudit-gate-g1.log`
- `/opt/cursor/artifacts/reaudit-claim-gate-probes.log`
- `/opt/cursor/artifacts/reaudit-pr77-view.log`
