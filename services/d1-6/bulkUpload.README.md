# L9.1 high-speed bulk upload

Server-side sessions for a batch of files. Each large file is sent as fixed chunks, a dropped connection resumes from the missing chunk indexes, and a file whose vault content hash is already held for the same firm and matter (or the loose vault) is marked `deduped` and is not uploaded. Finalising a file calls the existing `uploadDocument` path with `sourceChannel: "bulk"`, so classification, vault dedup, the OCR job and the immutable object write stay on that path.

The module is off unless `SIKANDER_FLAG_D1_BULK_UPLOAD` is exactly `true` after trim and lower-casing. Any other value, including unset, refuses before a session row or a staging object is written. The flag is env-only. It is not added to `platform/flags/featureFlags.ts`.

## Hash

`sha256` on a file descriptor is the vault content hash: `SpineStore.hashKey(firmId, bytes)`, which is SHA-256 over the firm id concatenated with the bytes. `bulkDeclaredHash` returns that value. It is the same string stored on `DocumentRecord.contentHash`. A bare digest of the file bytes does not match an existing document and fails the finalise check.

## Chunks and caps

- Chunk size is `BULK_UPLOAD_CHUNK_BYTES` (8 MiB). Chunk indexes are 1-based. The last chunk is the remainder and is shorter unless the size divides evenly.
- File indexes are 0-based.
- At most `BULK_UPLOAD_MAX_FILES` (500) files, and at most `BULK_UPLOAD_MAX_TOTAL_BYTES` (8 GiB) declared bytes, per session. Both caps are refused at start, before a session row is written.
- The same chunk twice is a no-op when the bytes match, and is refused when they differ.
- `resumeUpload` lists the missing 1-based indexes. After chunks 1 and 2 of a 5-chunk file, that list is 3, 4 and 5.

## Finalise

Assembled bytes are checked against the declared hash and the declared size. A mismatch marks that file `failed`, deletes only that file's staging chunks, and does not create a document row or an original object. A second finalise of a failed file refuses again. A second finalise of a successful file returns the same `docId` and does not call `uploadDocument` again.

## Storage

Session rows sit on `SpineStore.uploadSessions` (the runtime map for the `upload_sessions` collection inventoried by W1-INV). Chunk ciphertext uses the same AES-256-GCM layout as document objects, under `upload-staging/<firmId>/<sessionId>/<fileIdx>/<chunkIdx>`. Staging is removed after a successful finalise and after a hash mismatch. Those deletes go through `deleteStagingSession`, which only builds five-segment `upload-staging/...` paths. Original document paths are not passed to it.

A caller from another firm, or a different user in the same firm, gets the same `upload session refused` error as an unknown session id. The error does not include file names, hashes or the session's firm.

## Loose vault

`matterId: null` is the loose vault. W1-L45's `isLooseUploadBlocked` is not on this base, so this module does not call it. The call site is marked `TODO(W1-L45)`. The skipped test is named `isLooseUploadBlocked`.

## Out of scope

Client uploader UI, client-side compression, L7.1 staging and auto-merge, the splitter, HTTP routes and actions, flag registry entries, and retention inventory edits. On the S3 backend the existing vault read cap (`maxUploadBytes`, 25 MiB unless configured) still applies inside `uploadDocument`. A larger assembled file fails that path, leaves no original, and keeps its chunks. The memory backend used in unit tests stores the larger object.
