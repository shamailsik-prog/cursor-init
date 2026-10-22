# F33 Backup and Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypted Postgres, Firestore and document-vault backups with restore-and-verify drills that run for real locally and in CI, a measured RTO, and a runbook with named ownership.

**Architecture:** One TypeScript package `ops/backup/` (plus a dependency-free `.mjs` envelope and WAL helper). Every store follows the same shape: take a *manifest* (counts, order-independent digests, relationships, roles) in the same consistent state as the backup, write an encrypted *bundle*, and on restore into a clean target recompute the manifest and compare. Drills are vitest suites that start real clusters, the Firestore emulator and MinIO.

**Tech Stack:** TypeScript, vitest, vite-node, `node:crypto`, PostgreSQL 16 client programs, `firebase-admin`, `@firebase/rules-unit-testing`, `@aws-sdk/client-s3`, `zod`; StrykerJS for the pure modules.

**Spec:** `docs/superpowers/specs/2026-10-18-f33-backup-restore-design.md` (rulings R1 to R19; the plan cites them).

## Global Constraints

- No new dependency and no change to `package.json` / lockfiles (R1).
- Not touched: `corpus_service/**`, `functions/src/**`, `platform/**`, `tests/**`, `.gitleaks.toml`, F32's files (R1).
- Key material: never committed; tests use `randomBytes(32)`; no 64-hex literal in any committed file (gitleaks).
- Synthetic data only; the test firm names are `firm-alpha` and `firm-bravo`.
- A drill whose prerequisite is missing fails with an actionable message. Nothing is skipped or disabled.
- Delete every backup artefact, cluster, emulator export and bucket directory a test creates, also on failure.
- Disk is tight: fixtures stay small (under 5 MB of table data); WAL segments are 16 MB, so the PITR drill sets `wal_segment_size` only through `initdb --wal-segsize=1`.
- Commit trailers (exactly, per the brief):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DtzafHsrLji6x2SM4jCSWT
  ```

## Review Focus

1. A backup taken while the database is being written: manifest and dump must agree (exported snapshot). Test: write concurrently during `backupLogical`, restore, compare equal.
2. A database with a table that has no primary key, a vector column, `NULL`s, `-0`/`NaN` floats in Firestore, bytes and nested maps: digests stable across backup and restore.
3. A restore into a target that already holds some of the data (non-empty database, existing role, non-empty data directory, running emulator): refused and nothing written.
4. A key rotated since the backup: the old backup opens with the previous key in the ring; a wrong key never decrypts a byte.
5. A restored bundle that is internally valid but from another backup (swapped file): refused by the plaintext hashes.

## File structure

| Path | Responsibility |
| --- | --- |
| `ops/backup/lib/envelope.mjs`, `.d.mts` | SKB1: header, key id, HKDF, STREAM encrypt/decrypt transforms, error codes |
| `ops/backup/lib/keys.ts` | `loadKeyRing(env, readFile)`: current key, previous keys, mode check |
| `ops/backup/lib/bundle.ts` | `BundleWriter`, `verifyBundle`, `readBundleFile` |
| `ops/backup/lib/diff.ts` | `diffRecords`, `diffSets`: the comparison primitives every store uses |
| `ops/backup/lib/digest.ts` | `MultisetDigest`: count + four 64-bit word sums over SHA-256 row hashes |
| `ops/backup/lib/exec.ts` | `runCommand` with the argv prefix (R19), `PsqlSession` |
| `ops/backup/lib/results.ts` | `recordDrillResult(store, rtoMs, details)` to `$SIKANDER_BACKUP_RESULTS_DIR` |
| `ops/backup/bin/pg-wal.mjs` | `archive` / `restore` for `archive_command` / `restore_command` |
| `ops/backup/postgres/{sql,links,manifest,logical,pitr,guards}.ts` | R6 to R9, R14 |
| `ops/backup/firestore/{canonical,relationships,manifest,managed,guards,rulesProbe}.ts` | R10 to R12, R14 |
| `ops/backup/objects/{protection,verify,restore,s3}.ts` | R13 |
| `ops/backup/config.ts` | zod schemas and loaders for `infra/backup/*.json` |
| `ops/backup/cli.ts` | thin wrapper over the library |
| `ops/backup/mutation/{mutants.json,run-mutants.mjs}`, `ops/backup/stryker.config.mjs` | R16 |
| `ops/backup/test/**` | unit tests (`*.unit.test.ts`), drills (`*.drill.test.ts`), helpers |
| `infra/backup/{policy,postgres-backup,firestore-backup,document-vault}.json` | R4, R7, R12, R13, R15 |
| `docs/runbooks/backup-restore.md` | runbook, RPO/RTO, ownership, key escrow, appendix: SKB1 format |
| `.github/workflows/backup-drill.yml` | R15 |

## Tasks

Each task: write the failing test, run it and watch it fail for the stated reason, implement, run, commit and push (gitleaks first).

### Task 1: Scaffold, spec and plan
- Create `ops/backup/vitest.config.ts` (include `ops/backup/test/**/*.test.ts`, alias `@` to the repository root, `pool: "forks"`, `fileParallelism: false`, `testTimeout: 120_000` for drills only via per-file `// @vitest-environment`-free `test.timeout`), `ops/backup/lib/results.ts`.
- Commit the spec and this plan.
- Verify: `npx vitest run -c ops/backup/vitest.config.ts` finds no tests and exits 1 with "No test files found" (RED baseline), not a config error.

