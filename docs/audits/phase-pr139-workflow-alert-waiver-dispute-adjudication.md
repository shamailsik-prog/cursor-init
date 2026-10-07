# Independent Phase Auditor forensic audit: PR #139 waiver-expiry dispute adjudication + SLA breach resolution checkpoints

Date: 2026-09-21  
Repo: `shamail-sikander/cursor-init`  
PR: `#139` (`cursor/workflow-alert-waiver-dispute-adjudication-1125` → `main`)  
PR URL: `https://cursor.com/codebase/shamail-sikander/cursor-init/pull/139`  
Builder-claimed head: `cbc9d5e051193ba6feb6ca213fb12c924012575b`  
Implementation commit: `01ebcd96147c5cbd4640a35ef878f6b96487bac8`  
Merge SHA on `main`: `f541ae72c7753106532e134a17c347276a4f2ed5`  
Merge parent-2 (final PR head): `8503073beb5d1a3b6085a289b72e23a4e89caeda`  
Independently tested tip: `df7451dad4eaed415abe0a80efd5ccf81458b4c0`  
Main tip at audit close: `f023e420a036c1ba22ec128cb044c94a4110017a`

## Verdict (lead)

**PASS (severity: low).**

The phase is backend-real for the claimed slice, label-honest (`frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`), and does not assert COMPLETE/product-done. Focused API/route-wiring/Firestore/rules suites plus `gate:g0` / `gate:g1` replay green. Claim-gate replay against PR #139 metadata passes.

PR #139 merged to `main` during this audit (`f541ae7`). This auditor did **not** merge it. Transport-stub + frontend-false remains the accepted terminal cap. This audit does **not** certify COMPLETE/product-done.

Builder self-packet `docs/audits/phase-prXXX-workflow-waiver-expiry-dispute-adjudication-resolution.md` was **not** used as implementation evidence.

---

## Scope and evidence policy

- Independent verification used live PR metadata (`origin pr view 139`), feature-branch code at `df7451d` (implementation-identical to merge parent-2 `8503073` for runtime files), merge ancestry on `origin/main`, and local reruns only.
- Builder labels (`backend_real=true`, `frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`) were treated as claims to verify, not facts.
- This auditor did not merge feature PR #139.

---

## Findings by severity

### Blockers

- None. Live court transport remains the only true human blocker and is out of scope for this slice (explicit `transport_stub=true`).

### Majors

- None on PR #139 itself.
- Mid-audit residual after PR #135 (`docs-only queue update`, `never COMPLETE while transport_stub=true`) did not fire on #139 wording. PR #142 later landed on `main` (`0d1db61` / merge `f023e42`) and those residual probes now PASS on the current gate.

### Minors

1. Builder-claimed head `cbc9d5e` lagged the moving PR tip. Final merge parent-2 is `8503073`; claimed SHA and `df7451d` are ancestors. Post-implementation commits are auditor-stub SHA churn plus a docs refresh.
2. `tests/firestore.rules.test.ts` remains the generic G-0 suite (7 tests) and does not assert the two new collections by name.
3. Checkpoint GET is the default return of the view handler rather than an explicit `if (view === "alert_variance_remediation_sla_breach_resolution_checkpoints")`. Safe because `parseView` is a closed union that returns `undefined` for unknown views.

---

## A–F verification

### A) BACKEND_REAL

Status: **PASS**

Evidence verified on independently tested tip `df7451d` (implementation in `01ebcd9`; runtime files unchanged through merge parent-2 `8503073`):

1. Spine row models and store maps exist in `platform/spine/store.ts`:
   - `WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow`
   - `WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow`
   - `workflowOpsAlertWaiverExpiryDisputeAdjudications`
   - `workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints`
2. Memory repository interfaces + adapters exist in `platform/persistence/spineRepositories.ts` (`upsert` / `get` / `listByFirm` / `listByMatter` for both).
3. Firestore adapters exist in `platform/persistence/firestoreSpineRepositories.ts` for:
   - `workflow_ops_alert_waiver_expiry_dispute_adjudications`
   - `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoints`
4. `firestore.rules` includes read-scoped, write-denied posture for both collections.
5. `/api/d2/ops-reporting` exposes both views:
   - `alert_waiver_expiry_dispute_adjudications`
   - `alert_variance_remediation_sla_breach_resolution_checkpoints`
6. `/api/d2/ops-reporting` exposes the claimed partner actions:
   - `open_workflow_ops_alert_waiver_expiry_dispute_adjudication`
   - `assign_workflow_ops_alert_waiver_expiry_dispute_adjudication_panel_owner`
   - `resolve_workflow_ops_alert_waiver_expiry_dispute_adjudication`
   - `open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint`
   - `record_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint`
   - `reopen_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint`
