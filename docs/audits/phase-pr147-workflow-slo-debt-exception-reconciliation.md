# Independent Phase Auditor forensic audit: PR #147 workflow alert adjudication SLO debt-remediation + checkpoint expiry-attestation exception reconciliation

Date: 2026-09-21  
Repo: `shamail-sikander/cursor-init`  
PR: `#147` (`cursor/workflow-slo-debt-remediation-expiry-exception-0b2f` → `main`)  
PR URL: `https://cursor.com/codebase/shamail-sikander/cursor-init/pull/147`  
Main merge SHA audited: `07e5db8d6bc88ab68eec0dc5c0e3187a103c47d8`  
PR merge parent-2 (final PR head): `4f0a44d2530ab1e192e5b8a2662839ec305e9814` (short `4f0a44d`)  
Feature implementation commit: `a2a50a0b3a4bc9935bd8307a46d9963e912dec58`  
Pre-merge `main` parent: `abb135a07e27` (stacked on PR #143 lane at `9fd7dca`)  
Claim-gate anchor on `main`: `aca861c6075c45ef15034ad7867b7318f3a4b853` (PR #141 hardening; unchanged by #147)

## Verdict (lead)

**PARTIAL (severity: medium).**

Backend slice is **real** (A PASS), labels are **honest** (B PASS), there is **no semantic COMPLETE/product-done overclaim** (C PASS), merge SHA integrity holds (D PASS), and focused tests plus `G-0`/`G-1` replay green (E PASS). **Process-flag replay fails (F FAIL)** because PR #147 metadata uses `not a product-done claim` (article `a`), which `ci_gates/check_pr_phase_claims.py` does not treat as a negated disclaimer — the gate mis-reads `product-done` as an affirmative COMPLETE claim.

Product classification correctly remains **PARTIAL** because `transport_stub=true` and `frontend_real=false`; this audit does **not** certify COMPLETE/product-done.

Supersedes the builder packet stub `docs/audits/phase-prXXX-workflow-slo-debt-remediation-expiry-exception-reconciliation.md`.

---

## Scope and evidence policy

- Independent verification used live PR metadata (`origin pr view 147`), merge diff `abb135a..4f0a44d`, `origin/main` ancestry at `07e5db8`, and local reruns only.
- Builder labels (`backend_real=true`, `frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`) were treated as claims to verify, not facts.
- This auditor did not merge feature PR #147.

---

## Findings by severity

### Blockers

- None on runtime implementation. Live court transport remains the human blocker and is explicitly out of scope (`transport_stub=true`).

### Majors

1. **Process flags (F):** Live replay of `ci_gates/check_pr_phase_claims.py` with PR #147 title/body and `BASE_SHA=abb135a` / `HEAD_SHA=4f0a44d` exits **1** with three COMPLETE-related failures. Root cause: `product-done` in `**not** a product-done claim` is not inside `NEGATED_COMPLETE_DISCLAIMER_RE` (regex expects `not product-done claim` without an article). Semantic overclaim check (C) still **PASS**.

### Minors

1. PR docs commit `4f0a44d` attempted to delete the PR #143 ledger block from `docs/LEGAL_OS_PHASE_VERIFICATION.md` on the feature branch; merge `07e5db8` retained the #143 ledger from `main` — no net loss on `origin/main`, but the branch diff shows hygiene risk.
2. `tests/firestore.rules.test.ts` does not name-assert the two new collections; coverage is indirect via repository/runtime suites.
3. Builder PR summary cites `npm test -- …` while auditor reruns used `npm run test:unit -- …` (equivalent focused paths).

---

## A–F verification

### A) BACKEND_REAL

Status: **PASS**

Evidence verified in merge diff `abb135a..4f0a44d`:

1. **Spine row models and store maps** (`platform/spine/store.ts`):
   - `WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow` + `workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations`
   - `WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow` + `workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations`
2. **Memory repository wiring** (`platform/persistence/spineRepositories.ts`): upsert/get/listByFirm/listByMatter for both repos on `SpineRepositories`.
3. **Firestore adapters** (`platform/persistence/firestoreSpineRepositories.ts`):
   - `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediations`
   - `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations`
4. **`firestore.rules`** deny-write, firm-scoped read guards for both collections (lines 171–172 at `07e5db8`).
5. **`/api/d2/ops-reporting`**
   - Views: `alert_waiver_expiry_dispute_adjudication_slo_debt_remediations`, `alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations`
   - Partner-governed actions:
     - `record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation`
     - `downshift_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_tier`
     - `attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach_closure`
     - `open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception`
     - `assign_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_owner`
     - `reconcile_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception`
6. **Idempotency + audit write-through:** shared POST handler requires `Idempotency-Key`, replays via idempotency cache, and calls `persistAuditEntriesSince(...)` after audit append (e.g. debt remediation record ~6302–6349, exception reconcile ~6827–6872 in `app/api/d2/ops-reporting/route.ts`). Partner role enforced at POST gate (`actor.role !== "partner"`).

### B) FE honesty (`frontend_real=false`)

Status: **PASS**

1. PR metadata declares `frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`.
2. Merge diff excludes `app/ops/**` (only `app/api/d2/ops-reporting/route.ts` under `app/`).
3. Post-#141 claim gate: `/ops` call-site evidence not required when `frontend_real=false` and ops tree unchanged.

### C) No COMPLETE overclaim (semantic)

Status: **PASS**

1. Metadata frames PARTIAL backend-only scaffolding and explicitly denies product-done while `transport_stub=true`.
2. No affirmative COMPLETE/product-done delivery claim substantiated in title/body intent.

### D) SHA `07e5db8` on `main`

Status: **PASS**

1. `origin/main` tip at audit close: `07e5db8d6bc88ab68eec0dc5c0e3187a103c47d8` — merge commit for PR #147.
2. Merge parent-1: `abb135a`; parent-2: `4f0a44d` (matches claimed head `4f0a44d`).
3. Feature commit `a2a50a0` is an ancestor of `07e5db8`.

### E) Focused tests + gates

Status: **PASS**

Independent replay on `main` (`07e5db8`):

| Suite | Result |
|---|---|
| `npm run test:unit -- tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts` | 78/78 PASS |
| `npm run test:rules` (repos + runtime-mode + firestore.rules) | 22/22 PASS |
| `npm run gate:g0` | PASS |
| `npm run gate:g1` | 10/10 PASS |

New slice coverage appears in `tests/api.ops-reporting.test.ts` (debt remediation lifecycle + exception reconciliation chain), `tests/persistence.repositories.test.ts`, `tests/persistence.route-wiring.test.ts`, and `tests/persistence.runtime-mode.test.ts`.

### F) Process flags (post-#141 gate)

Status: **FAIL**

1. `ci_gates/check_pr_phase_claims.py` on current `main` with PR #147 metadata:
   - `BASE_SHA=abb135a` `HEAD_SHA=4f0a44d`
   - Exit code **1** — COMPLETE/product-done failures (transport stub + `frontend_real=false` + `transport_stub=true` branches), triggered by false-positive `product-done` token in `not a product-done claim`.
2. Required label triplet present in metadata: `backend_real=true`, `frontend_real=false`, `transport_stub=true`.
3. No `/ops` call-site evidence failure (correct for `frontend_real=false`).
4. No scaffold-only/docs-only false positive on this PR wording.

**Remediation (landed):** `main` @ `90b09962659d51ce0d5cdec904d9dbe7b0ae6cc7` extends `NEGATED_COMPLETE_DISCLAIMER_RE` for optional `a`/`an`/`the` and markdown-bold `**not**`; live replay of PR #147 title/body now **PASS**.

Token probes at audit close (pre-`90b0996`): `not a product-done claim` and `**not** a product-done claim` → `has_complete_claim=True`; `no product-done claim` → `False`.

---

## Merge-confirmation addendum (follow-up)

Date: 2026-09-21  
Trigger: parallel auditor run `bc-8c695da7` (Origin PR #149) requested SHA lock on `main` @ `07e5db8`.

| Claimed identifier | Observed on `origin/main` | Match |
|---|---|---|
| Final merge SHA `07e5db8d6bc88ab68eec0dc5c0e3187a103c47d8` | merge subject for PR #147 | PASS |
| PR head `4f0a44d2530ab1e192e5b8a2662839ec305e9814` | ancestor of `main`; `07e5db8^2` | PASS |
| Pre-merge main `abb135a07e273f54c835c217ae9b4a0f55612b97` | `07e5db8^1` | PASS |

Verdict remains **PARTIAL (medium)** for product scope (`transport_stub=true`). Process-flag dimension is **PASS** on current `main` after claim-gate hardening `90b0996`.

---

## Final adjudication

| Check | Result |
|---|---|
| A BACKEND_REAL | PASS |
| B FE honesty | PASS |
| C No semantic COMPLETE overclaim | PASS |
| D SHA on `main` | PASS |
| E Focused tests + G-0/G-1 | PASS |
| F Process flags | **FAIL** |

- **Auditor verdict:** **PARTIAL** (medium) — implementation and honesty checks pass; CI claim-gate replay on shipped PR metadata fails until wording or gate regex is fixed.
- **Product classification:** **PARTIAL** (`transport_stub=true`; not DONE).

---

## Commands (replay)

```bash
git fetch origin main
git rev-parse origin/main   # expect 07e5db8…

npm run test:unit -- tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts
npm run test:rules
npm run gate:g0
npm run gate:g1

PR_BODY="$(origin pr view 147 --json description | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"description\"])')"
BASE_SHA=abb135a HEAD_SHA=4f0a44d \
  PR_TITLE='Workflow alert SLO debt-remediation + checkpoint expiry exception reconciliation scaffolding #147' \
  PR_BODY="$PR_BODY" \
  python3 ci_gates/check_pr_phase_claims.py
```
