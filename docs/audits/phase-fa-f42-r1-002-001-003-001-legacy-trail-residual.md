# FA-F42-R1-002-001-003-001 — Legacy outputs with no version/ocr/job trail

Repository: `shamailsik-prog/cursor-init`  
Finding: **FA-F42-R1-002-001-003-001** [LOW] (residual of **FA-F42-R1-002-001-003** / PR #210)  
Register: issue #30 (no `Fixes #30` on the PR)

## Problem

After #210, absent-`matterId` legacy `committee_outputs` are purged when a matter-scoped trail (`document_versions`, `ocr_texts`, `p1_ocr_operations`, `jobs`, or the prepare snapshot of those ids) names their `documentId` before g0. **003-001** remained: a legacy row whose `documentId` appears on **no** such trail still survives (ME disclosed as intentional under the no firm-wide sweep rule; P3/P4 must stay KEPT).

## Root cause

Discovery was limited to document/version/OCR/job trails. Other matter-scoped stores already carry the same ids: **`document_workflow`** (`documentId` + `matterId`) and matter-scoped **`committee_outputs`** (`documentIds` on rows with `matterId`). Those rows were never fed into `purgeLegacyOutputs` / `legacyTrailDocumentIds`, so a legacy sibling could outlive deletion when only those proofs remained.

A firm-wide or `matterId == null` query remains out of scope; ids with **zero** matter-scoped proof before g0 still cannot be discovered safely.

## Correction

In `functions/src/retention/saga.ts`:

1. Page matter-scoped **`committee_outputs`** and batch each row's **`documentIds`** (same batching as `document_versions`).
2. Include **`document_workflow`** in the matter-scoped `documentId` field trail set (with `ocr_texts` / `p1_ocr_operations`).
3. Extend **`collectLegacyTrailDocumentIds`** (prepare snapshot) for both, so parallel purge groups that delete `document_workflow` before g0 cannot empty discovery.

No firm-wide sweep; `legacyOf` and P3/P4 behaviour unchanged.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Saga at #210 head; legacy absent-field row + only `document_workflow` or matter-scoped output naming `documentId` | Legacy row survives |
| GREEN | `f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-002-001-003-001` (workflow + sibling output) | Legacy row purged |
| GREEN | Same file — `003-001 PARTIAL` no-trail case | Legacy row kept |
| GREEN | Same file — `002`, `002-001`, `002-001-003`, P3, P4 | Unchanged |

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
| classification | PARTIAL |

## Residuals

| ID | Note |
| --- | --- |
| **FA-F42-R1-002-001-003-001** | **PARTIAL closed:** discovery widened; legacy rows whose `documentId` has no matter-scoped trail in documents, versions, committee outputs, workflow, OCR, or jobs before g0 still survive by design. |
| **FA-F42-R1-002-001-003-003** | Trail paging > `DOCUMENT_ID_PAGE` (open elsewhere). |
| **FA-F42-R1-002-001-004** | Mutant-proof tests (open elsewhere). |
