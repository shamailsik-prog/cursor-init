# Independent Phase Auditor forensic audit: PR #139 waiver-expiry dispute adjudication + SLA breach resolution checkpoints

Date: 2026-09-21  
Repo: `shamail-sikander/cursor-init`  
PR: `#139` (`cursor/workflow-alert-waiver-dispute-adjudication-1125` → `main`)  
PR URL: `https://cursor.com/codebase/shamail-sikander/cursor-init/pull/139`  
Builder-claimed head: `cbc9d5e051193ba6feb6ca213fb12c924012575b`  
Live PR head audited: `df7451dad4eaed415abe0a80efd5ccf81458b4c0`  
Implementation commit: `01ebcd96147c5cbd4640a35ef878f6b96487bac8`  
Main tip during audit: `44f1eb159eb04565876a22b166e1e0b7992898ae`  
Merge-base vs `origin/main`: `be8bb88ef3e89007e2009ed5dbd451fa8c976b78`

## Verdict (lead)

**PASS (severity: low).**

The open phase is backend-real for the claimed slice, label-honest (`frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`), and does not assert COMPLETE/product-done. Focused API/route-wiring/Firestore/rules suites plus `gate:g0` / `gate:g1` replay green. Live claim-gate replay against current PR #139 metadata also passes.

Transport-stub + frontend-false remains the accepted terminal cap for filing-linked work. This audit does **not** certify COMPLETE/product-done.

Builder self-packet `docs/audits/phase-prXXX-workflow-waiver-expiry-dispute-adjudication-resolution.md` was **not** used as implementation evidence.

---

## Scope and evidence policy

- Independent verification used live PR metadata (`origin pr view 139`), feature-branch code at `df7451d`, three-dot delta vs `origin/main`, and local reruns only.
- Builder labels (`backend_real=true`, `frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`) were treated as claims to verify, not facts.
- Do not merge feature PR #139 from this audit.

---

## Findings by severity

### Blockers

- None. Live court transport remains the only true human blocker and is out of scope for this slice (explicit `transport_stub=true`).

### Majors

- None on PR #139 itself.
- Known residual after PR #135 still exists in `ci_gates/check_pr_phase_claims.py` for *other* disclaimer shapes (`docs-only queue update`, `never COMPLETE while transport_stub=true`). Those probes still fail. Current PR #139 wording does **not** trip them, so this is process debt, not a #139 product or process-flag failure.

### Minors

1. Builder-claimed head `cbc9d5e` is stale versus live tip `df7451d`. The claimed SHA is an ancestor; post-claim commits are auditor-stub SHA churn only (`ef52299`, `575c31a`, `df7451d`). The stub file still records `575c31a`, not the live tip.
2. `tests/firestore.rules.test.ts` remains the generic G-0 suite (7 tests) and does not assert the two new collections by name.
3. Checkpoint GET is the default return of the view handler rather than an explicit `if (view === "alert_variance_remediation_sla_breach_resolution_checkpoints")`. Safe because `parseView` is a closed union that returns `undefined` for unknown views.

---

## A–F verification

### A) BACKEND_REAL

Status: **PASS**

Evidence verified on live feature tip `df7451d` (implementation in `01ebcd9`):

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
   - `idempotency.set(key, payload, fingerprint)` on success
8. Symbols are absent from `origin/main` and present only on the feature branch.

### B) FE honesty (`frontend_real=false`)

Status: **PASS**

1. Live PR metadata declares `frontend_real=false`.
2. Three-dot delta vs `origin/main` has no `app/ops/**` and no product TSX call-site files.
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

### D) SHA evidence (open PR vs `main`)

Status: **PASS** (open PR; live tip independently resolved)

1. Live Origin PR #139 version 6 head is `df7451dad4eaed415abe0a80efd5ccf81458b4c0`.
2. Builder-claimed `cbc9d5e` is an ancestor of that tip; it is not the current head.
3. Implementation commit `01ebcd9` is unchanged after the claimed SHA; later commits only rewrite the auditor stub SHA.
4. Feature is **not** landed on `main` (expected for an open PR).
5. Merge-base with `origin/main` is `be8bb88`. Current `main` tip `44f1eb1` is docs-only after that point (PR #138 / #140 Phase Auditor write-ups for #136) and is not an ancestor of the feature tip.
6. Ancestry is consistent: feature descends from `be8bb88`; no silent rewrite of the implementation SHA.

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
4. Residual after `#135` still false-positives on probes that are **not** in the current #139 body:
   - `docs-only queue update` → scaffold/docs-only rule FAIL
   - `never COMPLETE while transport_stub=true` → COMPLETE-token FAIL  
   These remain MAJOR process defects to fix in the gate, as recorded on the #136 ledger. They are not a #139 metadata failure.

---

## Fix recommendations

1. Keep PR #139 labels as declared. Do not raise `frontend_real` or classification without `/ops` call sites.
2. Stop SHA-chasing the builder stub. Set the stub head once to the implementation commit (`01ebcd9`) or omit a moving SHA.
3. Optional follow-up (not a #139 blocker): harden `ci_gates/check_pr_phase_claims.py` so scoped `docs-only` parentheticals and `never COMPLETE` disclaimers do not false-positive. Add those phrases to `tests/pr-phase-claim-gate.test.ts`.
4. Optional: add named `firestore.rules` deny-write cases for the two new collections.
5. Do not merge #139 from this audit.

---

## Final adjudication

- **Verdict:** `PASS`
- **Severity:** `low`
- **Classification (honest labels):** `PARTIAL` (`backend_real=true`, `frontend_real=false`, `transport_stub=true`)
- **Summary:** Backend implementation and focused validation are real and green. Labels are honest. Live claim-gate replay passes. Transport stub remains the accepted terminal cap.
