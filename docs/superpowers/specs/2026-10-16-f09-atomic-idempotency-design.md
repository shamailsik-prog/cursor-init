# F09: Functions idempotency covers committed effects atomically

Date: 2026-10-16. Base: `origin/main` @ 0a6f02f. Status: approved by the remediation builder under the owner's standing autonomy instruction (brainstorming self-approved and recorded here). Each ruling records its reason.

Audit sources:
- `docs/audit/2026-10-13-forensic-audit.md` F09 (:295), and F35 (:735), which depends on it.
- `docs/audit/2026-10-14-forensic-audit-v2.md` :82 (F09 OPEN, `functions/src/http/idempotency.ts:179-208`), :180 (top-5 fix 5).
- `docs/audit/REMEDIATION.md`: rule 2 (closed = merged PR with an end-to-end test of a real user flow, RED before and GREEN after), rule 3 (ticked only after an independent re-audit). This document claims neither closure nor a tick.
- O-58 (`docs/superpowers/specs/2026-10-11-phase3d-p1-ai-layer-design.md:84`, `functions/src/p1/README.md:11`): the committeeBrain half of F09, recorded when P1 shipped.

Scope: Cloud Functions only. `platform/http/idempotency.ts` (F10, Next.js) is untouched; §9 says how F10 can reuse this record shape. Nothing under `platform/documents/*` (#47), `app/api/**` or `platform/spine` (#44) is touched.

## 1. Root cause, traced from the code

`withIdempotency` (`functions/src/http/idempotency.ts:141-199` on main) runs three separate steps:

1. **Claim** (`:150-175`): one transaction writes `idempotency_keys/{firm}_{key}` = `{ status: "in_progress", claimId, claimedAt, ... }`.
2. **Handler** (`:186`): the operation commits its own effect in its own transaction (for example `registerClientOp`, `d1/client/ops.ts:129-211`, allocates a number and creates a client).
3. **Settle** (`:188-197`, `settle` at `:211-228`): a *separate* transaction either stores the response (`status: "done"`) or, for a throw or a non-storable result (5xx, 401/403, 429, contention 409s), **deletes** the claim.

Nothing in step 2's transaction says, in the store, that the effect happened. So:

- **Throw or 5xx after the effect.** Step 3 deletes the claim (`:188`, `:192`). A same-key retry finds no claim and runs the handler again: the effect commits twice. This is the audit's probe: a committed synthetic Firestore effect followed by a 500 ran twice for one key. An ambiguous commit (the effect's commit lands, its answer is lost, the handler throws) is the same path.
- **Crash, or a permanent settle failure, after the effect.** The claim stays `in_progress`. Once `claimedAt` is older than `IDEMPOTENCY_LEASE_MS` (5 min), the next same-key request takes it over (`:158-161`) and runs the handler again.
- **Takeover is not fenced.** A holder whose lease was taken over can still commit its effect, because the handler's transaction never reads the claim. Only `settle` checks `claimId`.

committeeBrain (`functions/src/p1/ops.ts:243-341`) has the same shape with a paid external effect in the middle:

- `callP1` reserves budget, records the provider attempt, calls the provider (paid), records the outcome on the reservation, exports the trace and commits the usage row (`gateway.ts:397-661`).
- Only then does `ops.ts:303-327` write `committee_outputs` with the route's allow row, in its own transaction.
- If that write fails for good (`withOutputWriteRetry`, `ops.ts:125-146`), the handler throws, the router answers 500, step 3 deletes the claim, and a same-key retry calls the provider again: a second charge (O-58).
- A crash anywhere between the provider call and the output write leaves no record of the answer, and the claim is taken over after the lease. Again a second paid call.

The provider call cannot be made atomic with any database write. What can be made durable and atomic is (a) the decision that the operation has dispatched, recorded in the same transaction as the provider-attempt record before dispatch, and (b) the answer, recorded as soon as the provider returns.

## 2. Design

### 2.1 Two documents per operation

**Operation record**: `idempotency_keys/{firmId|_nofirm}_{key lower-case}`. This is the existing document, with new fields:

