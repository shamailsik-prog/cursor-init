# FA-F42-R1-002-001-003-001-002 — Other-matter OCR / workflow trail must not discover legacy ids

Repository: `shamailsik-prog/cursor-init`  
Finding: **FA-F42-R1-002-001-003-001-002** [LOW]  
Register: issue #30 (no `Fixes #30` on the PR)

## Problem

After PR #211, `purgeLegacyOutputs` and `collectLegacyTrailDocumentIds` read `ocr_texts`, `p1_ocr_operations`, and `document_workflow` with `firmId` + `matterId` (live trail paging and prepare snapshot). The FA-F42-R1-002 emulator suite already keeps legacy `committee_outputs` when only another matter's document or row names the id (ME probes Q5/R4 pattern for committee outputs and `document_versions`). It had no parallel **KEEP** cases for the three field-trail collections. Mutant **M4b** (drop `matterId` from those reads) survives the PR #211 suite; independent probes catch it.

## Correction

Test-only: extend `functions/test/f42-r1-followup.e2e.emu.test.ts` with three cases under **FA-F42-R1-002-001-003-001-002** — absent-`matterId` legacy output, no matter-scoped trail on the deleting matter, other-matter row in each of `ocr_texts`, `p1_ocr_operations`, and `document_workflow` naming the same `documentId`. Expect **KEEP** after saga completion.

No production change; no firm-wide or `matterId == null` sweep.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | M4b on `noteMatterTrailDocumentIdFieldRows` / snapshot | Other-matter trail id enters legacy purge batch |
| GREEN | `f42-r1-followup.e2e.emu.test.ts` — `003-001-002` ×3 | Legacy row kept |
| GREEN | Same file — `002`, `002-001`, `003-001` (incl. workflow purge + PARTIAL no-trail), P3, P4 | Unchanged |

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
| classification | **COMPLETE** (this finding slice: regression tests only) |

## Residuals

| ID | Note |
| --- | --- |
| **FA-F42-R1-002-001-003-001** | Still **PARTIAL** by design when no matter-scoped trail names the id |
| **FA-F42-R1-002-001-003-003** | Trail paging > `DOCUMENT_ID_PAGE` (elsewhere) |
| **FA-F42-R1-002-001-004** | Broader mutant-proof coverage (elsewhere) |
