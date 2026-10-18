# F10: durable Next.js idempotency with an atomic effect fence

Audit finding **F10** (HIGH, `docs/audit/2026-10-13-forensic-audit.md`; v2 status OPEN at `platform/http/idempotency.ts:31,97`): Next.js idempotency disappears across instances and restarts.

Dependencies:
- **F01**: the production Admin Firestore adapter (`platform/persistence/adminFirestore.ts`) exists on main.
- **F09**: merged as 4481c8c. Its record and marker model is reused here.

Status: design approved by the builder under the owner's standing autonomy instruction. Every decision is recorded as a ruling (§3).

## 1. Root cause, traced from the code

`platform/http/idempotency.ts` at main 4481c8c:

1. **One Map per process.** `const store = new IdempotencyStore(...)` (`:211`) is a module-level object.
   - A second Next instance has its own Map, so a key completed on instance A is unknown on instance B and is claimed afresh.
   - A restart empties the Map. A rolling deploy therefore forgets every completed key.
2. **Eviction drops successful operations.** `evict` (`:181-195`) and `evictFirm` (`:159-175`) remove the least recently used *done* entries whenever the entry or byte bound is exceeded. A completed key that is evicted is claimed afresh by its next retry, and its effect runs again.
3. **No effect fence.** The claim is released (`settle`, `:246-248`) whenever the route did not call `claim.complete(payload)`: a refusal, a validation error, a throw.
   - Routes commit their effects through the repositories before they complete. For example, `app/api/d1/matters/route.ts` creates the matter, its index row and its members, and only then completes.
   - So a throw after the first write releases the key, and a same-key retry repeats the effect.
   - This is the F09 defect, unfenced, in the Next stack.
4. **A provider call is an effect too.** `app/api/p1/committee-brain/route.ts` calls `callCommitteeBrain` (a paid gateway call when a key is configured) and then writes the output. A failure between the two releases the key, and the retry pays again.

The audit's two-store reproduction is item 1. Items 2 to 4 are the same failure reached by a different path.

## 2. Design

### 2.1 Backend selection: one switch, fail closed

The idempotency backend follows `SIKANDER_PERSISTENCE_MODE`, the switch the repositories already obey (F01). It uses the same rules, implemented once in `platform/persistence/runtimeRepositories.ts` (`resolvePersistenceMode`):

| Mode | Idempotency backend |
| --- | --- |
| `firestore` | **Durable store** in the same Firestore database the repositories use (`setFirestorePersistenceForTests` override, else `getProductionFirestore()`). If no database is configured: `PersistenceConfigurationError` → 503 `PERSISTENCE_NOT_CONFIGURED`. |
| `memory` | The in-process Map. Refused when `NODE_ENV=production`. |
| unset | The Map under the test runner only (`VITEST=true`, not production). Otherwise refused. There is no silent default. |
| anything else | Refused. |

There is no fallback from the durable store to the Map. A Firestore failure during a claim answers 503 `idempotency_store_unavailable`, and the handler does not run.

### 2.2 The durable store: shared with F09

**Collections.** `idempotency_keys/{id}` (the operation record) and `idempotency_effects/{id}` (the effect marker).
- These are the F09 collections, with the same TTL policy on `expiresAt` (`functions/README.md`).
- They are already server-only under `firestore.rules`.

**Record fields** (F09 names, F09 meaning):

| Field | Meaning |
| --- | --- |
| `firmId`, `uid`, `route`, `requestHash` | Binding. A different fingerprint is 422 `idempotency_key_reused`. |
| `operationId` | Set at the first claim and kept on every takeover. |
| `claimId`, `claims`, `claimedAt` | The current attempt, the attempt count, and the 5-minute lease. |
| `status` | `in_progress` or `done`. |
| `response` | When `done`, one of:<br>• `{ status: 200, json }`: the completed payload;<br>• `{ status: 200, omitted: true }`: too large to keep;<br>• `{ status: 4xx, json }`: a refusal the route decided after an effect committed (ruling 9);<br>• `{ status: 409, code: "idempotency_effect_committed", operationId }`: the terminal answer. |
| `released` | Tombstone: a taken-over attempt that ended without an effect (F09 ruling 13). |
| `createdAt`, `expiresAt` | The 24-hour window from the first claim, kept on takeover. |
| `surface` | `"next"`. |