### Task 2: Envelope (R3)
**Interfaces (produces):**
```ts
export type KeyRing = { current: Buffer; byId: Map<string, Buffer> }
export class EnvelopeError extends Error { code: "BAD_MAGIC"|"BAD_HEADER"|"UNKNOWN_KEY"|"AUTH_FAILED"|"TRUNCATED"|"TRAILING_DATA"|"BAD_KEY" }
export function parseMasterKey(hex: string): Buffer          // 64 hex, not one byte repeated
export function keyIdOf(key: Buffer): string                  // 16 hex
export function makeKeyRing(current: Buffer, previous?: Buffer[]): KeyRing
export function createEncryptStream(key: Buffer, opts?: { chunkExp?: number }): Transform
export function createDecryptStream(ring: KeyRing): Transform
export function encryptBuffer(key: Buffer, data: Buffer): Buffer
export function decryptBuffer(ring: KeyRing, data: Buffer): Buffer
```
Tests (`envelope.unit.test.ts`): round trip at lengths 0, 1, 65535, 65536, 65537, 3 chunks and an exact multiple; streaming in odd write sizes equals buffer mode; same plaintext twice gives different ciphertext (fresh salt); the header is 48 bytes and names the key id; **refusals each with its code** (flip one byte in header magic / version / chunk exp / reserved / key id / salt / first chunk / middle chunk / last chunk / tag; swap two chunks; drop the last chunk at a boundary; drop 1 byte; append 1 byte; append a whole extra chunk; empty input; wrong key; key not in the ring); previous key decrypts; `parseMasterKey` refuses 63 / 65 hex, non-hex, all-zero, all-`ff`; ciphertext never contains a 16-byte plaintext marker.

### Task 3: Keys and bundles (R4, R5)
**Interfaces:** `loadKeyRing({ env, readFileSync, statSync }): KeyRing`; `class BundleWriter { static create(root, store, key): Promise<BundleWriter>; addStream(name, Readable): Promise<void>; addBuffer(name, Buffer): Promise<void>; finish(manifest: unknown): Promise<string> }`; `verifyBundle(dir, ring): Promise<{ ok: boolean; problems: string[]; manifest?: unknown; bundle: BundleInfo }>`; `openBundleFile(dir, name, ring): Readable` (decrypting, hash-checking on end).
Tests (`bundle.unit.test.ts`, `keys.unit.test.ts`): a good bundle verifies; each of {flip a ciphertext byte, truncate a file, delete a file, add an unlisted file, swap a file from another bundle with the same key, edit `bundle.json` hash, edit `manifest.json.skb`, wrong key, previous key} is refused with a named problem; `bundle.json` is written last (an interrupted writer leaves no `bundle.json`); no plaintext file is ever created in the bundle directory; key file with mode 0644 is refused on POSIX; `SIKANDER_BACKUP_KEY` and `--key-file` both set is refused.

### Task 4: Comparison and digest primitives
**Interfaces:** `diffRecords(path: string, expected: Record<string, unknown>, actual: Record<string, unknown>): string[]`; `diffSets(path: string, expected: string[], actual: string[]): string[]`; `class MultisetDigest { add(rowHash: Buffer): void; digest(): string; count: number }`.
Tests (`diff.unit.test.ts`): equal gives `[]`; a changed value, a missing key and an extra key each give one named line; set difference gives `missing` and `unexpected` lines; digest is order independent, count sensitive (duplicate row changes it), content sensitive, and equals the SQL formulation of R8 (golden value computed in the PG drill).

