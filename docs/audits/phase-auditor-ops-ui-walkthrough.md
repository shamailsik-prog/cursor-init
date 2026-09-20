# Phase Auditor operator UI walkthrough note

Date: 2026-09-20  
Route under test: `/ops`

## Click path and expected API activity

1. Click `Create matter fixture`.
   - Expected API: `POST /api/d1/matters` (`action=create`)
2. Click `Confirm engagement (/api/d1/matters)`.
   - Expected API: `POST /api/d1/matters` (`action=confirm_engagement`)
3. Click `Record case number (/api/d1/matters)`.
   - Expected API: `POST /api/d1/matters` (`action=record_case_number`)
4. Click `Read tenancy memberships (/api/p5/tenancy)`.
   - Expected API: `GET /api/p5/tenancy?view=memberships`
5. Click `Read tenancy audit (/api/p5/tenancy)`.
   - Expected API: `GET /api/p5/tenancy?view=audit`
6. Click `Read clients list (/api/d1/clients)`.
   - Expected API: `GET /api/d1/clients`
7. Click `Read reporting index (/api/d1/reporting)`.
   - Expected API: `GET /api/d1/reporting`
8. Click `Read ops reporting (/api/d2/ops-reporting)`.
   - Expected API: `GET /api/d2/ops-reporting`
9. Click `Persist committee output (/api/p1/committee-brain)`.
   - Expected API: `POST /api/p1/committee-brain`
10. Click `Hydrate committee output list (/api/p1/committee-brain)`.
   - Expected API: `GET /api/p1/committee-brain`
11. Click `Ingest document`.
   - Expected API: `POST /api/d1/documents` (`action=ingest`)
12. Click `Transition workflow`.
   - Expected API: `POST /api/d1/document-workflow` (`action=transition`)
13. Click `Read workflow queue`.
   - Expected API: `GET /api/d1/document-workflow?view=queue`
14. Click `Compose draft`.
   - Expected API: `GET /api/d4/drafts?view=templates` then `POST /api/d4/drafts` (`action=compose`)
15. Click `Read drafts view`.
   - Expected API: `GET /api/d4/drafts?view=drafts`
16. Click `Read court ops queue`.
   - Expected API: `GET /api/d2/court-ops`
17. Click `Post court ops command`.
   - Expected API: `POST /api/d2/court-ops` (`action=whatsapp_command`)
18. Click `Create filing package`.
   - Expected API: `POST /api/d4/filings` (`action=create_package`)
19. Click `Approve filing package`.
    - Expected API: `POST /api/d4/filings` (`action=decide_package`)
20. Click `Dispatch update`.
    - Expected API: `POST /api/d4/filings` (`action=dispatch_update`)
21. Click `Read filings dispatch view`.
    - Expected API: `GET /api/d4/filings?view=dispatch`
22. Click `Read filings closure compliance view`.
    - Expected API: `GET /api/d4/filings?view=closure_compliance_digests`
23. Click `Seed #70-#73 adjudication context`.
    - Expected APIs:
      - `POST /api/d4/filings` (`action=record_closure_attestation`)
      - `POST /api/d4/filings` (`action=open_closure_attestation_dispute`)
      - `POST /api/d4/filings` (`action=escalate_closure_dispute_to_panel`)
      - and fallback reads:
        - `GET /api/d4/filings?view=closure_attestations`
        - `GET /api/d4/filings?view=closure_attestation_disputes`
        - `GET /api/d4/filings?view=closure_adjudication_queue`
24. Click `Action: set_closure_adjudication_debt_burndown_target`.
    - Expected API: `POST /api/d4/filings` (`action=set_closure_adjudication_debt_burndown_target`)
25. Click `Action: rebaseline_closure_adjudication_burndown_forecast`.
    - Expected API: `POST /api/d4/filings` (`action=rebaseline_closure_adjudication_burndown_forecast`)
26. Click `Action: acknowledge_closure_burndown_settlement_drift`.
    - Expected API: `POST /api/d4/filings` (`action=acknowledge_closure_burndown_settlement_drift`)
27. Click `Action: checkpoint_closure_settlement_post_resolution_verification`.
    - Expected API: `POST /api/d4/filings` (`action=checkpoint_closure_settlement_post_resolution_verification`)
28. Click `View: closure_adjudication_debt_burndown`.
    - Expected API: `GET /api/d4/filings?view=closure_adjudication_debt_burndown`
29. Click `View: closure_burndown_recalibration`.
    - Expected API: `GET /api/d4/filings?view=closure_burndown_recalibration`