**Marker fields.** `operationId`, `claimId`, `firmId`, `uid`, `route`, `requestHash` (the F09 ruling 17 binding), `kind` (`transaction` or `external`), `expiresAt`, `createdAt`, `surface`.

**What is shared with F09:**
- the collections;
- the field names and meanings;
- the claim state machine (live record → binding, replay, in progress; lapsed, `released` → takeover; an unexpired marker counts and is never deleted early; an orphan marker is adopted only by the request that made it; an expired marker is deleted by the next fresh claim);
- the tombstone rule;
- the terminal 409 `idempotency_effect_committed` naming the `operationId`;
- the settle retries (3 retries, 100/200/400 ms).

**What differs, and why:**

| | Functions (F09) | Next (F10) | Reason |
| --- | --- | --- | --- |
| Document id | `{firmId\|_nofirm}_{key}` | `n_` + sha256(`firm\|user\|METHOD path\|key`) | Next has always scoped a key to the firm, the caller and the route. Other users and other routes keep their own records, as `tests/http.idempotency.test.ts` and `tests/g2.cross-firm.test.ts` pin. A path holds `/`, which a document id cannot. The prefix and the hash keep Next and Functions records from ever colliding (F09 spec §9). |
| `requestHash` | sha256 of the canonical JSON body | The route's own `fingerprintOf({ route, action, body })` | That is what each Next route already computes and binds. |
| Stored answer | `response: { status, body }` (a map) | `response.json` (JSON text) | Next payloads can hold nested arrays and `undefined`, which a Firestore map refuses. Text needs no conversion. |
| Answer size | Functions answers are small | At most 900,000 bytes of JSON; larger answers are kept as `omitted` and replay as 409 `idempotency_replay_unavailable` | A Firestore document holds at most 1 MiB. This is the Map's existing per-entry rule, at a lower cap. |
| Time fields | `Timestamp` | JS `Date`, stored by Firestore as a timestamp | The same code runs on the Admin SDK and on the compat client that `tests/g2.cross-firm.test.ts` hands the repositories. Both store a `Date` as a timestamp (TTL works); `Timestamp` objects do not cross SDKs. |
| Modes | `once`, `rerun`, `resume` | `once` only | No Next route has a self-healing post-commit step, and none can resume a provider receipt (§8). |
| How the marker is created | `CallAudit.stage` in the handler's effect transaction | The **write fence** (§2.3) in every effect write's transaction | Next handlers write through repositories, not through one transaction they own. |

### 2.3 The write fence: the marker commits with each effect write

Every Next Firestore write goes through four helpers in `platform/persistence/firestoreDbModular.ts`:
- `setDoc`, `updateDoc` and `deleteDoc`;
- `runTransaction` (inside which `tx.set` and `tx.update` stage the writes).

No other writer exists in the tree: only that file and `adminFirestore.ts` import a Firestore SDK. A static guard (§7) keeps new code on the helpers by refusing the common ways around them. It is a text check, not a proof; the behaviour tests prove the fence itself.

`platform/http/idempotency.ts` installs a fence provider there. While a request holds a durable claim (from `beginIdempotentRequest` until the request ends), each helper commits through one transaction that does the following:
1. Reads the claim record and the marker, first, because a transaction's reads must precede its writes.
2. Runs the write: `tx.set`, `tx.update`, `tx.delete`, or the repository's own transaction body.
3. If the write touched a covered path:
   - the record must still hold this attempt's `claimId` and be `in_progress`. Otherwise it throws `IdempotencyFenceError` (409 `idempotency_claim_lost`), and nothing commits;
   - the marker must be absent, or be this attempt's. Another attempt's marker throws 409 `idempotency_effect_committed`;
   - an absent marker is created in the same transaction.

What this guarantees:
- **Atomic.** The marker exists exactly when an effect write of the operation has committed.
- **Fenced.** A stale holder whose claim was taken over cannot commit an effect. Its transaction reads the record, so a takeover that lands first fails it, and one that lands after it is serialised behind it.
- **At most one attempt writes.** Once a marker exists, every later attempt of the key answers the terminal 409 before it runs (§2.4).

