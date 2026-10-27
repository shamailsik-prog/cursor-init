# FA-F42-R1-014 — Backup-restore runbook: tombstone and completed-deletion re-apply

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-014** (F42 R1 follow-up, LOW)

## Problem (RED baseline)

Before PR **#133** (`d3b87dbb`), `docs/runbooks/backup-restore.md` described Firestore/Postgres/vault restore mechanics only. It had **no** operator step to reconcile **matter tombstones** or **completed / in-flight retention deletions** after a restore, so a recovered database could resurrect deleted matters or skip deletions already applied in production.

Root cause: F33 (backup/restore) and F42 (retention/deletion) were documented separately; spec **R34** required an explicit post-restore trail export and re-apply, but acceptance for R1-014 was left open in #133 (“Residual LOW R1-014 … NOT DEMONSTRATED”).

## Correction

**Product behaviour (unchanged):** tombstones are written only on **approval** (`approveMatterDeletionOp` in `functions/src/retention/ops.ts` creates `matter_tombstones/{matterId}` and revokes `matter_members` in one transaction). Runtime paths **read** tombstones via `platform/retention/tombstone.ts` and `functions/src/p5/permission.ts`; there is **no** boot-time or restore hook that re-applies tombstones or replays completed deletions automatically.

**Documentation (R34, landed in #133; formalised here):**

| Artifact | What it adds |
| --- | --- |
| `docs/runbooks/retention-deletion.md` — **Restoring a backup (FA-F42-R1-014, spec R34)** | Five-step procedure: export deletion trail from live DB → restore to new Firestore id → import trail + strip restored `matter_members` → engineer re-purge for `in_progress` / `completed` requests (FU-9) → honour `legal_holds`. |
| `docs/runbooks/backup-restore.md` — **Post-restore: tombstones and completed deletions (F42, FA-F42-R1-014)** | Backup-operator summary with collection ids, code pointers proving no automatic re-apply, and cross-link to the retention runbook; applies after any restore that will serve traffic (including Postgres/vault follow-up via step 4). |

**Guard (this PR):** `ops/backup/test/runbook-f42-restore.unit.test.ts` fails if either runbook drops the section, deletion-trail collections, membership revocation, or completed/in-progress re-purge language.

**Rejected alternative:** A new automated “restore reconciler” Cloud Function on deploy — would weaken the explicit operator gate and duplicates FU-9 (engineer-run re-purge of a finished plan); not built.

**Residual (honest):** End-to-end restore drill executing trail export → import → membership strip → re-purge is **NOT DEMONSTRATED** (no CI drill, no production drill). FU-9 (scripted re-purge of a completed request's plan) remains not built; step 4 stays engineer-run per the retention runbook.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-014 | Backup-restore runbook lacked tombstone / completed-deletion re-apply |
| RED | `696fb80e` `docs/runbooks/backup-restore.md` (F33 only) | No F42 post-restore section |
| GREEN | Spec R34 (`docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md`) | Runbook restore step: export trail, re-apply tombstones, re-run approved requests |
| GREEN | `docs/runbooks/retention-deletion.md` — Restoring a backup | Five concrete steps, NOT DEMONSTRATED drill called out |
| GREEN | `docs/runbooks/backup-restore.md` — Post-restore section | Operator summary + no auto re-apply on boot |
| GREEN | `platform/retention/tombstone.ts` | Documents read-only tombstone checks (no restore hook) |
| GREEN | `functions/src/retention/ops.ts` — `approveMatterDeletionOp` | Tombstone + membership revocation at approval |
| GREEN | `ops/backup/test/runbook-f42-restore.unit.test.ts` — `FA-F42-R1-014` | Both runbooks satisfy deletion-trail contract |

### Mutant that must stay killed

If the backup runbook drops **Post-restore** or any deletion-trail collection name, or if the retention runbook drops **Restoring a backup**, the unit test `FA-F42-R1-014` fails.

## Focused verification

```bash
npx vitest run -c ops/backup/vitest.config.ts ops/backup/test/runbook-f42-restore.unit.test.ts
```

Existing backup config/runbook table check (F33):

```bash
npx vitest run -c ops/backup/vitest.config.ts ops/backup/test/config.unit.test.ts
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true (runbook guard test only; no production behaviour change) |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (executable operator procedure documented and guarded; end-to-end restore reconciliation drill and FU-9 re-purge tooling NOT DEMONSTRATED / not built) |

No COMPLETE claim until a drilled restore proves trail export → tombstone/membership reconcile → completed-deletion re-purge on a restored copy.
