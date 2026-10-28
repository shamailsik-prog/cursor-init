# FA-F42-R1-014-001-001 — Step-scoped deletion-trail export and legal-hold pins

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-014-001-001** [LOW] (carry-forward from ME REAUDIT_PR181_FA_F42_R1_014_001, PASS 9.8 on PR #181)

## Problem (RED baseline)

After PR #181, `describe("FA-F42-R1-014-001")` killed order / before-traffic / section-scoped **NOT DEMONSTRATED** mutants (**M3**), but ME residuals survived:

| Id | Mutant | Why it survived |
| --- | --- | --- |
| **M1** | Drop one or more `DELETION_TRAIL_COLLECTIONS` from step-1’s export enumeration while leaving the name in the trailing `gcloud` example | Whole-runbook `toContain` and step-order pins never scoped assertions to step 1’s export list |
| **L5** | Replace step 5 with a placeholder such as `none.` | No step-5 slice or `legal_holds` / hold-rule assertion |

## Correction

- **Test-only pin** in `ops/backup/test/runbook-f42-restore.unit.test.ts` (within `FA-F42-R1-014-001`, preserving #181 order pins):
  - `step1ExportListText(step1)` — text before `(for example` / `Example:` so the gcloud line cannot satisfy the export list alone.
  - `for (col of DELETION_TRAIL_COLLECTIONS) expect(step1ExportList).toContain(col)` on backup and retention **Restoring a backup** sections.
  - Step 5: `legal_holds`, hold language, and purge/honour rule (not a `none.` stub).
- **Runbook text:** unchanged on tip; both runbooks already enumerate all six collections in step 1 and state the legal-hold rule in step 5.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | ME REAUDIT_PR181 FA-F42-R1-014-001 | M1, L5 survived after #181 guard |
| GREEN | `runbook-f42-restore.unit.test.ts` — step-1 export list + step-5 hold pins | Mutants below fail |
| GREEN | `docs/runbooks/backup-restore.md` — Post-restore steps 1 and 5 | Six trail collections in step-1 list; step-5 hold rule |
| GREEN | `docs/runbooks/retention-deletion.md` — Restoring a backup steps 1 and 5 | Same contract |

### Mutants that must stay killed

| Id | If the mutant survives |
| --- | --- |
| **M1** | `legal_holds` (or any trail collection) only in the gcloud example, not in the step-1 export enumeration before the example |
| **L5** | Step 5 replaced with `none.` or hold rule removed; step-5 `legal_holds` / hold / purge assertions fail |

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
| classification | PARTIAL (guard only; restore reconciliation drill NOT DEMONSTRATED) |