**Covered paths:** every collection except `audit_log` and `audit_dead_letter`. Audit rows record a decision, not an effect. A refusal writes them too (the request-end flush and the route gate), and it must stay re-runnable. This is the F09 LOW-A ruling for `appendAudit`.

**External effects.** `callCommitteeBrain` calls `recordExternalEffect()` immediately before a dispatch that can reach a provider. Dispatches refused for lack of credentials are not marked. The call writes the marker through the same fence (`kind: "external"`), so the paid call happens at most once per key.

**Outside a durable claim the fence is inert:** GET requests, the memory mode, scripts, the scheduled paths, and tests that call the repositories directly.

A fence active over a modular client-SDK database is refused with an error: it cannot open the fenced transaction. No route runs on one.

### 2.4 The request lifecycle

1. `beginIdempotentRequest(request, key, fingerprint)` is now **async**: `await` at the 12 call sites. It returns, in this order of checks:
   - **A live record** (`expiresAt` ≥ now):
     - a different fingerprint → 422 `idempotency_key_reused`;
     - `done` → one of: the replay (200 `{ result, idempotencyKey, reused: true }`); 409 `idempotency_replay_unavailable` (omitted); the stored refusal (its status and body, plus `reused: true`); or the stored terminal 409;
     - `in_progress` within the lease, and not `released` → 409 `idempotency_in_progress`;
     - lapsed or `released`: an unexpired marker → the terminal 409 is stored and answered; otherwise take over (new `claimId`, `claims` + 1, the same `operationId` and `expiresAt`).
   - **No live record:**
     - an unexpired marker with another binding → 422, with nothing written;
     - an unexpired marker with this binding → adopted, and the terminal 409 stored;
     - otherwise a fresh claim, and an expired marker is deleted in the same transaction.
2. The route runs. Its effect writes are fenced (§2.3). `claim.complete(payload)` stays synchronous: it records the payload on the claim. Its 372 call sites are unchanged.
3. `runWithIdempotencyScope` (`withSession`) settles every claim after the audit flush, as before. In the durable store it awaits one settle transaction:
   - **completed** → `done` with the payload (or `omitted`);
   - **not completed, an unexpired marker exists** → the key never runs again (ruling 9):
     - if the route answered a refusal it decided (any 4xx but 429, whose code is not the catch-all `REQUEST_FAILED` or `INTERNAL_ERROR`), that refusal is stored and replayed as itself;
     - otherwise `done` with the terminal 409;
     - this request keeps its own 4xx (or 2xx) status and body. A 5xx or a throw is replaced by the terminal 409;
     - every non-2xx answer, on this request and on every retry, carries the effect-committed signal (ruling 15);
   - **not completed, no marker** → released. A first claim is deleted. A taken-over claim stays as the `released` tombstone;
   - **not this attempt's claim** → nothing;
   - **the settle cannot be written** → up to 3 retries, then logged. The record stays `in_progress` until its lease lapses, and then step 1 decides from the marker.

### 2.5 The Map (memory mode): reject, never evict an unexpired operation

The Map stays the store for the memory mode, with the audit's capacity rule:
- **No eviction of an unexpired operation.** Expired entries are pruned. When a new claim would exceed the global or the firm entry bound, the claim is **refused**: 503 `idempotency_capacity_exhausted`. No completed or in-progress entry is evicted to make room.
- **Bytes.** A completed answer that does not fit the per-entry, global or firm byte budget is kept as a tombstone with no body. It replays as 409 `idempotency_replay_unavailable`. Its key never runs again within its TTL.
- **Unchanged:** check-and-reserve (now behind an `await` with no other `await` before the reserve), the scoping, the TTL, the lease, and the per-firm bounds (N-1).

The N-1 property, that one firm cannot push out another firm's entries, now holds by refusal rather than by self-eviction.

## 3. Rulings

