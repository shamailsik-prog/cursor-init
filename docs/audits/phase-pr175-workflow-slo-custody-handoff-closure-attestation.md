# Independent Phase Auditor forensic audit: PR #175 archival-export custody handoff + transport-boundary receipt closure attestation

Date: 2026-09-21  
Repo: `shamail-sikander/cursor-init`  
PR: `#175` (`cursor/custody-handoff-closure-attestation-699a` → `main`, merged)  
Main tip audited: `40366e0bcb3b46a09beae1c24b1efe4b1e7cddeb` (`origin/main` @ audit close)  
Landed merge commit: `40366e0` (merge parent-2 / feature tip `966bf1b59f27fbc139fb18b37efde9cea151dcb4`)  
Implementation stack base: `62c863b` (PR #174 merge — `buildWorkflowOpsChainedDocumentId` / `woa:<sha256>` when logical id >1500 UTF-8 bytes)  
Slice commits: `eb44829` (custody + closure attestation slice), `966bf1b` (reuse shared chained doc-id helper for new entities)  
Claim-gate anchor on `main`: `ede9a9c` (plain `key=value` + markdown-table parsing in `ci_gates/check_pr_phase_claims.py`)

## Verdict (lead)

**FAIL (severity: major).**

Custody-handoff and transport-boundary closure-attestation backend wiring, Firestore **≤1500-byte** hashed document IDs (via PR #174 helper), deny-write rules, and `/api/d2/ops-reporting` views plus six partner POST actions are largely as claimed, and the **runtime-mode mega flow** that failed after PR #172 is **green again** on `main`. However, the builder’s **“tests green”** posture is **false** for the standard Firestore emulator trio: `tests/persistence.repositories.test.ts` **does not compile** (duplicate `const closureAttestation` in one mega round-trip block introduced in `eb44829`), so the repositories suite never runs. That fails checklist **E** and blocks a PASS replay despite green G-0/G-1 and partial Vitest lanes.

**Release / product classification remains PARTIAL** (not DONE) because `transport_stub=true` — unchanged and honestly labeled.

Builder stub `docs/audits/phase-prXXX-workflow-slo-freeze-override-seal-verification-archival-export-custody-handoff-transport-boundary-receipt-reconciliation-closure-attestation.md` was **not** used as evidence (marked PENDING; superseded by this file).

---

## Scope and provenance checked

- `origin/main` @ audit close: `40366e0`.
- Merge subject: `Merge pull request #175: archival-export custody handoff + transport-boundary closure attestation`.
- `git diff --name-only 62c863b..966bf1b` → 12 implementation paths; **excludes** `app/ops/**`.
- PR #174 (`62c863b`) is an ancestor of merge tip; PR #175 stacks on that Firestore ID fix rather than reintroducing raw oversized ids for the new entities.
- Claimed commands executed independently @ `40366e0`.

---

## A–F verification matrix

### A) BACKEND_REAL

Status: **PASS**

Evidence:

1. Durable row models in `platform/spine/store.ts` for archival-export custody handoff and transport-boundary receipt reconciliation **closure attestation** tracks.
2. Memory repositories in `platform/persistence/spineRepositories.ts` and Firestore adapters in `platform/persistence/firestoreSpineRepositories.ts` (`upsert` / `get` / `listByFirm` / `listAll`).
3. Firestore client write deny rules (`firestore.rules` L193–194) for both new collections.
4. Governance helper `platform/persistence/workflowOpsAlertPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationGovernance.ts` — **`buildWorkflowOpsChainedDocumentId`** from `platform/persistence/workflowOpsChainedDocumentId.ts` (PR #174); logical keys retained in row foreign-key fields; hashed ids `woa:[a-f0-9]{64}` (68 UTF-8 bytes) under deep parents (`tests/workflow-ops-custody-closure-firestore-id.test.ts`).
5. `/api/d2/ops-reporting`: two paginated GET views + **six** partner POST actions (three custody-handoff + three closure-attestation) with shared idempotency cache + audit write-through (verified in route diff `62c863b..966bf1b`).
6. **Firestore integrated persistence**: `tests/persistence.runtime-mode.test.ts` → `persists workflow/court-ops activity index and rehydrates reporting after reset` **passes** @ `40366e0` under Firestore emulator (remediates PR #172 doc-id length regression when combined with PR #174 hashing on the deep chain).

**Auditor finding:** `backend_real=true` is **supported** for this slice on `main` @ `40366e0`, including Firestore runtime-mode mega flow.

### B) FE honesty (`frontend_real=false`)

Status: **PASS**

1. PR metadata (user-supplied release labels): plain `key=value` `frontend_real=false`.
2. Diff `62c863b..966bf1b` and merge `40366e0` exclude `app/ops/**`.
3. No new `/ops` call sites for custody-handoff / closure-attestation actions.

### C) No COMPLETE overclaim

Status: **PASS**

1. PR metadata: `classification=PARTIAL`, explicit negated product-done posture while `transport_stub=true`.
2. Filing transport stubs remain (`platform/persistence/filingDispatchQueue.ts` → `TODO(firm)` / `blocked_todo_firm`).
3. No DONE/product-done assertion in merge commit subject or primary slice commit body.

### D) SHA-on-main integrity

Status: **PASS**

1. `origin/main` @ audit close: `40366e0bcb3b46a09beae1c24b1efe4b1e7cddeb`.
2. Feature tip: `966bf1b`; stack base: `62c863b` (PR #174).
3. `git merge-base --is-ancestor 966bf1b 40366e0` → true; `git merge-base --is-ancestor 62c863b 40366e0` → true.

### E) Focused tests + gates

Status: **FAIL (major)**

Executed independently @ `40366e0`:

| Suite | Command | Result |
|---|---|---|
| Ops reporting + route wiring + custody doc ids + chained-id unit + claim-gate unit | `npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts tests/workflow-ops-custody-closure-firestore-id.test.ts tests/workflowOpsChainedDocumentId.test.ts tests/pr-phase-claim-gate.test.ts` | **124** passed, exit **0** (recurring Vitest worker `onTaskUpdate` timeout noise — non-blocking) |
| Firestore parity (auditor standard) | `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"` | **21 passed, 1 failed suite**, exit **1** |
| G-0 | `bash ci_gates/gate_g0.sh` | PASS |
| G-1 | `python3 ci_gates/gate_g1.py` | PASS (**10** tests) |

Failure detail (blocking):

- `tests/persistence.repositories.test.ts` — **transform/compile error** before any test runs:
  - `The symbol "closureAttestation" has already been declared` @ L3036 vs earlier workflow-ops binding @ L2154 in the same mega round-trip block (`eb44829`).
- Subsuites that **did** run under the emulator command: `persistence.runtime-mode` (including mega refresh) + `firestore.rules` → **21/21** green.

Non-blocking residual (recurring): **zero** dedicated HTTP assertions in `tests/api.ops-reporting.test.ts` for the six new partner POST actions (same pattern as #170/#156).

**Auditor finding:** Builder claim **“tests + G-0/G-1 green”** is **overbroad** — G-0/G-1 pass, but the **mandatory Firestore repositories suite does not execute**.

### F) Process flags (post-`ede9a9c`)

Status: **PASS**

1. Release labels use machine-parseable plain `key=value` form (`backend_real=true`, `frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`).
2. `ci_gates/check_pr_phase_claims.py` replay with representative PR #175 metadata, `BASE_SHA=62c863b`, `HEAD_SHA=966bf1b` → exit **0** (`PASS: PR phase-claim gate.`).
3. `ede9a9c` is on `main` lineage (`git merge-base --is-ancestor ede9a9c 40366e0`).
4. Claim-gate unit suite **20/20** when included in Vitest run above.

---

## Release labels (auditor confirmation)

| Flag | PR claim | Auditor finding |
|---|---|---|
| `backend_real` | true | **true** for Firestore + API wiring (PASS A) |
| `frontend_real` | false | **false** (PASS — honest) |
| `transport_stub` | true | **true** (PASS — honest) |
| `classification` | PARTIAL | **PARTIAL** (not COMPLETE / not product-done) |

---

## Remediation required before PASS

1. Fix duplicate `closureAttestation` binding in `tests/persistence.repositories.test.ts` (rename filing-escalation variable or narrow block scope) so the file compiles.
2. Re-run full Firestore emulator trio; expect **22/22** green (repos + runtime-mode + rules).
3. Keep PR testing checklist aligned with prior independent audits: include Firestore trio whenever workflow-ops spine collections change.

---

## Auditor sign-off

Independent forensic replay @ `40366e0` (feature tip `966bf1b`, stack `62c863b`) **rejects** the builder’s full-test claim for this phase due to **non-compiling** `persistence.repositories.test.ts`. Severity **major**. Firestore doc-id remediation from PR #174 + PR #175 entity wiring is **verified** via runtime-mode mega + dedicated custody/closure id tests. Release classification stays **PARTIAL** because `transport_stub=true`.

---

## Independent Phase Auditor RE-AUDIT addendum (remediation PR #178)

Date: 2026-09-21  
Re-audit trigger: `main` @ `36dca9c811ca37bfb8dd373baab0c7942208f32e` (merge PR #178; fix head `dc1fc0f0c18820046e7c07a36d464bc575dc0f87`)  
Feature merge SHA (unchanged): `40366e0bcb3b46a09beae1c24b1efe4b1e7cddeb` (slice `966bf1b`; stack base `62c863b` PR #174)  
Prior FAIL ledger: `docs/LEGAL_OS_PHASE_VERIFICATION.md` @ `136922e` (PR #177 docs merge; on `main` lineage)

### Verdict (lead)

**PASS (auditor closure).** Prior **FAIL (major)** is **retired** — it applied only to a duplicate `const closureAttestation` binding in `tests/persistence.repositories.test.ts` (workflow-ops transport-boundary closure attestation @ L2154 vs filing-escalation closure attestation @ L3036 in the same mega block, introduced `eb44829`). Remediation renames the workflow-ops binding to `transportBoundaryReceiptReconciliationClosureAttestation`. Independent Firestore emulator trio is **22/22** green on `main` @ `36dca9c`.

**Product / release classification remains PARTIAL** (`transport_stub=true`; **not COMPLETE** / not product-done) — unchanged.

### 1) Rename on `main` @ `36dca9c` (`dc1fc0f`)

Status: **PASS**

- `git show dc1fc0f -- tests/persistence.repositories.test.ts` renames workflow-ops `const closureAttestation` → `const transportBoundaryReceiptReconciliationClosureAttestation` (and matching `expect` reference); filing-escalation `closureAttestation` @ L3036 retained (no collision).
- Merge commit `36dca9c`: `Merge pull request #178: fix(tests) remediates PR #175 duplicate closureAttestation compile failure`.

### 2) Firestore emulator trio (independent rerun)

Status: **PASS**

Command @ `36dca9c`:

```bash
npm run test:rules
```

Equivalent vitest scope: `tests/firestore.rules.test.ts`, `tests/persistence.repositories.test.ts`, `tests/persistence.runtime-mode.test.ts`.

Observed: **22 passed**, exit **0** (was **21/22** with repositories suite transform error @ `40366e0`).

Log artifact: `/opt/cursor/artifacts/pr175-firestore-trio-reaudit.log`.

### 3) A–F spot-check @ `36dca9c` (feature slice `966bf1b` + remediation `dc1fc0f`)

| Check | Status | Notes |
|---|---|---|
| **A BACKEND_REAL** | **PASS** | Unchanged from initial audit @ `40366e0` — custody-handoff + closure-attestation spine, repos, rules, governance (`buildWorkflowOpsChainedDocumentId`), ops-reporting views + six partner actions; runtime-mode mega green under emulator. |
| **B FE honesty** | **PASS** | `frontend_real=false`; diff `62c863b..966bf1b` excludes `app/ops/**`. |
| **C No COMPLETE** | **PASS** | `classification=PARTIAL`, `transport_stub=true`, negated product-done posture. |
| **D SHA on main** | **PASS** | Feature `966bf1b` + merge `40366e0` ancestors of `36dca9c`; remediation merge `36dca9c` on `main`. |
| **E Focused tests + gates** | **PASS** | Firestore trio **22/22** (sole prior major blocker); `gate_g0` PASS; `gate_g1` **10/10** PASS @ re-audit. Initial-audit partial Vitest lane (**124**) and claim-gate replay remain valid on feature SHA; non-blocking residual: six partner POST actions lack dedicated HTTP assertions in `api.ops-reporting` mega test (recurring #170/#156 pattern). |
| **F Process flags** | **PASS** | `ede9a9c` on lineage; PR #175 `key=value` claim-gate replay (`62c863b..966bf1b`) exit **0** (unchanged). Builder `phase-prXXX-…` stub not used as evidence. |

### Release labels (re-audit)

| Flag | PR #175 claim | Auditor finding @ `36dca9c` |
|---|---|---|
| `backend_real` | true | **true** (PASS — Firestore trio + runtime-mode) |
| `frontend_real` | false | **false** (PASS) |
| `transport_stub` | true | **true** (PASS) |
| `classification` | PARTIAL | **PARTIAL** (not COMPLETE) |

### Auditor sign-off (re-audit)

Independent forensic replay @ `36dca9c` **accepts** auditor closure for PR #175 phase verification. Prior major **E** failure **retired**. Severity **low** (prior major retired). **Not COMPLETE** — `transport_stub=true`.