| Field | Meaning |
| --- | --- |
| `firmId`, `uid`, `route`, `requestHash` | Unchanged binding: another body, route or user gets 422 `idempotency_key_reused`. |
| `operationId` | New. A UUID v4 set at the first claim and **kept on every takeover**: the identity of the operation, as distinct from the attempt. |
| `status` | `in_progress` or `done`. Unchanged values. |
| `claimId`, `claimedAt` | The current attempt and when it claimed. Unchanged. |
| `claims` | New. 1 at the first claim, +1 per takeover (diagnostics). |
| `resumable` | New, resume routes only: `true` when the last holder ended after a committed effect without an answer. The next same-key request may take over at once, without waiting out the lease. |
| `released` | New (ruling 13): `true` when an attempt that took the claim over ended without an effect. The record stays as the key's tombstone, because an older holder may still commit. The next same-key request may take over at once. |
| `response` | `{ status, body }` once `done`. Unchanged. |
| `createdAt`, `expiresAt` | The operation's 24 h window. **No longer reset on takeover** (ruling 6). |

**Effect marker**: `idempotency_effects/{same id}`. New, server-only (the `firestore.rules` catch-all denies every client read and write), with a TTL on `expiresAt`:

| Field | Meaning |
| --- | --- |
| `operationId`, `claimId` | The operation, and the attempt that committed the effect. |
| `firmId`, `route`, `expiresAt` | Scope, and the same expiry as the record. |
| `kind` | `transaction` (a database effect) or `p1_dispatch` (a provider call). |
| `usageLogId`, `traceId` | `p1_dispatch` only: the reservation, usage row and trace of the one provider call this operation made. |
| `result`, `resultAt` | `p1_dispatch` only, written when the provider answers: the attempt receipt. It holds the outcome, the masked text, the token counts, the cost, the model, the classification and the masked outbound body and purpose. |

The marker is created with `tx.create` **inside the effect's own transaction**. That gives two properties:

- **Atomic.** The marker exists exactly when the effect committed: they are one write set.
- **Fenced.** At most one attempt of an operation can commit an effect. A second `tx.create` fails the whole transaction with ALREADY_EXISTS, so the second effect never commits. This is a write-only fence: it needs no read, so it works in every handler's existing transaction, whatever order its reads and writes are in. For example, `runConflictCheck` writes the daily counter before it stages its audit row (`d1/conflict/ops.ts:154-155`), so a fence that had to read inside the transaction would not fit there.

### 2.2 How a route behaves after its effect (idempotency modes)

Each route declares `idempotency: "once" | "rerun" | "resume"` in `ROUTES` (`http/router.ts`). The default is `once`.

| Mode | Marker | After the effect, a same-key request… | Routes |
| --- | --- | --- | --- |
| `once` | Created by the allow row's staging (`CallAudit.stage(tx, "allow", …)`), so in the effect transaction | never runs the handler again. If no answer was stored it gets **409 `idempotency_effect_committed`**, which is stored and replayed. | Every POST route not listed below |
| `rerun` | None | runs again, as before. Each listed operation is idempotent by construction and relies on a same-key re-run to heal a failed post-commit step. | `onboardFirm`, `createFirmUser`, `setUserClaims`, `deactivateUser`, `disableMfa` (§4) |
| `resume` | Created at dispatch, with the provider-attempt record (§2.4) | takes the operation over and **resumes**: it publishes the recorded answer and never calls the provider again | `committeeBrain` |

### 2.3 The wrapper's state machine (`withIdempotency`)

**Claim** (one transaction that reads the record and the marker):

1. Not a UUID v4 → 400 `idempotency_key_required` (unchanged).
2. A live record (`expiresAt` ≥ now):
   - another uid, route or body → 422 `idempotency_key_reused`;
   - `done` with a well-formed response → replay with `reused: true`;
   - `done` with a malformed response, or any status other than `in_progress` → 409 `idempotency_in_progress` (unchanged);
   - `in_progress` with a live lease and neither `resumable` nor `released` → 409 `idempotency_in_progress`.
3. A lapsed, `resumable` or `released` claim:
   - An unexpired marker exists (any `operationId`, ruling 13) and the mode is not `resume`: the claim transaction itself stores the terminal answer, 409 `idempotency_effect_committed`, and returns it. The handler is not run.
   - The mode is `resume`: take over (new `claimId`, `claims` + 1, same `operationId`, `expiresAt` kept) and run the handler with `prior` = the marker, or null when no effect committed.
   - No marker: take over and run, as before.
