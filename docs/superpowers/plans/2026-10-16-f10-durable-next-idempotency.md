# F10 Durable Next Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Next.js idempotency survives instances and restarts, never drops an unexpired completed operation, and never repeats an effect that committed.

**Architecture:**
- `SIKANDER_PERSISTENCE_MODE=firestore` selects a Firestore store in the repositories' own database. It uses the F09 record/marker model (`idempotency_keys`, `idempotency_effects`).
- A write fence in the four `firestoreDbModular` write helpers commits the effect marker in each effect write's transaction and refuses stale holders.
- Memory mode keeps the Map, gated as F01 gates the repositories, and refuses new claims at capacity instead of evicting.

**Tech Stack:** Next.js route handlers, TypeScript, firebase-admin Firestore (and the compat client in G-2), vitest, the Firestore emulator.

**Spec:** `docs/superpowers/specs/2026-10-16-f10-durable-next-idempotency-design.md`

## Global Constraints

- Do not edit:
  - `platform/http/withSession.ts`
  - `platform/p5/session.ts`
  - `platform/persistence/adminFirestore.ts`
  - `platform/persistence/firestoreSpineRepositories.ts`
  - `platform/p5/committeeScope.ts`
  - `platform/p5/insecureDevAuth.ts`
- Route files get only the `await` (spec §4).
- Production fails closed. There is no fallback to the Map from `firestore` mode; memory or unset mode in production is refused.
- Constants:
  - TTL 24 h;
  - lease 5 min;
  - durable answer cap 900,000 bytes of JSON (UTF-8);
  - settle retries 3 (waits 100/200/400 ms).
- Codes:
  - `idempotency_key_reused` (422);
  - `idempotency_in_progress` (409);
  - `idempotency_replay_unavailable` (409);
  - `idempotency_effect_committed` (409, with `operationId`);
  - `idempotency_claim_lost` (409);
  - `idempotency_store_unavailable` (503);
  - `idempotency_capacity_exhausted` (503).
- Document id: `n_` + sha256(`firm|user|METHOD path|key-lower-case`). Unfenced collections: `audit_log`, `audit_dead_letter`.
- Never skip or weaken a test. Changed eviction assertions follow spec ruling 14 only.

## Review Focus

- **The fence reads must come before any write in the transaction.** A repository transaction body that reads after the fence's reads must still work (`filing_packages` `decideIfPending`, `audit_log` append). This is pinned by the runtime-mode suite in Task 5.
- **A refusal path that writes audit rows only must stay re-runnable.** The test "a refusal before any effect releases" in Task 4 runs through a route in Firestore mode.
- **The G-2 compat client:** the durable store and the fence work over `ctx.firestore()`. Pinned by `tests/g2.cross-firm.test.ts` in firestore mode (Task 5).
- **Concurrent writes inside one request** (two fenced transactions creating the same marker) both commit: contention retries. Pinned by the matters create, whose member upserts run in sequence, and by the store test "two fenced writes in parallel" in Task 3.
- **A completed answer with nested arrays or `undefined`** replays intact. Pinned by a store test in Task 3.

---

### Task 1: Backend selection and the Map's capacity rule

**Files:**
- Modify: `platform/persistence/runtimeRepositories.ts`
- Modify: `platform/http/idempotency.ts`
- Modify: `tests/http.idempotency.test.ts`, `tests/http.idempotency-firm-quota.test.ts`, `tests/http.validation-idempotency-surface.test.ts`, `tests/spine.hardening.test.ts` (ruling 14 only, plus `await`)
- Create: `tests/f10-idempotency-backend.test.ts`

**Interfaces:**
- Produces:
  - `resolvePersistenceMode(): "memory" | "firestore"`, which throws `PersistenceConfigurationError` per spec §2.1;
  - `getRuntimeFirestore(): Promise<unknown>` (the test override, else `getProductionFirestore()`);
  - `IdempotencyStore.begin(...)` gains `{ kind: "capacity" }`;
  - `beginIdempotentRequest(request, key, fingerprint): Promise<IdempotentStart>`;
  - `IdempotencyClaim` with `complete(payload): void`, `isCompleted`, `settle(): Promise<SettleOutcome>`;
  - `runWithIdempotencyScope` awaits its claims' settles.

