# FA-F42-R1-002-001 — Legacy `committee_outputs` when documents were gone before the saga

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-002-001** [LOW] (residual of **FA-F42-R1-002** / PR #156)

## Problem (RED baseline)

Parent **FA-F42-R1-002** purged legacy `committee_outputs` (null/absent `matterId`) by paging the matter's **`documents`** ids and querying `documentIds` `array-contains-any`. If every document row of the matter was already deleted before g0 ran, that list was empty: legacy rows survived the saga while reads were already refused (Next GET and `legacyOutputLive` rules).

## Correction

In `functions/src/retention/saga.ts`, `purgeLegacyOutputs` now:

1. Keeps the existing **`documents`** id paging and batched `array-contains-any` purge.
2. **FA-F42-R1-002-001:** Pages the matter's **`document_versions`** rows, batches distinct `documentId` values (≤30), and runs the same legacy purge (covers document rows removed early while versions still name the matter).

**FA-F42-R1-002-001-001 (ME fix-forward):** Removed the interim firm-wide sweep of null-`matterId` rows. Matter deletion must not delete or attribute firm orphans that are only unreadable/unclaimed; purge stays limited to ids proven on the matter via `documents` or `document_versions`.

Firm-wide orphan cleanup, if needed, belongs in a separate firm-level job with its own acknowledgement (out of scope here).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-002-001; saga before this change | Legacy output with pre-deleted `documents` rows survives g0 |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-002-001` (document_versions) | Matter-tied legacy row purged; other-matter legacy row kept |
| GREEN | Same file — `FA-F42-R1-002-001-001` P3 / P4 | Unrelated orphan and >3 loose-vault legacy row not purged on matter deletion |
| GREEN | Existing `FA-F42-R1-002` emulator and rules/Next pins | Unchanged behaviour for live-document legacy paths |

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
| classification | PARTIAL (legacy purge via matter `documents` + `document_versions` ids only; read refusal unchanged; fully-gone ids with no version trail remain a separate firm-level concern) |

## Residuals

| ID | Note |
| --- | --- |
| **FA-F42-R1-002-001-003** | LOW — absent-field `matterId` with pre-gone docs/versions (closed at PARTIAL via matter trails) |
| **FA-F42-R1-002-001-004** | LOW — mutant-proof tests (open) |
| **FA-F42-R1-002-001-005** | INFO (open) |
| — | Legacy rows whose documents and `document_versions` for the matter are both gone before g0 are not purged by this slice; intentional after **001-001** |