4. No live record (absent or expired):
   - An unexpired marker is adopted: the record is recreated with the marker's `operationId` and expiry, then `once` stores and answers the terminal 409, and `resume` runs with the marker as `prior` (ruling 13).
   - Otherwise this is a fresh operation with a new `operationId`. An expired marker is deleted in the same transaction, so it cannot fence the new one.

**After the handler**, in one settle transaction (retried as before: 3 retries, 100/200/400 ms):

- **A storable result** (`isStorableResult`, plus the new stored code `idempotency_effect_committed`):
  - our claim and `done` already (the handler stored its answer inside its effect transaction, §2.4) → nothing to do;
  - our claim and `in_progress` → `done` with the response, as before.
- **A non-storable result, or a throw**:
  - not our claim → nothing;
  - an unexpired marker exists, mode `resume` → `resumable: true`; the handler's answer is returned;
  - an unexpired marker exists, mode `once` → `done` with the terminal 409 `idempotency_effect_committed`, and **that is what this request answers**, because the effect did commit;
  - no unexpired marker:
    - a first claim (`claims == 1`) is deleted (released), as before;
    - a taken-over claim (`claims > 1`) is kept as a `released` tombstone (ruling 13).
- **The settle cannot be written**: logged, as before. The claim answers 409 `idempotency_in_progress` until its lease lapses. Then rule 3 above decides from the marker, which is the durable truth.

**The fence for answers stored in an effect transaction.**
- `binding.read(tx)` reads the record and the marker before any write.
- If the record no longer holds this request's `claimId`, it throws 409 `idempotency_claim_lost` (not stored).
- If the record is already `done` with this claim, it reports that the answer is stored. That is an ambiguous commit of the same transaction, and the caller treats it as success.

### 2.4 committeeBrain: one provider call per operation, answers resumed

Write order for a call made for an HTTP operation. `P1Request.operation` carries the marker reference and its fields; `callP1` without it behaves exactly as before.

| Step | Where | Writes, in one transaction | Purpose |
| --- | --- | --- | --- |
| 8b | `reserve` | Reservation (unchanged) | Budget hold (F07) |
| 8c | `markAttempt` | Reservation `providerAttempt` **+ marker `{ kind: "p1_dispatch", usageLogId, traceId }`** | **Dispatch fence**: the marker is read first. If it is absent, it is created. If it carries this call's `traceId`, an earlier attempt of this same transaction landed and its answer was lost, so the call proceeds. If it carries another `traceId`, the operation already dispatched: the call is refused `reservation_failed` and **nothing is sent**. |
| 9 | transport | (none) | The paid call |
| 9b | `recordAttemptOutcome` | Reservation outcome (unchanged) **+ marker `result` (the attempt receipt)** | Durable as soon as the provider answers, fail-open as before |
| 11 | `commit` | Usage row, month total, settlement (unchanged) | Accounting (F08) |
| pub | `ops.ts` publication | **Fence read**, then the route's allow row, the `committee_outputs` row **and the stored answer (`done`)** | The answer commits with the output row: no window between them |

A blocked call (no dispatch: kill switch, budget, policy) creates the marker (`kind: "transaction"`) in the publication transaction instead. It too is one write set with the output row and the answer.

**Resume.** When a same-key request finds a `p1_dispatch` marker (a crash, or a publication that failed for good), committeeBrain re-checks the request (input, `ai.call` permission, matter, classification and the caller's clearance against the stricter of the current label and the receipt's). It then reads the marker:

