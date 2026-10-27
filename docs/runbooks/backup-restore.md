# Backup and restore (F33)

**Owner:** Backup and Recovery Owner (deputy: on-call engineer).

## RPO / RTO policy

| Store | RPO | RTO target (minutes) | Owner | Schedule |
| --- | --- | ---: | --- | --- |
| postgres-logical | 24h (daily dump) | 240 | Backup and Recovery Owner | daily 02:00 UTC |
| postgres-pitr | 60s + segment flush | 120 | Backup and Recovery Owner | continuous WAL archive; base backup daily |
| firestore | PITR 7d; export weekly | 180 | Backup and Recovery Owner | daily scheduled backup; weekly export |
| document-vault | real-time versioned write | 120 | Backup and Recovery Owner | continuous immutable writes |

Measured fixture RTOs from CI drills are written to `ops/backup/.results/*.json`. Production RTO uses:

`RTO ≈ fixed_overhead + data_size / measured_throughput` (re-run quarterly on production-sized backups).

## Key escrow

The backup master key (`SIKANDER_BACKUP_KEY` or `--key-file`, mode 0600) lives in the secret manager and an offline sealed copy held by the owner and deputy. Losing every copy makes all bundles unreadable.

## PostgreSQL logical restore

1. Verify bundle: `npx vite-node -c ops/backup/vitest.config.ts ops/backup/cli.ts bundle verify <dir> --key-file <key>`
2. Target cluster must not have the database or application roles from the globals dump.
3. Restore via library `restoreLogical` or CLI `pg restore` (see `ops/backup/cli.ts`).
4. Re-provision role passwords: `corpus_service/docker/postgres/provision-roles.sh` / `rotate_postgres_password.sh`.

## PostgreSQL PITR

Configure `archive_command` / `restore_command` using `ops/backup/bin/pg-wal.mjs` (see `infra/backup/postgres-backup.json`). Prepare an empty data directory with `preparePitrRestore`, start `pg_ctl`, wait for `pg_is_in_recovery()` false.

## Firestore

Production: enable PITR, scheduled backups, weekly export to a retention-locked bucket (`ops/backup/firestore/managed.ts` argv). Restore only into a **new** database id, never `(default)`.

Emulator drills: export → encrypted bundle → import into a clean emulator.

After any Firestore restore that will serve traffic, complete **Post-restore: tombstones and completed deletions (F42)**
below before routing clients to the database.

## Document vault

S3-compatible: Object Lock GOVERNANCE + versioning (`ops/backup/objects/protection.ts`). Cloudflare R2: bucket lock API (no S3 versioning). Verify with `verifyDocumentObjects`; restore with `restoreObjects` from versioned secondary copy.

## Post-restore: tombstones and completed deletions (F42, FA-F42-R1-014)

A restore can resurrect every row an approved matter deletion removed. A backup taken **before** approval may have no
`tombstone` at all, so APIs and `firestore.rules` would serve the matter again until the deletion trail is reconciled.
Nothing in the runtime re-applies tombstones on boot: both stacks only **read** `matter_tombstones/{matterId}` when
handling traffic (`platform/retention/tombstone.ts`; approval writes the row in `functions/src/retention/ops.ts`).

Complete these steps before the restored environment serves a request. The canonical procedure (with API context) is
**Restoring a backup** in `docs/runbooks/retention-deletion.md` (spec R34). Summary for the backup operator:

1. **Before the restore**, export the **deletion trail** from the **live** database (never rely on the backup copy):
   `matter_tombstones`, `deletion_requests`, `deletion_acks`, `deletion_external_requests`, `vault_object_tombstones`,
   `legal_holds`. Example:
   `gcloud firestore export gs://<bucket>/pre-restore-<date> --collection-ids=matter_tombstones,deletion_requests,deletion_acks,deletion_external_requests,vault_object_tombstones,legal_holds`
   (**[REQUIRES VERIFICATION]** against the installed `gcloud` CLI).
2. Restore Firestore into a **new** database id (above), never `(default)`.
3. **Before traffic:** import the exported trail over the restored copies. For every tombstoned matter, delete every
   `matter_members` row the restore brought back (approval had revoked them; membership-gated rules and routes read
   those rows). Tombstones then refuse the matter on every path (`403 matter_deleted` on APIs; rules per R23).
4. **Completed and in-flight deletions:** for each `deletion_requests` row in the trail with `status` `in_progress` or
   `completed`, re-run the purge so Postgres, the document vault and every inventoried Firestore store match the trail
   again. Saga jobs deduplicate by request id, so this is an **engineer-run re-purge of the request's plan** (FU-9, not
   built): follow `GET /api/platform/retention/getDeletionRequest?requestId=` and retry or manually execute the
   remaining `retention.store.purge` work documented in the retention runbook. Until step 4 finishes, step 3 keeps
   restored matter content unreadable; record the restore on the requests' audit trail.
5. **Legal holds:** a hold present in the trail must remain; do not purge held matter content in step 4.

After Postgres or vault restore, run step 4 for every affected completed/in-progress matter deletion so corpus rows and
objects do not outlive the Firestore trail.

**NOT DEMONSTRATED:** no restore drill in CI or production has executed this reconciliation end to end.

## Drills

```bash
npx vitest run -c ops/backup/vitest.config.ts ops/backup/test/*.unit.test.ts
npx vitest run -c ops/backup/vitest.config.ts ops/backup/test/*.drill.test.ts
```

Requires PostgreSQL 16 (+ pgvector for full corpus seed), Java 21 + firebase-tools for Firestore, MinIO binary at `~/.cache/sikander-minio/minio` or `SIKANDER_BACKUP_DRILL_MINIO_BIN`.

## NOT DEMONSTRATED

Live Firestore PITR, export bucket lock, R2 bucket lock, off-account vault replica, compose `archive_mode` (F30), production-sized RTO, key custody review, independent SKB1 crypto review, the re-application of matter deletions after a restore (F42).

## Appendix: SKB1 envelope

See `ops/backup/lib/envelope.mjs` and spec R3: magic `SKB1`, 48-byte header, HKDF file key, AES-256-GCM STREAM chunks, key id in header.
