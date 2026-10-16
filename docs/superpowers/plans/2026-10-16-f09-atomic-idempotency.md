# F09 Atomic Idempotency: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A committed effect is never repeated for one Idempotency-Key. The operation's "effect committed" state commits with the effect. committeeBrain makes at most one provider call per operation, and resumes publishing its answer from a durable receipt.

**Architecture:**
- The effect marker `idempotency_effects/{id}` is created with `tx.create` inside the effect transaction. It is a write-only fence: no read is needed.
- Every route declares a mode: `once` (the default), `rerun` or `resume`.
- committeeBrain records its marker at dispatch (step 8c), its receipt when the provider answers (step 9b), and its answer in the publication transaction.

**Spec:** `docs/superpowers/specs/2026-10-16-f09-atomic-idempotency-design.md`, rulings 1–12.

**Base:** branch `claude/remediate-f09` from `origin/main` @ 0a6f02f.

## Global constraints

- Cloud Functions only. Do not touch `platform/http/idempotency.ts` (F10), `platform/documents/*` (#47), `app/api/**` or `platform/spine` (#44).
- No skipped, weakened or disabled test. Existing assertions change only where they encode the F09 defect itself, and each such change is named in the PR.
- Every new seam is inert when `NODE_ENV` is `production`.
- Commands:
  - Emulator: `/home/user/cursor-init/node_modules/.bin/firebase emulators:exec --only auth,firestore --project demo-sikander "cd functions && npx vitest run <files>"`
  - Typecheck: `npm --prefix functions run typecheck` and `npm run typecheck`
  - Lint: `npm run lint`

## Task 1: RED tests on main

**Files:** create `functions/test/f09-atomic-idempotency.e2e.emu.test.ts`.

- [ ] Generic probe through `createRouter`. A test route stages its allow row and increments `f09_effects/{id}.n` in one transaction, then throws. Two requests with the same key leave `n` at 1. On main it is 2.
- [ ] committeeBrain user flow through `ROUTES` (`viaApi`), with `p1OpsTestSeam.outputWriteFailures = [x3]`. The first request gets 500; a same-key retry gets 200 with `text: "REPLY"`, the same `traceId`, and `sent.length === 1`. On main there are 2 transport calls.
- [ ] committeeBrain with `crashAt: "dispatched"`: a same-key retry makes no second transport call and answers 409 `idempotency_effect_committed`. On main it calls the provider again.
- [ ] Generic takeover. A is held before its effect; B, with a clock past the lease, takes over and commits; A is then released. Effect count 1 (2 on main).
- [ ] committeeBrain takeover. A is held at `beforeReserve`; B takes over and dispatches; A is released. One transport call (2 on main).
- [ ] Run the five on main and record the failing counts.

## Task 2: wrapper, binding and modes

**Files:** `functions/src/http/idempotency.ts`, `functions/src/http/router.ts`, `functions/src/p5/common.ts`.

- [ ] `IdempotencyMode` and `scope.mode`. The claim reads the record and the marker together. Implement the state machine of spec §2.3: terminal 409, `resumable`, stale-marker deletion, and a takeover that keeps `operationId` and `expiresAt`.
- [ ] `OperationBinding`: `ref`, `markerRef`, `operationId`, `claimId`, `mode`, `prior`, `read(tx)`, `stageEffect(tx, extra?)`, `stageAnswer(tx, result)`, `markerFields()`.
- [ ] Settle: storable → `done`, unless the answer is already stored; non-storable → release, `resumable` or terminal, decided from the marker.
- [ ] `idempotencyTestSeam` (`settleFailures`, `beforeSettle`), inert in production.
- [ ] `CallAudit.effects`, and `stage(tx, decision, reason, { effect })` (default: `decision === "allow"`). No marker is staged after `committed()`.
- [ ] `Session.operation`. The router passes the binding into the session and into the audit; `rerun` routes get no audit binding.
- [ ] Modes on the routes: `rerun` for onboardFirm, createFirmUser, setUserClaims, deactivateUser and disableMfa; `resume` for committeeBrain.

## Task 3: P1 gateway fence and receipt

**Files:** `functions/src/p1/gateway.ts`.

- [ ] Add `P1Request.operation?: { markerRef, fields }`.
- [ ] `markAttempt` reads the marker, then creates it, accepts it when it carries this call's `traceId`, or throws `operation_fenced` (so nothing is sent).
- [ ] `recordAttemptOutcome` also writes `result` to a marker that carries this call's `traceId`. It still updates the reservation only while that is `reserved`.
- [ ] `crashAt: "recorded"`.

## Task 4: committeeBrain publication and resume

**Files:** `functions/src/p1/ops.ts`.

- [ ] Publication transaction: `operation.read(tx)` first; when the answer is already stored, return success. A marker with another `traceId` → 409 `idempotency_claim_lost`. Then `audit.stage(… { effect: no marker })`, the output row, and `stageAnswer`.
- [ ] Resume when `operation.prior` is a `p1_dispatch` marker: re-run the checks, then publish from the receipt, or answer 409 `idempotency_effect_committed` when the receipt is missing.
- [ ] Add `p1OpsTestSeam.beforePublish`.

## Task 5: approveDraft's gate_blocked

**Files:** `functions/src/d4/gateOps.ts`.

- [ ] `audit.stage(tx, "deny", "gate_blocked", { effect: true })`.

## Task 6: fault matrix (GREEN)

- [ ] Settle failure: after the lease, 409 and an effect count of 1.
- [ ] Real crash (hang plus lease) at the effect/settle boundary.
- [ ] committeeBrain:
  - crash after the receipt (thrown `crashAt: "recorded"`) → resume;
  - real crash at `beforePublish` → resume; the stale holder's later publication is fenced;
  - concurrent same-key requests → one call.
- [ ] State-machine units through `withIdempotency`:
  - an expired operation's marker is deleted;
  - `once` → terminal without a run;
  - `resume` passes `prior`;
  - `resumable` → immediate takeover;
  - a takeover keeps `operationId` and `expiresAt`;
  - a refusal before any effect releases the claim.
- [ ] A `rerun` route keeps main's behaviour.
- [ ] The new seams are inert in production.

## Task 7: documentation

- [ ] `functions/README.md`: modes, the 409 code, and the TTL command for `idempotency_effects`.
- [ ] `functions/src/p1/README.md`: O-58 resolved by F09 (awaiting re-audit); the marker, the receipt and resume.

## Task 8: verification and PR

- [ ] Run the functions typecheck, the root typecheck, lint and the functions unit tests.
- [ ] Run the F09 file and the touched suites on the emulator, then the full functions emulator suite.
- [ ] Run the claim gate locally: `ci_gates/check_pr_phase_claims.py` must PASS.
- [ ] Commit with the trailers, push, and open a draft PR whose body carries the RED/GREEN evidence.
