# Independent Phase Auditor re-audit: PR #209 Firestore closure adapter remediation

Date: 2026-09-24  
Repository: `shamail-sikander/cursor-init`  
Product slice: forge PR #209 — TB external transport receipt acknowledgment  
Remediation: PR #211 / `61dc85005edb84330a87850c5b2446fbdedecac5`  
Audited tip: `2835a00647aebdf0aeaf812994bd4bedb073f5e2`

## Verdict

| Layer | Result |
|---|---|
| Phase audit | **PASS** |
| Product | **PARTIAL** |

The prior major failure is remediated: the closure-track Firestore repository now exposes the exact long-key adapter with `upsert`, `get`, `listByFirm`, and `listByMatter`; the corresponding `SpineStore` map key and row type use that same closure-track name. The required Firestore emulator trio is green at **22/22**, so `backend_real=true` is now supported by runtime evidence.

This is not a COMPLETE product finding. `transport_stub=true` remains honest and binding: `platform/persistence/filingDispatchQueue.ts` still contains `TODO(firm)` and `blocked_todo_firm` markers. The product result remains PARTIAL.

## A. BACKEND_REAL — PASS

`61dc850` replaces the obsolete closure adapter member with:

- `workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments`
- an exact Firestore adapter exposing `upsert` and `get` (plus both list methods);
- the matching `SpineStore` in-memory map key and row type.

This matches the closure-track consumer that had previously been `undefined`. The live emulator run passed `tests/firestore.rules.test.ts`, `tests/persistence.repositories.test.ts`, and `tests/persistence.runtime-mode.test.ts`: **3 files, 22 tests passed**.

## B. FRONTEND_REAL and claim gate — PASS

`/ops` still executes the real view sequence:

1. GET view 475, custody TB seal-verification external transport receipt acknowledgments;
2. GET view 476, closure equivalent;
3. checkpoint POST through `/api/d2/ops-reporting`.

The focused PR #209 test and PR #205 regression passed **6/6**. Replaying `ci_gates/check_pr_phase_claims.py` for `f999c5b..f81e466` with the canonical flags and `/ops` → `/api/d2/ops-reporting` evidence passed.

## C. Classification and transport honesty — PASS

The audited metadata remains:

```text
backend_real=true
frontend_real=true
transport_stub=true
classification=PARTIAL
```

There is no COMPLETE/product-done claim. The transport boundary is still stubbed, so a COMPLETE classification would be false even after the Firestore repair.

## D. Tip integrity — PASS (with parent terminology correction)

`2835a00647aebdf0aeaf812994bd4bedb073f5e2` has direct parent `61dc85005edb84330a87850c5b2446fbdedecac5`; `f81e466b4cf7a899c2686b8c485697c9f18a7fed` is its grandparent. Both commits are ancestors of the audited tip:

```text
2835a006 (audit-ledger docs)
└── 61dc850 (Firestore closure adapter remediation)
    └── f81e466 (PR #209 product)
```

Accordingly, the intended remediation and product commits are both present in the audit tip. A statement that both are *direct* parents would be inaccurate.

## E. Executed checks

| Check | Result |
|---|---|
| Firestore rules/repositories/runtime-mode emulator trio | PASS — 22/22 |
| Focused PR #209 `/ops` test + PR #205 regression | PASS — 6/6 |
| PR #209 claim-gate replay | PASS |
| G-0 | PASS |
| G-1 | PASS — 10/10 |

Expected Firestore permission-denied messages in the rules tests are deny-rule assertions, not failures.

## F. Disposition

The earlier major audit finding is closed. This packet and the ledger entry record a phase-audit PASS only. Keep the product at PARTIAL until real external filing transport replaces the documented stub boundary and a new audit verifies it.