- [x] Write the failing tests:
  - `begin` at the entry bound returns `{ kind: "capacity" }`, and the completed keys still replay;
  - an answer over the remaining byte budget is kept as `unavailable`;
  - `beginIdempotentRequest` answers 503 `idempotency_capacity_exhausted` at the firm bound;
  - with `NODE_ENV=production` and `SIKANDER_PERSISTENCE_MODE=memory`, `beginIdempotentRequest` rejects with `PersistenceConfigurationError`;
  - unset mode outside the test runner rejects;
  - `firestore` mode without a database rejects.
- [x] Run `npx vitest run tests/f10-idempotency-backend.test.ts tests/http.idempotency*.test.ts tests/http.validation-idempotency-surface.test.ts tests/spine.hardening.test.ts`. Expected: FAIL (no capacity kind; begin is synchronous).
- [x] Implement the reject-at-capacity Map (prune expired; refuse; tombstone oversize answers), the mode resolution and the async begin over the Map.
- [x] Run the same command. Expected: PASS.

### Task 2: The write fence hook and the external-effect hook

**Files:**
- Modify: `platform/persistence/firestoreDbModular.ts` (`setDoc`, `updateDoc`, `deleteDoc`, `runTransaction`)
- Modify: `platform/p1/internalAICaller.ts` (before `transport.send`, unless the transport is the no-credentials one)

**Interfaces:**
- Produces:
  - `export type WriteFence = { covers(path: string): boolean; transact<T>(db: unknown, stage: (tx: FenceTx, note: (path: string) => void) => Promise<T>): Promise<T> }`, where `FenceTx` has `get`, `set`, `update` and `delete` on admin-style refs;
  - `installWriteFence(provider: () => WriteFence | null): void`;
  - `recordExternalEffect(kind: string): Promise<void>`, exported from `platform/http/idempotency.ts`.
- Behaviour:
  - with no active fence, the helpers behave exactly as before;
  - with an active fence on a covered path, each helper writes through `fence.transact`;
  - a non-admin-style database under an active fence throws.

- [x] Covered by Task 3's tests (the fence has no behaviour without the durable store).

### Task 3: The durable store

**Files:**
- Create: `platform/http/durableIdempotency.ts`
- Modify: `platform/http/idempotency.ts` (firestore backend; fence provider; settle; the response substitution in `runWithIdempotencyScope`)
- Create: `tests/f10-durable-idempotency.firestore.test.ts`
- Modify: `vitest.config.ts` (exclude without `FIRESTORE_EMULATOR_HOST`), `package.json` `test:rules` (add the file)

**Interfaces:**
- Produces:
  - `class DurableIdempotencyStore { constructor(db: unknown); begin(scope: DurableScope): Promise<DurableBegin>; settle(claim: DurableClaimRef, outcome: { completed: boolean; payload?: unknown }): Promise<SettleOutcome>; fence(claim: DurableClaimRef): WriteFence }`;
  - `durableDocId(firmId, userId, route, key): string`;
  - `durableIdempotencyTestSeam: { settleFailures?: Error[]; now?: () => number; failWrite?: (path: string) => Error | undefined }`, inert in production.

- [x] Write the failing store tests (two Admin apps on one emulator):
  - two-instance replay, and restart replay;
  - load: 40 keys × 4 concurrent across both instances → one claim per key, all replay after a restart;
  - binding 422; in-progress 409;
  - lease takeover keeps `operationId`; the tombstone on a taken-over release;
  - an unexpired marker makes a lapsed claim terminal;
  - orphan-marker binding;
  - an oversize answer → `omitted`;
  - nested arrays and `undefined` replay intact;
  - two fenced writes in parallel create one marker;
  - a fenced write by a stale holder → 409 `idempotency_claim_lost`;
  - an audit-path write creates no marker.
- [x] Run `bash <scratch>/emu.sh red-store tests/f10-durable-idempotency.firestore.test.ts`. Expected: FAIL (module missing).
- [x] Implement the store and wire it into `beginIdempotentRequest` and the fence provider.
- [x] Run the same command. Expected: PASS.

