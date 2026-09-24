# Independent Phase Auditor forensic audit: PR #209 TB external transport receipt acknowledgment

Date: 2026-09-24
Repository: `shamail-sikander/cursor-init`
Forge PR: [#209](https://cursor.com/codebase/shamail-sikander/cursor-init/pull/209)
Builder-internal label: PR #206 (provenance only; this audit uses forge PR #209)
Audited landed commit: `f81e466b4cf7a899c2686b8c485697c9f18a7fed`
Base / parent before landing: `f999c5be649a126f1756899d868db7e1ba3e19b9`

## Verdict

| Layer | Result |
|---|---|
| Phase audit | **FAIL (severity: major)** |
| Product | **PARTIAL** (`transport_stub=true`; never COMPLETE) |

PR #209's labels and operator-console wiring are materially present, but the durable Firestore repository path is broken in the required emulator suite. This is a runtime failure, not an acceptable API-only scaffold or a documentation discrepancy. Hold NEXT until a product remediation restores the missing repository member and the full emulator trio is green; this audit PR intentionally makes no product change.

## Labels and exact landing integrity

The canonical forge body declares:

```text
backend_real=true
frontend_real=true
transport_stub=true
classification=PARTIAL
```

`git fetch origin main` advanced the stale local remote-tracking ref from `f999c5b` to the exact landed `f81e466`; its sole parent is `f999c5b`. The commit subject and PR base match the forge metadata. PR #205 (`cee14af`) and PR #207 (`34ab13d`) remain product ancestors in the stated lineage.

Replaying `ci_gates/check_pr_phase_claims.py` with the canonical flags, `/ops` call-site evidence, `/api/d2/ops-reporting` path, `BASE_SHA=f999c5b`, and `HEAD_SHA=f81e466` exits 0. The gate therefore correctly accepts the PARTIAL claim, but it does not execute the Firestore adapter path that fails below.

## A. BACKEND_REAL — FAIL (major)

The implementation is not absent: it adds the governance module, memory and Firestore repository declarations, two deny-write Firestore rules, GET views 475–476, and six partner lifecycle actions (checkpoint, acknowledge, and finalization for custody and closure). The new ID builders are exercised in the persistence test and their generated IDs are bounded at 1500 bytes or fewer. No duplicate `const` was introduced in the changed persistence test declarations.

However, `npm run test:rules` fails:

1. `tests/persistence.repositories.test.ts` fails at the PR #209 closure-track `repos.…ExternalTransportReceiptAcknowledgments.upsert(...)` call with `Cannot read properties of undefined (reading 'upsert')`.
2. `tests/persistence.runtime-mode.test.ts` fails in `ensureWorkflowOpsAlertGovernanceRows` at the matching closure-track repository `.get(...)` with `Cannot read properties of undefined (reading 'get')`.
3. Vite also reports a duplicate object-key warning in `platform/persistence/firestoreSpineRepositories.ts`. Static route-wiring assertions cannot establish the missing runtime member.

This rejects `backend_real=true` under the raised bar until the Firestore repository object exposes the exact closure-track member consumed by the route and emulator tests.

## B. FRONTEND_REAL and claim gate — PASS

`tests/ops.pr-206-tb-external-transport-receipt-ack-frontend-real.test.ts` exists and passes. Its lattice checks establish that `app/ops/operator-audit-console.tsx` issues the ordered GET calls for views 475 and 476 after the PR #205 reconcile lane (views 469/470 and its POST), then sends the custody checkpoint POST using the long `…_external_transport_receipt_acknowledgment` action. The regression `tests/ops.pr-205-tb-transport-boundary-receipt-reconciliation-frontend-real.test.ts` also passes.

The checked PR #209 metadata passes `check_pr_phase_claims.py`; this is not an FE claim-gate failure. The product failure is instead the required durable backend suite described in A.

## C. COMPLETE and transport honesty — PASS, product capped at PARTIAL

The forge metadata says `classification=PARTIAL` and contains no positive COMPLETE/product-done claim. The added governance provenance retains `transport_stub:true`; the repository still contains `TODO(firm)`, `_stub`, and `blocked_todo_firm` transport markers. External transport is not implemented, so this audit does not permit COMPLETE regardless of any later adapter repair.

## D. SHA on main — PASS

After fetching the current remote branch, `origin/main` resolves exactly to `f81e466b4cf7a899c2686b8c485697c9f18a7fed`. The earlier local `main` reference at `f999c5b` was stale and was not used for the final verdict.

## E. Executed checks

| Check | Result |
|---|---|
| Focused PR #209 `/ops` test + PR #205 regression | PASS — 6/6 |
| Claim-gate replay with PR #209 metadata | PASS |
| Persistence route-wiring suite | PASS — 122/122 |
| Firestore rules/repositories/runtime-mode | **FAIL — 2 failed, 20 passed** |
| G-0 | PASS |
| G-1 | PASS — 10/10 |

## F. Disposition

This document is the audit packet for forge PR #209, not the builder's internal PR #206 label. Do not advance NEXT or upgrade the product status. A product remediation must repair the Firestore adapter member, remove or account for the duplicate-key warning, and re-run the emulator trio before a new phase audit can pass. Filing transport must separately become real before any COMPLETE claim can be considered.