- `result` present → it publishes from the receipt: a new output row with the call's original `usageLogId` and `traceId`, the masked text, usage and outbound. `accounting` is `settled` when the reservation is `settled` or `released`, otherwise `pending`. In that case the lease reconciler later flips the output row and the stored answer to `settled` through the existing `usageLogId` and `traceId` match (`reconciler.ts:173-193`). **No provider call.**
- `result` absent (the instance died between the provider's answer and step 9b, or 9b failed and so did the publication) → the answer is gone. The request is answered 409 `idempotency_effect_committed`, which is stored. **No provider call.** The spend is still recorded: the reservation holds its provider attempt, and the reconciler charges it (F08).

A publication whose fence read finds a marker with another `traceId` (a fenced-out attempt of the same operation) answers 409 `idempotency_claim_lost`, and the wrapper leaves the operation `resumable`.

### 2.5 Claim expiry and takeover rules

- Lease: `IDEMPOTENCY_LEASE_MS` (5 min) > `FUNCTION_TIMEOUT_SECONDS` (120 s), asserted at import (unchanged). A takeover never meets a live holder unless an instance stalls for more than 5 minutes. The fences make even that case safe:
  - the stale holder's effect transaction fails on the marker;
  - its publication fails on the claim;
  - its dispatch fails on the marker.
- `resumable: true` ends the lease at once. Only the holder itself sets it, and only as its last write.
- A takeover keeps `operationId` and `expiresAt`. The marker's expiry equals the record's, so TTL can never purge a marker while its record still lives (ruling 6).
- **A release never reopens the key while an older holder may still commit (ruling 13; Codex P1 on PR #58).**
  - **The defect at aacaae5:** A stalls, B takes over, and B ends without an effect, which deleted the record. A then commits (its marker lands on no record). The next request's fresh-claim path deleted A's marker as "left from an expired operation" and committed the effect a second time.
  - **Two rules close it, each sufficient alone:**
    1. **Tombstone.** A release by an attempt that took the claim over (`claims > 1`) keeps the record as `released`. Only a first claim (`claims == 1`), which no other attempt ever held, is deleted, so the normal retry after a 5xx is unchanged.
    2. **Marker authority.** An unexpired marker is the key's committed effect, whatever operation id it names and whether or not a record exists. Only an expired marker is ever deleted. A marker with no record is adopted (`once`: the terminal 409; `resume`: `prior`). The settle also counts any unexpired marker as an effect.

## 3. Rulings

| # | Decision | Ruling | Reason |
| --- | --- | --- | --- |
| 1 | Where the "effect committed" fact lives | A separate marker document created with `tx.create` in the effect transaction | Write-only and fenced: no read is needed, so all ~25 POST handlers keep their transactions as they are, and a second effect cannot commit. A field on the record would need a fence read at the start of every effect transaction, which means per-handler reordering (`runConflictCheck` writes before it audits). |
| 2 | Which staging creates the marker | `CallAudit.stage(tx, "allow", …)` by default; a deny staging only on request (`{ effect: true }`, used by `approveDraft`'s `gate_blocked`, which commits a fresh gate result); never `CallAudit.allow()` | Every effectful POST handler already stages its allow row inside its effect transaction: one audit row per call (P5). A deny staging is usually a refusal with no domain effect, which must stay re-runnable (a 403 is released so a refreshed token can succeed). `allow()` is not transactional, so a marker written there would not be atomic. |
| 3 | The answer when an effect committed and no answer was stored | 409 `idempotency_effect_committed`, stored and replayed | Honest and safe. The effect happened, the original answer is lost, and repeating the effect is the defect. A 2xx would need the handler's own response shape, which the wrapper does not have. The code joins `STORED_409_CODES`. It is not audited as a refusal: like a replay, it is the answer to a decision that already has its row. |
| 4 | Generic routes store their answer after the effect, not in it | Accepted, with ruling 3 as the fallback; committeeBrain stores its answer in the effect transaction | Moving every handler's answer into its transaction means rewriting each response path, and the fix-first freeze forbids that refactor. The marker already makes the effect once-only. Only the answer text can be lost, and only in the settle window. committeeBrain is the paid path, so it gets the full treatment. |
| 5 | `rerun` routes | `onboardFirm`, `createFirmUser`, `setUserClaims`, `deactivateUser`, `disableMfa` | Each has a documented post-commit external step (Auth claims, Auth user state, MFA factors) that a same-key retry is designed to heal. Each re-run is idempotent: FN-1 resume, set-to-value with a version bump, `active: false` again, approval-keyed resume, email uniqueness. Making them `once` would turn that self-healing into a terminal 409 (§4). |
| 6 | Takeover keeps `createdAt` / `expiresAt` | The 24 h window starts at the first claim | Main reset the window on takeover. The marker carries the record's expiry, so an extended record would outlive its marker under TTL and could re-run the effect. |
| 7 | Stable operation ID for a provider call | The marker binds the operation to one `usageLogId` and `traceId` at dispatch; the reservation id stays per call | A deterministic `usageLogId` would collide with the blocked-row and reconciler paths (one id for reservation and usage row, PR #40 decision 1). The marker already gives at most one dispatch per operation, and resume reuses the original `usageLogId` and `traceId`, so the reconciler's refresh finds the resumed answer. |
| 8 | Where the receipt text lives | On the marker (server-only, 24 h TTL), never on the reservation | The README states that `ai_reservations` and `ai_usage_logs` hold no prompt or response text. The stored answer in `idempotency_keys` already holds the masked text, so the marker adds no new class of data. Only masked text is stored. |
| 9 | A lost receipt | Terminal 409 `idempotency_effect_committed`; no second call | The provider answer cannot be made atomic with a write. Not paying twice beats answering. A new Idempotency-Key is a deliberate new paid call. |
| 10 | Resume re-checks permission and clearance | Yes. The response classification is the stricter of the current label and the call's | Fail closed: text produced for a matter must not reach a caller who has since lost access. Labels are monotonic (P2-13). |
| 11 | New test seams | `idempotencyTestSeam` (`settleFailures`, `beforeSettle`), `p1OpsTestSeam.beforePublish`, `p1TestSeam.crashAt: "recorded"` | Fault injection at every boundary. Each is inert when `NODE_ENV` is `production`, like the existing seams, and the bundle defines it so (`functions/build.mjs`). |
| 12 | Time budget | Unchanged | The claim reads two documents in one `getAll`. 8c and 9b add one document each to transactions they already run. The publication now stores the answer, and settle confirms it. `POST_CALL_ALLOWANCE_MS` already counts the 3 s completion. |
| 13 | A release while an older holder may still commit (Codex P1 on PR #58) | Two rules, together (§2.5): (1) a taken-over claim that ends without an effect stays as a `released` tombstone; (2) an unexpired marker always counts and is never deleted early, and a marker whose record is gone is adopted | Each rule alone stops the double effect; together they hold even if a record disappears by another path. A **fence read in the effect transaction** (reading and verifying the claim generation) was rejected: it needs a read before any write in every handler's transaction, the per-handler reordering ruling 1 avoids (`runConflictCheck` writes before it audits). The tombstone keeps the key bound to its body (another body still gets 422). The marker rule fails closed: a marker naming another operation, or one with no readable expiry, counts. |

## 4. Survey: every `withIdempotency` caller

The router is the only caller (`router.ts:346`). Every POST route goes through it.

| Route | Effect transaction (allow staged in it) | Re-run after a committed effect on main | Mode |
| --- | --- | --- | --- |
| identity/onboardFirm | firm, users, bootstrap, pending marker; then Auth claims | resumes the same firm (FN-1) | rerun |
| identity/createFirmUser | none (`audit.allow()`, then Auth createUser and users doc) | 409 `already_exists` (Auth email uniqueness) | rerun |
| identity/setUserClaims | users and claims_sync; then Auth claims, or a revert | idempotent set, version + 1 | rerun |
| identity/deactivateUser | users `active: false`; then Auth disable | idempotent | rerun |
| identity/enforceMfaForRole | firm policy | idempotent set; a second audit row | once |
| identity/approveMfaDisable | **a new approval doc (random id)** | duplicate approval | once |
| identity/disableMfa | code consumed, approval used; then Auth factors | approval-keyed resume | rerun |
| identity/generateRecoveryCodes | replaces the code hashes | new codes, never shown | once |
| identity/syncMfaStatus | users mfaEnabled | idempotent | once |
| gates/recordGatePass | **a new gate_passes doc** | duplicate pass | once |
| client/setFirmNumbering | prefixes | idempotent | once |
| client/registerClient | **a numbered client, an entity, links** | **duplicate client, number consumed** | once |
| conflict/runConflictCheck | **a check, the daily counter** | **duplicate check, counter consumed** | once |
| conflict/resolveReviewItem | the hit review | 409 `not_review_item` | once |
| conflict/recordPartnerWaiver | the waiver | 409 `already_waived` | once |
| matter/openMatter | **a numbered matter, its members and parties** | 409 (check already bound) | once |
| matter/advanceStage, closeMatter | stage or status | state-guarded | once |
| entity/confirmMerge, disputeLink, rejectLink, unmergeEntity | link and merge state | state-guarded | once |
| jobs/retryFailedJob, cancelJob | job state | state-guarded | once |
| brain/committeeBrain | **a paid provider call**, then the output | **second paid call (O-58)** | resume |
| brain/setBudgetAlerts, setAiKillSwitch, setPlatformAiKillSwitch | config | idempotent set | once |
| drafting/createDraft | **a new draft** | duplicate draft | once |
| drafting/saveDraftVersion, restoreDraftVersion | **a new version** | 409 stale base | once |
| drafting/overrideGate, approveDraft | override, approval; `gate_blocked` commits a new gate result | `gate_blocked` re-gates (new resultId) | once (`gate_blocked` stages its marker) |
| intelligence/gateDraft | **a new gate result** | re-gates | once |

Bold marks an effect that duplicates on re-run. Every route except the five `rerun` routes gets the marker through the allow row it already stages.

This was checked against the source by searching every `once` and `resume` handler file for non-transactional writes (`.set`, `.create`, `.update` and `.add` outside a `tx.` call):
- no `once` route writes anything outside the transaction that stages its allow row;
- the only post-commit writes found are `disableMfa`'s, and that route is `rerun`.

## 5. Failure modes considered

| # | Boundary / fault | Before (main) | After |
| --- | --- | --- | --- |
| 1 | Throw or 5xx after the effect commits (the audit's probe) | Claim deleted, so the effect runs twice | Marker exists → terminal 409, effect once |
| 2 | Ambiguous effect commit (lands, answer lost, handler throws) | Same as 1 | Same as 1 |
| 3 | Settle write fails for good after a 2xx | After the lease, the effect runs again | After the lease, the claim transaction sees the marker → terminal 409 |
| 4 | Crash between effect and settle | Same as 3 | Same as 3 |
| 5 | Takeover after lease; the stale holder later commits | Both effects commit | The stale holder's `tx.create(marker)` fails; one effect |
| 6 | Concurrent duplicate requests | 409 `idempotency_in_progress` | Unchanged |
| 7 | committeeBrain output write fails for good | 500, then a retry calls the provider again | 500 → `resumable` → the retry publishes the receipt; one provider call |
| 8 | committeeBrain crash after the provider answers (after 9b) | Lease → re-run → second call | Lease → resume from the receipt; one call |
| 9 | committeeBrain crash after the provider answers, before 9b | Same | Lease → 409 `idempotency_effect_committed`; one call; the reconciler charges it |
| 10 | committeeBrain stale holder dispatches after takeover | Two calls | Its 8c fails on the marker → `reservation_failed`; nothing sent |
| 11 | committeeBrain stale holder publishes after takeover | Two output rows | Fence read → 409 `idempotency_claim_lost`; one row |
| 12 | 8c commit lands, its answer is lost, the SDK retries | Reservation recorded twice (idempotent) | Marker carries our `traceId` → proceed; no self-fencing |
| 13 | Publication commit lands, its answer is lost | ALREADY_EXISTS path finds the row | Fence read sees `done` with our claim → success (the ALREADY_EXISTS path remains for unbound calls) |
| 14 | Marker left from an expired operation | n/a | Deleted by the next fresh claim, so it never fences a new operation |
| 15 | Key reused across the 24 h boundary while a stale holder runs | n/a | At most one effect per operation. A request after expiry is a new operation by definition (residual, §8). |
| 16 | Store down at settle | Logged; lease | Logged; lease; the marker decides afterwards |
| 17 | A refusal before any effect (401/403/429/503 precall) | Released | Released (no marker): a refreshed token or a later retry runs |
| 18 | Stale holder A; B takes over and ends without an effect; A then commits (Codex P1 on PR #58) | n/a (at aacaae5: the record was deleted, the next request deleted A's marker and committed again) | B leaves a `released` tombstone; the next request takes over, counts A's unexpired marker → terminal 409; one effect |
| 19 | The same, but A commits before B releases | n/a | B's settle finds A's marker → terminal 409; one effect |
| 20 | A record lost while its marker lives | n/a | The marker is adopted (`once` 409, `resume` `prior`); never deleted before its expiry |

## 6. Files that change

- `functions/src/http/idempotency.ts`: the record and marker, modes, the claim and settle state machine, the binding (`read`, `stageEffect`, `stageAnswer`), the terminal code, `idempotencyTestSeam`.
- `functions/src/http/router.ts`: `Route.idempotency`, binding plumbing into `Session.operation` and `CallAudit`, modes on the routes.
- `functions/src/p5/common.ts`: `CallAudit.effects` and the `stage(…, { effect })` option; `Session.operation`.
- `functions/src/p1/gateway.ts`: `P1Request.operation`; the fence in 8c; the receipt in 9b; `crashAt: "recorded"`.
- `functions/src/p1/ops.ts`: the fenced publication with an atomic answer; resume; `beforePublish`.
- `functions/src/d4/gateOps.ts`: `gate_blocked` stages its marker.
- `functions/README.md`, `functions/src/p1/README.md`: the behaviour and the TTL command for `idempotency_effects`.

## 7. Tests

The new file `functions/test/f09-atomic-idempotency.e2e.emu.test.ts` runs through the real HTTP router (`createRouter`, `ROUTES`) on the Auth and Firestore emulators. The provider is faked only at the transport boundary (`setP1TransportForTests`).

**RED on main, GREEN after:**
- **Audit probe.** A route commits a Firestore effect (with its allow row) and then answers 500. The same key twice runs the effect once.
- **User flow.** committeeBrain's output write fails for good, then a same-key retry: 200 with the original text and `traceId`, and exactly one transport call.
- **Crash before the receipt.** committeeBrain crashes after the provider answers and before 9b. The retry makes no second call.
- **Generic takeover.** The stale holder's effect is fenced.
- **committeeBrain takeover.** The stale holder's dispatch is fenced.

**Fault matrix (GREEN after):**
- settle failure → 409 after the lease;
- a real crash (hang plus lease) at the effect/settle boundary and at the provider/publication boundary;
- concurrent duplicates;
- an expired operation's marker;
- `resumable`;
- reruns of `rerun` routes;
- inertness of the new seams in production.

The existing suites must stay green: `http.test.ts`, `p5.security-gaps.emu.test.ts`, `p1.api.emu.test.ts`, `f07-f08-ai-spend.e2e.emu.test.ts`, the d1/d4/p2 suites and the full functions emulator run.

## 8. Residual risk

- **Answer loss on generic routes (ruling 4).** A crash or settle failure after a `once` route's effect gives 409 `idempotency_effect_committed` instead of the original 2xx body. The effect is never repeated. Staging each handler's answer inside its own transaction is a follow-up.
- **Receipt loss on committeeBrain (ruling 9).** If the instance dies between the provider's answer and 9b, the text is unrecoverable. The call is charged, and the key answers 409.
- **The 24 h window.** A retry after the window expires is a new operation and can repeat the effect (failure mode 15). This is inherent in a bounded idempotency window and unchanged from main.
- **The convention the fence relies on.** The marker rides on the transaction that stages the allow row. A future `once` route that commits an effect outside that transaction would not be fenced. The P5 convention (one audit row, staged with the effect) must keep holding, and a reviewer should check it on every new POST route.
- **`rerun` routes keep main's semantics (ruling 5).** Their safety rests on their own idempotency, verified by reading the code (§4), not on the marker.
- **Emulator evidence.** Production Firestore aborts the younger of two contending transactions rather than waiting on locks. The fence is a `create` precondition, which both enforce. The behaviour was measured on the emulator only.
- **TTL.** The `idempotency_effects` TTL policy must be enabled in the project (`gcloud firestore fields ttls update expiresAt --collection-group=idempotency_effects --enable-ttl`). Until then, markers accumulate; they are harmless to correctness, because staleness is decided by `operationId` and expiry.

## 9. F10 reuse

F10 (Next.js, `platform/http/idempotency.ts:96`) can adopt the same two documents through the Admin SDK:

- the operation record, with its binding, `operationId`, lease and stored answer;
- the effect marker, created in the effect transaction.

Keys must be namespaced by surface (for example route strings `POST /api/...`, which already differ between the two stacks), so the Functions and Next.js records never collide. The state machine in §2.3 is transport-agnostic. Only `CallAudit` is Functions-specific; a Next.js port would stage the marker beside its own effect writes.
