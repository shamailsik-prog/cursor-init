# Phase Auditor operator UI walkthrough note

Date: 2026-09-20  
Route under test: `/ops`

## Click path and expected API activity

1. Click `Create matter fixture`.
   - Expected API: `POST /api/d1/matters` (`action=create`)
2. Click `Ingest document`.
   - Expected API: `POST /api/d1/documents` (`action=ingest`)
3. Click `Transition workflow`.
   - Expected API: `POST /api/d1/document-workflow` (`action=transition`)
4. Click `Read workflow queue`.
   - Expected API: `GET /api/d1/document-workflow?view=queue`
5. Click `Compose draft`.
   - Expected API: `GET /api/d4/drafts?view=templates` then `POST /api/d4/drafts` (`action=compose`)
6. Click `Read drafts view`.
   - Expected API: `GET /api/d4/drafts?view=drafts`
7. Click `Read court ops queue`.
   - Expected API: `GET /api/d2/court-ops`
8. Click `Post court ops command`.
   - Expected API: `POST /api/d2/court-ops` (`action=whatsapp_command`)
9. Click `Create filing package`.
   - Expected API: `POST /api/d4/filings` (`action=create_package`)
10. Click `Approve filing package`.
    - Expected API: `POST /api/d4/filings` (`action=decide_package`)
11. Click `Dispatch update`.
    - Expected API: `POST /api/d4/filings` (`action=dispatch_update`)
12. Click `Read filings dispatch view`.
    - Expected API: `GET /api/d4/filings?view=dispatch`
13. Click `Read filings closure compliance view`.
    - Expected API: `GET /api/d4/filings?view=closure_compliance_digests`
14. Click `Seed #70-#73 adjudication context`.
    - Expected APIs:
      - `POST /api/d4/filings` (`action=record_closure_attestation`)
      - `POST /api/d4/filings` (`action=open_closure_attestation_dispute`)
      - `POST /api/d4/filings` (`action=escalate_closure_dispute_to_panel`)
      - and fallback reads:
        - `GET /api/d4/filings?view=closure_attestations`
        - `GET /api/d4/filings?view=closure_attestation_disputes`
        - `GET /api/d4/filings?view=closure_adjudication_queue`
15. Click `Action: set_closure_adjudication_debt_burndown_target`.
    - Expected API: `POST /api/d4/filings` (`action=set_closure_adjudication_debt_burndown_target`)
16. Click `Action: rebaseline_closure_adjudication_burndown_forecast`.
    - Expected API: `POST /api/d4/filings` (`action=rebaseline_closure_adjudication_burndown_forecast`)
17. Click `Action: acknowledge_closure_burndown_settlement_drift`.
    - Expected API: `POST /api/d4/filings` (`action=acknowledge_closure_burndown_settlement_drift`)
18. Click `Action: checkpoint_closure_settlement_post_resolution_verification`.
    - Expected API: `POST /api/d4/filings` (`action=checkpoint_closure_settlement_post_resolution_verification`)
19. Click `View: closure_adjudication_debt_burndown`.
    - Expected API: `GET /api/d4/filings?view=closure_adjudication_debt_burndown`
20. Click `View: closure_burndown_recalibration`.
    - Expected API: `GET /api/d4/filings?view=closure_burndown_recalibration`
21. Click `View: closure_burndown_settlement`.
    - Expected API: `GET /api/d4/filings?view=closure_burndown_settlement`
22. Click `View: closure_settlement_attestation`.
    - Expected API: `GET /api/d4/filings?view=closure_settlement_attestation`
23. Click `Batch E actions (#48-#59 filing/escalation lattice)`.
    - Expected APIs (POST `/api/d4/filings`):
      - `annexure_checkpoint`
      - `record_submission_receipt`
      - `reconcile_submission`
      - `claim_submission_exception`
      - `escalate_submission_exception`
      - `resolve_submission_exception`
      - `reopen_submission_exception`
      - `mark_transport_blocked`
      - `attach_retry_plan`
      - `acknowledge_breach`
      - `defer_window`
      - `assign_primary_owner`
      - `set_backup_owner`
      - `acknowledge_owner_drift`
      - `snooze_workload_alert`
      - `rebalance_assignment`
      - `set_policy_baseline`
      - `grant_breach_waiver`
      - `acknowledge_policy_variance`
      - `snooze_policy_variance`
      - `record_variance_remediation`
      - `acknowledge_waiver_expiry`
      - `extend_breach_waiver`
      - `acknowledge_handoff`
      - `confirm_delivered`
      - `clear_digest`
      - `revoke_assignment`
      - `revoke_breach_waiver`
24. Click `Batch E views (#48-#59 governance reads)`.
    - Expected APIs (GET `/api/d4/filings`):
      - `view=annexures`
      - `view=submission_receipts`
      - `view=submission_reconciliation`
      - `view=submission_exceptions`
      - `view=transport_execution`
      - `view=submission_sla_digests`
      - `view=escalation_owner_rota`
      - `view=escalation_workload_digests`
      - `view=escalation_policy_baselines`
      - `view=breach_waiver_ledger`
      - `view=policy_variance_digests`
      - `view=waiver_expiry_digests`
      - `view=variance_remediation_ledger`
      - `view=waiver_rollover_attestations`

## Purpose

This walkthrough establishes `frontend_real` evidence for the audited API families while preserving the `transport_stub=true` status for filing transport completion claims.

## Expected completion state

- API call log panel shows successful responses across steps 1-24 (for Batch E action lattice, some guarded operations may return deterministic 4xx statuses while still proving call-site wiring and fail-closed behavior).
- No red error text is present in the UI.
- Fixture ids are populated in the operator panel:
  - `matterId` after step 1
  - `documentId` after step 2
  - `draftId` after step 5
  - `packageId` after step 9
  - `attestationId`, `disputeId`, and `adjudicationId` after step 14
