# F33: encrypted backups, restore into a clean target, and verified drills

Date: 2026-10-18 (first draft), rewritten 2026-10-22. Base: `origin/main` (merged at 437b1da). Branch: `claude/remediate-f33`.
Status: approved by the remediation builder under the owner's standing autonomy instruction. The brainstorming is self-approved; every decision is a numbered ruling below with its reason, and the adversarial review (steelman, devil's advocate, bias check) sits beside the ruling it changed.

## 0. Audit sources and what this PR can prove

- `docs/audit/2026-10-13-forensic-audit.md`, F33 (HIGH): "Backup and restoration capability is unproven". No backup or restore implementation, restore drill, RPO/RTO evidence or recovery ownership for Firestore, Postgres and document objects; "a mounted volume is not a backup". Correction asked for: encrypted point-in-time backups and immutable object versions; restore into a clean isolated environment and verify content digests, record counts and relationships; publish measured RPO/RTO and drill ownership. Acceptance shape (line 1106): "Measured RPO/RTO, no dangling accepted document, credentials and isolation validated".
- `docs/audit/2026-10-14-forensic-audit-v2.md:106`: "F33 | HIGH | OPEN | no backup/restore drill; documentObjectStore.ts:215-236 file-copy helpers only".
- `docs/audit/REMEDIATION.md`: closed means a merged PR with an end-to-end test that fails before and passes after, ticked only after an independent re-audit. This document claims neither.

