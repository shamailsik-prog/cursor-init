# Independent Phase Auditor forensic audit: PR #147 workflow SLO debt-remediation + checkpoint expiry-attestation exception reconciliation

Date: 2026-09-21  
Repo: `shamail-sikander/cursor-init`  
PR: `#147` (`cursor/workflow-slo-debt-remediation-expiry-exception-0b2f` → `main`)  
PR URL: `https://cursor.com/codebase/shamail-sikander/cursor-init/pull/147`  
Claimed PR head: `4f0a44d2530ab1e192e5b8a2662839ec305e9814`  
Feature commit: `a2a50a0b3a4bc9935bd8307a46d9963e912dec58`  
Merge SHA on `main`: `07e5db8d6bc88ab68eec0dc5c0e3187a103c47d8`  
Merge parent-1 (pre-merge `main`, includes #143 audit docs): `abb135a07e273f54c835c217ae9b4a0f55612b97`  
Merge parent-2 (PR head): `4f0a44d2530ab1e192e5b8a2662839ec305e9814`  
Claim-gate anchor on `main` (post-#141/#142): `aca861c` / `f023e42`  
`origin/main` tip at audit close: `07e5db8d6bc88ab68eec0dc5c0e3187a103c47d8`

## Verdict (lead)

**PARTIAL (severity: medium).**

`BACKEND_REAL` is verified from merged code and independent reruns.  
`FRONTEND_REAL` honesty is verified for a backend-only slice (`frontend_real=false`; no `app/ops/**` delta; no phase-specific `/ops` call sites).  
`COMPLETE/product-done` is not claimed semantically (`classification=PARTIAL`, `transport_stub=true`).  
SHA integrity is verified: PR #147 is already merged to `main` at `07e5db8`; claimed head `4f0a44d` is merge parent-2 and an ancestor of `origin/main`.  
Focused tests plus `G-0`/`G-1` are green on independent replay.  
**Process flags FAIL** on live `ci_gates/check_pr_phase_claims.py` replay of actual PR #147 title/body under the current post-#141/#142 gate: the disclaimer `**not** a product-done claim` is treated as an affirmative COMPLETE/product-done claim. This is a metadata-wording / gate-phrasing failure and does not invalidate backend reality.

This audit does **not** certify COMPLETE/product-done. Product classification remains **PARTIAL** because `transport_stub=true` and `frontend_real=false`.

Builder packet stub `docs/audits/phase-prXXX-workflow-slo-debt-remediation-expiry-exception-reconciliation.md` was **not** used as implementation evidence.

---

## Scope and evidence policy

- Independent verification used Origin PR metadata (`origin pr view 147`), merged code at `07e5db8`, feature delta `abb135a..4f0a44d`, claim-gate source on current `main`, and local reruns only.
- Author labels (`backend_real=true`, `frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`) were treated as claims to verify, not facts.
- This auditor did not merge feature PR #147. Merge agent had already landed it onto `main` before this audit closed.
- Nomenclature note: PR title uses “scaffolding”; implementation is executable route/repository/rules coverage with runtime tests — not a docs-only or hollow stub slice.

---

## A–F verification

### A) BACKEND_REAL

Status: **PASS**

Evidence verified directly in merged code at `07e5db8` (feature delta `abb135a..4f0a44d`, implementation commit `a2a50a0`):

1. **Spine row models and store maps** in `platform/spine/store.ts`:
   - `WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow` + `workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations`
   - `WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow` + `workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations`
   - Debt statuses: `not_required | debt_watch | remediation_recorded | tier_downshifted | breach_closure_attested`
   - Exception statuses: `not_required | exception_open | exception_assigned | exception_reconciled`
2. **Memory repository wiring** in `platform/persistence/spineRepositories.ts` (upsert/get/listByFirm/listByMatter for both collections).
3. **Firestore adapters** in `platform/persistence/firestoreSpineRepositories.ts` writing:
   - `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediations`
   - `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations`
4. **`firestore.rules`** deny-write, firm-scoped read guards for both collection paths (lines 171–172).
5. **`/api/d2/ops-reporting` views**
   - `alert_waiver_expiry_dispute_adjudication_slo_debt_remediations`
   - `alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations`
   - Both list via repositories, then apply clearance, matter, status, freshness, and research-permission filters with cursor pagination.
6. **Partner-governed actions** (partner role required at shared POST gate):
   - `record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation`
   - `downshift_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_tier`
   - `attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach_closure`
   - `open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception`
   - `assign_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_owner`
   - `reconcile_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception`
7. **Lifecycle coupling to prior slice (PR #143)** is real, not decorative:
   - SLO breach-acknowledge seeds/updates the debt-remediation row (`debt_watch` when stewardship is `breach_acknowledged`).
   - Checkpoint expiry-acknowledge seeds/updates the exception-reconciliation row (`exception_open` when attestation is `expiry_acknowledged` or expiry risk is `expired`).
   - Record/downshift/attest and open/assign/reconcile enforce sequential posture checks and return `400` on illegal transitions.
8. **Idempotency + audit write-through**
   - Shared POST requires `Idempotency-Key` UUID v4 via `requireIdempotencyKey`.
   - Replay/conflict cache is used; each new action path calls `idempotency.set(...)`.
   - Each new action path `store.audit.push(...)` then `persistAuditEntriesSince(...)` from `platform/persistence/auditWriteThrough.ts` (real `repos.audit.append`).

This is not a hollow stub. Route handlers persist through memory + Firestore repos, enforce partner governance, and emit audit actions named in the roadmap.

### B) FE honesty (`frontend_real=false`)

Status: **PASS**

1. PR metadata declares `frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`.
2. Feature file list excludes `app/ops/**`. Only `app/` change is `app/api/d2/ops-reporting/route.ts`.
3. Grep of `app/ops/**` finds no phase-specific call sites for the six new actions or two new views. Existing `/ops` hits for `record_closure_adjudication_slo_debt_remediation` belong to the older filings closure-debt lattice, not this workflow-ops slice.
4. Under current gate policy (post-#126/#141), `/ops` call-site evidence is required only when `frontend_real=true` or `app/ops/**` changes. Neither applies.

### C) No COMPLETE overclaim (semantic)

Status: **PASS (semantic)** with **process wording hazard**

1. Metadata frames the slice as PARTIAL backend-only scaffolding and denies product-done while `transport_stub=true`.
2. Filing transport stubs remain active (`TODO(firm)`, `_stub` channels, `blocked_todo_firm`) in:
   - `platform/persistence/filingDispatchQueue.ts`
   - `platform/persistence/filingSubmissionReceipts.ts`
   - `platform/persistence/filingTransportExecutionEvidence.ts`
3. No affirmative “phase complete / product done” delivery state is substantiated in the implementation.
4. Machine-gate hazard: `**not** a product-done claim` (and the unbolded form `not a product-done claim`) still matches `COMPLETE_CLAIM_RE` because post-#141 `NEGATED_COMPLETE_DISCLAIMER_RE` requires the COMPLETE token immediately after `no|not|never|without|do not`, with no intervening article (`a`). See F).

### D) SHA on `main`

Status: **PASS**

1. `origin/main` at audit close is `07e5db8` — merge commit “Merge branch 'cursor/workflow-slo-debt-remediation-expiry-exception-0b2f' (Origin PR #147)”.
2. Merge parents: `abb135a` (pre-merge main with #143 audit docs) + `4f0a44d` (claimed PR head).
3. `4f0a44d`, `07e5db8`, `aca861c` (#141), and `f023e42` (#142) are ancestors of `origin/main`.
4. Origin lists PR #147 as closed; git ancestry confirms the merge landed. Audit uses the post-merge main SHA `07e5db8` as instructed.
5. Merge hygiene note (non-blocking): the feature branch copy of `docs/LEGAL_OS_PHASE_VERIFICATION.md` deleted the PR #143 targeted ledger (branch was cut from `9fd7dca` before `abb135a`). The merge commit kept `abb135a`’s file; landed `main` still contains the #143 ledger. No ledger loss on `main`.

### E) Focused tests + gates

Status: **PASS**

Independent replay on merged `main` (`07e5db8`):

| Suite | Result |
|---|---|
| `npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts` | 78/78 PASS (3 + 75) |
| `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"` | 22/22 PASS (7 + 1 + 14) |
| `npm run gate:g0` | PASS |
| `python3 ci_gates/gate_g1.py` | 10/10 PASS |
| `npx vitest run tests/pr-phase-claim-gate.test.ts` | 16/16 PASS (gate unit tests; does not replay PR #147 metadata) |

API suite exercises the full prerequisite chain (PR #139/#143 surfaces) then the six new actions and both new views, including debt retirement `120_000`, tier-downshift, breach-closure attestation by `partner_a`, exception open/assign/reconcile, and filtered GET evidence. Runtime-mode suite persists both new collections to Firestore and rehydrates views after store reset.

Artifacts: `/opt/cursor/artifacts/pr147-audit-unit.log`, `pr147-audit-firestore.log`, `pr147-audit-g0.log`, `pr147-audit-g1.log`, `pr147-audit-claim-gate-tests.log`, `pr147-audit-claim-gate-replay.log`.

### F) Process flags (current claim-gate post-#141/#142)

Status: **FAIL (process-only)**

1. Gate code on audited `main` is the post-#141/#142 implementation (`NEGATED_COMPLETE_DISCLAIMER_RE` includes `never` / `not yet` / `do not`; `has_scaffold_only_claim` ignores `docs-only queue update`).
2. Required flags are present and parse correctly: `backend_real=true`, `frontend_real=false`, `transport_stub=true`.
3. Scaffold-only rule does **not** fire (`internal scaffolding only` ≠ `scaffold-only` / `docs-only`).
4. Live replay of actual PR #147 title + body with `BASE_SHA=abb135a` / `HEAD_SHA=4f0a44d` returns **FAIL** (exit `1`):
   - `PR claims COMPLETE/product-done while filing transport TODO/stub markers still exist.`
   - `PR claims COMPLETE/product-done while frontend_real=false.`
   - `PR claims COMPLETE/product-done while transport_stub=true.`
5. Token analysis: the only `COMPLETE_CLAIM_RE` hit is `product-done` inside `classification=PARTIAL — internal scaffolding only; **not** a product-done claim while transport_stub=true`. No negated span is recorded. Probes:
   - `not a product-done claim` → `has_complete_claim=True` (article `a` breaks negation)
   - `**not** a product-done claim` → `True` (markdown plus article)
   - `no product-done claim` / `not product-done claim` / `never COMPLETE while transport_stub=true` → `False`
6. Sanitized replay replacing `**not** a product-done claim` with `no product-done claim` returns **PASS** (exit `0`) against the same SHAs. Backend files are unchanged.

This is the same wording-hazard class previously seen on #133/#136, now on a phrase the post-#141/#142 residual fix does not cover. It does **not** negate `BACKEND_REAL`.

Re-audit process flags after metadata amend (`no product-done claim` / `no COMPLETE/product-done claim`) or further gate hardening for `not a product-done`.

---

## Residual notes (non-blocking)

1. Roadmap still says “pending PR + merge SHA assignment” for this slice after merge. Docs hygiene only.
2. Builder stub still says `PR: pending` / `Head SHA: pending` after the author’s evidence fill. Auditor file supersedes it.
3. `tests/firestore.rules.test.ts` does not enumerate the two new collections; it remains a generic rules suite. Deny-write posture is present in `firestore.rules` and G-0 Phase-0 collection coverage still passed.
4. `listByMatter` Firestore adapters scan the collection then filter in process — same pattern as prior workflow-ops slices, not a new defect.

---

## Final adjudication

| Dimension | Result |
|---|---|
| Audit verdict | **PARTIAL** |
| Severity | **medium** |
| Product classification | **PARTIAL** (`transport_stub=true`, `frontend_real=false`) |
| Disposition | Accept backend slice as real and merged; phase remains process-blocked until claim-gate-compatible disclaimer phrasing (or further gate hardening) is landed. Do not treat as product-done or frontend-complete. |
