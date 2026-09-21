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

---

## Re-audit addendum (after claim-gate negation fix on `main`)

Date: 2026-09-21  
Main tip audited: `f270e0b1979ef59337903708d57bb0ce55cbe89d`  
Feature SHA under review (unchanged): `632fbdaaf3b04239708c7ead609c68e898a048b6`  
Referenced fix lane: PR #135 (`15f0a08` merged via `f270e0b`)  

### Verdict (lead)

**PASS (severity: low).**

Process-flag failure from the prior audit is remediated. The claim gate now correctly ignores negated COMPLETE/product-done disclaimer phrasing, and replay against live PR #133 metadata passes. A–E spot-checks remain green for the previously merged feature slice.

### Re-audit verification results

1. **Gate change on `main` confirmed**  
   `ci_gates/check_pr_phase_claims.py` now:
   - matches COMPLETE tokens through `COMPLETE_CLAIM_RE` (including literal `complete`), and
   - excludes negated disclaimers via `NEGATED_COMPLETE_DISCLAIMER_RE` + `has_complete_claim(...)` span filtering.

2. **Claim-gate replay against PR #133 metadata**  
   Replay used live `origin pr view 133` fields:
   - `baseSha=df818e034e328986171c53339d1570a9d066099d`
   - `headSha=270f5032ee35963a6a5345f40815c63446834f8e`
   - title/body unchanged from prior audit (`frontend_real=false`, `transport_stub=true`, negated COMPLETE disclaimer text)
   - result: `PASS: PR phase-claim gate.` (exit code `0`)

3. **Spot-check A–E (regression scan)**
   - **A BACKEND_REAL:** PASS — runtime row types, repo wiring, Firestore rules, and `/api/d2/ops-reporting` view/action surfaces remain present.
   - **B FE honesty:** PASS — PR metadata remains `frontend_real=false`; diff scope still excludes `app/ops/**`.
   - **C no COMPLETE overclaim:** PASS — no affirmative COMPLETE/product-done claim; negated disclaimer no longer false-trips gate logic.
   - **D SHA integrity:** PASS — feature SHA `632fbda` remains on `origin/main`.
   - **E focused checks:** PASS — `tests/pr-phase-claim-gate.test.ts`, `gate_g0`, and `gate_g1` reruns are green.

### Updated adjudication (superseding)

- **Verdict:** `PASS`
- **Severity:** `low`
- **Classification note:** backend-scoped slice remains non-COMPLETE because `transport_stub=true` persists globally; this pass reflects claim-honesty + process-gate compliance for PR #133 metadata under current policy.
