# FA-F42-R1-002-001-003-003 — Matter trail reads must page past `DOCUMENT_ID_PAGE`

Repository: `shamailsik-prog/cursor-init`  
Finding: **FA-F42-R1-002-001-003-003** [LOW]  
Register: issue #30 (no `Fixes #30` on the PR)

## Problem

Matter-scoped trail reads on `ocr_texts`, `p1_ocr_operations`, `document_workflow`, and `jobs` used a single `limit(300)` with no `orderBy` / `startAfter`. Any trail row after the first page was invisible to legacy output discovery — both in live `matterTrailDocumentIdBatches` during `purgeLegacyOutputs` and in the prepare snapshot `legacyTrailDocumentIds` (`collectLegacyTrailDocumentIds`). `document_versions` and matter-scoped `committee_outputs` already paged correctly.

## Correction

- Page `ocr_texts`, `p1_ocr_operations`, and matter-scoped `jobs` with `orderBy(FieldPath.documentId())` + `startAfter`, mirroring `versionTrailDocumentIdBatches`.
- Share helpers for prepare snapshot and live trail batching; keep `documentIdFromJobRow` unchanged.
- Test seam `retentionTestSeam.trailDocumentIdPageSize` (non-production) so emulator tests need not seed 301 rows.

No firm-wide or `matterId == null` sweep.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Single-page trail read with target row on page 2 | Legacy output survives saga |
| GREEN | `f42-r1-followup.e2e.emu.test.ts` — `003-003` | Legacy row purged; prepare snapshot lists trail id |
| GREEN | Same file — `002`, `002-001`, `003`, `003-001`, `003-001-002`, P3, P4 | Unchanged |

## Focused verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r2 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-002'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | **PARTIAL** (backend-only; transport stub; issue #30 register not closed) |

## Residuals

| ID | Note |
| --- | --- |
| **FA-F42-R1-002-001-003-001** | Still **PARTIAL** when no matter-scoped trail names the id |
| **FA-F42-R1-002-001-003-001-003** | INFO — `document_workflow` single-page shape (separate finding) |
| **FA-F42-R1-002-001-004** | Mutant-proof coverage (elsewhere) |
