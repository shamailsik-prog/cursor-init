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

- [x] Generic probe through `createRouter`. A test route stages its allow row and increments `f09_effects/{id}.n` in one transaction, then throws. Two requests with the same key leave `n` at 1. On main it is 2.
- [x] committeeBrain user flow through `ROUTES` (`viaApi`), with `p1OpsTestSeam.outputWriteFailures = [x3]`. The first request gets 500; a same-key retry gets 200 with `text: "REPLY"`, the same `traceId`, and `sent.length === 1`. On main there are 2 transport calls.
- [x] committeeBrain with `crashAt: "dispatched"`: a same-key retry makes no second transport call and answers 409 `idempotency_effect_committed`. On main it calls the provider again.
- [x] Generic takeover. A is held before its effect; B, with a clock past the lease, takes over and commits; A is then released. Effect count 1 (2 on main).
- [x] committeeBrain takeover. A is held at `beforeReserve`; B takes over and dispatches; A is released. One transport call (2 on main).
- [x] Run the five on main and record the failing counts.

## Task 2: wrapper, binding and modes

**Files:** `functions/src/http/idempotency.ts`, `functions/src/http/router.ts`, `functions/src/p5/common.ts`.

- [x] `IdempotencyMode` and `scope.mode`. The claim reads the record and the marker together. Implement the state machine of spec §2.3: terminal 409, `resumable`, stale-marker deletion, and a takeover that keeps `operationId` and `expiresAt`.
- [x] `OperationBinding`: `ref`, `markerRef`, `operationId`, `claimId`, `mode`, `prior`, `read(tx)`, `stageEffect(tx, extra?)`, `stageAnswer(tx, result)`, `markerFields()`.
- [x] Settle: storable → `done`, unless the answer is already stored; non-storable → release, `resumable` or terminal, decided from the marker.
- [x] `idempotencyTestSeam` (`settleFailures`, `beforeSettle`), inert in production.
- [x] `CallAudit.effects`, and `stage(tx, decision, reason, { effect })` (default: `decision === "allow"`). No marker is staged after `committed()`.
- [x] `Session.operation`. The router passes the binding into the session and into the audit; `rerun` routes get no audit binding.
- [x] Modes on the routes: `rerun` for onboardFirm, createFirmUser, setUserClaims, deactivateUser and disableMfa; `resume` for committeeBrain.

## Task 3: P1 gateway fence and receipt

**Files:** `functions/src/p1/gateway.ts`.

- [x] Add `P1Request.operation?: { markerRef, fields }`.
- [x] `markAttempt` reads the marker, then creates it, accepts it when it carries this call's `traceId`, or throws `operation_fenced` (so nothing is sent).
- [x] `recordAttemptOutcome` also writes `result` to a marker that carries this call's `traceId`. It still updates the reservation only while that is `reserved`.
- [x] `crashAt: "recorded"`.

## Task 4: committeeBrain publication and resume

**Files:** `functions/src/p1/ops.ts`.

- [x] Publication transaction: `operation.read(tx)` first; when the answer is already stored, return success. A marker with another `traceId` → 409 `idempotency_claim_lost`. Then `audit.stage(… { effect: no marker })`, the output row, and `stageAnswer`.
- [x] Resume when `operation.prior` is a `p1_dispatch` marker: re-run the checks, then publish from the receipt, or answer 409 `idempotency_effect_committed` when the receipt is missing.
- [x] Add `p1OpsTestSeam.beforePublish`.

## Task 5: approveDraft's gate_blocked

**Files:** `functions/src/d4/gateOps.ts`.

- [x] `audit.stage(tx, "deny", "gate_blocked", { effect: true })`.

## Task 6: fault matrix (GREEN)

- [x] Settle failure: after the lease, 409 and an effect count of 1.
- [x] Real crash (hang plus lease) at the effect/settle boundary.
- [x] committeeBrain:
  - crash after the receipt (thrown `crashAt: "recorded"`) → resume;
  - real crash at `beforePublish` → resume; the stale holder's later publication is fenced;
  - concurrent same-key requests → one call.
- [x] State-machine units through `withIdempotency`:
  - an expired operation's marker is deleted;
  - `once` → terminal without a run;
  - `resume` passes `prior`;
  - `resumable` → immediate takeover;
  - a takeover keeps `operationId` and `expiresAt`;
  - a refusal before any effect releases the claim.