30. Click `View: closure_burndown_settlement`.
    - Expected API: `GET /api/d4/filings?view=closure_burndown_settlement`
31. Click `View: closure_settlement_attestation`.
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
25. Click `Batch F actions (#60-#69 governance lattice)`.
    - Expected APIs (POST `/api/d4/filings`):
      - `set_closure_sla_window_config`
      - `set_closure_auto_assignment_rule`
      - `assign_closure_followup`
      - `auto_assign_closure_followup`
      - `claim_closure_followup`
      - `waive_closure_sla_exception`
      - `acknowledge_remediation_expiry`
      - `snooze_remediation_expiry`
      - `attest_remediation_closure`
      - `resolve_closure_followup`
      - `record_closure_attestation`
      - `review_closure_attestation`
      - `open_closure_attestation_dispute`
      - `escalate_closure_dispute_to_panel`
      - `govern_closure_adjudication_quorum`
      - `acknowledge_closure_adjudication_slo_breach`
      - `extend_closure_adjudication_slo_deadline`
      - `escalate_closure_adjudication_slo_tier`
      - `record_closure_adjudication_slo_debt_remediation`
      - `downshift_closure_adjudication_slo_tier`
      - `record_closure_adjudication_verdict`
      - `attest_closure_adjudication_slo_breach_closure`
      - `tick_closure_sla_exception_enforcement`
      - `rebalance_closure_enforcement_queue`
      - `configure_closure_rebalance_auto_execution_safeguard`
      - `set_closure_rebalance_safeguard_override_expiry`
      - `execute_closure_rebalance_owner_transfer`
      - `attest_closure_rebalance_auto_execution_override`
      - `auto_clear_closure_rebalance_safeguard_suppression`
      - `cleanup_stale_closure_rebalance_safeguard_lock`
      - `acknowledge_closure_safeguard_expiry_attestation`
      - `queue_closure_safeguard_overdue_expiry_exception`
      - `reconcile_closure_safeguard_expiry_override`
26. Click `Batch F views (#60-#69 closure governance reads)`.
    - Expected APIs (GET `/api/d4/filings`):
      - `view=closure_compliance_digests`
      - `view=closure_followup_queue`
      - `view=closure_attestations`
      - `view=closure_sla_window_configs`
      - `view=closure_auto_assignment_rules`
      - `view=closure_sla_windows`
      - `view=closure_sla_exception_digests`
      - `view=closure_attestation_disputes`
      - `view=closure_sla_exception_enforcement`
      - `view=closure_adjudication_queue`
      - `view=closure_enforcement_rebalance`
      - `view=closure_adjudication_quorum`
      - `view=closure_rebalance_execution`
      - `view=closure_adjudication_slo`
      - `view=closure_rebalance_safeguards`
      - `view=closure_adjudication_slo_debt_remediation`
      - `view=closure_rebalance_safeguard_expiry`
27. Click `Batch D actions (/p5 tenancy + /d1 clients + source actions + committee write)`.
    - Expected APIs:
      - `POST /api/d1/matters` (`action=confirm_engagement`)
      - `POST /api/d1/matters` (`action=record_case_number`)
      - `POST /api/d1/clients` (`action=create`)
      - `POST /api/d1/clients` (`action=conflict_check`)
      - `POST /api/p5/tenancy` (`action=update_role`)
      - `POST /api/p1/committee-brain` (persisted output seed for list hydration path)
28. Click `Batch D views (/p5 tenancy + /d1 reporting + /d2 ops-reporting + committee list)`.
    - Expected APIs:
      - `GET /api/p5/tenancy?view=session`
      - `GET /api/p5/tenancy?view=users`
      - `GET /api/p5/tenancy?view=memberships`
      - `GET /api/p5/tenancy?view=audit`
      - `GET /api/d1/clients`
      - `GET /api/d1/reporting`
      - `GET /api/d2/ops-reporting`
      - `GET /api/p1/committee-brain`

## Purpose

This walkthrough establishes `frontend_real` evidence for the audited API families while preserving the `transport_stub=true` status for filing transport completion claims.

## Expected completion state

- API call log panel shows successful responses across the walkthrough, while guarded operations can return deterministic 4xx values and still prove call-site wiring/fail-closed behavior.
- No red error text is present in the UI.
- Fixture ids are populated in the operator panel:
  - `matterId` after step 1
  - `documentId` after step 2
  - `draftId` after step 5
  - `packageId` after step 9
  - `attestationId`, `disputeId`, and `adjudicationId` after step 14
  - `clientEntityId` after step 27 (or resolved via client list fallback)
