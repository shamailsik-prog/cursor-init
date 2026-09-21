# Independent Phase Auditor forensic audit: PR #133 workflow waiver-expiry + variance-remediation SLA scaffolding

Date: 2026-09-21  
Repo: `shamail-sikander/cursor-init`  
PR: `#133` (`cursor/waiver-expiry-variance-sla-930a` → `main`)  
Main SHA audited: `632fbdaaf3b04239708c7ead609c68e898a048b6`  
PR head reference: `270f5032ee35963a6a5345f40815c63446834f8e`

## Verdict (lead)

**PARTIAL (severity: medium).**

The merged phase is backend-real and claim-honest for a backend-only slice, and targeted tests/gates are green. However, process-flag compliance fails when replaying the claim gate against PR metadata because the phrase `no COMPLETE/product-done claim` still matches the gate's COMPLETE regex.

---

## Scope and evidence policy

- Independent verification used merged code, commit lineage, PR metadata, and local reruns only.
- Builder packet stub `docs/audits/phase-prXXX-workflow-waiver-expiry-remediation-sla.md` was not used as implementation evidence.

---

## A–F verification

### A) BACKEND_REAL

Status: **PASS**

Evidence:

1. New runtime row models and store maps are present:
   - `WorkflowOpsAlertWaiverExpiryDigestRow`
   - `WorkflowOpsAlertVarianceRemediationSlaLedgerRow`
   - `workflowOpsAlertWaiverExpiryDigests`
   - `workflowOpsAlertVarianceRemediationSlaLedgers`
2. Memory + Firestore repository wiring exists:
   - interfaces/adapters in `platform/persistence/spineRepositories.ts`
   - Firestore adapters in `platform/persistence/firestoreSpineRepositories.ts`
3. Firestore rules include both collections with deny-write posture:
   - `workflow_ops_alert_waiver_expiry_digests`
   - `workflow_ops_alert_variance_remediation_sla_ledgers`
4. `/api/d2/ops-reporting` exposes new views:
   - `alert_waiver_expiry_digests`
   - `alert_variance_remediation_sla_ledgers`
5. `/api/d2/ops-reporting` exposes new partner actions:
   - `acknowledge_workflow_ops_alert_waiver_expiry_digest`
   - `extend_workflow_ops_alert_waiver_expiry_digest`
   - `acknowledge_workflow_ops_alert_variance_remediation_sla_ledger`
   - `resolve_workflow_ops_alert_variance_remediation_sla_ledger`
6. Idempotency + audit write-through are present in the route path:
   - `Idempotency-Key` replay/conflict checks
   - per-action `store.audit.push(...)` + `persistAuditEntriesSince(...)`

### B) FE honesty (`frontend_real=false` for backend-only phase)

Status: **PASS**

Evidence:

1. PR metadata declares `frontend_real: false`.
2. Merged diff excludes `app/ops/**`; `/ops` call-site evidence is not required under current backend-only policy.

### C) No COMPLETE overclaim

Status: **PASS (semantic)** / **WARNING (machine-gate wording risk)**

Evidence:

1. PR metadata explicitly declares:
   - `backend_real: true`
   - `frontend_real: false`
   - `transport_stub: true`
   - classification: `PARTIAL`
2. No affirmative "phase complete/product done" claim is present.
3. A wording hazard exists because the literal token `COMPLETE/product-done` appears in a negated sentence, which can still trigger regex-based policy checks.

### D) SHA on main integrity

Status: **PASS**

Evidence:

1. `632fbdaaf3b04239708c7ead609c68e898a048b6` is current `origin/main` tip.
2. Merge parent-2 resolves to claimed head `270f5032ee35963a6a5345f40815c63446834f8e`.

### E) Focused tests + gates

Status: **PASS**

Independent reruns:

1. `npm run test:unit -- tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts`  
   - PASS (`70` tests)
2. `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npm run test:unit -- tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts"`  
   - PASS (`15` tests)
3. `npm run gate:g0`  
   - PASS
4. `npm run gate:g1`  
   - PASS (`10` tests)

### F) Process flags

Status: **FAIL**

Evidence:

1. Backend-only `/ops` policy itself is satisfied (`frontend_real=false` and no `app/ops/**` changed).
2. Replay of `ci_gates/check_pr_phase_claims.py` against actual PR #133 metadata returns failure:
   - `PR claims COMPLETE/product-done while filing transport TODO/stub markers still exist.`
   - `PR claims COMPLETE/product-done while frontend_real=false.`
   - `PR claims COMPLETE/product-done while transport_stub=true.`
3. Root cause is regex matching against a negated phrase (`no COMPLETE/product-done claim`) in the PR body, which is treated as a positive COMPLETE claim by rule implementation.

---

## Final adjudication

- **Verdict:** `PARTIAL`
- **Severity:** `medium`
- **Summary:** Backend implementation and focused validation are real and green, but process-flag compliance fails under independent claim-gate replay due to COMPLETE-token wording in PR metadata.
