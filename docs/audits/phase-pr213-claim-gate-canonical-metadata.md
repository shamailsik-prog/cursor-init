# PR #213 — canonical phase-claim metadata (claim-gate remediation)

Repository: `shamail-sikander/cursor-init`  
Forge PR: **#213** (product slice already on `main`)  
Landed merge commit: `955bf5e8a01656172670789c6eb8a6a0bb8b3166`  
Parent before merge: `0b52925cfd8cf198316ebc7891a66f0d74f8af26`

This file records the **machine-readable PR metadata** that `ci_gates/check_pr_phase_claims.py` expects for the #213 `app/ops/**` + `frontend_real=true` slice. Auditors replay the block below as `PR_BODY` (with the forge title as `PR_TITLE`).

## Canonical `PR_TITLE`

```text
TB seal-verifications transport-boundary external transport receipt acknowledgment reconciliation (stub-honest) (#213)
```

## Canonical `PR_BODY` (claim-gate compliant)

```text
## Release labels (honest)

| Label | Value |
|---|---|
| backend_real | true |
| frontend_real | true |
| transport_stub | true |
| classification | PARTIAL (never COMPLETE while transport_stub=true) |

## /ops action-name→call-site evidence

- view-name→call-site: PR #213 GET view 477 (custody TB seal-verifications transport boundary external transport receipt acknowledgment reconciliation) -> app/ops/operator-audit-console.tsx
- view-name→call-site: PR #213 GET view 478 (closure TB seal-verifications transport boundary external transport receipt acknowledgment reconciliation) -> app/ops/operator-audit-console.tsx
- action-name→call-site: reconcile_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation -> app/ops/operator-audit-console.tsx

## Concrete `/api/...` fetch paths

- GET `/api/d2/ops-reporting` — custody lattice view **477** (`custodyTbSealVerificationTransportBoundaryExternalTransportReceiptAcknowledgmentReconciliationView` in `app/ops/operator-audit-console.tsx` ~3470–3483)
- GET `/api/d2/ops-reporting` — closure lattice view **478** (`closureTbSealVerificationTransportBoundaryExternalTransportReceiptAcknowledgmentReconciliationView` in `app/ops/operator-audit-console.tsx` ~3484–3497)
- POST `/api/d2/ops-reporting` — TB seal-verifications transport-boundary external transport receipt acknowledgment **reconciliation** (`reconcile_workflow_ops_…_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation` in `app/ops/operator-audit-console.tsx` ~3498–3512)

## Backend parent gate (already on main)

- POST reconcile parent gate + builder: `app/api/d2/ops-reporting/route.ts` ~14767–14784

## Focused ops test

- `tests/ops.pr-213-tb-external-transport-receipt-ack-reconciliation-frontend-real.test.ts`

no COMPLETE/product-done claim
```

## Claim-gate replay (#213 merge range)

```bash
export PR_TITLE='TB seal-verifications transport-boundary external transport receipt acknowledgment reconciliation (stub-honest) (#213)'
export PR_BODY="$(sed -n '/^```text$/,/^```$/p' docs/audits/phase-pr213-claim-gate-canonical-metadata.md | sed '1d;$d' | sed -n '/^## Release labels/,$p')"
export BASE_SHA=0b52925cfd8cf198316ebc7891a66f0d74f8af26
export HEAD_SHA=955bf5e8a01656172670789c6eb8a6a0bb8b3166
python3 ci_gates/check_pr_phase_claims.py
```

Expected: `PASS: PR phase-claim gate.`
