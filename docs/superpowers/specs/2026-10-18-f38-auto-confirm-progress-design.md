# F38: auto-confirm progress past ineligible pairs

Date: 2026-10-18. Status: rulings made under the owner's standing autonomy instruction; the owner pre-authorised this spec without a review gate.

## The finding

Audit F38 (HIGH, P1), `docs/audit/2026-10-13-forensic-audit.md:788`: "Auto-confirm's fixed oldest-row window can starve later eligible pairs." The v2 re-audit (`docs/audit/2026-10-14-forensic-audit-v2.md:111`) has it OPEN at `functions/src/d1/entity/autoConfirmJob.ts:201-202` (`orderBy(createdAt).limit` fixed window).

On `main` (`0e6981b`) the daily `d1.autoconfirm` run:

1. queries `entity_links` where `firmId == f`, `state == "candidate"`, `disputed == false`, `createdAt <= now − 30 d`, ordered by `createdAt`, limit 2,000 (`AUTO_CONFIRM_ROW_LIMIT`);
2. groups the rows into pairs, sorts the pair ids and keeps the first 480 (48 positional steps of 10);
3. in each fenced step re-reads every pair and confirms it only if every row reads `auto_confirmed`.

A pair that fails the re-check stays a candidate, so its rows match the same query the next day, at the same place. Nothing remembers that it was already looked at. Two windows can therefore starve the eligible pairs behind them:

- **the row window:** 2,000 or more rows of ineligible pairs, older than the eligible rows;
- **the pair slice:** 480 or more ineligible pairs whose ids sort before the eligible ones inside the window.

Spec O-50 recorded this in October and left it open. The finding's recommended correction: "Persist eligibility/dueAt and scan eligible pairs with a stable cursor/high-watermark, record deferred reasons and checkpoint continuation jobs. Test more than 2,000 ineligible head rows followed by eligible rows and alert on oldest eligible age."

## What makes a scanned pair ineligible

A row matches the scan when it is an undisputed candidate (`state "candidate"`, `disputed === false`) with a Timestamp `createdAt` at least 30 days old. Its pair still fails the in-transaction re-check (P3-44, P3-58) when:

