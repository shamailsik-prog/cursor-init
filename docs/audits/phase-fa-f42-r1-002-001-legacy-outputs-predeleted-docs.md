# FA-F42-R1-002-001 — Legacy `committee_outputs` when documents were gone before the saga

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-002-001** [LOW] (residual of **FA-F42-R1-002** / PR #156)

## Problem (RED baseline)

Parent **FA-F42-R1-002** purged legacy `committee_outputs` (null/absent `matterId`) by paging the matter's **`documents`** ids and querying `documentIds` `array-contains-any`. If every document row of the matter was already deleted before g0 ran, that list was empty: legacy rows survived the saga while reads were already refused (Next GET and `legacyOutputLive` rules).

## Correction

In `functions/src/retention/saga.ts`, `purgeLegacyOutputs` now:

1. Keeps the existing **`documents`** id paging and batched `array-contains-any` purge.
2. **FA-F42-R1-002-001:** Pages the matter's **`document_versions`** rows, batches distinct `documentId` values (≤30), and runs the same legacy purge (covers document rows removed early while versions still name the matter).
3. **Firm sweep:** Pages firm `committee_outputs` with `matterId == null`, and purges legacy rows whose linked documents are not live and are not claimed by another matter's live `documents` or `document_versions` row (closes the fully-gone id case without touching firm-level rows with empty `documentIds`).

Composite index added: `committee_outputs` — `firmId` + `matterId` (sweep query).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-002-001; saga before this change | Legacy output with pre-deleted `documents` rows survives g0; `committee_outputs` ack may still complete |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-002-001` (2 cases) | Legacy row purged via versions and via firm sweep; other-matter legacy row kept |
| GREEN | Existing `FA-F42-R1-002` emulator and rules/Next pins | Unchanged behaviour for live-document legacy paths |

## Focused verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r2 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-002'"

npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r2 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-002-001'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | COMPLETE (saga purge path for this residual; read refusal unchanged from parent finding) |

## Residuals

| ID | Note |
| --- | --- |
| — | None identified for this slice. Firm sweep may remove firm-wide orphaned legacy rows with no live document/version anywhere when any matter deletion runs; acceptable garbage collection per re-audit LOW residual. |
