# Phase 3b close-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close O-36, O-44, O-45 and O-46 and wire `gate:g4:phase3b` into CI, so Phase 3b's preconditions hold before Phase 3c.

**Architecture:** The P2 sweeper selects rows by a new `sweepAt` field that every state transition writes, re-dispatches with exponential backoff, and pages. `jobKey` scopes per caller and route. `registerClient` gains the `openMatter` round loop. `openMatter` refuses a stored check that relied on a link being un-merged.

**Tech Stack:** TypeScript Cloud Functions (`functions/`), Firestore Admin SDK, vitest under the Auth and Firestore emulators.

**Spec:** `docs/superpowers/specs/2026-10-10-phase3b-closeout-design.md` (rulings P3-34 to P3-41).

## Global Constraints

- Constants: `DISPATCH_GRACE_MS = 30_000` (unchanged), `MAX_REDISPATCH_BACKOFF_MS = 600_000`, `SWEEP_LIMIT = 100` (unchanged), `SWEEP_MAX_PAGES = 5`, `REGISTER_CLIENT_ROUNDS = 10`.
- Backoff: `min(DISPATCH_GRACE_MS * 2 ** redispatches, MAX_REDISPATCH_BACKOFF_MS)`.
- New error codes: none beyond `registry_contended` (409) and `unmerge_in_progress` (409), which already exist.
- `functions` lint at zero warnings (`npx eslint --max-warnings 0 functions`); `npm --prefix functions run typecheck` (or `tsc -p functions`) clean.
- Emulator tests run with `npm --prefix functions run test:emu` or, for one file, `cd /home/user/cursor-init && npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- <file>"`.
- Never skip, weaken or delete an existing test assertion except one that asserts the replaced query or index shape (P3-34), and say so in the commit.
- Commit messages end with the session's Co-Authored-By and Claude-Session lines.

## Review Focus

