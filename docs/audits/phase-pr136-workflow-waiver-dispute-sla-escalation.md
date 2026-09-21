# Independent Phase Auditor forensic audit: PR #136 workflow alert waiver-expiry disputes + remediation SLA breach escalation

Date: 2026-09-21  
Repo: `shamail-sikander/cursor-init`  
PR: `#136` (`cursor/workflow-waiver-expiry-disputes-sla-1f10` → `main`, merged)  
Feature merge SHA on `main`: `f20cdf1f78c349c3c65a0e0f24459fbab0e2102f`  
PR head SHA (merge parent-2): `42e7b0b72728c842d0aa04285395ca1480bb11c6`  
Claim gate replay base/head: `0b9152155b0b45fb067e6432811f6106d8d88f04` → `42e7b0b72728c842d0aa04285395ca1480bb11c6`  
Post-#135 gate script: `ci_gates/check_pr_phase_claims.py` at `origin/main` tip `f270e0b` (includes negated-disclaimer fix from PR #135)

## Verdict (lead)

**PARTIAL (severity: medium).**

Backend implementation, SHA integrity, frontend honesty, semantic classification, and focused tests/gates are verified green. **Process-flag replay still FAILs** under the current claim gate: PR #136 metadata contains `(docs-only queue update)` (triggers scaffold/docs-only vs route/test delta rule) and `(never COMPLETE while transport_stub=true)` (literal `COMPLETE` is not covered by the post-#135 negation regex, which only strips `no|not|without … claims`). This is **not** the PR #133 false-positive pattern alone; gate PASS was not observed, so overall **PASS (low) is not warranted**.

Product classification remains **PARTIAL** (`transport_stub=true`; filing transport TODO/stub markers unchanged). **Not product-done.**

---

## Recovery note

Prior agent `bc-559654a1` left no unpushed local commits on this workspace (`git status` clean on `main` before audit branch). Audit work is fresh from merged `main`.

---

## Scope and evidence policy

- Independent verification used merged code at `f20cdf1`, PR #136 metadata from Origin, `git diff` file list, and local reruns only.
- Builder stub `docs/audits/phase-prXXX-workflow-waiver-expiry-remediation-sla.md` was not used as implementation evidence.

---

## A–F verification

### A) BACKEND_REAL

Status: **PASS**

Evidence:

1. Durable row models in `platform/spine/store.ts`:
   - `WorkflowOpsAlertWaiverExpiryDisputeRow`
   - `WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow`
2. Runtime maps on spine store:
   - `workflowOpsAlertWaiverExpiryDisputes`
   - `workflowOpsAlertVarianceRemediationSlaBreachEscalations`
3. Memory repository wiring in `platform/persistence/spineRepositories.ts`:
   - `workflowOpsAlertWaiverExpiryDisputes`
   - `workflowOpsAlertVarianceRemediationSlaBreachEscalations`
4. Firestore adapters in `platform/persistence/firestoreSpineRepositories.ts` for collections:
   - `workflow_ops_alert_waiver_expiry_disputes`
   - `workflow_ops_alert_variance_remediation_sla_breach_escalations`
5. Firestore rules (deny-write posture) in `firestore.rules` for both collections.
6. `/api/d2/ops-reporting` views:
   - `alert_waiver_expiry_disputes`
   - `alert_variance_remediation_sla_breach_escalations`
7. Partner lifecycle actions (open / assign / resolve) for both surfaces in `app/api/d2/ops-reporting/route.ts`, with audit events such as:
   - `ops_reporting_alert_waiver_expiry_dispute_opened`
   - `ops_reporting_alert_waiver_expiry_dispute_reviewer_assigned`
   - `ops_reporting_alert_waiver_expiry_dispute_resolved`
   - `ops_reporting_alert_variance_remediation_sla_breach_escalation_opened`
   - `ops_reporting_alert_variance_remediation_sla_breach_escalation_owner_assigned`
   - `ops_reporting_alert_variance_remediation_sla_breach_escalation_resolved`
8. Route wiring tests assert repository-backed reads for both views (`tests/persistence.route-wiring.test.ts`).

### B) FE honesty (`frontend_real=false`)

Status: **PASS**

Evidence:

1. PR metadata declares `frontend_real: false`.
2. PR #136 diff excludes `app/ops/**`; `/ops` call-site evidence is not required when `frontend_real=false` and no ops UI files changed.

