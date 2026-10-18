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
4. If the flush succeeded **and the request reached its audited end** (ruling 18: the handler returned a 2xx, every idempotency claim it took is completed, and, for a request with a body, at least one persisted row is an action row rather than a `permission_check` decision), the request deletes its outbox entries (`RequestOutbox.release`). A failed delete is logged; the reconciler then publishes the entry, whose rows already exist (ruling 6).
5. If the flush succeeded but the request stopped short of that end (a refusal or a failure after a commit, a throw, a claim left open, an action that wrote but recorded no action), the entries stay and a warning names the route; the reconciler publishes each entry's recovered row after the grace.
6. If the flush failed, the request answers 503 `AUDIT_UNAVAILABLE` as before and leaves its entries for the reconciler.
7. If the process dies anywhere after a commit, its entries stay. Nothing depends on the process any more.

### 2.4 The reconciler

`auditOutboxReconciler`, a Cloud Functions scheduled function (`functions/src/p5/auditOutboxReconciler.ts`), every minute, timeout 45 s, wall-clock budget 30 s: the pattern of `p1ReservationReconciler` and `jobSweeper` (ruling 4). The work is `reconcileAuditOutbox(deps)` in `functions/src/p5/auditOutbox.ts`, which takes its database, clock and logger as arguments.

One run:
0. **The sweep** (ruling 19). Retries the entries on the sweep's pending list, then reads one page (200) of the outbox by document id after the cursor in `platform/auditOutboxSweepCursor`, and dead-letters whole (`entry_malformed`) every entry the pass below cannot reach: its `stagedAt` is missing or is not a Firestore Timestamp (a number, a string, a map, null), or is a Timestamp more than 24 hours ahead. Each dead-letter is a transaction that re-reads the entry. The cursor moves only past entries handled, stays on the last handled id when the budget runs out, and wraps to the start after a short or empty page. An entry it cannot dead-letter goes on the pending list (at most 100) and counts as `unreadable`.
1. Reads the entries staged at or before `now - AUDIT_OUTBOX_GRACE_MS` (10 minutes), oldest first, up to 5 pages of 100.
2. Publishes each in its own transaction:
   - Reads the entry (gone: someone published it; skip), every staged row's `audit_log/{id}`, and the recovered row's `audit_log/aud_outbox_<entryId>`.
   - Creates every valid staged row that is absent. An existing row with that id is never overwritten (the audit log is insert-only); it was published by its own request and counts as `superseded`.
   - Creates the **recovered row** (ruling 2): `action: "request_effect_recovered"`, `actorId: "system"`, `onBehalfOf: <request actor>`, `target: <first effect path>`, `effectPaths`, `route`, `requestAction`, `operationId`, `requestId`, `stagedRowIds`, `classification: "privileged-restricted"`, `reason: "audit_unconfirmed"`, `at: <stagedAt>`, `recoveredAt`.
   - Writes a dead letter for every poisoned row (ruling 7).
   - Deletes the entry.
