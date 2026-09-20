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

## Purpose

This walkthrough establishes `frontend_real` evidence for the audited API families while preserving the `transport_stub=true` status for filing transport completion claims.

## Expected completion state

- API call log panel shows 13 consecutive `200` responses.
- No red error text is present in the UI.
- Fixture ids are populated in the operator panel:
  - `matterId` after step 1
  - `documentId` after step 2
  - `draftId` after step 5
  - `packageId` after step 9