- [x] A `rerun` route keeps main's behaviour.
- [x] The new seams are inert in production.

## Task 7: documentation

- [x] `functions/README.md`: modes, the 409 code, and the TTL command for `idempotency_effects`.
- [x] `functions/src/p1/README.md`: O-58 resolved by F09 (awaiting re-audit); the marker, the receipt and resume.

## Task 8: verification and PR

- [x] Run the functions typecheck, the root typecheck, lint and the functions unit tests.
- [x] Run the F09 file and the touched suites on the emulator, then the full functions emulator suite.
- [x] Run the claim gate locally: `ci_gates/check_pr_phase_claims.py` must PASS.
- [x] Commit with the trailers, push, and open a draft PR whose body carries the RED/GREEN evidence.

## Execution record (2026-10-16)

All emulator runs used the repo's rules and indexes. They differed from the repo command only in a config file with its own ports, because another session on the host was using `firebase.json`'s ports.

- **RED.** Main @ 0a6f02f plus this plan's test file: `npx vitest run test/f09-atomic-idempotency.e2e.emu.test.ts` gave **21 failed / 6 passed (27)**. All 7 audit scenarios fail:
  - the effect committed twice: `expected 2 to be 1`;
  - two provider calls: `expected … to have a length of 1 but got 2`.
- **GREEN.** The same file on this branch: **27 / 27**. The F09 file plus the touched suites (http, p5.security-gaps, p1.api, p1.gateway, f07-f08, d4.gate, p2.jobs-scheduled): **505 / 505**.
- **Full functions emulator suite.** Branch: 1600 passed, 3 failed, all of them `p2.jobs-scheduled` 15 s timeouts when that file runs late.
  - Main in the same fresh order: 1572 passed, 4 failed in that same file.
  - Main with that file first: 1576 / 1576.
  - The file's cost is O(every firm in the shared emulator), as its own comment notes. It passes in 4.6 s on this branch when it runs early.
  - The common files took 778 s on main and 771 s on this branch (no measurable overhead).
  - This file deletes the `firms` docs it creates, so it leaves that scan as main does.
- **Unit run (no emulators).** 506 passed, and the same 5 `d4.gate.emu` tests that lack an emulator skip guard fail. Main is identical.
- **Typecheck, lint, rules and coverage.**
  - Functions typecheck, root typecheck and `typecheck:tests` all exit 0, the root ones after `npm ci` in the worktree; the shared install lacked `@playwright/test` and `@types/pg`.
  - Lint: 0 errors and 0 warnings in touched paths, and `eslint --max-warnings 0 functions` exits 0.
  - Rules: `tests/firestore.rules.p1-phase3d.test.ts` 23 / 23.
  - Route coverage: PASS ×3.

### Delta re-audit of 226a54e (PASS 8.0; one MEDIUM and one LOW fixed before merge)

- **MEDIUM-1 (ATK-7, a matter-wall leak), ruling 17.** Markers carry `uid`, `route` and `requestHash`, and a committeeBrain marker carries `matterId`. An orphan marker is adopted only by the request that made it; otherwise 422 `idempotency_key_reused` with nothing written. `resumeCommittee` re-checks the binding and the matter on the fresh marker.
  - RED: the 226a54e source with this round's tests (F09 and guard files) gave **8 failed / 40 passed (48)**. ATK-7 answered 200 with X's text on Y's matter.
  - GREEN: **48 / 48**. A mutant without the `resumeCommittee` matter check fails the forged-matter test.
- **LOW-A, ruling 18.** The static guard flags writes and task dispatches outside a transaction on each `once` route's path, following same-file and relative-import functions.
  - The 226a54e guard accepted both G3 samples: **2 / 2 RED**.
  - Allowlist: `*` for `p5/audit.ts#appendAudit: ref.create`; `retryFailedJob` for `run: runtimeDeps().dispatcher.dispatch`.
- **Verification.**
  - Targeted emulator set (9 files): **526 / 526**.
  - Functions typecheck exits 0, and `eslint --max-warnings 0 functions` exits 0.
  - `npm run lint` exits 0 with 0 errors. Its 89 warnings are all pre-existing, the same files as the previous round, none in touched paths.