| # | Decision | Ruling | Reason |
| --- | --- | --- | --- |
| 1 | Retire the mutating Next APIs, or make them durable | Durable store. Retiring them is the canonical-backend decision of F01/F02 (v2 top-5 #5), not a fix-first change | The consoles call these routes today (F02). Retiring them is a product change; F10's correction allows either. |
| 2 | Which switch selects the backend | `SIKANDER_PERSISTENCE_MODE`, with the F01 rules (§2.1) | Durable effects need a durable key store. A second switch could pair Firestore effects with the Map, which is the F10 defect itself. |
| 3 | Which database | The repositories' own instance | The fence reads the claim inside the effect's transaction, so both must live in the same database. |
| 4 | Record and marker model | The F09 collections and fields; differences in §2.2 | One model for both stacks, as the F09 spec §9 anticipated. |
| 5 | Key scope | Keep Next's `firm\|user\|route\|key` scope, hashed into the document id | It is the existing documented contract. Two tests and the G-2 isolation suite pin it. Within a document the binding can differ only in `requestHash`. |
| 6 | How the "effect committed" fact is made durable and atomic | A write fence in the four `firestoreDbModular` write helpers: one transaction per write with a claim read, a marker read, and the marker created with the write | The repositories own no request-level transaction, and their file (`firestoreSpineRepositories.ts`) belongs to #44. The helpers are the single choke point, and #44 does not touch them. This is F09's atomic marker at the granularity the Next code has. |
| 7 | Audit rows | Not covered by the fence | A refusal writes them and must stay re-runnable. They record a decision, not an effect (as F09 LOW-A). |
| 8 | The P1 provider call | Marked as an external effect (write-ahead) just before dispatch. No receipt or resume | The call cannot share a transaction with a write. The marker is written before it, so a retry never pays twice. Without a recorded answer, the retry gets the terminal 409, as F09 ruling 9. Receipt resume is F09-only (the canonical committeeBrain). |
| 9 | The answer when an effect committed and the request did not complete | Never run the key again. **Later requests:** a refusal the route decided (a 4xx but 429, without the catch-all `REQUEST_FAILED` / `INTERNAL_ERROR` code) is stored and replayed as itself (F09 replays its storable results); anything else gets the terminal 409 `idempotency_effect_committed`. **This request:** its 4xx (or 2xx) answer is left as the route wrote it; a 5xx or a throw is replaced by the terminal 409. A refused fenced write (the claim was taken over) answers 409 `idempotency_claim_lost` | Found by the suites. Next routes write derived state before deciding: filings `resolve_closure_followup` recomputes closure compliance and then refuses 422; tenancy recomputes lineage state and then refuses a cross-firm assignee. Their refusals must survive: `persistence.runtime-mode` and the G-2 isolation suite assert them. The routes also report a public refusal and a masked failure with the same catch-all 400 `REQUEST_FAILED`, so this request's 4xx is never rewritten. Its retries are told the truth (the effect committed) unless the refusal is unambiguous. |
| 10 | Capacity | Durable store: no eviction (TTL only). Map: refuse new claims at capacity; keep oversize answers as body-less tombstones | The audit's correction: "reject capacity pressure without deleting unexpired successful operations". |
| 11 | `beginIdempotentRequest` becomes async | `await` added at the 12 call sites | A durable claim needs I/O. The one-token edit is the minimum. A lazy "claim at first write" design was rejected: routes mutate the in-memory runtime store before their first write, so a late replay would leave phantom rows in that instance's cache. |
| 12 | F11 (effects and audit publication not atomic): bring part of it into F10? | **No** | The fence makes "this effect committed" durable and atomic with the effect write itself. A failed or lost audit flush no longer affects idempotency: a completed claim still stores its payload (final audit F6), and an uncompleted one leaves its marker. F11's defect, that an effect can lack its audit row, is untouched by F10 and stays open. The fence's transaction is the natural place F11 can later stage audit rows, but that needs a request-level unit of work in the repositories (#44's file). |
| 13 | The 409 for a capacity refusal (memory mode) | 503 `idempotency_capacity_exhausted` | Nothing ran; the client may retry later. It is not a key conflict. |
| 14 | Changed test expectations | `tests/http.idempotency.test.ts`, `tests/http.idempotency-firm-quota.test.ts`, `tests/http.validation-idempotency-surface.test.ts` and `tests/spine.hardening.test.ts` asserted that a completed key is evicted and runs again. They now assert refusal at capacity and replay of the completed key | That eviction is the F10 defect the audit names. Every other assertion in those tests (TTL and lease boundaries, byte accounting, reuse, the per-firm separation) is kept. |
| 15 | How a caller learns that its key's effect committed (re-audit of 08c0990, MEDIUM-1) | **Both** a response header `Idempotency-Effect-Committed: <operationId>` and a body field `effectCommitted: { operationId }`. They appear on every answer for such a key other than its completed 2xx replay: this request's own kept 4xx, every replay of a stored refusal, and every terminal 409 (from the settle or from a later claim). The status and the rest of the body are unchanged. A completed 2xx and its replays carry neither | Ruling 9 kept a catch-all 400 `REQUEST_FAILED` unchanged on the request whose effect committed. The auditor's ATK-9b (the write committed, its acknowledgement was lost) answered "client operation failed" while the client existed, and a caller who believed it would resubmit under a new key and duplicate the effect. **Header:** protocol level, so any client, proxy or log sees it without parsing the body, including on a non-JSON answer. **Body field:** survives client wrappers that hand callers only the parsed JSON (the consoles' fetch helpers do). Both carry the `operationId`, the same one the terminal 409 names, so a caller can correlate. The route's own answer is never rewritten (ruling 9 still holds); the signal is added to it. |

## 4. Survey: the 12 Next callers

All 12 call `beginIdempotentRequest` once, after the body is parsed and the fingerprint computed, and call `claim.complete(payload)` on each success path (372 sites):
- d1/clients, d1/matters, d1/documents, d1/document-workflow, d1/reporting;
- d2/court-ops, d2/ops-reporting;
- d4/drafts, d4/filings;
- g0/normalise, p1/committee-brain, p5/tenancy.

The change at each site is `beginIdempotentRequest(` → `await beginIdempotentRequest(`. TypeScript enforces it: an un-awaited result has no `response` or `claim`.

Overlap with #44: 9 of these files are in #44's diff (d1/document-workflow, documents, matters, reporting; d2/ops-reporting; d4/drafts, filings; p5/tenancy, and none of clients, court-ops, normalise or committee-brain). #44 changes none of the 12 lines. The nearest #44 hunk is in d4/filings, two lines below the call. No other #44-owned file is edited.

## 5. Failure modes considered

| # | Boundary / fault | Before (main) | After |
| --- | --- | --- | --- |
| 1 | A key completed on instance A, the same request on instance B | B claims afresh and runs again | B replays A's answer |
| 2 | A restart (rolling deploy) after completion | Runs again | Replays |
| 3 | Capacity pressure (Map) | Completed keys evicted, so they run again | New claims refused (503); completed keys replay |
| 4 | A throw or 5xx after an effect write | Key released, so the retry repeats the effect | The marker committed with the write. This request and its retries answer the terminal 409; one effect |
| 4a | The route's catch-all 400 `REQUEST_FAILED` after an effect write (the clients route maps every error to it) | Key released, so the retry repeats the effect | This request keeps its 400 and carries the effect-committed signal (ruling 15); the retry answers the terminal 409; one effect |
| 4c | Re-audit ATK-9b: an effect write commits but its acknowledgement is lost (the transaction throws after commit) | Released; the retry re-runs | The marker committed in the same transaction. This request's 400 carries the signal; the retry answers 409; one effect |
| 4d | Re-audit ATK-13: a document ingest writes the document, a later write fails, and the route deletes the document (compensation) | Released; the retry runs | Conservative (LOW-4, §8): the compensated write still counts. The signal is sent and the retry answers 409, although no document remains |
| 4b | A decided refusal after a write of derived state (filings 422 "already resolved", a G-2 cross-firm denial) | Released; the retry runs again and refuses again | This request keeps its refusal, and the retry replays it (`reused: true`). The derived-state write is not repeated |
| 5 | Crash after an effect write | Lost on restart (memory) or n/a | Record `in_progress`; after the lease the marker makes it the terminal 409 |
| 6 | Settle fails for good after a completed request | n/a | `in_progress` until the lease, then the terminal 409; one effect |
| 7 | Takeover after the lease; the stale holder writes later | n/a | The stale holder's write fails its fence read (409 `idempotency_claim_lost`); one effect |
| 8 | Concurrent duplicates | 409 `idempotency_in_progress` (one process only) | The same, across instances (one claim transaction) |
| 9 | committee-brain: the provider answered, then the output write failed or threw | Key released, so the retry pays again | Marker written before dispatch; the retry gets the terminal 409; one provider call |
| 10 | A refusal before any effect | Released | Released (no marker): a corrected retry runs |
| 11 | An orphan marker (record lost) and another request with the key | n/a | 422 unless the binding matches (F09 ruling 17) |
| 12 | An answer over 900 KB | Kept up to 4 MB in the Map | Kept as `omitted`: 409 `idempotency_replay_unavailable`, never re-run |
| 13 | Durable store down at claim | n/a | 503 `idempotency_store_unavailable`; nothing runs |
| 14 | Persistence mode unset in production, or memory in production | Repositories refused | The idempotency store refuses identically; no Map fallback |

## 6. Files that change

- `platform/http/idempotency.ts`: backend selection, the async begin, the claim classes, the Map's capacity rule, the settle, and the fence provider.
- `platform/http/durableIdempotency.ts` (new): the Firestore store (claim, settle, fence transaction) and its test seam.
- `platform/persistence/firestoreDbModular.ts`: the fence hook in the four write helpers.
- `platform/persistence/runtimeRepositories.ts`: `resolvePersistenceMode` and `getRuntimeFirestore`, shared with the repositories.
- `platform/p1/internalAICaller.ts`: `recordExternalEffect()` before a provider dispatch.
- The 12 route files: `await` (§4).
- Tests, `vitest.config.ts` and `package.json` `test:rules`: the new emulator file is listed with the other Firestore suites.

## 7. Tests

**Emulator: end to end** (`tests/f10-next-idempotency.e2e.firestore.test.ts`, run by `npm run test:rules`).

RED on main, GREEN after, through real route handlers on Admin Firestore. The routes are live by default: `app/api/d1/clients` `create`, and `app/api/p1/committee-brain`. Matters `create` is frozen behind `LEGACY_D1_NEXT_WRITES`, so it is not a production path.
- A completed create replays after a restart (the Map reset); one client row.
- The same against a second Admin app (instance B, its own Firestore client); one client row.
- A throw after the effect writes: the retry answers 409 and does not create a second client.
- committee-brain: a throw after the output write; one provider call.
- Through the route, GREEN only (main has no durable store):
  - concurrent duplicates;
  - a refusal before any effect releases the key;
  - a settle failure gives 409 in progress, then the terminal 409 after the lease;
  - takeover after the lease with the stale holder fenced (409 `idempotency_claim_lost`);
  - store down → 503.

**Emulator: store and fence** (`tests/f10-durable-idempotency.firestore.test.ts`, run by `npm run test:rules`). Two independent store instances over two Admin apps on one emulator:
- completed on A replays on B and on a new instance (restart);
- a load run: 40 keys, each sent 4 times concurrently across both instances, gives exactly one claim per key, and every key replays after a restart;
- nothing unexpired is ever deleted.

Fault matrix (GREEN):
- throw after the effect;
- settle failure → `in_progress`, then the terminal 409 after the lease;
- takeover after the lease with the stale holder fenced (409 `idempotency_claim_lost`, one effect);
- concurrent duplicates;
- refusal releases;
- the tombstone on a taken-over release;
- orphan-marker binding;
- an oversize answer;
- store down at claim → 503.

**Unit:**
- backend selection and fail-closed configuration: production with memory, unset mode outside tests, firestore without a database;
- the Map's capacity rule: refuse at capacity, keep completed keys, oversize tombstones, per-firm separation.

**Re-audit of 08c0990 (PASS 7.5): the auditor's attacks, adopted.** These pin the load-bearing claims; a mutant of each claim now fails:

| Claim | Test (e2e file, "re-audit attacks") | Mutant it kills |
| --- | --- | --- |
| The marker commits in the same transaction as the effect | ATK-9b: the commit's acknowledgement is lost | M2b: the marker is written in a separate transaction after the effect |
| The test seam is inert in production | ATK-8a | M6: the seam is live in production |
| The provider dispatch is marked before it is sent | ATK-14: the output write fails after dispatch | M7: the dispatch is not marked first |
| The marker's window equals the record's | ATK-11 | M8b: the fresh marker's window is shorter |
| A refusal before any effect releases the key | ATK-15, plus "a refusal with no write before it … the key is released" (store file) | M12: a refusal is stored without an effect |

ATK-13 (a compensated document ingest) pins LOW-4 as recorded behaviour.

**Static guard** (`tests/f10-write-fence-guard.test.ts`). It is a text check over the non-test sources in `app/`, `platform/`, `lib/`, `services/` and `components/`. It fails when a file outside the allowed ones:
- imports a Firestore SDK (allowed only in `firestoreDbModular.ts` and `adminFirestore.ts`);
- requires or imports a module by a computed name;
- names the Firestore handle `getRuntimeFirestore` / `getProductionFirestore` (allowed only in `adminFirestore.ts`, `runtimeRepositories.ts` and `platform/http/idempotency.ts`);
- calls `.collection(`, `.collectionGroup(`, `.doc(`, `.runTransaction(`, `.batch(`, `.bulkWriter(`, `.recursiveDelete(` or `.listCollections(` (allowed also in `durableIdempotency.ts`, which reaches only its two collections);
- reaches one of those members, or `set`, `update`, `delete`, `create`, `add` or `commit`, by bracket access;
- writes through a ref taken from the helpers' `doc()` / `collection()`, inline or through one assignment.

It also fails when one of the four writing helpers stops assigning and branching on its fence (`fenceFor(ref)` / `writeFence()`).

The re-audit's bypass forms are must-fail samples. **It does not see** a handle passed in from elsewhere under another name, or aliasing beyond one assignment. It keeps new code on the helpers; the behaviour tests prove the fence.

**Existing suites that must stay green:**
- the unit suite;
- `npm run test:rules` (including `persistence.runtime-mode`, the F01 e2e, `g2.cross-firm`, f03 and f14).

## 8. Residual risk

- **A multi-write route is not atomic as a whole.** Each write is fenced, so a crash between two writes leaves a partial effect that is never repeated (the key answers the terminal 409). The partial state needs repair. That is a request-level unit of work, F11/F01 territory, in #44's repository file.
- **No receipt resume in Next (ruling 8).** A committee-brain call whose output was lost answers 409. The text is not recovered.
- **Memory mode has no fence and no durability.** It is a dev/test mode, and production refuses it.
- **The audit row can still be missing after a committed effect (F11, open).** Idempotency no longer depends on it.
- **Document object bytes (d1/documents).** These are written per new document id before the metadata write. A retry after a failed metadata write uploads again under a new id, leaving orphan bytes (FA-D16-003 family). The metadata, and so the visible document, is never duplicated once committed.
- **Cost.** Each effect write inside a claim is a transaction with two extra reads, and the first one also writes the marker. Next mutations write a handful of documents each.
- **TTL.** The policy on `idempotency_keys` and `idempotency_effects` (`functions/README.md`) now also purges Next records.
- **Writes of derived state count as effects.** A request that recomputes a digest and then refuses (ruling 9) leaves its key answered for 24 hours. A same-key retry gets that refusal (or the terminal 409), never a fresh evaluation. A corrected request needs a new key, which is already the contract.
- **Re-audit LOW-1: a replay is not re-authorised.** A stored answer replays to the same caller, on the same route, with the same body, for up to 24 hours, even after the caller lost access (for example a member removed from the matter). The replay returns only what that caller was already given. Re-checking permission on replay is a follow-up (to be logged on #30).
- **Re-audit LOW-2: stored answers hold the payload.** A client-create answer stored in `idempotency_keys` holds the raw CNIC and phone for 24 hours plus the TTL purge lag. The collection is server-only (`firestore.rules` catch-all; F09's rules test). Redacting or encrypting stored answers, as F09's `redactReplay` does for recovery codes, is a follow-up.
- **Re-audit LOW-4: a compensated effect still spends the key.** A route that writes, fails, and rolls its write back (the d1/documents ingest, ATK-13) leaves the marker. The key answers the terminal 409 with the signal although nothing remains. This is conservative: the fence cannot tell a compensation from an effect. A caller retries under a new key.
- **The `package.json` `test:rules` line conflicts with #44.** Whoever resolves the conflict must keep both F10 files, `tests/f10-durable-idempotency.firestore.test.ts` and `tests/f10-next-idempotency.e2e.firestore.test.ts`, in the list (and in `vitest.config.ts`'s emulator-only exclusions).
- **Route comments.** The 12 routes still say "check-and-reserve the key in one synchronous step (no await in between)". This holds inside `beginIdempotentRequest`: the Map's check and reserve are one synchronous step, and the durable store's are one transaction. Rewording the comments was left out to keep the route diff to the `await` (#44 overlap).
