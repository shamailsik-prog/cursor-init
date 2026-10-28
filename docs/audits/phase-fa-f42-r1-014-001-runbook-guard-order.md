# FA-F42-R1-014-001 — Restore runbook guard: step order and before-traffic binding

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-014-001** [LOW] (child of FA-F42-R1-014 / ME REAUDIT_PR171_FA_F42_R1_014)

## Problem (RED baseline)

`ops/backup/test/runbook-f42-restore.unit.test.ts` guarded the F42 post-restore runbook with `toContain` / heading checks only. ME mutants **M1** (reorder restore vs trail export / serve-before-reconcile) and **M3** (drop the post-restore **NOT DEMONSTRATED** drill marker while keeping unrelated NOT DEMONSTRATED appendix text) **survived** because the guard did not bind:

1. numbered step order (export → restore → before-traffic reconcile → re-purge → legal holds),
2. the **before traffic** gate relative to completed/in-progress re-purge language, or
3. **NOT DEMONSTRATED** inside the F42 restore sections.

## Correction

- **Test-only pin:** `describe("FA-F42-R1-014-001")` extracts the post-restore / Restoring-a-backup sections, asserts ascending `1.`–`5.` markers, checks step 3 before-traffic language precedes re-purge tokens, and requires section-scoped **NOT DEMONSTRATED** (backup runbook uses the bold lead-in).
- **Runbook text:** unchanged on tip (already honest); pins match existing `docs/runbooks/backup-restore.md` and `docs/runbooks/retention-deletion.md`.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | ME REAUDIT_PR171 FA-F42-R1-014 PASS 9.8 | M1/M3 survived `runbook-f42-restore.unit.test.ts` |
| RED | Prior guard | `toContain` on collections/keywords only |
| GREEN | `ops/backup/test/runbook-f42-restore.unit.test.ts` — `FA-F42-R1-014-001` | Step order, before-traffic index, section NOT DEMONSTRATED |
| GREEN | `docs/runbooks/backup-restore.md` — Firestore + Post-restore | Route clients only after post-restore; five ordered steps |
| GREEN | `docs/runbooks/retention-deletion.md` — Restoring a backup | Five ordered steps; serve gate before re-purge |

### Mutants that must stay killed

| Id | If the mutant survives |
| --- | --- |
| **M1** | Steps reordered (e.g. restore or traffic before live trail export / before-traffic import); ascending `1.`–`5.` or before-traffic vs `in_progress` index assertion fails |
| **M3** | Post-restore **NOT DEMONSTRATED** removed but appendix NOT DEMONSTRATED kept; section-scoped `**NOT DEMONSTRATED:**` / Restoring-a-backup NOT DEMONSTRATED assertion fails |

## Focused verification

```bash
npx vitest run -c ops/backup/vitest.config.ts ops/backup/test/runbook-f42-restore.unit.test.ts -t 'FA-F42-R1-014-001'
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true (runbook guard test only) |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (guard pins operator procedure order; end-to-end restore reconciliation drill NOT DEMONSTRATED) |

No COMPLETE claim without a drilled restore proving trail export → tombstone/membership reconcile → completed-deletion re-purge on a restored copy.
