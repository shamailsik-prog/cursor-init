# F11: Next effects stage their audit in the effect's own commit; a reconciler publishes what a dead request left

Audit finding **F11** (HIGH, `docs/audit/2026-10-13-forensic-audit.md`; v2 status OPEN at `platform/http/withSession.ts:263`, "flushRequestAudit after handler commit; no outbox"): Next effects and audit publication are not atomic.

Dependencies:
- **F10** (merged #59, 0844ed8): the durable Next idempotency store and its write fence. F10 ruling 12 left F11 open and named the fence's transaction as the place to stage audit rows.
- **F01/F12** (merged #44, 2bf12d5): firm-scoped Next repositories that read the document id and page every listing.
- **F07/F08** (`functions/src/p1/reconciler.ts`): the repo's lease reconciler pattern (a one-minute scheduled function with a pinned timeout and a wall-clock budget).

Status: design decided by the builder under the owner's standing autonomy instruction. Every decision is a ruling (§3).

## 1. Root cause, traced from the code

`platform/http/withSession.ts` at main a9b0e06:

1. **The effect commits first, the audit later.** `runAuditedInner` (`:254-268`) runs the handler, then `flushRequestAudit(outcome.rows)`. Every effect write the handler made has already committed, each in its own Firestore transaction (the F10 fence, `platform/persistence/firestoreDbModular.ts`).
2. **The handler's own row comes after its writes.** For example `app/api/d1/clients/route.ts` writes the entity, its search-index row and its links, and only then pushes `client_create`. `app/api/d1/matters/route.ts` does the same with `matter_create`. Those rows exist only in process memory until the flush.
3. **The safety net lives in the process.** A failed flush answers 503 `AUDIT_UNAVAILABLE` and leaves the rows on the `AuditLog` retry queue (`platform/audit/requestAudit.ts`), an array in the process. A process that dies between the effect commit and the flush loses every row of that request. Nothing else ever learns that the effect happened.
4. **The code says so.** The `FOLLOW-UP (outbox)` comment above `runAudited` (`:243-247`) names the missing transactional outbox.
5. **A retry does not repair it.** After F10, a same-key retry on another instance never re-runs the effect (409 `idempotency_in_progress`, then 409 `idempotency_effect_committed`). That is correct for the effect, but it also means no later request ever writes the missing audit row.

In-lane LOW from the F12 re-audit (F12-LOW-2): `auditDeadLetter.listByFirm` queries a top-level `firmId`, but a stored letter has only `row.firmId`. Firestore returns no letters; the memory adapter returns every firm's letters.

## 2. Design

### 2.1 The outbox entry

Collection `audit_outbox`, server-only (rules `allow read, write: if false`). One document per **effect write** of a request (not one per request; ruling 1):

| Field | Meaning |
| --- | --- |
| `v` | Shape version, `1`. |
| `surface` | `"next"`. |
| `firmId` | The session firm (null when the request has no session). |
| `actorId` | The session user (null when none). |
| `route` | `METHOD /path`. |
| `requestAction` | The body's top-level `action` when it is a short identifier, else null. |
| `operationId` | The F10 operation of the request's durable claim, when the write was fenced. |
| `requestId`, `seq` | A random id per request and a counter per write; the document id is `<requestId>_<seq>`. |
| `effectPaths` | The document paths the write touched (or `external:<kind>` for a provider dispatch). |
| `rows` | The request's audit rows collected before this write and not yet staged by an earlier committed write: normalised (id, firmId, at filled in place, as the flush does) and JSON-copied. At most 200 rows and about 512 KiB. |
| `stagedAt` | When it was staged. |
| `attempts` | Reconciler failures counted against it (ruling 7). |

### 2.2 Staging: in the effect's own commit

Every Next Firestore write goes through the four helpers of `firestoreDbModular.ts` (F10's static guard, `tests/f10-write-fence-guard.test.ts`). While a request runs inside `withSession`, the request's outbox session (installed by `platform/persistence/auditOutbox.ts`, as `idempotency.ts` installs the write fence) is consulted by every helper:

- **Fenced write** (the request holds a durable claim): the outbox entry is set inside the fence's transaction, after the effect write. One commit carries the effect, the F10 marker and the outbox entry.
- **Unfenced write** (no durable claim, e.g. a GET that persists derived state): `setDoc` / `updateDoc` / `deleteDoc` commit the effect and the entry in one batch.
- **`runTransaction`**: the paths the repository's transaction function staged are collected; after it returns, the entry is set in the same transaction (a write after the reads, so the Admin SDK's read-before-write rule holds).
- **Provider dispatch** (`recordExternalEffect("p1_dispatch")`): the entry is set in the transaction that creates the F10 marker before the dispatch, with `effectPaths: ["external:p1_dispatch"]`.
- **Not effects**: writes to `audit_log`, `audit_dead_letter`, `audit_outbox`, `idempotency_keys` and `idempotency_effects` stage nothing (the audit itself, and F10's bookkeeping).
- **Client (modular) SDK**: a write inside a request with an outbox is refused, as F10 refuses a fenced one; the production database is the Admin SDK.

If the transaction or batch fails, neither the effect nor the entry exists. If it commits, both do. A row is marked staged only after its commit, so a retried or failed write re-stages it with the next write.

### 2.3 The request lifecycle

1. `withSession` opens the request's outbox (session firm, user, route, body action) around the handler.
2. The handler runs; each effect write stages its entry (§2.2).
3. The end-of-request flush appends the request's rows to `audit_log`, as before (normal path unchanged; ruling 3).
4. If every row of the request persisted, the request deletes its outbox entries (`releaseRequestOutbox`). A failed delete is logged; the reconciler then publishes the entry, whose rows already exist (ruling 6).
5. If the flush failed, the request answers 503 `AUDIT_UNAVAILABLE` as before and leaves its entries for the reconciler.
6. If the process dies anywhere after a commit, its entries stay. Nothing depends on the process any more.

### 2.4 The reconciler

`auditOutboxReconciler`, a Cloud Functions scheduled function (`functions/src/p5/auditOutboxReconciler.ts`), every minute, timeout 45 s, wall-clock budget 30 s: the pattern of `p1ReservationReconciler` and `jobSweeper` (ruling 4). The work is `reconcileAuditOutbox(deps)` in `functions/src/p5/auditOutbox.ts`, which takes its database, clock and logger as arguments.

One run:
1. Reads the entries staged at or before `now - AUDIT_OUTBOX_GRACE_MS` (10 minutes), oldest first, up to 5 pages of 100.
2. Publishes each in its own transaction:
   - Reads the entry (gone: someone published it; skip), every staged row's `audit_log/{id}`, and the recovered row's `audit_log/aud_outbox_<entryId>`.
   - Creates every valid staged row that is absent. An existing row with that id is never overwritten (the audit log is insert-only); it was published by its own request and counts as `superseded`.
   - Creates the **recovered row** (ruling 2): `action: "request_effect_recovered"`, `actorId: "system"`, `onBehalfOf: <request actor>`, `target: <first effect path>`, `effectPaths`, `route`, `requestAction`, `operationId`, `requestId`, `stagedRowIds`, `classification: "privileged-restricted"`, `reason: "audit_unconfirmed"`, `at: <stagedAt>`, `recoveredAt`.
   - Writes a dead letter for every poisoned row (ruling 7).
   - Deletes the entry.
3. Measures the backlog (the oldest entry's age, and how many are past the grace) and keeps the alert state (ruling 9).

Exactly once: every row it creates has a deterministic id, the create is conditional on the read in the same transaction, and the entry is deleted in that transaction. Two runs that race serialise on the entry document; the second finds it gone.

### 2.5 The dead letter (F12-LOW-2)

A letter is `{ row, reason, deadLetteredAt, firmId, source?, outboxId? }`. The top-level `firmId` is the firm that owns the letter: the row's firm for a letter the Next process writes, the entry's (request's) firm for one the reconciler writes. `listByFirm(firmId)` is the firm-scoped, fully paged query on that top-level `firmId`, plus, for letters stored before this change (they carry only `row.firmId`), the query on `row.firmId` keeping only letters with no top-level `firmId`. The memory adapter applies the same rule.

### 2.6 Composition with F10

- `audit_outbox` joins F10's `UNFENCED_COLLECTIONS`: the release delete is not an effect, never takes the fence, and never creates a marker.
- The fence object carries its `operationId`, which the entry records, so the recovered row and the 409 `idempotency_effect_committed` name the same operation.
- `markEffect(kind, outbox?)` stages the entry in the marker's transaction.
- A same-key retry on another instance after a crash answers 409 `idempotency_in_progress` within the lease, then 409 `idempotency_effect_committed`. It writes nothing, so it stages nothing, and the dead attempt's entries are published once by the reconciler.

### 2.7 Firm isolation

- Staged rows: a request's entry holds only rows of its own request audit context (AsyncLocalStorage, by object), and the entry's `firmId` is the session firm.
- Reconciler: a staged row whose `firmId` is not the entry's firm is not published; it goes to the dead letter under the entry's firm (`cross_firm_row`). An entry with no firm is dead-lettered whole (`entry_no_firm`).
- Dead letter: `listByFirm` returns only letters the firm owns (§2.5).

### 2.8 Test seams

No new production seam. The e2e simulates the crash by stopping firebase-admin's own prototypes in the test process (every transaction, batch commit, document write and read hangs after the chosen commit), which a deployed process cannot reach. The existing `setRequestAuditSinkForTests` gains a production guard: it refuses unless the process runs under the test runner (`VITEST=true`), so a deployed process can never swap the audit sink (the F01/F12 auditor's request for such hooks).

## 3. Rulings

| # | Decision | Ruling | Reason |
| --- | --- | --- | --- |
| 1 | One outbox document per request, or per effect write | **Per effect write** | A per-request document would be rewritten by every write of the request: a hot document (Firestore's sustained limit is about one write per second per document), contention between a request's concurrent writes, and a read-before-write inside each effect transaction. A per-write document is a blind create in the effect's own commit, and exactly-once publication follows from its id. |
| 2 | What becomes the audit row when the request died after its last write | **A recovered row per entry, synthesised by the reconciler**, plus every staged row unchanged | Handlers push their action row (`client_create`, `matter_create`) after their writes. Reordering hundreds of handler paths would audit effects that later fail. The recovered row is "an outbox row that becomes the audit row": who (`onBehalfOf`), which firm, which route and action, which documents, which F10 operation, when. Actor `system` with `onBehalfOf` follows P3-18 and `ai.gateway.reconciled`: the row is written by the system about a user's action. `privileged-restricted` fails closed: the effect paths can name a privileged matter's documents. |
| 3 | The normal path | **Unchanged** (flush, then release); 503 `AUDIT_UNAVAILABLE` kept on a failed flush | The flush is now only the fast path; durability comes from the staged entry. A POST whose post-write rows did not persist still answers 503: only its staged rows and the recovered row are durable, and the existing tests pin the 503. |
| 4 | Where the reconciler runs | **A Cloud Functions scheduled function**, not a P2 job and not a Next route | O-22 says "drain them with a P2 job". A P2 scheduled job runs per firm per period (hourly at the finest), and every job writes its own `job.*` audit rows, so a per-minute drain would flood the log it drains. The repo's crash-window reconcilers (`p1ReservationReconciler`, the P2 `jobSweeper`) are one-minute scheduled functions; this follows them. The Next app has no scheduler and no system caller. |
| 5 | Grace and alert thresholds | Grace **10 min**; alert at **20 min** | The grace is twice F10's 5-minute lease and far above any route's `maxDuration` (60 s), so a live request is never published under it. The alert leaves ten one-minute runs after the grace. |
| 6 | An `audit_log` row with the staged row's id already exists | **Skip it** (counted `superseded`); never overwrite | The log is insert-only (`AuditAppendConflictError`). The request's own flush or a handler's own `repos.audit.append` (p5/tenancy) wrote it, possibly an enriched copy under the same id. |
| 7 | Poison and retries | A malformed entry, or one with no firm, is dead-lettered whole at once. A malformed or cross-firm row is dead-lettered alone; the rest is published. A non-retryable commit failure counts on the entry (`attempts`); at 3 the entry is dead-lettered whole. Retryable failures (contention, `ABORTED`, `UNAVAILABLE` and the rest of P1's set) are never counted | P1 reconciler parity (re-audit R1-D2, R2-D1): store faults that a later run may not meet must not quarantine a valid record. |
| 8 | Dead-letter firm scope (F12-LOW-2) | Store a top-level `firmId`; list by it, plus the legacy letters by `row.firmId` | The F12 helpers (firm-scoped query, cursor validated against top-level `firmId`) apply unchanged, and letters already stored stay listable without a migration. |
| 9 | The backlog alert | Structured logs, the P2/P1 pattern: `audit.outbox_backlog_stale` at ERROR on every run while the oldest entry is older than 20 minutes; `audit.outbox_backlog_cleared` at INFO on the run that sees it drained. State in `platform/auditOutboxBacklog` (server-only) | P2's dead-letter alert is `logger.error("job.deadLettered")` with a log-based alert policy at deploy (O-30); F28 raises its alerts per run while the condition holds. The state document gives the transition and lets an operator read the backlog. |
| 10 | F10 files touched | `durableIdempotency.ts` (`audit_outbox` unfenced; the fence exposes `operationId`; `markEffect` takes an optional outbox) and `idempotency.ts` (`recordExternalEffect` passes it) | Composition with F10 requires it; each change is additive and F10's tests keep their expectations. |
| 11 | A client (modular) SDK write inside a request | Refused while an outbox is open | It has no admin-style transaction or batch to stage in. F10 refuses it already when fenced. |
| 12 | Test seams | No new production seam; `setRequestAuditSinkForTests` refuses outside the test runner | The crash is simulated in the test by stopping firebase-admin's prototypes. |
| 13 | Index cost of the staged rows | `fieldOverrides` exempt `audit_outbox.rows` and `audit_outbox.effectPaths` from indexing | No query reads them; indexing every nested row field costs write throughput and index entries. |
| 14 | Entry size | At most 200 rows and about 512 KiB per entry | A Firestore document holds 1 MiB. Rows beyond the cap stay unstaged: the next write stages them, the flush publishes them, and the recovered row records the effect if neither happens. |
| 15 | A write by a request with no session | Staged with `firmId: null`; the reconciler dead-letters it (`entry_no_firm`) | No public route writes today. Fail closed into the durable dead letter rather than guess a firm. |
| 16 | Document bytes in the object store | Not staged | An object PUT is not a Firestore write. An object whose `documents` row never committed is unreachable through the app; the row's own write stages the entry. Orphaned objects are F03's. |
| 17 | Changed test expectations | The Functions export lists (`functions/test/p2.boot.test.ts`, `functions/test/p5.identity.test.ts`) and the G-2 `NOT_TENANT_ENDPOINTS` list gain `auditOutboxReconciler` | A new deployed function. |

## 4. Survey: the Next routes that write

`app/api/**` has 13 route files. `g0/monitor` (public GET) and `g0/normalise` write nothing to Firestore (normalise only claims an idempotency key). The other 11 write through the repositories, and every repository write goes through the four helpers (F10's static guard): d1/clients, d1/matters, d1/documents, d1/document-workflow, d1/reporting, d2/court-ops, d2/ops-reporting, d4/drafts, d4/filings, p1/committee-brain, p5/tenancy. Each therefore stages its entries in its own writes, GET and POST alike, without a route change. `p1/committee-brain` also stages at its provider dispatch (§2.2). No Next route uses Postgres.

## 5. Failure modes considered

| Failure | Outcome |
| --- | --- |
| Crash after an effect commit, before the flush | The entry stays; the reconciler publishes its rows and the recovered row once, after the grace. |
| Crash between two effect writes | The first write's entry stays; F10 never re-runs the request; the reconciler publishes. |
| The effect transaction fails | Neither the effect nor its entry commits. |
| A transaction retried by the SDK under contention | Each attempt sets the same entry id; only the committed attempt counts; rows are marked staged after the commit. |
| The flush fails (store down) | 503 as before; the entries stay; the reconciler publishes them. |
| The flush succeeds, the release fails | The reconciler finds the rows present (superseded) and writes the recovered row: a benign extra row naming the request. |
| A request still running past the grace | The reconciler publishes its staged rows; the request's own flush then appends the rest; identical rows are no-ops. |
| Two reconciler runs at once | One transaction per entry; the second finds the entry gone. |
| A staged row malformed or of another firm | Dead-lettered under the entry's firm; the rest published. |
| The audit store fails for the reconciler | Retryable: next run, uncounted. Persistent non-retryable: three counted runs, then the dead letter. The backlog alert fires at 20 minutes either way. |
| Same-key retry on another instance | No effect, no entry; the 409 carries the operationId the recovered row records. |

## 6. Files that change

- `platform/persistence/auditOutboxContract.ts` (new): the entry shape, validation, the recovered row, the dead-letter shape, the constants. No SDK import; shared by Next and Functions.
- `platform/persistence/auditOutbox.ts` (new): the request outbox session, staging rows, the release.
- `platform/persistence/firestoreDbModular.ts`: the four helpers stage the entry; the external-effect hook.
- `platform/http/withSession.ts`: opens the outbox around the handler; releases it after a successful flush.
- `platform/persistence/requestAuditFlush.ts`: the production guard on the sink seam.
- `platform/http/durableIdempotency.ts`, `platform/http/idempotency.ts`: ruling 10.
- `platform/persistence/firestoreSpineRepositories.ts`, `platform/persistence/spineRepositories.ts`, `platform/audit/requestAudit.ts`: the dead-letter firm scope (§2.5).
- `functions/src/p5/auditOutbox.ts`, `functions/src/p5/auditOutboxReconciler.ts` (new), `functions/src/index.ts` (one export line).
- `platform/persistence/firmScopedList.ts` (`listAllRowsByFirmField`), `firestoreDbModular.ts` (`queryByFieldEquals`): the paged legacy dead-letter listing.
- Functions tests: `functions/test/f11-audit-outbox.emu.test.ts` (new); the export lists in `p2.boot`, `p5.identity` and the G-2 `NOT_TENANT_ENDPOINTS` (ruling 17).
- `firestore.rules` (`audit_outbox` server-only), `firestore.indexes.json` (ruling 13).
- `package.json` (`test:rules` runs the new emulator files), `vitest.config.ts` (excludes them without emulators).

## 7. Tests

- `tests/f11-atomic-request-audit.e2e.firestore.test.ts`: the real flow. `POST /api/d1/clients` through `withSession`, `NODE_ENV=production`, Firebase auth with Auth-emulator ID tokens, Firestore mode on the emulator. The crash: the test stops firebase-admin's prototypes right after a chosen commit. RED on main; GREEN for every property the brief lists.
- `tests/f11-audit-outbox.firestore.test.ts`: the helpers stage in the same commit or not at all (fenced, unfenced, transaction, external effect, excluded collections, no request); the reconciler's exactly-once, poison, attempts, alert and isolation; the dead-letter `listByFirm` on Firestore.
- `tests/f11-audit-outbox.unit.test.ts`: the contract, the memory `listByFirm`, the sink seam guard, the client-SDK refusal (ruling 11).
- `functions/test/f11-audit-outbox.emu.test.ts`: the reconciler on the Functions package's own firebase-admin (the deployed one): racing runs publish once, a poisoned row is dead-lettered, the alert fires and clears.

## 8. Deploy and consumer impact

- Deploy the Functions codebase (`auditOutboxReconciler`) together with or before the Next app, so a staged entry always has a drain. Until the reconciler is deployed, entries accumulate; nothing is lost.
- Create the log-based alert policies at deploy: ERROR `audit.outbox_backlog_stale` and ERROR `audit.outbox_dead_lettered` / `audit.outbox_row_dead_lettered` (the O-30 pattern of `job.deadLettered`).
- Deploy `firestore.rules` and `firestore.indexes.json` (the field overrides).
- In-flight audit rows at the switch-over: rows on a running instance's retry queue are still flushed by that instance as before; nothing is migrated. Dead letters already stored stay listable (§2.5).
- Write volume: each effect write adds one document to its own commit, and each request with effects deletes its entries at the end.

## 9. Residual risk

- Rows a handler pushes after its last effect write are durable only through the flush; a crash there leaves the recovered row in their place, not the rows themselves.
- A row mutated in memory after it was staged and before the flush can conflict with the reconciler's copy if the request outlives the grace (more than 10 minutes); the flush then answers 503 and dead-letters the row through the existing path.
- A deployment without the reconciler, or without the alert policies, leaves the backlog undrained or unwatched; the state document still shows it.
- The object-store bytes of a document whose row never committed (ruling 16).
- The reconciler's range query sees only entries whose `stagedAt` is a timestamp. The Next process always writes a `Date`; an entry written otherwise (by hand) is neither published nor counted in the backlog.
- Each effect commit carries one more write. A repository transaction that already writes Firestore's per-commit maximum would exceed it by one; no Next repository transaction writes near that many documents today.
- A fire-and-forget effect write that a handler leaves running after the response would stage an entry after the release; the reconciler then publishes it, its rows already present (superseded), with a recovered row.

## 10. Amendments in execution (2026-10-18)

- A1. Rows are normalised (id, firm, time) when they are staged, not at the flush. A staged row's `at` is the time of the write that staged it, and the flush persists the same object with the same id and content.
- A2. The dispatch staging rides on F10's `markEffect(kind, outbox)`. The outbox write lives in a non-exported helper of `firestoreDbModular.ts` and runs only inside the fenced transaction; F10's static guard still finds exactly the four fenced writers.
- A3. A request whose flush has no rows cannot fail it, so it releases its entries even when the sink fails. That is correct (no row is owed); two staging tests push a row so that their failing flush keeps the entries.
- A4. Main 957fe26 (F37's `d1ConflictReindexTick`) was merged; the Functions export lists hold both new functions.
- A5. Observation from the full `test:rules` set: another file's scenario (a request whose flush fails in Firestore mode) leaves one outbox entry in the emulator. In production such an entry is what the reconciler drains.
