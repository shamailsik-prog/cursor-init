# Document vault (`platform/documents`)

Original uploaded documents are stored here, encrypted, immutable and verified. This closes
audit finding F03 (bytes were discarded) and its residuals FA-D16-001 (the vault was the
instance's local disk, not R2), FA-D16-002 (integrity and key checks were untested) and
FA-D16-003 (a failed round-trip check left the written object behind).

| File | Role |
|---|---|
| `documentObjectStore.ts` | Envelope encryption, storagePath and key rules, backend selection (fail-closed), put / get / delete |
| `objectBackend.ts` | The backend interface and its errors |
| `r2ObjectBackend.ts` | Cloudflare R2 over the S3 API, AWS SigV4 (`aws4fetch`, pinned 1.0.20) |
| `localObjectBackends.ts` | `fs://` local-disk backend (development) and the in-memory backend (tests only) |

## What every backend stores

- **Envelope** (identical for every backend): `[version 0x01][12-byte nonce][AES-256-GCM ciphertext][16-byte tag]`.
  Encryption happens in this process before any byte is sent. R2 never sees plaintext.
- **Key**: `SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY`, exactly 64 hex characters (32 bytes).
  Anything else is refused before an upload is accepted.
- **storagePath** (stored on the document row): `r2://<firmId>/documents/<docId>/v1` (or
  `fs://…` for the local backends). It never names a bucket, so a restored copy in another bucket
  is read by repointing configuration, not by rewriting rows.
- **Object key**: `<firmId>/documents/<docId>/v1.enc`. It is firm-scoped, and `docId` is
  `doc_<random UUID>`, so keys cannot be guessed. A read checks that the storagePath's firm is the
  document's firm.
- **Write**: a conditional create (`If-None-Match: *` on R2, `O_EXCL` on disk). An existing object
  is never overwritten or deleted by a later upload.
- **Read-after-write**: the object is read back from the backend itself (R2: a signed GET to the
  bucket, never a local copy), decrypted, and its firm-scoped SHA-256 is compared with the upload's.
  If that fails, the object is deleted before the error propagates. If the delete also fails,
  `uploadDocument` retries it (FA-D16-003).
- **Every read** checks the format version, GCM authentication and the content hash. A tampered,
  truncated or swapped object is refused: the route answers 500 "document bytes unavailable".

## Backend selection (fails closed)

| `SIKANDER_DOCUMENT_OBJECT_BACKEND` | Allowed when | Needs |
|---|---|---|
| `r2` | always | `SIKANDER_R2_ENDPOINT`, `SIKANDER_R2_BUCKET`, `SIKANDER_R2_ACCESS_KEY_ID`, `SIKANDER_R2_SECRET_ACCESS_KEY`; `SIKANDER_R2_REGION` optional (default `auto`); https endpoint when `NODE_ENV=production` |
| `fs` | **not** when `NODE_ENV=production` | `SIKANDER_DOCUMENT_OBJECT_ROOT` |
| `memory` | test runner only | nothing |
| unset | refused in production; otherwise `fs` if a root is set, `memory` under the test runner, refused elsewhere | |

A process that cannot satisfy this refuses uploads with HTTP 503 before anything is written, and
every read fails. This is the same per-request fail-closed rule F01 uses for persistence
(`platform/persistence/runtimeRepositories.ts`). The process still starts, because the other
services do not depend on the vault.

## Operator steps (production on R2)

1. Create a **private** R2 bucket in the required jurisdiction. Do not connect an `r2.dev`
   subdomain or a custom domain to it.
2. Create an R2 API token scoped to **that bucket only**, with Object Read & Write permission.
   Store the token in the deployment's secret manager, never in the repository.
3. Generate the encryption key once (`openssl rand -hex 32`) and store it in the secret manager.
   Back it up separately from the bucket: **losing the key loses every document**, and a key
   leaked together with the bucket credentials exposes them.
4. Set on the Next.js runtime: `SIKANDER_DOCUMENT_OBJECT_BACKEND=r2`,
   `SIKANDER_R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (or the jurisdiction
   endpoint), `SIKANDER_R2_BUCKET`, `SIKANDER_R2_ACCESS_KEY_ID`, `SIKANDER_R2_SECRET_ACCESS_KEY`,
   `SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY`.
5. Bucket settings:
   - **Bucket lock (retention).** Add an R2 bucket lock rule covering the whole bucket (or each
     `<firmId>/documents/` prefix) with the firm's retention period, for example
     `npx wrangler r2 bucket lock add <bucket> --name vault-retention --retention-days <days>`.
     Cloudflare's docs (developers.cloudflare.com/r2/buckets/bucket-locks/) say a lock keeps
     objects from being deleted or overwritten. The architecture's Ghost Archive sets 7 years for
     closed matters. While the lock holds, the delete that discards an object which failed its
     read-after-write check will itself fail. That object is encrypted and no document row
     references it, and the failure is logged (`[documents] could not remove unverified object …`).
     **[REQUIRES VERIFICATION]**: how a locked key answers a conditional create through the S3
     API (412 expected).
   - **Versioning.** This change does not depend on object versioning, and R2's S3 compatibility
     page (developers.cloudflare.com/r2/api/s3/api/) is the place to check whether
     `PutBucketVersioning` exists. Immutability here rests on the conditional create plus the
     bucket lock. **[REQUIRES VERIFICATION]**: R2 versioning support, before relying on it.
   - **Lifecycle.** No lifecycle rule may delete objects under `*/documents/`, or move them to a
     storage class that cannot be read synchronously, unless the retention policy is satisfied
     first. Infrequent Access is readable but billed per read.
6. Run the live-bucket test (architecture open item **O-2**) once against the production bucket:

   ```bash
   R2_LIVE_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com R2_LIVE_BUCKET=<bucket> \
   R2_LIVE_ACCESS_KEY_ID=<id> R2_LIVE_SECRET_ACCESS_KEY=<secret> npm run test:r2-live
   ```

   It writes one encrypted object under firm `o2livetest`, reads it from a second instance and
   checks that R2 refuses an overwrite of the key. Cloudflare documents conditional headers on
   `PutObject` (developers.cloudflare.com/r2/api/s3/extensions/), and the S3 region `auto`
   (`us-east-1` is an alias). **[REQUIRES VERIFICATION]**: this run is the only proof that R2
   honours `If-None-Match: *` on PutObject and accepts this SigV4 signing. The CI proof uses MinIO.
7. **Restore drill**, scheduled (for example quarterly). Copy every object in the bucket to a
   second bucket, for example with `rclone copy r2:<bucket> r2:<restore-bucket>` or S3
   CopyObject. Point a staging deployment's `SIKANDER_R2_BUCKET` at the copy and download a
   sample of documents through `GET /api/d1/documents?includeContent=true`; every download is
   hash-checked. `npm run test:document-vault-s3` runs the same drill in CI against MinIO.
8. **Moving existing `fs://` objects.** The envelope is the same on every backend, so each file
   `<root>/<firmId>/documents/<docId>/v1.enc` uploads unchanged to the key
   `<firmId>/documents/<docId>/v1.enc`. Then rewrite the row's `storagePath` from `fs://` to
   `r2://` with the Admin SDK (the Firestore rules forbid clients from changing `storagePath`).
   Until a row is migrated, a process configured for R2 refuses to read its `fs://` path.

## Tests

| Test | Proves |
|---|---|
| `tests/fa-d16-001.document-vault-s3.e2e.test.ts` (`npm run test:document-vault-s3`, CI job `document-vault-s3`, MinIO) | upload → bucket holds only ciphertext → a fresh store instance reads it → download bytes and hash match; overwrite refused; tamper, truncation and deletion detected; restore drill into a second bucket; FA-D16-003 on S3 |
| `scripts/e2e-document-vault-server.mjs` (`npm run test:document-vault-server`, same CI job) | the same flow through a running Next.js server: the bundled route and Next's extended fetch (body sent with a known length, `cache: "no-store"`) |
| `tests/fa-d16-001.r2-object-backend.unit.test.ts` | SigV4 (checked by an independent verifier), the conditional PUT, payload hashes, status handling, timeouts, settling an ambiguous PUT, the identical envelope across backends |
| `tests/fa-d16-001.object-store-config.unit.test.ts` | the fail-closed selection rules above, including the 503 from the upload route |
| `tests/fa-d16-002.*.unit.test.ts` | tampered and truncated ciphertext, the wrong key, malformed keys, the format version, hash mismatches, storagePath validation, uploadDocument's rollback and dedup paths |
| `tests/fa-d16-003.round-trip-cleanup.unit.test.ts` | no object survives a failed read-after-write check, including the outer retry in uploadDocument |
| `tests/fa-d16-001.r2-live.o2.test.ts` (`npm run test:r2-live`) | O-2 against real R2. **Skipped** unless `R2_LIVE_*` are set; not run in CI |

Mutation testing: `npm run mutation:documents` (per-file floors in `stryker.documents.config.mjs`).
