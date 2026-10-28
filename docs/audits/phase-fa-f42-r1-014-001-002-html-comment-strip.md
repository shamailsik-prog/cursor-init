# FA-F42-R1-014-001-002 — Strip HTML comments before restore runbook step pins

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-014-001-002** [LOW] (ME REAUDIT_PR181 residual **M3c**)

## Problem (RED baseline)

`ops/backup/test/runbook-f42-restore.unit.test.ts` sliced numbered steps and applied `toMatch` / `indexOf` on raw markdown. Mutant **M3c** moved the step-3 **Before traffic:** / `matter_members` gate into an HTML comment while step 4 kept FU-9 re-purge language. The **FA-F42-R1-014-001** pins still passed because tokens inside `<!-- ... -->` satisfied regex and ordering checks.

## Correction

- **Test guard:** `stripHtmlComments()` removes `<!-- ... -->` (including multiline) from each F42 restore section body before `numberedStepOffsets`, step slices, and before-traffic / NOT DEMONSTRATED index pins on:
  - `docs/runbooks/backup-restore.md` — Post-restore section
  - `docs/runbooks/retention-deletion.md` — Restoring a backup section
- **Runbook prose:** unchanged; existing #181/#182 pins (step order, before-traffic, NOT DEMONSTRATED, DELETION_TRAIL_COLLECTIONS step-1 export list, step-5 legal_holds/hold/purge) remain on stripped text.
- **Synthetic M3c pin:** `describe("FA-F42-R1-014-001-002")` asserts comment-hidden gates do not satisfy step-body matching after strip.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | ME REAUDIT_PR181 residual M3c | Before-traffic pins pass with gate only in HTML comment |
| GREEN | `stripHtmlComments` on both restore sections | Step 3 visible text must carry before-traffic gate |
| GREEN | M3c self-check on `backup-restore.md` step 3 | `runbook-f42-restore.unit.test.ts` fails; reverted |

### Mutants that must stay killed

| Id | If the mutant survives |
| --- | --- |
| **M3c** | Step 3 prose routes traffic while **Before traffic:** / `matter_members` live only in a comment; step-3 `toMatch` or stripped `indexOf("**Before traffic:**")` vs `in_progress` fails |

## Focused verification

```bash
npx vitest run -c ops/backup/vitest.config.ts ops/backup/test/runbook-f42-restore.unit.test.ts
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true (runbook guard test only) |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (guard only; end-to-end restore reconciliation drill NOT DEMONSTRATED) |

No COMPLETE claim without a drilled restore proving trail export → tombstone/membership reconcile → completed-deletion re-purge on a restored copy.