### Task 5: Postgres harness, manifest, links, guards (R8, R9, R14)
Harness `test/helpers/cluster.ts`: `startCluster({ port?, archive?: {...}, walSegSize? }) → { dir, port, env, stop(), runAs() }` (initdb, `pg_ctl` as `postgres` through `runuser` when root); `seedAnnexA(cluster)` applies DDL 001, 003, 004 in one transaction as `apply-annex-a.sh` does, runs `provision-roles.sh` with synthetic role names and fake passwords, and `python -m scraper.migrate` as the migration role (venv from `SIKANDER_BACKUP_DRILL_PYTHON`); `seedRows(cluster)` inserts the synthetic dataset (court, judgment with a vector embedding, statute, staging rows in every lifecycle state, promoted decisions, queue rows, receipts, transitions, a publication).
`ops/backup/postgres/manifest.ts`: `takePgManifest(session: PsqlSession, db: string): Promise<PgManifest>`; `comparePgManifests(expected, actual): string[]`.
Tests: unit (`pg-compare.unit.test.ts`: every section of `comparePgManifests`; `links.unit.test.ts`: each link SQL parses against the DDL text by naming only existing tables and columns; `guards.unit.test.ts`: `assertPgTargetClean` refuses an existing database / existing role / older server, passes a clean one) and the first drill test (`pg-manifest.drill.test.ts`: manifest of the seeded database has the expected tables and non-zero counts; two manifests of an unchanged database are equal; each tamper changes exactly the expected section).

