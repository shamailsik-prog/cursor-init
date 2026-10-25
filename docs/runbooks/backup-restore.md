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

**Matter deletions survive a restore (audit F42, FA-F42-R1-014).** A restore brings back rows that an approved
deletion removed, and a backup taken before an approval has no tombstone for the matter at all. Before any restore that
will be put into service, follow "Restoring a backup" in `docs/runbooks/retention-deletion.md`: export the deletion
trail first, restore, re-apply every tombstone and revoke the restored memberships before the database serves a request,
then re-run the deletions. Not drilled (NOT DEMONSTRATED).

## Document vault

S3-compatible: Object Lock GOVERNANCE + versioning (`ops/backup/objects/protection.ts`). Cloudflare R2: bucket lock API (no S3 versioning). Verify with `verifyDocumentObjects`; restore with `restoreObjects` from versioned secondary copy.

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