### Task 4: End to end through the real routes (RED on main)

**Files:**
- Modify: the 12 route files (`await`)
- Test: `tests/f10-durable-idempotency.firestore.test.ts` (route section)

- [x] Write the route tests (Admin Firestore, `app/api/d1/matters` create):
  - restart replay;
  - instance B (second Admin app) replay;
  - throw after the effect (the in-memory `store.matters.set` throws once): the retry gets 409 and still one matter;
  - settle failure → 409 `idempotency_in_progress`, then the terminal 409 after the lease;
  - takeover after the lease: the stale holder's later write is fenced, one matter;
  - concurrent duplicates → one matter;
  - a refusal releases;
  - committee-brain throw after the output write → one transport call;
  - store down → 503.
- [x] Record RED: copy the route tests onto a main export and run them there. Expected: the restart, instance B, throw-after-effect and committee-brain tests fail (2 matters, 2 calls).
- [x] Run GREEN on the branch. Expected: PASS.

### Task 5: Static guard, full verification, docs, PR

**Files:**
- Create: `tests/f10-write-fence-guard.test.ts` (no SDK import outside the allowed files; no direct writes in the repository files)
- Modify: `platform/http/idempotency.ts` header comment; this plan's execution record

- [x] The guard test: RED by mutation (a direct `.set(` inserted in a copy of the repository source is flagged), then GREEN on the tree.
- [x] `npm run typecheck`, `npm run typecheck:tests`, `npm run lint`, `npm run test:unit`.
- [x] `npm run test:rules` (own ports), including `persistence.runtime-mode`, `g2.cross-firm`, f01, f03 and f14.
- [x] `BASE=origin/main bash ci_gates/gate_g0.sh`; the claim gate.
- [x] Commit with the trailers, push, open the draft PR `fix(F10): …`.

## Execution record (2026-10-16)

Execution was native (inline), self-approved under the owner's standing autonomy instruction. Emulator runs used the repo's rules and indexes on F10's own ports, because another session used `firebase.json`'s ports.

**Deviations from the plan, each recorded in the spec:**
- The e2e route is `app/api/d1/clients` `create`, not matters `create`. Matters `create` is frozen behind `LEGACY_D1_NEXT_WRITES` (default off), so it is not a production path.
- Ruling 9 was refined twice, on evidence from the suites.
  - **`persistence.runtime-mode`.** Filings `resolve_closure_followup` recomputes compliance state (writes) and then refuses 422.
  - **G-2 in Firestore mode.** Tenancy recomputes lineage state and then refuses a cross-firm assignee through the catch-all 400 `REQUEST_FAILED`.
  - **The rule now.** A request's own 4xx is never rewritten; only a 5xx or a throw becomes the terminal 409. Retries replay a decided refusal, or get the terminal 409 when the refusal is ambiguous (a catch-all code).
- In the concurrent-duplicates e2e, the duplicate may also be answered by the replay: its claim transaction can retry past the first request's completion. The invariant tested is one run and one client.

**RED on main (4481c8c):**
- `tests/f10-next-idempotency.e2e.firestore.test.ts`: **7 failed / 2 passed (9)**. The four audit scenarios fail on the defect itself, `expected 2 to be 1`: restart, instance B and throw-after-effect each create a second client, and committee-brain makes a second provider call. The three seam tests need the durable store.
- New and changed unit tests (backend selection, write-fence guard, and the four Map test files): **17 failed / 54 passed (71)**.

**GREEN (branch):**
- Both F10 emulator files plus G-2 in Firestore mode: **166 / 166**.
- `npm run test:rules` file set (13 files, including both F10 files): **672 / 672**.
- `npm run test:unit`: **167 files, 3324 / 3324**.
- The same unit files: **71 / 71**.

**Checks:**
- `npm run typecheck` and `npm run typecheck:tests` exit 0.
- `npm run lint` exits 0 with 0 errors. Its 89 warnings are identical, line for line, to the pre-F10 baseline.
- `BASE=origin/main bash ci_gates/gate_g0.sh` and the claim gate: see the PR.
