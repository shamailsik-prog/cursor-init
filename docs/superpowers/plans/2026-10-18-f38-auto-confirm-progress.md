# F38 auto-confirm progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daily auto-confirm job reaches every eligible pair in a bounded number of runs, however many ineligible pairs sit ahead of it, and records why it passes a pair over.

**Architecture:** A per-firm frontier cursor over `(createdAt, linkId)` replaces the fixed 2,000-row window. Pairs the frontier finds ineligible get deferral records with a due time, which a recheck query brings back. A run that leaves work continues through the P2 engine (up to 23 continuations per period). A checkpoint records progress and the backlog age that drives the stale alert. It is a transaction rather than a step, and it checks the claim's fence first (R7a, PR #84 review round 1).

**Tech Stack:** TypeScript, Firebase Admin SDK (Firestore), firebase-functions logger, vitest, Firestore and Auth emulators.

**Spec:** `docs/superpowers/specs/2026-10-18-f38-auto-confirm-progress-design.md` (rulings R1–R14).

## Global Constraints

- Ten pairs per step (`AUTO_CONFIRM_STEP_PAIRS = 10`). At most 48 positional step ids per job (`AUTO_CONFIRM_MAX_STEPS = MAX_FENCED_STEPS - 2`). Step id `autoconfirm-<n>`.
- `AUTO_CONFIRM_ROW_LIMIT = 2000` frontier rows per run; `AUTO_CONFIRM_PAGE_ROWS = 500`.
- `AUTO_CONFIRM_MAX_CONTINUATIONS = 23`; `AUTO_CONFIRM_RECHECK_MS = 7 days`; `AUTO_CONFIRM_STALE_MS = 36 hours`.
- Progress doc `counters/{firmId}_autoconfirm`. Deferral collection `autoconfirm_deferrals`, id `acd_` + the first 40 hex characters of SHA-256(firmId NUL pairId).
- Log lines (codes and ids only): `autoconfirm.backlog_stale` (error), `autoconfirm.backlog_cleared` (info), `autoconfirm.backlog_remaining` (warn); `autoconfirm.event_exists_skip` unchanged.
- Do not touch `functions/src/d1/conflict/*`, `functions/src/d1/matter/ops.ts`, `corpus_service/**`, `app/api/**`, `.gitleaks.toml`.
- Every document a new test creates is deleted by that test file.

## Review Focus

- A pair whose rows straddle the cursor (one old row handled, a newer row of the same pair read later): it is evaluated whole each time and confirmed once. Task 2, test "a pair whose rows straddle the cursor".
- Head rows that cannot name a pair (unsafe or equal ids): the frontier passes them, counts them, and they never starve later pairs. Task 2, test "rows that cannot name a pair".
- Two runs of one firm at once (a backfill of two periods): every pair is confirmed exactly once and the chains end. Task 2, test "two periods' chains at once".
- Equal `createdAt` across a page boundary (ties broken by link id): no row is skipped or read twice. Covered by the 500-pair crash test (one createdAt, page 500) and P3-53 (520 pairs).
- The flag read off at the checkpoint: nothing is written and no continuation is enqueued. Task 2, flag test.

---

### Task 1: Spec, plan and RED tests

**Files:**
- Create: `functions/test/f38-autoconfirm-progress.test.ts` (unit, no emulator)
- Create: `functions/test/f38-autoconfirm-progress.e2e.emu.test.ts` (emulators)

**Interfaces (consumed from Task 2; absent on main, so RED):**
- `autoConfirmJob.ts`: `AUTO_CONFIRM_MAX_CONTINUATIONS`, `AUTO_CONFIRM_STALE_MS`, `AUTO_CONFIRM_RECHECK_MS`, `autoConfirmProgressRef(firmId)`, `autoConfirmHandler.parse`, `autoConfirmTestSeam.beforeCheckpoint`.
- `autoConfirmDeferral.ts`: `AUTO_CONFIRM_DEFERRALS = "autoconfirm_deferrals"`, `deferralIdOf(firmId, pairId): string`, `judgeRows(rows: Array<{ id: string; data: DocumentData }>, nowMs: number): Verdict`, `type DeferralReason`.