7. Route path keeps idempotency + audit write-through:
   - `requireIdempotencyKey(request)` plus replay/conflict handling
   - each new action `store.audit.push(...)` then `persistAuditEntriesSince(...)`
     - *Update (7 Oct 2026, final audit F8):* `persistAuditEntriesSince` has been removed. The action now only appends its rows to `store.audit`; withSession persists the request's own rows once, by object, in the end-of-request audit flush (`platform/persistence/requestAuditFlush.ts`) and answers 503 `AUDIT_UNAVAILABLE` if that flush fails. The text above records the code as audited at the time.
   - `idempotency.set(key, payload, fingerprint)` on success
8. Symbols were absent from pre-merge `main` and are now present on `origin/main` via merge `f541ae7`.

### B) FE honesty (`frontend_real=false`)

Status: **PASS**

1. Live PR metadata declares `frontend_real=false`.
2. Feature delta has no `app/ops/**` and no product TSX call-site files.
3. Roadmap labels match: `frontend_real: false` with "pending Auditor".
4. PR does not claim `FRONTEND_REAL` / `frontend_real=true`.

### C) No COMPLETE overclaim

Status: **PASS**

1. Live PR metadata declares:
   - `backend_real=true`
   - `frontend_real=false`
   - `transport_stub=true`
   - `classification=PARTIAL (no product-done claim while transport_stub=true)`
2. Roadmap claim is "slice landed / backend_real PASS pending Auditor", not COMPLETE/product-done.
3. Filing transport stubs remain (`TODO(firm)`, `_stub`, `blocked_todo_firm`). Classification is correctly capped at PARTIAL.

### D) SHA evidence vs `main`

Status: **PASS**

1. PR #139 is merged. Merge commit `f541ae72c7753106532e134a17c347276a4f2ed5` is on `origin/main`.
2. Merge parent-2 is final PR head `8503073beb5d1a3b6085a289b72e23a4e89caeda`.
3. Builder-claimed `cbc9d5e`, independently tested `df7451d`, and implementation `01ebcd9` are all ancestors of `origin/main`.
4. `df7451d..8503073` is docs-only (auditor stub SHA refresh + merge of #136 audit docs). Runtime files are unchanged.
5. This auditor did not perform the merge.

### E) Focused tests + gates

Status: **PASS**

Independent replay on worktree at `df7451d`:

1. `npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts tests/pr-phase-claim-gate.test.ts`  
   - PASS (`84` tests: 3 + 71 + 10)
2. `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"`  
   - PASS (`22` tests: 1 + 14 + 7)
3. `npm run gate:g0`  
   - PASS
4. `npm run gate:g1`  
   - PASS (`10` tests)

API tests exercise all six new actions plus both new views. Route-wiring tests bind the new views to the new repository adapters.

Logs:

- `/opt/cursor/artifacts/pr139-audit/unit-api-route-claimgate.log`
- `/opt/cursor/artifacts/pr139-audit/firestore-repos-runtime-rules.log`
- `/opt/cursor/artifacts/pr139-audit/gate-g0.log`
- `/opt/cursor/artifacts/pr139-audit/gate-g1.log`
- `/opt/cursor/artifacts/pr139-audit/claim-gate-replay.log`
- `/opt/cursor/artifacts/pr139-audit/sha-evidence.log`

### F) Process flags

Status: **PASS** for PR #139 live metadata

1. Backend-only `/ops` policy is satisfied (`frontend_real=false` and no `app/ops/**` changed).
2. Live replay of `ci_gates/check_pr_phase_claims.py` against current PR #139 title/body:
   - `BASE_SHA=476e0ab` (PR-listed base) + `HEAD_SHA=df7451d` → `PASS` (exit 0)
   - `BASE_SHA=be8bb88` (merge-base) + `HEAD_SHA=df7451d` → `PASS` (exit 0)
3. `#135` negation handling covers this PR's disclaimer `no product-done claim` (probe PASS).
4. Mid-audit residual after `#135` still false-positived on probes **not** present in #139's final body (`docs-only queue update`, `never COMPLETE while transport_stub=true`). That residual was process debt, not a #139 failure.
5. After this audit's first replay, PR #142 landed (`0d1db61` / merge `f023e42`). Independent residual probes on the current `main` gate now PASS for those phrases.

---

## Fix recommendations

1. Keep PR #139 labels as declared. Do not raise `frontend_real` or classification without `/ops` call sites.
2. Stop SHA-chasing builder stubs. Record the implementation or merge SHA once.
3. Optional: add named `firestore.rules` deny-write cases for the two new collections.
4. Claim-gate residual after #135 was subsequently addressed by #142; keep those tests from regressing.

---

## Final adjudication

- **Verdict:** `PASS`
- **Severity:** `low`
- **Classification (honest labels):** `PARTIAL` (`backend_real=true`, `frontend_real=false`, `transport_stub=true`)
- **Summary:** Backend implementation and focused validation are real and green. Labels are honest. Live claim-gate replay passes. Transport stub remains the accepted terminal cap.