### C) No COMPLETE / product-done overclaim (semantic)

Status: **PASS (semantic)** / **WARNING (machine-gate wording)**

Evidence:

1. Required labels present in PR body:
   - `backend_real=true`
   - `frontend_real=false`
   - `transport_stub=true`
   - `classification=PARTIAL (never COMPLETE while transport_stub=true)`
2. No affirmative product-done narrative; global transport-stub cap remains explicit in repo policy docs.
3. Wording hazards for automated gate (see F): `docs-only` substring and bare `COMPLETE` inside a “never …” clause.

### D) SHA on `main` integrity

Status: **PASS**

Evidence:

1. Merge commit `f20cdf1f78c349c3c65a0e0f24459fbab0e2102f` is on `main` (`git merge-base --is-ancestor f20cdf1 main`).
2. Merge parent-2 resolves to PR head `42e7b0b72728c842d0aa04285395ca1480bb11c6`.
3. Ledger feature SHA recorded as **`f20cdf1`** (not post-merge tip `f270e0b`, which is the PR #135 claim-gate merge).

### E) Focused tests + gates

Status: **PASS**

Independent reruns on audit workspace (`origin/main` at `f270e0b`, includes PR #136 feature):

1. `npm run test:unit -- tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts`  
   - PASS (`72` tests)
2. `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npm run test:unit -- tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts"`  
   - PASS (`15` tests) on second run (first run hit an unrelated `5000ms` timeout in an older runtime-mode case; retry green)
3. `npm run gate:g0`  
   - PASS
4. `npm run gate:g1`  
   - PASS (`10` tests)

Transport-stub policy scan (representative): `platform/persistence/filingDispatchQueue.ts` still contains `TODO(firm)` and `blocked_todo_firm` — consistent with `transport_stub=true`.

### F) Process flags (claim gate replay, post-#135)

Status: **FAIL**

Evidence:

1. Backend-only `/ops` policy satisfied (`frontend_real=false`, no `app/ops/**` in diff).
2. Replay:

```bash
PR_TITLE='Add workflow waiver-expiry dispute and SLA breach escalation scaffolding'
PR_BODY='<PR #136 agent body including Required release labels>'
BASE_SHA='0b9152155b0b45fb067e6432811f6106d8d88f04'
HEAD_SHA='42e7b0b72728c842d0aa04285395ca1480bb11c6'
python3 ci_gates/check_pr_phase_claims.py
```

Observed failures:

- `PR claim says scaffold/docs-only or no runtime changes, but route/tests changed.`  
  Root cause: summary bullet `(docs-only queue update)` matches `docs-only` in `SCAFFOLD_ONLY_RE` while `app/api/**` and `tests/**` changed.
- `PR claims COMPLETE/product-done while filing transport TODO/stub markers still exist.`
- `PR claims COMPLETE/product-done while frontend_real=false.`
- `PR claims COMPLETE/product-done while transport_stub=true.`  
  Root cause: `classification=PARTIAL (never COMPLETE while transport_stub=true)` — token `COMPLETE` matches `COMPLETE_CLAIM_RE` and is **not** inside `NEGATED_COMPLETE_DISCLAIMER_RE` (which requires `no|not|without`, not `never`).

3. Post-#135 negation fix **does** address PR #133-style `no COMPLETE/product-done claim` disclaimers, but **does not** clear PR #136’s `never COMPLETE` or incidental `docs-only` phrases. Gate **does not PASS** for #136 metadata as merged.

---

## Final adjudication

| Check | Result |
|---|---|
| A BACKEND_REAL | PASS |
| B FE honesty | PASS |
| C Semantic overclaim | PASS (with gate wording warnings) |
| D SHA (`f20cdf1`) | PASS |
| E Tests/gates | PASS |
| F Process flags | **FAIL** |
| Product classification | **PARTIAL** (transport stub cap) |
| Auditor overall | **PARTIAL** (medium) — not PASS (low) |

**Remediation (metadata hygiene, no runtime required for audit closure):**

- Remove or rephrase `(docs-only queue update)` when routes/tests change (e.g. “roadmap queue note only”).
- Replace `never COMPLETE while …` with negation forms recognized by the gate (e.g. `no COMPLETE/product-done claims`) or drop the literal `COMPLETE` token from label lines.

---

## Independent re-audit addendum (after claim-gate residual hardening on `main`)

Date: 2026-09-21  
Gate merge audited: `aca861c6075c45ef15034ad7867b7318f3a4b853` (PR **#141**; supersedes overlapping PR **#142** at `f023e42` for gate semantics)  
Docs queue note on `main`: `44f1eb1` (PR **#140**)  
Feature SHA under review (unchanged): `f20cdf1f78c349c3c65a0e0f24459fbab0e2102f`  
`origin/main` tip at close: `2df6951`

### Verdict (lead)

**PASS (severity: low).**

Prior **PARTIAL (medium)** was driven solely by process-flag false positives on PR #136 metadata (`docs-only queue update` roadmap bullet + `never COMPLETE while transport_stub=true`). Gate hardening on `aca861c` clears both without weakening literal COMPLETE/product-done or real docs-only overclaim detection. Claim-gate replay against live PR #136 metadata is **PASS**. A–E spot-checks remain green. Product classification stays **PARTIAL** (`transport_stub=true`; not product-done).

### 1) Gate change on `main` (`aca861c`) — confirmed

`ci_gates/check_pr_phase_claims.py` at `aca861c` (commit `0f5f33c` in PR #141) introduces:

1. **Next-slice docs-only ignore:** `SCAFFOLD_NEXT_SLICE_MENTION_RE` matches `docs-only queue update`; `has_scaffold_only_claim(...)` span-filters `SCAFFOLD_ONLY_RE` hits inside that mention (parenthetical roadmap bullet no longer treated as a current-PR docs-only claim when `app/api/**` and `tests/**` change).
2. **Expanded negation allowlist:** `NEGATED_COMPLETE_DISCLAIMER_RE` includes `never`, `not yet`, `do not` / `don't`, unified `COMPLETE_TOKEN`, optional trailing `claims?`, and span-based filtering via `has_complete_claim(...)` + `_contained_in_spans(...)`.
3. **Regression tests:** `tests/pr-phase-claim-gate.test.ts` includes PR #136-style fixtures (`never COMPLETE while transport_stub=true`, incidental `docs-only queue update`).

No further edits to this gate file after `aca861c` on current `main` (`git diff aca861c HEAD -- ci_gates/check_pr_phase_claims.py` empty).

### 2) Claim-gate replay against PR #136 metadata — PASS

Replay (independent, current `main` tree):

```bash
PR_TITLE='Add workflow waiver-expiry dispute and SLA breach escalation scaffolding'
PR_BODY='<agent body from origin pr view 136; includes docs-only queue update + never COMPLETE disclaimer>'
BASE_SHA='0b9152155b0b45fb067e6432811f6106d8d88f04'
HEAD_SHA='42e7b0b72728c842d0aa04285395ca1480bb11c6'
python3 ci_gates/check_pr_phase_claims.py
```

Observed: `PASS: PR phase-claim gate.` (exit code `0`).  
Prior failures (scaffold/docs-only conflict + three COMPLETE/product-done transport/FE flags) are **not** reproduced.

### 3) Spot-check A–E (regression scan)

| Check | Result | Notes |
|---|---|---|
| A BACKEND_REAL | PASS | Row types, spine maps, memory/Firestore repos, Firestore rules, `/api/d2/ops-reporting` dispute + escalation views/actions unchanged at feature SHA `f20cdf1`. |
| B FE honesty | PASS | `frontend_real=false`; PR diff `0b9152155b0b` → `42e7b0b` excludes `app/ops/**`. |
| C No COMPLETE overclaim | PASS | Semantic PARTIAL + `transport_stub=true`; disclaimer is negated, not an affirmative product-done claim. |
| D SHA integrity | PASS | `f20cdf1` merge on `main`; parent-2 `42e7b0b`; ancestors of `origin/main`. |
| E Focused tests + gates | PASS | `npx vitest run tests/pr-phase-claim-gate.test.ts tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts` → 90 passed; `npm run gate:g0` + `gate:g1` → PASS. |

### Updated adjudication (superseding)

| Check | Prior audit | Re-audit |
|---|---|---|
| F Process flags | FAIL (wording false positives) | **PASS** |
| Auditor overall | PARTIAL (medium) | **PASS (low)** |
| Product classification | PARTIAL (`transport_stub=true`) | **PARTIAL** (unchanged; not COMPLETE) |
