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

## Purpose

This walkthrough establishes `frontend_real` evidence for the audited API families while preserving the `transport_stub=true` status for filing transport completion claims.

## Expected completion state

- API call log panel shows successful responses across steps 1-31 (non-2xx on phase-specific actions indicates missing preconditions and should be treated as failed walkthrough evidence).
- No red error text is present in the UI.
- Fixture ids are populated in the operator panel:
  - `matterId` after step 1
  - `documentId` after step 2
  - `draftId` after step 5
  - `packageId` after step 9
  - `attestationId`, `disputeId`, and `adjudicationId` after step 14