| Cause | Comes from | Lapses by itself? |
| --- | --- | --- |
| another row of the pair is younger than 30 days | a key added to a pair later (O-50's future writer); seeded in P3-58(a) | yes, when that row ages |
| another row is `confirmed` (a mixed pair) | O-50's future writer; seeded in P3-58(b) | no |
| another row is `rejected` or disputed | the same; today's routes decide every row of a pair at once | no |
| a row has an un-merge in progress | seeded in P3-58(d) | no (the saga ends with the rows disputed, out of the scan) |
| a row with an unknown state, a non-boolean `disputed` or no Timestamp `createdAt` | data repair or corruption | no |
| an entity of the pair is missing, or another firm's | data repair or corruption | no |
| the pair's deterministic merge event already exists (O-52) | an un-dispute path or manual repair (none today) | no |
| the row's `leftId`/`rightId` cannot name a pair (unsafe id, or both the same) | corruption | no (the row is dropped before pairing, but still fills the window) |

None of these needs today's writers to misbehave for the window to fill: a few thousand corrupt or mixed rows are enough.

## Intent and success criteria

- A later eligible pair is never starved by any number of ineligible pairs or rows ahead of it. Every eligible pair is confirmed within a bounded number of runs and continuations.
- Each run still reads and writes a bounded number of documents. A large backlog drains over several runs or continuations, never in one unbounded scan.
- An ineligible pair stays a candidate, and why it was passed over is recorded, by code and ids only.
- An alert fires when the oldest pending work is stale and clears when it drains, through the repo's existing log-based alert pattern. A successful daily run that did not finish the backlog is visible as such.
- Unchanged: what is eligible; the merge event, rows, `entity.confirmed` event and audit row a confirmation writes; the registry bump; ten pairs per step; at most 48 step ids per job; the flag re-read per step; the deterministic event id; the retryable `flag_read_failed`.

## Approaches considered

**A. One cyclic cursor.** Persist `{createdAt, linkId}`; each run continues after it, and wraps to the start when it reaches the end. Small change. But every pass re-checks every ineligible pair in a transaction (about seven reads each), and newly aged pairs sit at the end of the order, so a new eligible pair waits for a whole pass. With 100,000 stuck rows a pass takes days, so latency grows with the backlog the finding is about.

**B. A frontier high-watermark plus due-time rechecks (chosen).** Rows age in `createdAt` order, so a cursor over `(createdAt, linkId)` that only moves forward (the frontier) reaches every newly aged row exactly once, whatever sits behind it. A pair the frontier finds ineligible gets a deferral record with a reason and a due time (`recheckAt`). A recheck query over the deferral records (`recheckAt <= now`) brings each deferred pair back when it can have changed. New eligible pairs never queue behind stuck ones. Each stuck pair costs one recheck per interval, not one per run.

**C. A `dueAt` field on the link rows that the scan filters on.** `entity_links` is wholly in `REGISTRY_SCOPE` (P3-20). Every deferral write would need a registry bump, which would invalidate every open re-screen daily. It would also change the rows P3-58 pins as unwritten, and it would contend with human decisions on the same rows. Rejected.

## Rulings

| Id | Ruling | Reason |
| --- | --- | --- |
| R1 | **The frontier.** Per firm, `counters/{firmId}_autoconfirm.cursor = { createdAt, linkId }`: the last scanned row the job has handled. The scan is main's query plus `orderBy(__name__)` and `startAfter(cursor)`, read in pages of 500 rows (`AUTO_CONFIRM_PAGE_ROWS`), at most 2,000 rows per run (`AUTO_CONFIRM_ROW_LIMIT`, meaning kept). Pairs are taken in the order their first row appears. After each step, the step's own transaction sets the cursor to the row before the first pair not yet handled, or to the last row read if every pair read so far is handled. Rows that cannot name a pair are passed over and counted. The cursor never wraps. | Aged rows arrive in `createdAt` order, so every row that ages is ahead of the cursor and is reached once, whatever is behind it. A cursor written in the step's transaction is a checkpoint: a crash resumes after the last committed step. The existing composite index `(firmId, state, disputed, createdAt, __name__)` serves the query, so no new index is needed for it. |
| R2 | **Deferral records.** A pair a step finds ineligible gets `autoconfirm_deferrals/{id}`, written in that step's transaction. The id is `acd_` plus the first 40 hex characters of SHA-256(firmId NUL pairId), so two firms can never share a record. Fields: `firmId`, `pairId`, `leftId`, `rightId`, `linkIds`, `reason`, `rowId` (the row that decided it, for a row reason), `since` (the first deferral, kept while the pair stays deferred), `lastCheckedAt`, `recheckAt`, `checks`, `jobId`, `classification: "internal"`. Codes and ids only. A pair confirmed, or found to have left the backlog, has its record deleted in the same transaction. | The finding asks for deferred reasons by code and ids. A separate server-only collection keeps the diagnostic write out of `REGISTRY_SCOPE`, off the rows and out of P3-58's "nothing is written" assertions (rows, merge events, events, audit rows, registry version). The label is `internal` because the record holds ids and codes, never content (as for the job row, P3-49). |
| R3 | **Reasons**, in this order of precedence: `entity_missing`, `entity_other_firm` (from the pair read); then, by row, `unmerge_in_progress`, `confirmed_row`, `rejected_row`, `disputed_row`, `invalid_row`, `young_row`; and `event_exists` for a pair whose rows all read `auto_confirmed` but whose deterministic merge event exists (the P3-57 skip, still logged as `autoconfirm.event_exists_skip`). A pair with no row left in the scan's predicate (a decision, dispute or un-merge landed) has **left the backlog**: no record, and an old one is deleted. | Precedence puts the most permanent cause first. "Left the backlog" is not a deferral: nothing is waiting. |
| R4 | **Due time.** `young_row`: the latest young row's `createdAt` + 30 days, the instant the pair can first be eligible. Every other reason: now + 7 days (`AUTO_CONFIRM_RECHECK_MS`). | A young row reaches the frontier when it ages, so the frontier normally takes the pair then. For a cause that does not lapse by itself (a manual repair, an un-merge ending), a weekly recheck bounds both the cost and the delay before a repaired pair is confirmed. |
| R5 | **Rechecks.** When a run has drained the frontier and step positions remain, it reads the firm's due deferral records (`firmId ==`, `recheckAt <= now`, ordered by `recheckAt`, at most the remaining positions × 10). It re-checks those pairs in the same fenced steps. Composite index `autoconfirm_deferrals (firmId ASC, recheckAt ASC)`. A record that cannot name a pair (malformed; this job never writes one) is deleted by the step that takes it. | The deferral record is the persisted eligibility index the finding asks for. Each stuck pair costs one recheck per interval, never one per run, and the frontier keeps priority. |
| R6 | **Continuation.** After its steps, a run checks whether work remains: the frontier is not drained, or a deferral record is still due. If so, and if the run is the scheduled run or a continuation below the cap, it enqueues the next continuation through the P2 engine. Payload `{ period, continuation: n }`, idempotency key and run key `d1.autoconfirm:<period>:c<n>`, `n` from 1 to 23 (`AUTO_CONFIRM_MAX_CONTINUATIONS`), so at most 24 runs per firm per period. `parse` accepts `{ period }` or `{ period, continuation }` and nothing else. | Continuation drains a large backlog the same day with bounded work per run. Enqueue is idempotent by key, so a retried run reuses its continuation. No new job type, export, schedule or handler registration, so the P2 registry, boot tests and G-2's endpoint list are unchanged. |
| R7 | **Checkpoint.** After its steps (none of them flag-off), the run commits one transaction that is not a fenced step, although it checks the claim's fence first (R7a). It re-reads the L17.2 flag (and writes nothing if it is off, as P3-56 requires), enqueues the continuation, and records `cursor`, `lastRun` and `backlog` on the progress doc. | A fenced step would add a step id beyond P3-53's 48 positions and change what the P3-53 retry test pins. Nothing in the checkpoint needs exactly-once: the enqueue is idempotent by key, the cursor only re-scans if it moves back, and the counts describe the latest run. The checkpoint runs only when every step of the attempt committed or was already recorded, because a lease lost during a step throws out of the run first. A lease lost after the last step was not covered; R7a covers it. |
| R7a | **The checkpoint is fenced (amends R7; PR #84 review round 1, Codex P1).** The checkpoint transaction first calls `ctx.checkFence(tx)`. This new P2 engine call re-reads the job in that transaction and makes the same check `runFenced` makes (status `running` and the claim's lease owner), through one shared `readFenced`. If the fence no longer holds, it throws `LeaseLostError`: the transaction writes nothing and enqueues nothing, and the worker ends the attempt `lease_lost`. The flag re-read follows. | R7 kept the checkpoint out of `runFenced` to spare a step id, but that left one effect the fence did not guard. A stale attempt could enqueue a continuation and overwrite the progress record after another delivery took the claim, after a newer attempt finished the job, or after the job was dead-lettered. The new call checks the fence without recording a step, so P3-53's bound of 48 positional ids still holds. |
| R8 | **Positions on a retry (amends P3-53).** A fenced position already recorded by an earlier attempt (`runFenced` returns `undefined`) is spent, and the same chunk goes to the next position. Before, that chunk waited for the next day. | With a cursor, skipping the chunk would let a later step move the cursor past pairs nobody handled. The bound is unchanged: at most 48 positional ids per job. The P3-53 test's counts are unchanged: 3 positions spent, 45 chunks processed. |
| R9 | **Unchanged confirmation.** Eligibility (every row `auto_confirmed`), `stageMaterialisation`, the event-exists skip and its log line, the registry bump only when a step confirms a pair, ten pairs per step, the flag read per step and at the start, and `flag_read_failed` are unchanged. Deferral and progress writes are outside `REGISTRY_SCOPE` and bump nothing. | Only the window and progress change (brief). |
| R10 | **The backlog metric.** `pendingSince` is the earlier of two instants. The first is the frontier's first unhandled row's `createdAt` + 30 days, when the frontier is not drained. The second is the oldest due deferral record's `recheckAt`. `ageMs = now − pendingSince`. | This is the age of the oldest work the job has not yet done. Every eligible pair not yet confirmed is either ahead of the frontier or under a due record, so this age bounds the age of the oldest eligible pair from above. It can be an ineligible pair the job has not reached yet; once the job reaches it, the metric moves on. |
| R11 | **The alert.** At each checkpoint the run records `backlog = { pendingSince, source: "frontier" \| "recheck" \| null, ageMs, alert, alertSince }`. When `ageMs > 36 h` (`AUTO_CONFIRM_STALE_MS`), `alert` is `"stale"` and the run logs `logger.error("autoconfirm.backlog_stale", { firmId, jobId, source, ageMs })`. When a run finds it no longer stale after a stale run, it clears `alert` and logs `logger.info("autoconfirm.backlog_cleared", { firmId, jobId })`. A run with work left and no continuation left for the period logs `logger.warn("autoconfirm.backlog_remaining", { firmId, jobId, period, continuation })`. | This is the repo's alert pattern (`job.deadLettered`, F28's ERROR line with a fixed marker): a fixed log message, codes and ids only, matched by a log-based alert policy created at deploy (P2 README). 36 h covers the daily cadence (at most about 24 h between a pair ageing and the next run) plus the scheduler's retries; one missed day trips it. `lastRun.outcome` (`drained`, `continued`, `backlog_remaining`) shows that a "done" job did not finish the backlog. |
| R12 | **Bounds per run.** Frontier: at most 2,000 rows (4 pages) plus a 1-row peek. Rechecks: at most 480 records plus a 1-record peek. Steps: at most 48, each re-reading at most 10 pairs as main does, plus one deferral record per pair. Writes per step: main's, plus at most one deferral write per pair and one progress write. Per firm per period: at most 24 runs. | Bounded cost (brief). Firestore allows 500 writes per transaction, and a step stays far below it. |
| R13 | **Isolation.** Every query filters on `firmId`. The progress doc id embeds the firm id and its `firmId` field is checked on read. Deferral ids are hashed with the firm id, and the record's `firmId` is checked before its `since` is reused. A continuation carries its firm's id. | Cross-firm isolation (G-2) holds by construction and is tested. |
| R14 | **Rules.** `match /autoconfirm_deferrals/{id} { allow read, write: if false; }`. The progress doc lives in `counters`, which is already server-only. | Server-only, like `counters` and `events`. G-2's rules sweep picks the new line up and asserts that even firm A's partner is denied. |

## Data flow of one run

```
flag read ─ off → return (nothing written)
progress = counters/{firmId}_autoconfirm (cursor)
frontier: pages after cursor → pairs in first-appearance order
  for position n = 0..47 while pairs remain:
    runFenced("autoconfirm-n"): flag → off: stop the run, write nothing more
      per pair: read rows, entities, clients (main's reads), event, deferral record
      confirm | defer (record) | left the backlog (delete record)
      bump registry if any confirmed; cursor := row before next unhandled pair
    already recorded → same chunk, next position
if frontier drained and positions remain:
  due records (recheckAt <= now) → same steps, positions continue
checkpoint (a transaction, not a step): claim's fence (ctx.checkFence) → lost: LeaseLostError, write nothing
  flag → off: write nothing
  work remains? → enqueue continuation c+1 (≤ 23)
  progress: cursor, lastRun, backlog (pendingSince, alert)
after commit: backlog_stale (ERROR) | backlog_cleared (info) | backlog_remaining (warn)
```

## Consumer impact

- **Migration and backfill:** none to run. At the first run after deploy the cursor is absent, so the frontier starts at the oldest aged candidate and walks the existing backlog in bounded runs, continuing the same day up to 24 runs per firm. Pairs it finds ineligible get deferral records. The stale alert can fire on that first day while it drains (the old rows are more than 36 h past due) and clears when it drains. To start draining before the next 02:15 tick, run the day's backfill: `npm --prefix functions run jobs:backfill -- d1.autoconfirm <today> <today>`.
- **Deploy:** the composite index on `autoconfirm_deferrals (firmId, recheckAt)` must be deployed (`firebase deploy --only firestore:indexes`) before the first run that rechecks. Without it the recheck query fails, the attempt fails retryably and the job dead-letters after 4 attempts, which raises `job.deadLettered`. Create a log-based alert policy on `autoconfirm.backlog_stale` (severity ERROR), as for `job.deadLettered` (O-30).
- **Job rows:** a firm with a backlog gets up to 23 extra `d1.autoconfirm` job rows per day (`createdBy: "system"`, label `internal`), visible through the jobs routes. Each one carries `{ period, continuation }`.
- **Firestore:** a new server-only collection and a new per-firm doc in `counters`. No client reads either.
- **F37 (merged as `f670d62`): no change to F37's files.** F37's conflict name index stays current while every registry write goes through `bumpRegistryVersion`, which moves `nameIndex.version` with `version`. Auto-confirm still bumps through it, with the unchanged two-argument call, whenever a step confirms a pair. Its writes change only link state, so they add no client or opposing-party name and need no chunk write. The deferral records and the progress doc are outside `REGISTRY_SCOPE` and `PROJECTION_SCOPE`. Auto-confirm only reads `clients.classification` (for the pair's label). It writes no `clients` or `matter_parties` field, so a trigger on those collections never fires for it. What it writes:
  - `merge_events` (create);
  - `entity_links` `{state, confirmation, classification}`;
  - `events` (create);
  - `audit_log` (create);
  - the registry bump;
  - `autoconfirm_deferrals`;
  - `counters/{firmId}_autoconfirm`;
  - continuation `jobs` rows.

## Testing

E2E against the Firestore and Auth emulators through the real engine: the scheduled tick (`enqueueScheduledRuns(AUTO_CONFIRM_SPEC)`), `onJobCreatedCore` dispatch, `runJobTask` and the in-process Cloud Tasks stand-in. The tests:

1. **RED/GREEN core.** More than 2,000 old ineligible pairs (every reason in R3), then eligible pairs created later, run for three simulated days. On main, 0 eligible pairs are confirmed on any day. On the branch, all of them are confirmed on day 1, within 5 runs. Every ineligible pair is still a candidate with its rows unchanged and a deferral record carrying the expected reason.
2. **Alert.** A stale backlog logs `autoconfirm.backlog_stale` and records `alert: "stale"` after the first run. The run that drains it logs `autoconfirm.backlog_cleared` and clears the alert.
3. **Crash and retry.** The checkpoint fails on the first attempt, and the retry still enqueues exactly one continuation. A continuation fails after one committed step, and its retry spends that position and handles the rest. A duplicate delivery is dropped. Every pair gets exactly one merge event, event and audit row.
4. **Fencing.** A continuation attempt whose lease is reclaimed mid-run commits nothing after the fence is lost.
5. **Flag off mid-continuation.** That step and the rest of the run write nothing, no further continuation is enqueued, the cursor stays at the last committed step, and the next run after the flag is back on continues from there.
6. **Rechecks.** A deferred pair whose cause is repaired is confirmed at its recheck. A deferred pair that has left the backlog has its record deleted. A record that is not yet due is not re-read in a transaction.
7. **Cross-firm isolation.** One firm's chain never reads or writes another firm's rows, deferral records or progress.

Unit tests (no emulator) pin `parse`, the reason precedence and due times, and the deferral id. The existing thirteen P3 auto-confirm tests stay green unchanged. The new emulator tests join the Phase 3c gate's named tests. Every document a new test creates is deleted after it, including the tick's job rows for other firms.

## Out of scope and open items

- **O-50** stays open for the decision on mixed pairs; its starvation note is closed by this spec.
- **O-52:** a future un-dispute path or manual repair that returns an *old* row to an undisputed candidate puts it behind the frontier. The job then sees it only through a deferral record. Such a writer must also write the pair's deferral record with `recheckAt` now (or delete the progress cursor to force a full pass). This is added to O-52's preconditions.
- **O-51** (backfills scan current state N times) is unchanged. Each backfilled period may continue up to 23 times.
- A firm whose daily inflow of newly aged pairs exceeds 24 × 480 would trip the stale alert every day. That is the intended signal, not a silent failure.