What is proven here, because it runs for real in this repository and in CI: a PostgreSQL 16 + pgvector cluster (logical backup and point-in-time recovery), the Firestore emulator (`firebase emulators:export` and import), and an S3-compatible server with versioning and Object Lock (MinIO, the F03 test double). What is not: there is no cloud project, Cloudflare account or production host in reach. Every live setting (Firestore PITR, scheduled backups and exports, the export bucket's retention lock, the R2 bucket lock, key escrow, the schedule on a real host, a restore of production data) is code plus runbook, and its live state is **NOT DEMONSTRATED**. This is an evidence blocker being worked, not proof that the external organisation has or lacks backups.

## 1. Root cause (main)

- **Postgres** (`corpus_service/docker-compose.yml:78`, volume `pgdata`): one named volume. No `pg_dump`, `pg_basebackup`, `archive_command` or restore script exists in the tree outside docs and tests (`corpus_service/scripts/rotate_postgres_password.sh` is the only operations script). Losing the volume loses the corpus, the F23 decision ledger (`quarantine_decisions`), the F19 publication audit (`corpus_publication*`), the F27 receipts and the F21 lifecycle history.
- **Firestore** (`firebase.json:1`): no export, no PITR flag, no backup schedule, no restore procedure.
- **Document objects** (F03, `platform/documents/documentObjectS3.ts`): writes are create-only (`IfNoneMatch: "*"`), but nothing sets bucket versioning or Object Lock, and no R2 bucket lock. A delete with the vault credentials is permanent. `backupDocumentObjectFile` / `restoreDocumentObjectFile` copy one object to a local file and back; nothing calls them outside tests.
- **Nothing verifies a restore.** No artefact records counts, digests or relationships to compare against, and no drill has run.

## 2. Rulings

### R1. Lane and layout
- Tooling, drills and their tests: `ops/backup/**`. Chosen over `scripts/backup/**`: `scripts/` holds one-off helpers run by hand; this is an operations package with its own tests, configuration and CLI. It is deliberately not under `app/ops/`, which the claim gate treats as the operator console.
- Cloud settings as code and policy data: `infra/backup/**`.
- CI: one new workflow with one job, `.github/workflows/backup-drill.yml`. A separate workflow because the drill needs a weekly `schedule:` of its own; adding one to `gate-g0.yml` would rerun every G-0 job weekly.
- Runbook: `docs/runbooks/backup-restore.md`.
- Not touched: `corpus_service/**` (R19), `functions/src/**`, `platform/**`, `tests/**`, `.gitleaks.toml`, `package.json`, `package-lock.json` (no new dependency: the tooling uses `zod`, `firebase-admin`, `@aws-sdk/client-s3`, `@firebase/rules-unit-testing` and `vitest`, all already declared).

### R2. One language: TypeScript, plus one dependency-free `.mjs`; Postgres through the client programs
- All tooling is TypeScript run by vitest (tests, drills) and `vite-node` (the CLI: `npx vite-node -c ops/backup/vitest.config.ts ops/backup/cli.ts ...`). The object verifier must use the product's own read path (`getImmutableDocumentObject`, which decrypts and checks the F03 content hash, resolved through the `@/` alias), the Firestore side uses the Admin SDK, root `tsc` and `eslint` already cover `**/*.ts`.
- The encryption envelope is `ops/backup/lib/envelope.mjs` with an `.d.mts` declaration (the `ci_gates/check_known_advisories.mjs` pattern), so the WAL `archive_command` and `restore_command` (`ops/backup/bin/pg-wal.mjs`) run under plain `node` with no loader and no package import, once per WAL segment.
- Postgres is driven only through `psql`, `pg_dump`, `pg_restore`, `pg_dumpall`, `pg_basebackup`, `pg_verifybackup` and `pg_ctl` as subprocesses, with connection settings from the standard libpq environment (`PGHOST`, `PGPORT`, `PGUSER`, `PGSSLMODE`, `PGPASSFILE`), never argv. *Reason:* the production deployment publishes no port (F30), so the same tool must run through a prefix such as `docker compose exec -T postgres` (R19); a client library bound to a TCP port cannot. *Change from the draft:* the draft left this open; the `pg` package is not used.

### R3. Encryption envelope `SKB1`
- AES-256-GCM in 64 KiB chunks (the STREAM construction used by age and Tink). Header, 48 bytes: magic `SKB1`, version `1`, chunk-size exponent `16`, two reserved zero bytes, an 8-byte key id, a 32-byte random salt.
- Per-file key: HKDF-SHA256(master key, salt, info `sikander-backup/file-key/v1`). A fresh salt per file makes nonce reuse across files impossible.
- Chunk *i*: nonce = u64be(*i*) ‖ u32be(final ? 1 : 0); AAD = the 48-byte header; output = ciphertext ‖ 16-byte tag. The last chunk carries the final flag; an empty input is one empty final chunk.
- Key id = first 8 bytes of HMAC-SHA256(master key, `sikander-backup/key-id/v1`): it names a key without revealing it.
- Refused on decrypt, each with its own error code: wrong magic (`BAD_MAGIC`); wrong version or chunk size or non-zero reserved bytes (`BAD_HEADER`); a key id not in the key ring (`UNKNOWN_KEY`: a backup made with another key); any tag failure, which covers a flipped byte and swapped or reordered chunks (`AUTH_FAILED`); a stream that ends without a final chunk (`TRUNCATED`); bytes after the final chunk (`TRAILING_DATA`).
- *Steelman against R3.* "Use `gpg --symmetric` or `age`, not a hand-rolled format." *Answer.* Both are sound tools, but neither is guaranteed on the restore host or in the CI image, and gpg's behaviour on a flipped byte differs between 2.x releases. This format is about 200 lines over `node:crypto` primitives (GCM, HKDF, HMAC), invents no cipher construction, and each refusal is a test. The format is documented in the runbook (appendix), so an operator can decrypt without this repository. *Devil's advocate.* "Home-made crypto is the first thing an auditor flags." *Answer.* It is stated as such; the construction is the published STREAM one, the primitives are the platform's, and the residual is listed (R18). A review by a cryptographer is a follow-up, not a claim.
- *Bias check.* The draft assumed AES-GCM's 96-bit nonce is safe here. It is: the nonce is a counter within a file and the key is per file, so no (key, nonce) pair repeats; the 2^32 chunk-per-key bound is 256 TiB per file.

### R4. Keys
- The master key comes from configuration: `SIKANDER_BACKUP_KEY` (64 hex characters) or `--key-file` (a file holding them, mode 0600 or refused on POSIX). Never committed; tests generate one per run with `randomBytes(32)`; the CI job generates one with `openssl rand -hex 32` and masks it.
- A key that is one byte repeated (all-zero, all-`ff`, ...) is refused, as F03 refuses one for the document key. A key shorter or longer than 32 bytes is refused.
- Rotation: `SIKANDER_BACKUP_PREVIOUS_KEYS` (comma-separated, each 64 hex) joins the decrypt-only key ring; a file names the key it needs by key id. Encryption always uses the current key.
- The backup key is separate from `SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY` and the corpus `ENCRYPTION_KEY`: losing an application secret must not open the backups, and a backup must stay readable after an application key rotates.
- Escrow (runbook): the key lives in the secret manager and in an offline sealed copy held by the Backup and Recovery Owner and the deputy. Losing every copy makes every backup unreadable; the runbook says so plainly. *Devil's advocate:* "one key for every store is one point of failure and one point of compromise". *Answer:* a key per store is a configuration choice (the tool takes the key per invocation); the default is one key because three escrow procedures that drift are the likelier failure. Recorded as a decision, not hidden.

### R5. Bundles
A backup is a directory `<store>-<UTC timestamp>-<8 hex>/` holding `bundle.json` (plaintext: format, store, creation time, tool version, key id, and each file's name, size and ciphertext SHA-256) and one `.skb` file per artefact, among them `manifest.json.skb`: the store's manifest (R8, R10) and each artefact's plaintext size and SHA-256.

`verifyBundle` (no restore): lists the directory (a missing or unlisted file is a problem), checks every ciphertext hash, authenticates every chunk of every file with the key ring, then checks every plaintext hash against the manifest. One flipped byte anywhere is refused before anything is restored. The plaintext hashes in the encrypted manifest also refuse a file swapped in from another bundle made with the same key, even though its envelope authenticates.

Not covered by design: a whole older bundle replacing a newer one (rollback). The object-lock retention on the backup bucket (R12, R13) is the control; the bundle's creation time is shown by every restore so the operator sees it.

Writes are atomic: temporary name, `fsync`, rename; a bundle directory is complete only when `bundle.json` exists (written last). The tool never deletes a bundle; retention is the bucket's lifecycle rule.

### R6. Postgres logical backup (portable, verifiable in a clean cluster)
- A bundle `postgres-logical-*` holds `globals.sql.skb` (`pg_dumpall --globals-only --no-role-passwords`), `database.dump.skb` (`pg_dump --format=custom`, streamed through the envelope with no plaintext file) and `manifest.json.skb`.
- *Snapshot consistency (change from the draft).* The manifest and the dump must describe one state, or every restore of a live database would report false differences. The tool opens one `psql` session, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, exports its snapshot (`pg_export_snapshot()`), computes the manifest in that session, runs `pg_dump --snapshot=<id>`, and rolls back. (Probed in this environment: a row inserted after the export is absent from the dump.) The roles come from `pg_dumpall`, which cannot take a snapshot; roles change rarely and the restore compares them against the manifest read in the snapshot, so a role change mid-backup is reported, not silently lost.
- Role passwords are left out on purpose: they are re-provisioned from the secret store after a restore with the existing `docker/postgres/provision-roles.sh` / `rotate_postgres_password.sh`, so a backup never carries SCRAM verifiers. A restored login role cannot authenticate until that step; the runbook lists it.
- `pg_dumpall` 16.13 prefixes its output with `\restrict <token>` and ends with `\unrestrict <token>` psql meta-commands (probed); the globals are applied through `psql` (which understands them), after removing the statements that create or alter the bootstrap superuser (it exists on any cluster).
- **RPO of the logical path:** the dump interval (daily by policy). Retention 35 days.

### R7. Postgres point-in-time recovery
- Source cluster settings (code in `infra/backup/postgres-backup.json`, runbook): `wal_level = replica`, `archive_mode = on`, `archive_command = 'node <repo>/ops/backup/bin/pg-wal.mjs archive %p %f --archive-dir <dir> --key-file <file>'`, `archive_timeout = 60`.
- `pg-wal.mjs archive` encrypts one segment (or `.history` / `.backup` / `.partial` file) to `<name>.skb` atomically, succeeds again for a name already archived with the same plaintext (idempotent retry), and exits non-zero without writing when the name exists with different content.
- `pg-wal.mjs restore <name> <dest>` decrypts one segment atomically. A missing segment exits 1, which PostgreSQL reads as the end of the archive. An unreadable one (wrong key, flipped byte, truncated) exits **127**: PostgreSQL treats exit status 126 or 127 from `restore_command` as a fatal error (`wait_result_is_any_signal(rc, true)` in `RestoreArchivedFile`), so recovery aborts instead of promoting at an earlier point than the operator asked for. A drill proves this (flipped byte in a needed segment: the cluster never opens).
- Base backup: `pg_basebackup -D - --format=tar --wal-method=fetch --checkpoint=fast --manifest-checksums=SHA256`, gzip level 1, then the envelope: `base.tar.gz.skb`. (Probed: the tar stream carries `backup_manifest`; `pg_verifybackup` passes on the extracted directory. PostgreSQL 16's `pg_verifybackup` cannot read tar format, so the restore extracts first.)
- Restore: `preparePitrRestore` refuses a non-empty data directory, verifies the bundle, extracts, runs `pg_verifybackup`, writes `recovery.signal` and the recovery settings (`restore_command`, `recovery_target_name` / `recovery_target_time` / `recovery_target = immediate`, `recovery_target_action = promote`, and `archive_mode = off` so a restored cluster never archives into the production archive). The operator (or the drill) starts the server; `waitForPromotion` polls `pg_is_in_recovery()`.
- **RPO of the PITR path:** at most `archive_timeout` (60 s) plus the time to write one segment. Base backups daily, kept 14 days with their WAL.
- *Devil's advocate:* "two backup kinds doubles the surface". *Answer:* they fail differently. The logical dump is portable (a different minor version, another platform) and is the only kind the compose deployment can run until F30's policy admits `archive_mode` (R19); PITR is the only kind that meets an RPO of a minute. Both are drilled.

### R8. What a Postgres restore must reproduce (the manifest)
Taken at backup time inside the exported snapshot, stored in the encrypted manifest, recomputed on the restored target and compared field by field. The session pins `TimeZone=UTC`, `DateStyle=ISO, YMD`, `IntervalStyle=iso_8601`, `extra_float_digits=3`, `bytea_output=hex` so `to_jsonb(row)` is stable.

- **Per table** (every ordinary or partitioned table outside the system schemas): row count and an **order-independent digest**: for each row, `h = SHA-256(primary-key text ‖ 0x1E ‖ to_jsonb(row)::text)` (no primary key: the row text alone, duplicates counted); the digest is the SHA-256 of `count : S0 : S1 : S2 : S3`, where `Sk` is the exact sum, over all rows, of the *k*-th signed 64-bit word of `h`. *Change from the draft* (a sorted `string_agg` of all hashes): the sum is constant-memory, so the digest scales to a corpus that does not fit in `work_mem`. It is an accidental-corruption and loss detector, not a defence against an attacker who can craft rows, which the authenticated manifest does not need.
- **Sequences**: each sequence's `last_value` (identity columns such as `corpus_publication.seq` must not restart).
- **Foreign keys**: each constraint's `convalidated` flag and its violating-row count.
- **Logical links**: the orphan counts of R9.
- **Extensions**: names and versions.
- **Definitions**: a sorted list of facts, one line each, for every non-system relation's columns (name, type, nullability, default), constraint (`pg_get_constraintdef`), index (`pg_get_indexdef`), trigger (`pg_get_triggerdef`, with `tgenabled`), function and procedure (`md5(pg_get_functiondef)`, owner, `prosecdef`, `proconfig`) and view (`md5(pg_get_viewdef)`), and whether row-level security is on. It catches a restore that silently dropped a trigger (the monotonic-classification and append-only triggers are the F23 / FA-DATA-001 safeguards) or a function.
- **Roles and grants ("Annex A roles and grants")**: a sorted list of facts: every role except `pg_*` and the bootstrap superuser (attributes, connection limit, validity, per-database and per-role settings); every membership with grantor and the `ADMIN` / `INHERIT` / `SET` options; the owner and exploded ACL of the database and of every non-system schema, relation, column, sequence and function; the default privileges. Grantees of `PUBLIC` are written `PUBLIC`.
- **Meta**: server version, database name, encoding, collation, system identifier, backup time, snapshot id. Reported, not compared (a restored cluster has another system identifier).

Comparison: equal counts, digests, sequences, FK results, links, extensions, definitions, roles and grants. Any difference fails the restore and the report names it (`table public.judgment: digest differs`, `role corpus_writer: missing`, `link receipt_queue: 0 -> 1`). Sets (definitions, roles) are reported as `missing` and `unexpected` entries.

### R9. Postgres logical links (orphan checks)
No foreign key holds these links, so the manifest counts them; each count must be reproduced exactly. A link whose table is absent is recorded as `absent` and must stay absent. The seeded drill dataset has every count at zero, so a restore that loses a referenced row is caught by the digests and by a link count moving off zero. Definitions are SQL strings in `ops/backup/postgres/links.ts` (one place; a unit test checks each against the DDL in the repository).

| Link | Rule | Relied on by |
| --- | --- | --- |
| `staging_published_case` | `scraper_staging` in lifecycle state `published`/`embedded` has `published_id` in `case_law_master` | F21 |
| `staging_published_statute` | the same for `statutes_staging` and `statutes_master` | F21 |
| `staging_promoted_case`, `staging_promoted_statute` | `promoted = true` rows have `promoted_to_id` in their master table | F21 (legacy flags) |
| `lifecycle_transition_record` | `corpus_lifecycle_transitions.record_id` exists in `record_table` (history may outlive a record: expected 0 in the seed, compared exactly) | F21 |
| `decision_published_row` | a promoted `quarantine_decisions` row's `published_id` exists in `published_table` | F23 |
| `decision_outbox_row` | a promoted decision's `embedding_outbox_id` exists in `embedding_queue` | F23 |
| `outbox_record` | `embedding_queue.record_id` exists in `table_name` | F23, F27 (outbox → records) |
| `receipt_queue` | `embedding_attempts.queue_id` exists in `embedding_queue` | F27 (receipts → queue) |
| `publication_item_entity` | non-rejected `corpus_publication_item.entity_id` exists in its `entity_type` table | F19 |

(The exact column names are fixed against the DDL in task 4 of the plan; the table above is the contract.)

### R10. Firestore manifest and canonical encoding
- Read through the Admin SDK (the emulator in the drill, a restored database id in production) by walking collections and subcollections (`listDocuments()` so a document that exists only as a parent of a subcollection is visited).
- Per collection **path pattern** (document ids replaced by `*`, e.g. `firms/*/members`): document count and an order-independent digest, computed as for Postgres (R8) over `SHA-256(document path ‖ 0x1E ‖ canonical encoding of its data)`.
- Canonical encoding is typed and self-delimiting: null, boolean, integer (a JS integer-valued number; Firestore does not distinguish, so the encoding writes integers and doubles under one number rule, `-0` written as `-0`, `NaN` and the infinities named), string, `Timestamp` (seconds and nanoseconds), `GeoPoint`, `DocumentReference` (path), `Bytes`, `VectorValue`, arrays (ordered), maps (keys sorted).
- Per-firm fingerprints: for every collection pattern and every `firmId` value found on its documents, the same count and digest (documents with no `firmId` are grouped under `(none)`), so a document that moved between firms moves two fingerprints.
- Relationship checks: R11.
- *Bias check.* The draft assumed collections are nested. They are not: every product collection is top-level and carries `firmId` (`firestore.rules`, G-0 check 10), with composite ids (`{matterId}_{userId}`, `{firmId}_registry`, `{firmId}_{n}`). The walker still handles nesting, but the isolation story rests on the `firmId` field and on the rules, not on paths.

### R11. Firestore relationship checks and firm isolation
Pure functions over an in-memory index of the facts (`ops/backup/firestore/relationships.ts`); each returns a count and up to 20 sample paths.
- `firm_exists`: every document that carries a `firmId` names an existing `firms/{id}` (a document with a missing or empty `firmId` in a firm-scoped collection is its own violation, `firm_missing`).
- `matter_client`: `matters.clientId` names a `clients` document of the same firm.
- `party_matter`: `matter_parties.matterId` names a matter of the same firm.
- `member_matter`: `matter_members.matterId` names a matter of the same firm and `userId` a `users` document of the same firm.
- `document_matter`: a `documents` row with a `matterId` names a matter of the same firm.
- `audit_target`: an `audit_log` row whose `target` is a document path (`collection/id`) names an existing document of the same firm (`firms/{id}` counts as firm `id`); a target that is not a path is counted apart (`audit_target_opaque`).
- `outbox`: an `audit_outbox` entry's firm exists, each effect path that is a document path belongs to that firm, each staged row carries that firm.
- `name_index` (F37, #89): for each firm whose registry counter reads current (`counters/{firm}_registry.nameIndex.schema = 1` and `nameIndex.version = version`), the chunks `conflict_name_index/{firm}_0 .. {firm}_{pointer}` exist and carry the firm, no chunk of the firm lies beyond the pointer, and every client `canonicalName` and every opposing `matter_parties.name` of the firm is in the chunks.
- **Firm isolation after a restore is proven three ways:** (1) the per-firm fingerprints equal the backup's; (2) every same-firm check above has zero violations; (3) through the real `firestore.rules` on the restored emulator, a partner of firm A reads firm A's client and matter and is refused firm B's client, matter, audit row and document (the rules read `users/{uid}` and `firms/{id}`, so this also proves the identity documents came back). Collections absent from a given backup are reported, not assumed empty.

### R12. Firestore in production: code plus runbook (live state NOT DEMONSTRATED)
`infra/backup/firestore-backup.json` declares, and `ops/backup/firestore/managed.ts` turns into exact `gcloud` argument vectors (tested offline, never executed here):
- **PITR**: `gcloud firestore databases update --database=(default) --enable-pitr` (7-day version retention, whole-minute restore points). Verified against the vendor pages on 2026-10-22: `--enable-pitr` is a flag of `databases update` and of `databases create`; the PITR page itself documents only `--no-enable-pitr` for an existing database and the console route to enable, so the runbook gives both and marks the update flag **[REQUIRES VERIFICATION]** against the live CLI.
- **Scheduled backups**: `gcloud firestore backups schedules create --database=(default) --recurrence=daily --retention=14w` (14 weeks is the documented maximum for both schedule kinds).
- **Managed export** (weekly): `gcloud firestore export gs://<bucket>/<UTC timestamp> --database=(default)`.
- **Export bucket**: uniform bucket-level access, a customer-managed encryption key, and a **locked retention policy** (`gcloud storage buckets update gs://<bucket> --retention-period=35d`, then `--lock-retention-period`, which is irreversible; the generator emits the lock step only on an explicit flag). *Change from the draft:* the draft also required object versioning on this bucket. Secondary sources say a Cloud Storage bucket with a retention policy cannot have Object Versioning enabled, and Google's pages read on 2026-10-22 do not settle it **[REQUIRES VERIFICATION]**. Exports are written once under a unique timestamp prefix and never overwritten, so the locked retention policy gives the immutability the finding asks for and versioning adds nothing; the configuration therefore does not require it.
- **Restore**: always into a new database id, never into `(default)`: `gcloud firestore databases restore --source-backup=projects/<p>/locations/<l>/backups/<id> --destination-database=<new>`, `gcloud firestore databases clone --source-database=projects/<p>/databases/(default) --snapshot-time=<whole minute> --destination-database=<new>`, or `gcloud firestore import gs://<bucket>/<prefix>/ --database=<new>`. An import overwrites same-id documents and leaves the rest ("If a document in your database is not affected by an import, it will remain"), so importing into a non-empty database is a merge, not a restore; `assertFirestoreTargetEmpty` refuses a target that has any collection. Then the manifest comparison (R10) against the restored id.
- The emulator drill exercises the same manifest and relationship code on `firebase emulators:export` output imported into a clean emulator.

### R13. Document objects
- Settings as code, `infra/backup/document-vault.json`:
  - **S3-compatible vaults** (MinIO in CI, an S3 secondary copy): bucket created with Object Lock enabled (which turns versioning on; probed on the pinned MinIO build), versioning `Enabled`, default retention `GOVERNANCE`, 2555 days (about seven years). `ops/backup/objects/protection.ts` applies the settings and `checkVaultProtection` reports every deviation.
  - **Cloudflare R2** (the production vault): R2 does **not** implement `PutBucketVersioning`, `GetBucketVersioning`, `PutObjectLockConfiguration` or `GetObjectLockConfiguration`, nor the object-lock headers (developers.cloudflare.com/r2/api/s3/api/, read 2026-10-22). Its immutability control is the bucket lock: `PUT /client/v4/accounts/<id>/r2/buckets/<bucket>/lock` with `{"rules":[{"id","enabled","prefix?","condition":{"type":"Age","maxAgeSeconds":N}}]}` (developers.cloudflare.com/api, read 2026-10-22), which blocks overwrite and delete for the period. `validateR2LockRules` checks the body offline.
  - Consequence, stated plainly: on R2 there are no prior versions to restore. The lock prevents the delete or overwrite in the first place (and vault writes are create-only), but it cannot recover from the loss of the Cloudflare account or bucket. The off-account, versioned, locked secondary copy is the recovery path; its replication job is a follow-up (R18) and its live state is NOT DEMONSTRATED.
- `verifyDocumentObjects`: every `documents` row with an `s3://` storage path must have its object, readable and decrypting to bytes whose F03 content hash equals the row's `contentHash` (through `getImmutableDocumentObject`, so the check is the product's own). It reports `missing`, `digest_mismatch`, `unreadable` per row; rows marked `objectBytesStatus: "missing"` are counted apart; non-`s3://` paths are counted as skipped, and in a production-mode run they are a problem.
- `restoreObjects`: for each failing row, lists the key's versions in a source bucket (the same bucket, or the secondary copy), takes the newest version that decrypts and whose F03 hash equals the row's, and writes its bytes as the new current version of the key in the target bucket. It never deletes a version or a delete marker, and reports `unrecoverable` when no version qualifies. Repeating it is a no-op once the verifier passes.
- *Devil's advocate.* "Seven years of GOVERNANCE retention keeps documents a client asked to erase." *Answer.* GOVERNANCE (not COMPLIANCE) lets the Backup and Recovery Owner, holding `s3:BypassGovernanceRetention`, delete under a documented procedure; the period is one policy value in one file; F42 (retention) owns the erasure flow. *Steelman for COMPLIANCE:* a compromised owner credential could bypass GOVERNANCE. Accepted residual; the bypass permission is not held by the application role.

### R14. Restore targets and refusals
- Postgres logical restore goes into a clean target only. Refused: the bundle fails verification; the target database already exists; a role of the backup's globals (other than the bootstrap superuser) already exists on the target; the target's server major version is lower than the backup's.
- PITR restore prepares an empty or absent data directory only (refused otherwise).
- Firestore emulator restore is refused while anything answers on the target emulator address; the production helper refuses a target database that has any collection.
- Object restore refuses to run when the source key ring is empty and never writes a version it did not verify.
- Every refusal is a test that proves nothing was written to the target.

### R15. Drills, RTO, schedule and ownership
- `ops/backup/test/*.drill.test.ts` run real clusters (`initdb`'d by the drill, never shared; ports from `SIKANDER_BACKUP_DRILL_PG_PORT` upward, else free ports), the Firestore emulator (started by the drill on its own ports) and MinIO (started by the drill from `~/.cache/sikander-minio/minio` or `SIKANDER_BACKUP_DRILL_MINIO_BIN`, the binary Gate G-0 builds). A missing prerequisite **fails** the drill with an actionable message; nothing is skipped.
- **Measured RTO** per store is the time from the start of the restore command to a verified result (bundle verify, restore, manifest, comparison), for the fixture dataset; it is written to a JSON result file the CI job uploads. Fixture timings are not a production RTO: the runbook publishes the formula (fixed overhead + size / measured throughput), the measured figures with their machine, and the policy target; the quarterly production-size drill by the owner replaces the estimate (NOT DEMONSTRATED here).
- **Policy** (`infra/backup/policy.json`, validated by a zod schema; the runbook's table is generated from it and a unit test fails when they drift): configured RPO and RTO target per store, the owner role, the deputy role, the schedules.
- **Owner**: the **Backup and Recovery Owner** role (deputy: the on-call engineer role). The weekly CI drill is the standing evidence; the quarterly restore of a production backup into an isolated project is the owner's task.
- **CI**: `.github/workflows/backup-drill.yml`, one job, on pull requests that touch the backup code, the DDL, the corpus schema, the vault, the rules or the workflow (not while the PR is a draft, as the repository's cost rule), on pushes to `main`, weekly (Mondays 04:17 UTC) and on demand.

### R16. Mutation testing
Two layers. (1) A committed mutant runner (`ops/backup/mutation/run-mutants.mjs` and `mutants.json`): each mutant is one exact text edit of a source file, applied to a copy of the tree, run against the targeted test files, and reported killed or survived; at least 10 on the verifiers (counts, digests, relationships, firm isolation) and the safety refusals, 24 are planned. (2) StrykerJS (`ops/backup/stryker.config.mjs`, the repository's existing tool) on the pure modules with a break threshold. A survivor is fixed with a test or reported with its reason.

### R17. Joining F32's manifest
F32's deployment manifest is being built on `claude/remediate-f32` and is not on main; its files are not edited here. `infra/backup/*.json` are plain data with zod schemas (`ops/backup/config.ts`). **Integration point:** when F32's manifest lands, its gate imports `infra/backup/policy.json` (one entry per store: RPO, RTO, owner, schedule) and `infra/backup/firestore-backup.json` instead of restating them; until then they stand alone. Recorded as a follow-up in the PR.

### R18. Residuals (NOT DEMONSTRATED here)
Live Firestore PITR, scheduled backups and managed exports; the export bucket's retention lock; the R2 bucket lock; the off-account secondary copy of the vault and its replication job; PITR on the compose Postgres (needs F30's policy extended); key escrow and a custody review; the weekly job's first scheduled run on `main`; a restore of a real production backup and a production-size RTO; transfer of bundles off the host (the runbook gives the commands; the CI proves the bundle, not the transfer); cross-store reconciliation of Firestore documents that cite corpus rows when the stores are restored to different points; an independent cryptographic review of `SKB1`.

### R19. No compose change
F30's compose policy (`ci_gates/check_compose_policy.py`) refuses Postgres options outside its allow-list (`archive_mode`, `archive_command` are not in it) and unknown services, so a WAL archiver or backup sidecar in `corpus_service/docker-compose.yml` needs that gate extended first, which is F30's lane. Until then the compose deployment is backed up by the logical path through the running container: the tool takes `SIKANDER_BACKUP_PG_EXEC`, a JSON argv prefix (for example `["docker","compose","-f","corpus_service/docker-compose.yml","exec","-T","postgres","gosu","postgres"]`) put in front of every `psql`, `pg_dump`, `pg_dumpall`, `pg_restore` it runs, so nothing is published and no credential leaves the container. PITR on compose is a follow-up. The prefix is unit-tested (argument construction) and drilled with a local `env` / `runuser` prefix standing in for `docker compose exec`; the real `docker compose exec` form is NOT DEMONSTRATED (no Docker daemon here).

## 3. Tests

**RED on main** (before any tooling): the drill suites fail because `ops/backup` does not exist; and a probe on main shows that nothing in the repository can recover a deleted Postgres row, Firestore document or vault object (`git grep` for `pg_dump|pg_basebackup|archive_command|pg_restore|emulators:export|firestore export|ObjectLock|PutBucketVersioning` outside docs, tests and the corpus-service image finds none), and that a bucket created as the F03 test helper creates it keeps no prior version of an overwritten or deleted object.

**GREEN:**
- Postgres logical: seed (Annex A DDL 001/003/004 as `apply-annex-a.sh` applies them, roles through `provision-roles.sh`, the corpus-service schema through `python -m scraper.migrate`, then synthetic rows, a vector row among them) → backup → drop the database → restore into a second, clean cluster → every manifest field equal. A post-restore tamper (deleted row, changed cell, orphaned link, revoked grant, dropped trigger) is reported by the comparison.
- Postgres PITR: base backup, WAL archive, a named restore point, writes after it → restore to the point → the restored cluster equals the manifest taken at the point and the later rows are absent.
- Firestore emulator: seed two firms → `firebase emulators:export` → stop (the loss) → start clean, assert empty → import → manifest equal, every check clean, the rules probe proves isolation.
- Objects: overwrite one object and delete another → the verifier names both → permanent delete of a locked version is refused → restore → the verifier passes with digests equal.
- Refusals: one flipped byte (bundle file, WAL segment), truncation, a wrong key, a non-empty target (each store), a non-empty PITR data directory, an existing role on the target.
- Unit: envelope, bundle, comparison, canonical encoding, relationship checks, object classification and version choice, gcloud argument vectors, policy and runbook consistency.

Ledger and numbers: `docs/superpowers/plans/2026-10-18-f33-backup-restore.md`.

## 4. Consumer impact (summary; the PR body carries the full text)

Nothing changes at runtime: no product code, API, schema, compose file or Firestore rule is touched. Operators gain: a CLI and runbook for encrypted Postgres, Firestore and vault backups and restores; a policy file with RPO/RTO and ownership; a weekly CI drill. To get the protection they must: create the backup key and escrow it; schedule the Postgres logical backup (daily) and, where the cluster is theirs to configure, enable WAL archiving; enable Firestore PITR, the daily backup schedule and the weekly export into a retention-locked bucket; create the vault bucket with Object Lock (S3 secondary) or apply the R2 bucket lock; copy bundles off the host; run the quarterly production restore.
