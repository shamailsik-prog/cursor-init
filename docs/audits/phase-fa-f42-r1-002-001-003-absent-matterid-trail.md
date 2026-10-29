# FA-F42-R1-002-001-003 — Legacy `committee_outputs` with absent `matterId` when document rows are gone

Repository: `shamailsik-prog/cursor-init`  
Finding: **FA-F42-R1-002-001-003** [LOW] (residual of **FA-F42-R1-002-001** / PR #209)

## Problem

PR #209 closed **002-001** at PARTIAL by paging matter `document_versions` for `documentId` values when `documents` rows were already removed before g0. `legacyOf` already treats absent and null `matterId` the same; the gap was **discovery**: when both `documents` and `document_versions` for the matter are gone, a legacy row (including one whose `matterId` field is absent rather than null) has no id batch for `array-contains-any`. A firm-wide null/absent sweep remains out of scope (**002-001-001** P3/P4).

## Correction

In `functions/src/retention/saga.ts`, `purgeLegacyOutputs` after the matter's live `documents` ids now pages matter-scoped **trail** collections that still carry `documentId`:

1. `document_versions` (unchanged from #209)
2. `ocr_texts`
3. `p1_ocr_operations`
4. `jobs` (top-level `documentId`, matter-scoped)

Each query is `firmId` + `matterId` (no loose-vault or orphan sweep). Batches feed the same `purgeLegacyOutputsForDocIdBatch` + `legacyOf` filter as before.

**FA-F42-R1-002-001-003-002 (HIGH, Monitor YES 2026-10-29):** Parallel purge groups enqueue concurrently; a non-g0 group can purge `firestore:jobs` before g0 runs `purgeLegacyOutputs`, so a live jobs trail read at document purge time can be empty. **Fix:** in `prepareSteps`, before enqueue, `collectLegacyTrailDocumentIds` snapshots matter-scoped trail ids onto `deletion_requests/{requestId}.legacyTrailDocumentIds`; g0 also purges from that snapshot after live trail paging. Jobs rows use `documentIdFromJobRow` (top-level, payload, or `documents/{id}` input ref).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Open **002-001-003**; saga at #209 head | Absent-`matterId` legacy row survives when docs + versions gone and no trail |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-002-001-003` | Absent-`matterId` legacy row purged via matter `jobs` trail |
| GREEN | Same file — `FA-F42-R1-002`, `002-001`, P3, P4 | Unchanged |

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
| **FA-F42-R1-002-001-003-001** | Legacy rows with no matter-scoped trail row naming their `documentId` before g0 remain (intentional; no firm-wide sweep). |
| **FA-F42-R1-002-001-004** | Mutant-proof tests (open elsewhere). |