### Task 6: Postgres logical backup and restore (R6, R14, R19)
`backupLogical({ db, outRoot, key, pgPrefix? }): Promise<{ dir: string; manifest: PgManifest }>`; `restoreLogical({ bundleDir, ring, db, pgPrefix? }): Promise<{ ok: boolean; differences: string[]; rtoMs: number }>`.
Drill (`pg-logical.drill.test.ts`): seed → backup (with a concurrent writer during the dump) → drop the database → restore into the clean second cluster → no differences; RTO recorded. Refusal tests: flipped byte in `database.dump.skb`; truncated `globals.sql.skb`; wrong key; previous key works; target database exists; a role of the backup exists on the target; bundle swapped file. Tamper tests after restore (delete row, change cell, add orphan, revoke grant, drop trigger, drop a sequence's progress) each produce the expected difference. Prefix test: the same backup through `["env","X=1"]` prefix shape (argument construction asserted in a unit test).

### Task 7: Postgres PITR (R7)
`bin/pg-wal.mjs`, `baseBackup({ outRoot, key }): Promise<string>`, `preparePitrRestore({ bundleDir, ring, dataDir, archiveDir, keyFile, target }): Promise<void>`, `waitForPromotion(env, timeoutMs): Promise<void>`.
Tests: unit (`pg-wal.unit.test.ts`: archive twice same bytes exits 0; different bytes exits 1 and leaves the first; restore of a missing name exits 1; wrong key and flipped byte exit 127; no partial file on failure); drill (`pg-pitr.drill.test.ts`): cluster with `archive_mode=on` and `--wal-segsize=1`; seed; base backup; write batch A; `pg_create_restore_point('f33_pit')`; take the manifest; write batch B; switch WAL; stop; restore to `f33_pit` into a new data directory on a new port; equals the manifest; batch B absent. Refusals: non-empty data directory; flipped byte in an archived segment needed for recovery (the cluster never opens: `pg_ctl` start fails or `pg_is_in_recovery()` stays true until timeout, and the log shows the fatal error); base backup bundle with a flipped byte.

### Task 8: Firestore canonical encoding, relationships, manifest comparison (R10, R11)
`canonicalEncode(value: unknown): Buffer`; `docHash(path, data): Buffer`; `collectionPattern(path): string`; `runRelationshipChecks(index: FirestoreIndex): RelationshipReport`; `compareFirestoreManifests(expected, actual): string[]`.
Unit tests: canonical encoding distinguishes null / false / 0 / "" / [] / {} / "0"; integer vs double text; `-0`, `NaN`; Timestamp nanoseconds; GeoPoint; DocumentReference; bytes; vector; key order independence; array order dependence; nested maps. Relationship tests: for each of the nine checks, a clean index gives 0 and each of a list of corrupted indexes gives the expected count and sample path (cross-firm reference, missing parent, dangling target, name missing from chunk, chunk beyond pointer, stale name index skipped, opaque audit target counted apart). Per-firm fingerprint tests: moving a document to another firm changes exactly two fingerprints.

### Task 9: Firestore emulator drill (R10, R11, R14)
`collectFirestoreManifest(db: Firestore): Promise<FirestoreManifest>`; `backupFirestoreEmulator({ hub, outRoot, key }): Promise<string>`; `restoreFirestoreEmulator({ bundleDir, ring, ports }): Promise<{ ok; differences; rtoMs; stop() }>`; `probeFirmIsolation({ host, port, rulesPath })`.
Drill (`firestore.drill.test.ts`): seed two firms (clients, matters, matter_members, matter_parties, documents, audit_log, audit_outbox, counters registry + conflict_name_index chunks, users, firms) → manifest → `firebase emulators:export` → bundle → stop the emulator (the loss) → start clean, assert every collection empty → decrypt, import → manifest equal, all relationship counts 0, rules probe passes. Refusals: flipped byte; running emulator on the target port; wrong key. Tamper tests: delete a document, change a field, move a document to the other firm, delete a chunk, each reported.

### Task 10: Firestore production helpers, config, policy (R12, R15, R17)
`managed.ts`: `firestoreCommands(cfg, ctx): { enablePitr, schedule, export, bucketCreate, bucketRetention, bucketLock?, restoreBackup, clonePitr, importExport }` as argv arrays; `assertFirestoreTargetEmpty(db)`. `config.ts`: zod schemas, `loadInfraConfig(root)`.
Unit tests: exact argv for each command; restore refuses `(default)` as destination; no argv contains `--force`, `delete` or `rm`; the lock step is absent unless `lock: true`; `--snapshot-time` must be whole-minute RFC 3339 within 7 days; `policy.json` validates, every store has RPO, RTO target, owner role, schedule; the runbook table equals the policy (drift test); `assertFirestoreTargetEmpty` refuses a database with one document.

### Task 11: Document objects (R13)
`objects/s3.ts`: `S3Versioned implements VersionedObjectAccess` (`listVersions`, `getVersion`, `put`); `verify.ts`: `verifyDocumentObjects({ rows, read }): Promise<ObjectReport>`; `restore.ts`: `pickIntactVersion(versions, check)`, `restoreObjects({ rows, source, target, check }): Promise<RestoreReport>`; `protection.ts`: `desiredVaultProtection(cfg)`, `applyVaultProtection(s3, bucket, cfg)`, `checkVaultProtection(s3, bucket, cfg): Promise<string[]>`, `validateR2LockRules(body): string[]`.
Unit tests (fake access): classification into missing / digest_mismatch / unreadable / available-flag-missing / non-s3; version choice (newest intact; skips delete markers and tampered versions; none intact is `unrecoverable`; never calls delete); R2 body validation (id required, `maxAgeSeconds` at least policy, prefix, enabled). Drill (`objects.drill.test.ts`, MinIO): baseline (a bucket made as the F03 helper makes it keeps no prior version); protected bucket; upload N objects through the product's `putImmutableDocumentObject`; metadata rows in Firestore; verifier clean; overwrite one, delete one; verifier names both; permanent delete of a locked version refused; restore; verifier clean; digests equal; second restore is a no-op.

### Task 12: CLI
`cli.ts` subcommands: `bundle verify`, `pg backup|restore|pitr-base|pitr-restore`, `firestore manifest|compare|commands`, `objects verify|restore|protect|check`. Unit-test argument parsing and that every subcommand refuses without a key. One smoke test runs `bundle verify` through `vite-node`.

### Task 13: Runbook and infra data
`docs/runbooks/backup-restore.md`: schedule, RPO/RTO table (generated from `policy.json`, with the measured fixture RTOs and the formula), roles and escrow, step-by-step restores for the three stores, post-restore role re-provisioning, drill procedure, the SKB1 format appendix, NOT DEMONSTRATED list. `infra/backup/*.json`.

### Task 14: CI workflow
`.github/workflows/backup-drill.yml` (pins copied from `gate-g0.yml`): checkout; Node 22; Java 21; Python 3.12 and `corpus_service/requirements-test.txt`; `apt-get install postgresql-16 postgresql-16-pgvector`; Go and the MinIO build as in `gate-g0.yml`; `npm ci`; unit tests, then drills; upload `ops/backup/.results/*.json`. Triggers per R15. `actionlint`-clean (the repository's `ci_gates/actionlint` is not present; run `actionlint` if installed, else a YAML parse and a review against `gate-g0.yml`).

### Task 15: Mutants and Stryker (R16)
`mutants.json` entries `{ id, file, old, new, tests, why }` (24 planned), `run-mutants.mjs` copies the tree to a scratch directory, applies one edit, runs the targeted tests, restores, and prints killed or survived; a survivor fails the run unless listed with a reason. Stryker config for `ops/backup/lib` and the pure modules.

### Task 16: Verification and PR
Full unit and drill runs; RED run on an exported `origin/main`; `npm run typecheck`, `npm run typecheck:tests`, `npx eslint ops infra`, `bash ci_gates/gate_g0.sh`; gitleaks; PR body; `python3 ci_gates/check_pr_phase_claims.py`.

## RED/GREEN ledger

(Filled in as each task lands; the same numbers go to the PR body.)

| Task | RED (what failed, and why) | GREEN |
| --- | --- | --- |

## Verification log

(Commands and exit codes, appended as run.)