1. A state transition that leaves `sweepAt` stale (for example `cancelJob`, the fan-out trigger's enqueue, the scheduled primitive's enqueue, a dead-letter from the sweeper's query B): the row would vanish from the sweeper. Every writer of `status` must also write `sweepAt`.
2. The sweeper's page loop must terminate when a page acts on nothing (a race on every row), and must not re-dispatch one row twice in one sweep.
3. Query B's dead-letter path at `attempts >= MAX_ATTEMPTS` must still fire for a row whose `sweepAt` equals its lease expiry.
4. `jobKey` must keep throwing when the session has no Idempotency-Key, and must not change the key of anything already enqueued (there is no caller today).
5. `openMatter`'s new refusal must read link rows inside its existing transaction, before any write, and must not fire for links that are merely `confirmed` or `disputed`.

---

### Task 1: `sweepAt`, re-dispatch backoff and sweeper paging (P3-34..P3-36)

**Files:**
- Modify: `functions/src/p2/constants.ts`, `functions/src/p2/enqueue.ts` (JobRow type, new-row writer), `functions/src/p2/worker.ts` (claim, retry, terminal writes), `functions/src/p2/ops.ts` (retryFailedJob, cancelJob), `functions/src/p2/sweeper.ts`, `firestore.indexes.json`
- Test: `functions/test/p2.jobs-sweeper.emu.test.ts` (extend), `functions/test/p2.jobs-worker.emu.test.ts`, `functions/test/p2.jobs-api.emu.test.ts`, `functions/test/p2.jobs-enqueue.emu.test.ts` as needed

**Interfaces:**
- Produces: `JobRow.sweepAt: Timestamp | null`, `JobRow.redispatches: number`; `export function redispatchBackoffMs(redispatches: number): number` in `constants.ts`; `SWEEP_MAX_PAGES`, `MAX_REDISPATCH_BACKOFF_MS`.

- [ ] Write failing emulator tests, one per transition: enqueue sets `sweepAt = createdAt + 30 s` and `redispatches: 0`; a failed attempt sets `sweepAt = nextAttemptAt + 30 s` and `redispatches: 0`; a claim sets `sweepAt = lease.expiresAt` and `redispatches: 0`; `retryFailedJob` sets `sweepAt = now + 30 s`, `redispatches: 0`; `cancelJob`, `done` and `dead_lettered` set `sweepAt: null`; a sweeper re-dispatch of a queued row sets `redispatches: 1` and `sweepAt = now + 60 s`, the next one `redispatches: 2`, `sweepAt = now + 120 s`, capped at 600 s.
- [ ] Write a failing head-of-line test: 150 due queued rows of which the first 120 (by `nextAttemptAt`) were dispatched 10 s ago; one sweep re-dispatches all 30 eligible rows (before: 0, because the 100-row page held only ineligible rows).
- [ ] Write a failing paging test: 260 eligible rows are all re-dispatched in one sweep; 600 eligible rows give exactly 500.
- [ ] Implement. `redispatchable(row, now)` uses `redispatchBackoffMs(row.redispatches ?? 0)` from `dispatchedAt` (the skew rule is unchanged). Queries A and B order and filter on `sweepAt`. The page loop stops on a short page, after `SWEEP_MAX_PAGES`, or when a page dispatched and dead-lettered nothing.
- [ ] Replace the two `jobs` indexes `(status, nextAttemptAt)` and `(status, lease.expiresAt)` with `(status, sweepAt)`.
- [ ] Run the whole `p2.*` emulator suite plus `d1.entity-unmerge.emu.test.ts`; all pass. Lint and typecheck clean.
- [ ] Commit: `feat(p2): sweepAt, re-dispatch backoff and paged sweeps (O-36, P3-34..P3-36)`.

### Task 2: Long-handler load test (P3-37)

**Files:**
- Create: `functions/test/p2.jobs-load.emu.test.ts`
- Modify (only if a test-only job type is needed): the test registers its type through the existing registry test seam, not in `functions/src`.

**Interfaces:**
- Consumes: Task 1's `sweep(deps)`, the worker entry the existing worker tests call, `JobDeps` with a virtual `clock`.

- [ ] Write the test as P3-37 states: 250 jobs, handler holds a slot for 240 virtual seconds, a fake dispatcher with 10 FIFO slots, a sweep every 60 virtual seconds, run until every job is `done` or 6 virtual hours pass. Assert every job is `done`, no due row waited longer than one backoff period past eligibility without a dispatch or a claim, and total tasks enqueued ≤ 8 per job.
- [ ] Add the control: the same scenario with `redispatchBackoffMs` forced to the fixed 30 s grace (through a test seam on the sweeper, deleted in `finally`) exceeds 8 tasks per job. If the control does not exceed the bound, the scenario is too gentle: tighten it, never the bound.
- [ ] Keep the run under 120 s of real time in the emulator (reduce rows only if necessary, and record the number in the test name).
- [ ] Commit: `test(p2): long-handler load test for sweeper back-pressure (O-36, P3-37)`.

### Task 3: Per-caller job keys and `registerClient` contention (P3-38, P3-39)

**Files:**
- Modify: `functions/src/p2/enqueue.ts` (`jobKey`), `functions/src/http/router.ts` (session gains `route` for POST/PUT), the `Session` type, `functions/src/d1/client/ops.ts` (round loop)
- Test: `functions/test/p2.dispatch.test.ts` or a new `functions/test/p2.jobkey.test.ts`; `functions/test/d1.client.emu.test.ts`

- [ ] Failing unit tests: `jobKey` differs for two uids and for two routes with one key; is equal for an upper- and lower-case UUID; still throws without a key.
- [ ] Failing emulator test: 10 parallel `registerClient` calls against one firm answer 200 or 409 `registry_contended`, never 500 (mirror the `openMatter` "10 parallel opens" test).
- [ ] Implement both. `registerClient` reuses `isContentionAbort` from `d1/matter/ops.ts` (move it to a shared module if importing it would create a cycle).
- [ ] Run unit and `d1.client` emulator tests; lint and typecheck clean.
- [ ] Commit: `fix(functions): per-caller job keys (O-44) and registerClient contention retry (O-45)`.

### Task 4: `openMatter` refuses a check relying on a link being un-merged (P3-40)

**Files:**
- Modify: `functions/src/d1/matter/ops.ts` (`openMatter`'s stored-check path)
- Test: `functions/test/d1.entity-unmerge.emu.test.ts` (extend)

- [ ] Failing test: confirm a pair, run a conflict check whose hit relies on that link and clear it, start `unmergeEntity` without delivering the saga jobs, then `openMatter` with that check answers 409 `unmerge_in_progress` and writes no matter; after delivering the checks job it answers 409 `check_stale`.
- [ ] Failing test: a check whose hits rely only on confirmed or disputed links is unaffected.
- [ ] Implement: inside the existing transaction, before any write, read the `entity_links` rows named by the stored hits' `reliedOnLinkIds` (deduplicated) and refuse if any reads `unmerging` by the same read-time rule E-43(c) uses (reuse that function).
- [ ] Run `d1.matter`, `d1.entity-unmerge` and the registry-discipline suites; lint and typecheck clean.
- [ ] Commit: `fix(d1): openMatter refuses a check relying on a link being un-merged (O-46, P3-40)`.

### Task 5: CI gate step and records (P3-41)

**Files:**
- Modify: `.github/workflows/gate-g0.yml`, `ci_gates/gate_g4_phase3b.sh` (name the new load test and the O-46 test), `docs/architecture/ERRATUM_SET_2_PROPOSED.md` (E-44; O-36, O-44, O-45, O-46 closed with the commit), `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md` (P3-34..P3-41), `functions/src/p2/README.md` (sweeper behaviour)

- [ ] Add the `gate:g4:phase3b` step after the Phase 3a step in the gates job.
- [ ] Run `npm run gate:g4:phase3b` locally; passes.
- [ ] Commit: `ci: run gate:g4:phase3b; record Phase 3b close-out rulings and errata`.