3. Measures the backlog (the oldest Timestamp entry's age, how many are past the grace, and the sweep's `unreadable` count) and keeps the alert state (ruling 9). The alert fires while the oldest entry is at least 20 minutes old or `unreadable` is above zero. The oldest-entry query is restricted to Timestamps (`stagedAt >= 0001-01-01`), because a null `stagedAt` sorts before every Timestamp and would hide the oldest age. A run whose sweep failed keeps the last stored `unreadable` count.

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
| 3 | The normal path | **Unchanged** (flush, then release; the release is conditional since review round 1, ruling 18); 503 `AUDIT_UNAVAILABLE` kept on a failed flush | The flush is now only the fast path; durability comes from the staged entry. A POST whose post-write rows did not persist still answers 503: only its staged rows and the recovered row are durable, and the existing tests pin the 503. |
| 4 | Where the reconciler runs | **A Cloud Functions scheduled function**, not a P2 job and not a Next route | O-22 says "drain them with a P2 job". A P2 scheduled job runs per firm per period (hourly at the finest), and every job writes its own `job.*` audit rows, so a per-minute drain would flood the log it drains. The repo's crash-window reconcilers (`p1ReservationReconciler`, the P2 `jobSweeper`) are one-minute scheduled functions; this follows them. The Next app has no scheduler and no system caller. |
| 5 | Grace and alert thresholds | Grace **10 min**; alert at **20 min** | The grace is twice F10's 5-minute lease (after which F10 already treats an attempt as dead) and ten times the one `maxDuration` a route declares (60 s, `d1/documents`), so a live request is not published under it; one that does outlive it is the residual in §9. The alert leaves ten one-minute runs after the grace. |
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
| 18 | When a request may delete its entries (review round 1, Codex P1, PR #86) | **Only when it reached its audited end**: the flush succeeded, the handler returned (did not throw) a 2xx, every idempotency claim it took is completed (`requestClaimsCompleted`), and, for a request with a body, at least one persisted row is an action row (not `permission_check`). A GET or HEAD needs only the 2xx. Otherwise the entries stay, and the reconciler writes one `request_effect_recovered` row per entry after the grace | Before, a successful flush released every entry. A handler that committed an early write and then failed before pushing its action row (client create: the entity commits, then its search-index write fails and the route answers 400 `REQUEST_FAILED`) still flushed its decision rows, or nothing, and the release deleted the only durable record of the committed entity. The test is per request, not per entry. A row names a business target, not the documents written, and one action writes several documents (the entity, then its search-index row), so no row can be matched to an entry. What can be decided is whether the request finished: a completed claim means the route stored its success payload after its effects; an action row means the route audited an action. A GET writes only state derived under the read it audits (reports, drafts, snapshots; §4), so its 2xx suffices. The rule covers every handler, whatever its number of writes, without a route change; the survey in §4 checks the routes that write more than once. A row the request flushed is never written twice: the reconciler's creates are insert-only, under the same ids (ruling 6). |
| 19 | Entries the reconciler's queries cannot see (review round 1, Codex P2, PR #86) | **A bounded sweep by document id every run**, before the pass: it dead-letters whole (`entry_malformed`) every entry whose `stagedAt` is not a Firestore Timestamp, or is one more than 24 hours ahead. The cursor is persisted, moves only past handled entries, keeps its place when the budget runs out, and wraps after a short or empty page. Entries it cannot dead-letter are kept on a pending list (at most 100), retried each run, and counted as `unreadable`, which fires the backlog alert. The backlog's oldest-age query is restricted to Timestamps | A range filter on `stagedAt` matches one value type, Timestamps. An entry with no `stagedAt`, or with any other type of value, is invisible to the pass and to the backlog's stale count. A null value sorts before every Timestamp, so it also hid the oldest age. Such an entry would never be published, dead-lettered or counted. No Firestore query selects a missing field, so only a scan reaches it. The scan is bounded (one page of 200 by id, plus the pending list) so that a run's reads stay fixed however large the outbox grows; the cursor visits every entry once per wrap. Dead-lettering rather than publishing: the Next process always writes a `Date`, so such an entry was not written by it, and its time cannot be trusted as the recovered row's `at`; the letter keeps the rows and the recovered row it would have made. A Timestamp more than a day ahead is not clock skew; that entry would wait unseen until its time came. |

## 4. Survey: the Next routes that write

`app/api/**` has 13 route files. `g0/monitor` (public GET) and `g0/normalise` write nothing to Firestore (normalise only claims an idempotency key). The other 11 write through the repositories, and every repository write goes through the four helpers (F10's static guard): d1/clients, d1/matters, d1/documents, d1/document-workflow, d1/reporting, d2/court-ops, d2/ops-reporting, d4/drafts, d4/filings, p1/committee-brain, p5/tenancy. Each therefore stages its entries in its own writes, GET and POST alike, without a route change. `p1/committee-brain` also stages at its provider dispatch (§2.2). No Next route uses Postgres.

**Review round 1 survey (ruling 18): the handlers that write more than once.** Every request in the Firestore-mode route suites (the 18 files of `test:rules`, 736 tests, all passing) was logged by temporary instrumentation, which was not committed. For each request the log recorded its committed outbox entries and their collections, its rows, its status, whether its claims were completed, and the release decision.
- 288 requests to the real routes committed at least one effect write, and 236 committed two or more. Of the 236, 231 reached their audited end and released their entries: `d1/clients` create, `d1/document-workflow` transition, `d1/documents` ingest, `d1/matters` create, confirm_engagement and record_case_number, `d1/reporting` record_matter_report_export, `d2/court-ops` resolve_follow_up and resolve_workflow, every `d2/ops-reporting` action (about 148 writes each), `d4/drafts` compose, the `d4/filings` actions, and the `p5/tenancy` actions. Each of these records its own action row on success.
- The other 5 wrote and then refused or failed, and kept their entries. They are client create 400 after the entity and its search-index row, document ingest 400, filings resolve_closure_followup 422 after five writes, and committee-brain twice.
- Successful GETs that write derived state are released on their 2xx: `d1/reporting` (search index, export analytics, relevance snapshots), `d2/ops-reporting` (alert digests and ledgers, 435 writes a request), `d4/drafts` (template analytics), `d4/filings` (escalation rota and digests), and `p5/tenancy` (lineage ledgers). One `p5/tenancy` GET wrote a session reference and then answered 410; it kept its entry.
- **One gap, fixed in this round.** `POST /api/p1/committee-brain` stores its output (and stages its provider dispatch) and recorded only `permission_check` decisions, so every successful call kept its entries (6 of 6 in the survey) and would have been audited only by recovered rows. The route now records `committee_brain_output_create` (actor, firm, output id, classification, `purpose:answered|blocked`; never the text) after the output commits. Test: `tests/f16-next-output-size.firestore.test.ts` (RED without the row, GREEN with it).

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
| A request commits a write, then refuses, fails, throws, leaves its claim open, or records no action (review round 1) | Its flush may succeed (decision rows, or none), but it did not reach its audited end (ruling 18): the entries stay and each gets its recovered row from the reconciler after the grace. |
| An entry whose `stagedAt` is missing, not a Timestamp, or more than a day ahead (review round 1) | The sweep dead-letters it whole within one wrap of its cursor (ruling 19); while it cannot, it is pending and counted, and the alert fires. |
| Same-key retry on another instance | No effect, no entry; the 409 carries the operationId the recovered row records. |

## 6. Files that change

- `platform/persistence/auditOutboxContract.ts` (new): the entry shape, validation, the recovered row, the dead-letter shape, the constants. No SDK import; shared by Next and Functions.
- `platform/persistence/auditOutbox.ts` (new): the request outbox session, staging rows, the release.
- `platform/persistence/firestoreDbModular.ts`: the four helpers stage the entry; the external-effect hook.
- `platform/http/withSession.ts`: opens the outbox around the handler; releases it after a successful flush only when the request reached its audited end (`reachedAuditedEnd`, ruling 18). `platform/http/idempotency.ts` gains `requestClaimsCompleted()` for it.
- `platform/persistence/requestAuditFlush.ts`: the production guard on the sink seam.
- `platform/http/durableIdempotency.ts`, `platform/http/idempotency.ts`: ruling 10.
- `platform/persistence/firestoreSpineRepositories.ts`, `platform/persistence/spineRepositories.ts`, `platform/audit/requestAudit.ts`: the dead-letter firm scope (§2.5).
- `functions/src/p5/auditOutbox.ts`, `functions/src/p5/auditOutboxReconciler.ts` (new), `functions/src/index.ts` (one export line). Review round 1: the sweep, its cursor document `platform/auditOutboxSweepCursor`, and the backlog's `unreadable` count (ruling 19).
- `app/api/p1/committee-brain/route.ts` (review round 1): records `committee_brain_output_create` after the output commits (§4); its test is in `tests/f16-next-output-size.firestore.test.ts`.
- `platform/persistence/firmScopedList.ts` (`listAllRowsByFirmField`), `firestoreDbModular.ts` (`queryByFieldEquals`): the paged legacy dead-letter listing.
- Functions tests: `functions/test/f11-audit-outbox.emu.test.ts` (new); the export lists in `p2.boot`, `p5.identity` and the G-2 `NOT_TENANT_ENDPOINTS` (ruling 17).
- `firestore.rules` (`audit_outbox` server-only), `firestore.indexes.json` (ruling 13).
- `package.json` (`test:rules` runs the new emulator files), `vitest.config.ts` (excludes them without emulators).

## 7. Tests

- `tests/f11-atomic-request-audit.e2e.firestore.test.ts`: the real flow. `POST /api/d1/clients` through `withSession`, `NODE_ENV=production`, Firebase auth with Auth-emulator ID tokens, Firestore mode on the emulator. The crash: the test stops firebase-admin's prototypes right after a chosen commit. RED on main; GREEN for every property the brief lists.
- `tests/f11-audit-outbox.firestore.test.ts`: the helpers stage in the same commit or not at all (fenced, unfenced, transaction, external effect, excluded collections, no request); the reconciler's exactly-once, poison, attempts, alert and isolation; the dead-letter `listByFirm` on Firestore.
- `tests/f11-audit-outbox.unit.test.ts`: the contract, the memory `listByFirm`, the sink seam guard, the client-SDK refusal (ruling 11).
- `functions/test/f11-audit-outbox.emu.test.ts`: the reconciler on the Functions package's own firebase-admin (the deployed one): racing runs publish once, a poisoned row is dead-lettered, the alert fires and clears, and the sweep walks the outbox by id (one-entry pages) to dead-letter an entry with no `stagedAt`.
- Review round 1 (rulings 18, 19). The e2e: the real client create with the search-index commit refused after the entity commits answers 400; the entity keeps its entry and gets exactly one audit row after recovery. The Firestore file covers ruling 18 case by case: kept after a 400, a throw (409), decision rows only, an open claim, a claimless POST with decision rows only, and a GET's derived write followed by a 404; released for a completed action, a claimless action with its row, and a GET's 2xx. It also covers ruling 19: missing, text, number, Timestamp-shaped map, null, and a year ahead are all dead-lettered; an entry that cannot be dead-lettered is counted and fires the alert; the cursor walks the outbox in bounded pages and wraps after a short page and after a full page followed by an empty one; a run stopped by the budget keeps the cursor on its last handled entry; a full pending list stops the cursor; a null `stagedAt` does not hide the oldest age.

## 8. Deploy and consumer impact

- Deploy the Functions codebase (`auditOutboxReconciler`) together with or before the Next app, so a staged entry always has a drain. Until the reconciler is deployed, entries accumulate; nothing is lost.
- Create the log-based alert policies at deploy: ERROR `audit.outbox_backlog_stale` and ERROR `audit.outbox_dead_lettered` / `audit.outbox_row_dead_lettered` (the O-30 pattern of `job.deadLettered`).
- Deploy `firestore.rules` and `firestore.indexes.json` (the field overrides).
- In-flight audit rows at the switch-over: rows on a running instance's retry queue are still flushed by that instance as before; nothing is migrated. Dead letters already stored stay listable (§2.5).
- Write volume: each effect write adds one document to its own commit, and each request with effects deletes its entries at the end.
- Review round 1: a request that commits a write and then stops short of its audited end keeps its entries; ten minutes later each one gets a `request_effect_recovered` row (ruling 18). `POST /api/p1/committee-brain` now records `committee_brain_output_create` per call. The reconciler reads up to 200 outbox entries a minute for the sweep (plus up to 100 pending), keeps its cursor in `platform/auditOutboxSweepCursor`, and adds `unreadable` to `platform/auditOutboxBacklog`.

## 9. Residual risk

- Rows a handler pushes after its last effect write are durable only through the flush; a crash there leaves the recovered row in their place, not the rows themselves.
- A row mutated in memory after it was staged and before the flush can conflict with the reconciler's copy if the request outlives the grace (more than 10 minutes); the flush then answers 503 and dead-letters the row through the existing path.
- A deployment without the reconciler, or without the alert policies, leaves the backlog undrained or unwatched; the state document still shows it.
- The object-store bytes of a document whose row never committed (ruling 16).
- Ruling 18 is per request. A request that reached its audited end releases all its entries, so an effect that none of the route's action rows describes is not detected; what each route audits is the route's design (F11 does not change it). A GET's derived writes are released on a 2xx under its decision rows.
- Ruling 18 adds rows. Every request that commits a write and then stops short of its audited end now gets one `request_effect_recovered` row per entry, ten minutes later, even when an earlier action row of the same request persisted. Such effects had no durable audit before.
- The sweep reads up to 200 entries a minute (plus up to 100 pending). An outbox larger than one page is swept once per wrap, so an unusable entry can wait (outbox size / 200) minutes. When the pending list is full, the cursor waits at the next such entry until the list drains, and the alert fires meanwhile.
- A `stagedAt` up to 24 hours ahead (clock skew) is waited on, not swept.
- Open (LOW, from the independent re-audit at f43e936; follow-ups, not fixed here): `stageableRows` measures the 512 KiB row cap in JSON string length (UTF-16 code units), not UTF-8 bytes. Non-ASCII text takes up to 3 bytes per code unit, so an entry under the cap could pass the 1 MiB document limit, and the effect's commit would then be refused. `tests/f11-audit-outbox.firestore.test.ts` leaves 5 `audit_log` documents per run in the emulator. The auditor's surviving mutants are listed in the plan.
- Each effect commit carries one more write. Today every Next effect commit writes one document (the two repository transactions, `filingPackages.decideIfPending` and `audit.append`, write one each), so a commit is at most the effect, the F10 marker and the entry; a future multi-document transaction near Firestore's per-commit maximum would need room for the entry.
- A fire-and-forget effect write that a handler leaves running after the response would stage an entry after the release; the reconciler then publishes it, its rows already present (superseded), with a recovered row.

## 10. Amendments in execution (2026-10-18)

- A1. Rows are normalised (id, firm, time) when they are staged, not at the flush. A staged row's `at` is the time of the write that staged it, and the flush persists the same object with the same id and content.
- A2. The dispatch staging rides on F10's `markEffect(kind, outbox)`. The outbox write lives in a non-exported helper of `firestoreDbModular.ts` and runs only inside the fenced transaction; F10's static guard still finds exactly the four fenced writers.
- A3. A request whose flush has no rows cannot fail it, so it releases its entries even when the sink fails. That is correct (no row is owed); two staging tests push a row so that their failing flush keeps the entries.
- A4. Main 957fe26 (F37's `d1ConflictReindexTick`) was merged; the Functions export lists hold both new functions.
- A5. Observation from the full `test:rules` set: another file's scenario (a request whose flush fails in Firestore mode) leaves one outbox entry in the emulator. In production such an entry is what the reconciler drains.
- A6. Review round 1 (PR #86): Codex P1 (thread 4307160231) and P2 (4307160234), with Bugbot duplicates and follow-ups (4307209436, 4307209440, 4307237669, 4307237674, 4307255060, 4307293100). RED first (3665687), then rulings 18 and 19.
- A7. Three commits pushed to the branch by Bugbot Autofix (7a4b1aa, d127765, 1e141d3) were reviewed and reverted in a new commit (9ad5482; no history rewrite). Their release rule freed every claimless 2xx request. Their sweep counted unreadable entries by reading the whole outbox each run, value-imported the Functions package's v13 `FieldPath`/`FieldValue` into the reconciler core (every run on the root v14 SDK threw, so 18 of the 33 F11 emulator tests failed), ran only after the pass with budget left, pinned its cursor behind an entry it could not dead-letter, published numeric-`stagedAt` entries, and left the null-sort hole in the oldest-age query. Rulings 18 and 19 are this branch's own implementation.
- A8. Main c02ebbc (F38 #84) was merged in f43e936 with no conflict; `firestore.rules` and `firestore.indexes.json` merged beside `audit_outbox`'s rule and field overrides.
- A9. Main ac69873 (F18 #88) was merged in 5e24c50. `package.json` (`test:rules`) and `vitest.config.ts` conflicted on their test lists, and both sides' entries were kept. `app/api/p1/committee-brain/route.ts` merged automatically and was reviewed by hand against F18's R1, R4 and R6. Ruling 18 on each of the route's paths:
  - **Forward (a Firebase session with a Functions URL).** Next writes nothing (F18 R6), so it stages no entry and needs no action row of its own. Functions writes the output row and its audit.
  - **Forward failure (503, 504, 502).** Again no Next entry. Whatever Functions did is audited by Functions.
  - **Local pipeline (insecure-dev, no Functions URL, or a provider key in production).** It writes the blocked or answered output row, staging an entry, and records `committee_brain_output_create`, so the request releases on its 2xx.
  - **Tests.** A new case in `tests/f18-legacy-ai-path.e2e.firestore.test.ts` (production, Firebase sessions, the Functions router in process) finds no outbox entry for the firm after a forwarded 200, after a forward 503, or after a local blocked 200 with a key present. It also finds exactly one `committee_brain_output_create` row and no `request_effect_recovered` row. That file now sweeps `audit_outbox` with the rest. The insecure-dev local path is `tests/f16-next-output-size.firestore.test.ts`. Dropping the route's row fails both cases.
