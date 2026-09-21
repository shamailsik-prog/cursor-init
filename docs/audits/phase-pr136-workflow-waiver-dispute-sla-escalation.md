# Independent Phase Auditor forensic audit: PR #136 workflow waiver-expiry disputes + remediation-SLA breach escalation

Date: 2026-09-21  
Repo: `shamail-sikander/cursor-init`  
PR: `#136` (`cursor/workflow-waiver-expiry-disputes-sla-1f10` → `main`)  
Main merge SHA audited: `f20cdf1f78c349c3c65a0e0f24459fbab0e2102f`  
PR head SHA: `42e7b0b72728c842d0aa04285395ca1480bb11c6`

## Verdict (lead)

**PARTIAL (severity: medium).**

`BACKEND_REAL` is verified from code and focused runtime evidence.  
`FRONTEND_REAL` honesty is verified for a backend-only slice (`frontend_real=false`).  
`COMPLETE/product-done` is not claimed semantically.  
`SHA` integrity is verified on `main`.  
Focused tests and gates are green on replay, with one observed flaky timeout on a first run of the Firestore runtime suite.  
Process flags fail on claim-gate replay due wording-triggered regex hits in PR metadata; this is a process/compliance outcome and does not invalidate backend reality.  
PR #135 (claim-gate negation) is already on `main` (`15f0a08` / merge `f270e0b`) and does not clear these residual wording matches. Re-audit process flags after further gate hardening.

---

## A–F verification

### A) BACKEND_REAL

Status: **PASS**

Evidence verified directly in merged code:

1. Spine row models and store maps exist for both new surfaces:
   - `WorkflowOpsAlertWaiverExpiryDisputeRow`
   - `WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow`
   - store maps for `workflowOpsAlertWaiverExpiryDisputes`
   - store maps for `workflowOpsAlertVarianceRemediationSlaBreachEscalations`
2. Memory repository interfaces and implementations are present:
   - `workflowOpsAlertWaiverExpiryDisputes`
   - `workflowOpsAlertVarianceRemediationSlaBreachEscalations`
3. Firestore repository adapters are present for both collections.
4. `firestore.rules` includes read-guarded entries for:
   - `/workflow_ops_alert_waiver_expiry_disputes/{id}`
   - `/workflow_ops_alert_variance_remediation_sla_breach_escalations/{id}`
5. `/api/d2/ops-reporting` exposes both views and all open/assign/resolve actions:
   - `alert_waiver_expiry_disputes`
   - `alert_variance_remediation_sla_breach_escalations`
   - `open/assign/resolve` for dispute and escalation.
6. Route path maintains idempotency and audit write-through:
   - idempotency key required + replay/cache behavior
   - `persistAuditEntriesSince(...)` on action paths.

### B) FE honesty (`frontend_real=false`)

Status: **PASS**

1. PR metadata declares backend-only labels (`frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`).
2. PR delta does not include `app/ops/**`; backend-only scope claim is consistent with changed files.

### C) No COMPLETE overclaim (semantic)

Status: **PASS (semantic)** with **process wording hazard**

1. Metadata frames the slice as PARTIAL and transport-stub constrained.
2. No affirmative "product done" delivery state is substantiated in the implementation.
3. Claim-gate regex still interprets specific wording patterns (including `COMPLETE` token and `docs-only` token in a scoped bullet) as violations.

### D) SHA `f20cdf1` on `main`

Status: **PASS**

1. `f20cdf1` is a merge commit on `origin/main`.
2. Parent-2 is PR head `42e7b0b`, matching the audited phase head.
3. Both merge SHA and phase head are ancestors of `origin/main`.

### E) Focused tests + gates

Status: **PASS** (with stability note)

Independent replay:

1. `npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts` → PASS.
2. `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts"`
   - first replay: one timeout at 5000ms in a single runtime-mode test,
   - retry replay: PASS.
3. `npm run gate:g0` → PASS.
4. `npm run gate:g1` → PASS.

Stability note: runtime-mode suite is near timeout threshold for one test and behaves flakily at default 5s budget.

### F) Process flags

Status: **FAIL (process-only)**

Replay of `ci_gates/check_pr_phase_claims.py` against actual PR #136 metadata (`PR_TITLE`, `PR_BODY`, `BASE_SHA`, `HEAD_SHA`) on current `main` (post-#135) returns:

- scaffold/docs-only claim conflict from the scoped phrase `docs-only queue update` in the PR body
- COMPLETE/product-done conflicts from the disclaimer phrase `never COMPLETE while transport_stub=true`

PR #135's negation regex only excludes `no|not|without ... claims` spans. It does not treat `never COMPLETE while ...` as a negated complete-claim, and it does not ignore scoped `docs-only` wording.

This is a policy-gate/phrasing failure class and does **not** negate `BACKEND_REAL`.

---

## Final adjudication

- **Verdict:** `PARTIAL`
- **Severity:** `medium`
- **Disposition:** backend implementation accepted as real; phase remains process-blocked pending claim-gate-compatible metadata phrasing and/or additional regex hardening. Re-audit process flags after further gate work beyond #135.