- [ ] **Step 1: Unit tests.** `parse` accepts `{ period }` (continuation 0) and `{ period, continuation: 1..23 }`; rejects continuation 0, 24, 1.5, "1", and any extra key with `invalid_payload`. `judgeRows`: no row in the scan predicate gives `gone`; all rows aged undisputed candidates give `eligible`; precedence `unmerge_in_progress > confirmed_row > rejected_row > disputed_row > invalid_row > young_row`; `young_row` due time = latest young `createdAt` + 30 d; others now + 7 d; `rowId` names the deciding row. `deferralIdOf("firm-1", "aaa_bbb")` equals `"acd_"` + the first 40 hex of SHA-256 of `b"firm-1\x00aaa_bbb"`, computed independently and hard-coded.
- [ ] **Step 2: E2E tests** (helpers seed pairs per kind in batches and purge every doc by firm, plus the tick's job rows by run key):
  1. "F38 RED/GREEN: more than 2,000 ineligible head pairs never starve the eligible pairs behind them": 2,002 ineligible pairs (each R3 reason), 15 eligible pairs created later, three simulated days through `enqueueScheduledRuns` + `onJobCreatedCore` + drain. Assert cumulative eligible confirmed per day `[15, 15, 15]`, runs on day 1 ≤ 5, every ineligible pair still a candidate with rows unchanged and a deferral record with its reason, one merge event per eligible pair.
  2. "F38 alert": 481 entity-missing head pairs + 5 eligible. After run 1, `backlog.alert === "stale"` and one `autoconfirm.backlog_stale` error. After the chain, `alert === null` and one `autoconfirm.backlog_cleared`.
  3. "F38 crash and retry": 500 eligible pairs, one `createdAt`. The checkpoint seam throws on run 1 attempt 1, and the retry enqueues c1 once. c1's step seam throws at index 1 on attempt 1, and the retry finishes. A duplicate delivery is dropped. Exactly one merge event, `entity.confirmed` and audit row per pair. c1's fenced steps are `autoconfirm-0` and `autoconfirm-1`: position 0 is spent on the retry and its chunk runs at position 1.
  4. "F38 fencing": c1's lease is reclaimed mid-run (the clock passes the lease inside the step seam and the reclaim runs to done). The stale attempt ends `lease_lost`, and every pair is confirmed exactly once.
  5. "F38 flag off mid-continuation": 480 entity-missing + 20 eligible. In c1 the flag goes off at index 1: 10 are confirmed, there is no c2, and the cursor stays at the last committed step. With the flag back on, the next day's run confirms the other 10. A separate check: the flag off at the checkpoint writes nothing.
  6. "F38 rechecks": a deferred `entity_missing` pair whose entity is restored is confirmed when its recheck falls due. A deferred pair that left the backlog has its record deleted. A record not yet due is not handed to a step.
  7. "F38 cross-firm": two firms with head backlogs. Firm A's chain leaves firm B's rows, records and progress untouched, and B's own chain then completes.
  8. Review Focus tests: straddling rows, rows that cannot name a pair, and two periods' chains at once.
- [ ] **Step 3: Run on main (RED).** `scratchpad/f38/emu.sh "npm --prefix functions test -- test/f38-autoconfirm-progress.test.ts test/f38-autoconfirm-progress.e2e.emu.test.ts"`. Expected: the unit file fails at import; every e2e fails. Record per-day eligible confirmed on main (`[0, 0, 0]`).
- [ ] **Step 4: Commit and push** spec, plan and tests (gitleaks first).

### Task 2: Frontier, deferrals, rechecks, continuation, checkpoint

**Files:**
- Create: `functions/src/d1/entity/autoConfirmDeferral.ts`: reasons, `judgeRows`, `deferralIdOf`, `deferralRefOf(firmId, pairId)`, `AUTO_CONFIRM_RECHECK_MS`.
- Create: `functions/src/d1/entity/autoConfirmFrontier.ts`: `type Cursor = { createdAt: Timestamp; linkId: string }`, `class FrontierScan` (`fill(n)`, `pending()`, `peek(n)`, `advance(n)`, `cursorAt(k)`, `drained`, `nextDueMs()`), `autoConfirmProgressRef(firmId)`, `readCursor(data, firmId)`.
- Modify: `functions/src/d1/entity/autoConfirmJob.ts`: `parse` (R6); `readPair` returns a tagged result; `run` = frontier steps, recheck steps, checkpoint (R7), logs (R11); position reuse on a retry (R8).

- [ ] **Step 1:** Implement to the interfaces above. The step transaction reads in main's order, then the event (eligible only), then the deferral record, and writes only after all reads.
- [ ] **Step 2:** Run the unit and e2e files: all pass. Run `test/d1.entity-autoconfirm.emu.test.ts`: 14 pass, unchanged.
- [ ] **Step 3:** `npm --prefix functions run typecheck`; `npx eslint --max-warnings 0 functions`.
- [ ] **Step 4: Commit and push.**

### Task 3: Rules, index, README, gate, ledger

**Files:**
- Modify: `firestore.rules`: `match /autoconfirm_deferrals/{id} { allow read, write: if false; }` after the `entity_links` block.
- Modify: `firestore.indexes.json`: append `autoconfirm_deferrals (firmId ASC, recheckAt ASC)`.
- Modify: `functions/src/p2/README.md`: a section "Auto-confirm progress and the backlog alert (F38)" between the dead-letter runbook and Backfill.
- Modify: `ci_gates/gate_g4_phase3c.sh`: a named F38 suite (the e2e tests), with the count derived from the arrays.
- Modify: `docs/superpowers/specs/2026-10-10-phase3c-autoconfirm-fixes-design.md`: a note under O-50 and P3-53 pointing at this spec.

- [ ] **Step 1:** Make the edits. Run `npm run test:rules`, `npm run gate:g2` and `npm run gate:g4:phase3c`.
- [ ] **Step 2:** Run the full functions unit suite, the d1 entity and P2 job emulator suites, typecheck, lint, and `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [ ] **Step 3:** Fill the ledger below. Write the PR body and run the claim gate. Commit and push.

## RED/GREEN ledger

RED: the main `0e6981b` tree plus the two new test files only. GREEN: commit `3f752f5`. Both ran under `scratchpad/f38/emu.sh` (Auth and Firestore emulators on private ports, project `demo-sikander`) with `npm --prefix functions test -- <files>`. Load average was about 11 on 4 cores.

| Test | main (RED) | branch (GREEN) |
| --- | --- | --- |
| Core: 2,002 old ineligible pairs (9 reasons), then 15 eligible; real tick; 3 days | eligible confirmed by day `[0,0,0]` of 15; runs `[1,1,1]`; `event_exists_skip` repeated daily | `[15,15,15]`; runs `[5,1,1]`; every head pair a candidate, rows unchanged, one record with its reason |
| Alert fires, then clears | no log line (1 run, no continuation) | `backlog_stale` after run 1 (age 30 d − 480 ms), `backlog_cleared` after c1 |
| Stale state on the progress doc | no progress doc | `alert: "stale"`, `pendingSince`, `outcome: "continued"`, `deferred: 480` |
| Last continuation (c23) | payload refused | `backlog_remaining` warn, no c24, the next day resumes |
| Crash at checkpoint, crash mid-c1, duplicates | no continuation | one c1; c1 steps `0,1`; 500 events / audits / `entity.confirmed`, max 1 per pair |
| Fencing: c1 lease reclaimed mid-run | dead-lettered (payload refused) | stale attempt `lease_lost`, reclaim `done`, 30 confirmed once |
| Flag off mid-c1 | 1 run | 10 confirmed, no c2, cursor at the 10th, next day 20 |
| Flag off at checkpoint | no progress doc | no `lastRun`/`backlog`, no c1 |
| Rechecks | no records | repaired pair confirmed at its due time; left-backlog record deleted; not-due not re-read |
| Cross-firm | 1 run | A's chain leaves B untouched; per-firm records for one shared pair id |
| Straddling rows | 1 run | pair confirmed once with both rows; rejected pair `checks: 2`, rows unchanged |
| 2,001 rows that cannot name a pair | eligible never reached | `skippedRows` 2,000 then 1; 5 confirmed |
| Two periods at once | no continuation | 30 confirmed once, every job `done` |
| Unit file (8 tests) | import fails | 8 pass |
| Existing P3 auto-confirm suite (14) | 14 pass | 14 pass, unchanged |

### Verification on the merged tree (F37 `f670d62` and main `957fe26` merged)

The machine is shared; its load average ran 9 to 32 on 4 cores. Every failure below was re-run against main, either in the same run or alone at the same load.

| Check | Branch | Main, same load |
| --- | --- | --- |
| F38 e2e and unit, after the final merge | 21/21; core `[15,15,15]`, runs `[5,1,1]` | — |
| What the F38 e2e leaves behind (census before and after) | 0 → 0 in every collection it writes (firms, jobs, `entity_links`, entities, merge events, events, audit rows, counters, deferral records) | — |
| Auto-confirm, then scheduled and sweeper, in one session | 35/35, then 32/32 (scheduled 4.7 s) | — |
| Full functions `test:emu` set, run side by side | 2,390/2,393; 3 timeouts at load 26 | 2,371/2,372; 1 timeout (the same `p2.jobs-invariants` first test) |
| The 3 timed-out files, alone and side by side | 44/44 | 44/44 |
| `npm run gate:g4:phase3c` steps 1–4 | routes 21 + 4; boot; **42 named passed, 0 failed**; lint | — |
| G-2 (gate step 5), re-run at load ~7 | all 4 rules tests pass, firm-B denial covering `autoconfirm_deferrals` included; HTTP-api test times out at 15 s; root file fails at import | HTTP-api test times out at 15 s; root file fails at import |
| Rules (`test:rules` file list) | 6/6 rules files; D1 2a 110/110 (7 new) | — |
| Static | typecheck 0; eslint `--max-warnings 0 functions` 0; G-0 PASSED | — |

### Review round 1: PR #84, Codex P1, fencing the checkpoint (spec R7a)

| Test | Head `7249c25` (RED) | Fix `312d611` (GREEN) | Mutant: `checkFence` call deleted |
| --- | --- | --- | --- |
| Claim taken by another delivery before the checkpoint | stale attempt enqueued `c1` | no `c1`, no `lastRun`/`backlog` | fails |
| Reclaimed and finished by a newer attempt | stale attempt enqueued `c1`, overwrote the newer attempt's record | no `c1`; the newer attempt's `drained` record stands | fails |
| Dead-lettered at attempt 4 | stale attempt enqueued `c1` | no `c1`, no `lastRun`/`backlog` | fails |
| F38 e2e and unit; auto-confirm; unmerge; every P2 file | — | 22 files, 212/212 | — |
| `gate:g4:phase3c` steps 1–4 | — | routes 21 + 4, boot 4/4, **45 named passed, 0 failed**, lint | — |

G-2 at load ~17, run side by side: the setup hooks time out (10 s) on branch and main alike, and the root file fails at import on both.

The borrowed `node_modules` predates F03 and lacks `@aws-sdk/client-s3`. Every root test that imports `platform/documents` fails at import on branch and main alike.
