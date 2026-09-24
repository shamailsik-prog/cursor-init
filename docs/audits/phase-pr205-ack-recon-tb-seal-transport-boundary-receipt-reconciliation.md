# Independent Phase Auditor forensic audit: PR #205 ack-recon TB seal verification × transport-boundary receipt reconciliation

Date: 2026-09-24
Repository: `shamail-sikander/cursor-init`
Forge PR: [#205](https://cursor.com/codebase/shamail-sikander/cursor-init/pull/205)
Audited landed commit: `cee14af03c4d7bfd72bd92e2006eebb7c6e23a8b` — `Ack-recon TB seal verification transport-boundary receipt reconciliation (stub-honest) (#205)`
Product base: `57508c8348c8751a5e389a5ca1b777b1765753d1`
Main integrity: `git fetch origin main` resolved `origin/main` to `cee14af`; the landed commit is the remote-main tip. The locally pre-fetched `8bb1f1c` was stale and was not audited as the tip.

## Verdict

| Layer | Result |
|---|---|
| Phase audit | **FAIL (severity: major)** |
| Product / release | **PARTIAL** (expected: `transport_stub=true`) |

The claimed durable backend and real operator-console call sites are present and the claimed focused test lanes pass. The phase cannot pass the raised completeness bar, because its own phase-claim gate rejects a PR that changed `app/ops/**` without changing a focused `tests/ops*.test.ts` file. This is not cured by route-wiring tests elsewhere. No COMPLETE/product-DONE claim is accepted or inferred.

## Scope and CM labels verified

PR #205 declares, in plain `key=value` labels:

```text
backend_real=true
frontend_real=true
transport_stub=true
classification=PARTIAL
```

The changed product paths are the D2 ops route, `app/ops/operator-audit-console.tsx`, spine/store and memory/Firestore repositories, Firestore rules, the TB-seal governance module, and focused tests. The PR also contains an internal `PR #202` label and builder audit filename; that is a provenance-labeling discrepancy only—the forge PR and landed squash commit are #205 / `cee14af`.

## A. BACKEND_REAL — PASS for implementation evidence; phase result remains blocked by F

Evidence independently checked:

1. `platform/spine/store.ts` adds the custody and closure child row/map tracks; memory and Firestore repository adapters are present in `platform/persistence/spineRepositories.ts` and `platform/persistence/firestoreSpineRepositories.ts`.
2. `platform/persistence/workflowOpsAckReconTbSealVerificationTransportBoundaryReceiptReconciliationGovernance.ts` builds both child tracks, gates their state from the seal-verification parent, and uses `buildWorkflowOpsChainedDocumentId` (`L19–32`). It carries `transport_stub:true` provenance (`L15`, `L176–181`, `L314–320`) and assigns the blocked external transport channel (`L168–170`, `L308–309`).
3. Firestore has both new deny-write rules (`firestore.rules:L204` and `L219`: `allow write: if false`).
4. `/api/d2/ops-reporting` includes the added view/action family; the focused API and route-wiring suite exercises this wiring.
5. The added ID-length test invokes both new governance ID builders and checks each result is at most 1500 UTF-8 bytes (`tests/workflow-ops-custody-closure-firestore-id.test.ts:L419–441`).

Result: the backend implementation supports `backend_real=true`; it is not an API-only scaffold.

Checks:

- `npx vitest run tests/persistence.route-wiring.test.ts tests/api.ops-reporting.test.ts tests/workflow-ops-custody-closure-firestore-id.test.ts` → **137 passed**.
- `npm run test:rules` → Firestore rules, repositories, and runtime mode **22 passed**.
- `npm run gate:g0 && npm run gate:g1` → **PASS**; G-1 has **10 passed**.

Residual minor: the Firestore emulator/Vite transform emits a duplicate object-key warning in `platform/persistence/firestoreSpineRepositories.ts:L4012` and `L4048`. It predates this slice (`git show 57508c8:... | rg -c <key>` returns `2`), so this audit does not attribute it to PR #205. The changed test declarations do not introduce a duplicate `const`; the focused and emulator suites compile and pass.

## B. FRONTEND_REAL honesty — PASS for actual wiring; FAIL at process gate

The CM’s `frontend_real=true` statement is substantively true:

1. `app/ops/operator-audit-console.tsx:L3329–3412` defines the lattice and invokes `/api/d2/ops-reporting` GET views 463, 464, 469, and 470, then posts the reconcile action.
2. The dedicated operator-control button calls that lattice at `app/ops/operator-audit-console.tsx:L3671–3681`.
3. The route contains the matching reconcile action handler (`app/api/d2/ops-reporting/route.ts:L24124`); the focused route/API suite passes.

This is real UI-to-API wiring, not an API-only claim.

The raised process requirement still fails. `ci_gates/check_pr_phase_claims.py:L233–240` requires a changed `tests/ops*.test.ts` file whenever `app/ops/**` changes. PR #205 changes `app/ops/operator-audit-console.tsx` but its test changes are only `tests/api.ops-reporting.test.ts`, `tests/persistence.*`, and `tests/workflow-ops-custody-closure-firestore-id.test.ts`.

Replay using the PR’s exact labels and call-site evidence, `BASE_SHA=57508c8` and `HEAD_SHA=cee14af`, exits **1**:

```text
FAIL: PR phase-claim gate blocked this change.
 - PR touches app/ops but no focused tests under tests/ops*.test.ts were changed.
```

## C. COMPLETE / transport-stub honesty — PASS

`transport_stub=true` is real and accepted only as a PARTIAL product classification. The new governance rows retain `blocked_todo_firm` transport behavior and `transport_stub:true` provenance; they do not submit to a live court transport. PR #205 labels the release `classification=PARTIAL`, and no positive COMPLETE/product-DONE assertion is present. Therefore this phase must not be described as product complete.

## D. SHA on main and CM honesty — PASS with labeling minor

- `git fetch origin main` updated the stale local remote tracking ref from `8bb1f1c` to `cee14af`.
- `origin/main` resolves to the full claimed SHA, and its parent is the claimed base `57508c8`.
- Commit subject matches the claimed landed subject.
- CM labels match the code: backend and frontend implementations exist; transport is honestly a stub; classification is PARTIAL.

Minor: the PR body, UI strings, and builder audit filename use internal phase number `#202` while the forge PR is #205. This does not alter the code evidence, but future audit packets should use the forge PR number consistently.

## E. Tests and gates — FAIL overall because the claim gate is red

| Check | Result |
|---|---|
| Focused route/API/ID Vitest | PASS — 137/137 |
| Firestore emulator rules/repository/runtime-mode | PASS — 22/22 |
| G-0 | PASS |
| G-1 | PASS — 10/10 |
| PR phase-claim gate | **FAIL** — missing focused `tests/ops*.test.ts` change |

The duplicate adapter-key warning described in A is a pre-existing minor and does not fail these suites. The claim-gate failure is a major current-phase issue because `frontend_real=true` and an `app/ops` implementation are explicitly claimed.

## F. Documentation and process disposition

This independent audit document and the ledger row in `docs/LEGAL_OS_PHASE_VERIFICATION.md` are the required audit packet for the exact landed tip. The builder stub `docs/audits/phase-pr202-workflow-slo-ack-recon-tb-seal-verification-transport-boundary-receipt-reconciliation.md` was not used as audit evidence.

### Required remediation before a PASS audit

1. Add a focused operator-console test under `tests/ops*.test.ts` that covers the #205 lattice’s GET views and POST reconcile call, then re-run the phase-claim gate against the full PR metadata.
2. Correct the internal `#202` provenance labels to the forge PR number in a follow-up audit packet if retained.
3. Separately remove the pre-existing duplicate Firestore adapter object key and retain a regression check; this is a minor cleanup, not a permitted product-code change in this docs-only audit PR.

## Gate for CM

**Hold the NEXT merge until this docs PR is mergeable and the missing focused `/ops` test has been added in the appropriate product follow-up.** The product remains terminally PARTIAL for filing transport while `transport_stub=true`; no code or documentation may upgrade it to COMPLETE on this evidence.
