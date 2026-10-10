## Summary

Phase 3c auto-confirm fixes. #17 shipped the 30-day entity auto-confirm job (O-28). An independent review of it against the same requirements confirmed the core:
- the per-pair re-read happens inside the transaction;
- a pair is confirmed whole or not at all;
- with the flag off, nothing is written;
- the registry version is bumped;
- the un-merge round trip works.

The review also found defects that must be fixed before the job's first production run, because `merge_events` rows are immutable and a dead-lettered run loses that day's work. This PR fixes them. Spec rulings P3-53 to P3-59 are in `docs/superpowers/specs/2026-10-10-phase3c-autoconfirm-fixes-design.md`; the plan is `docs/superpowers/plans/2026-10-10-phase3c-autoconfirm-fixes.md`; the erratum is E-47, and open items O-50, O-51 and O-52 are added.

**Merged with `main` after #19 and #20.** #19 (`4432e21`, the scheduled-tick retry: P3-51, P3-52, E-46, O-43 closed) and #20 (`5d888ce`, the `gate:g4:phase3c` CI step) landed after this branch's base. The merge keeps all of #19's records and #20's single CI step, and drops this branch's duplicate step. This branch's own rulings are renumbered after #19's: P3-51..P3-57 became P3-53..P3-59, and E-46 became E-47. Its spec and plan are renamed "auto-confirm fixes" so they stay apart from #19's close-out docs.

| Ruling | Fix |
| --- | --- |
| P3-53 | **Positional fenced step ids** (`autoconfirm-<n>`). Content-hashed ids changed on a retry. With about 480 or more pairs waiting, a retry after 3 or more committed steps passed `MAX_FENCED_STEPS` and dead-lettered permanently, and the test reproduced this on the old code. A retry now reuses at most 48 ids. Pairs that shift into an already-committed position wait until the next day's run. |
| P3-54 | **One system audit row per auto-confirmed pair**: `entity.confirm`, `reason: "auto_confirm"`, targeting the merge event, written in the step transaction that writes that merge event (a step holds up to 10 pairs). |
| P3-55 | **`priorState: "auto_confirmed"`**, as `confirmMerge` records for the same pair state. E-45 is amended. |
| P3-56 | **The flag is read inside each step's transaction**, and the run stops at the first step that finds L17.2 off. A failed flag read is the retryable `flag_read_failed`, so the day's run is no longer silently lost. |
| P3-57 | **Deterministic merge event id** (`auto_` + SHA-256 of firm, pair and sorted link ids). It is read in the transaction, and an existing event makes the job skip the pair and log `autoconfirm.event_exists_skip` (firm and pair ids only). A fixed digest vector pins the formula. |
| P3-58 | **Tests of the in-transaction re-check**, one per case: an aged row with a young sibling, a confirmed row plus an aged candidate, a dispute that lands mid-run, and an un-merge in progress. Each was mutation-checked: with the re-check forced to `true`, each fails. |
| P3-59 | **Gate and records:**<br>• The Phase 3c gate selects 29 named tests (was 20) and counts them from its name arrays. Its CI step is #20's.<br>• The claim gate fails `transport_stub: false` while the filing-transport stub markers remain. #17 claimed false, which was inaccurate.<br>• The claim gate counts only line-anchored flag declarations, and conflicting declarations of one flag fail.<br>• The autopilot workflow must declare the transport stub flag true while the markers remain.<br>• Date corrections (11 → 10 October), and a stale late-dispute comment fixed. |

Also: `p2.jobs-scheduled`'s backfill test gets an explicit 120 s timeout. Its cost grows with the number of firms in the shared emulator, so it timed out at 15 s depending on file order. No assertion changed.

## Final review fixes (this round)
- **I1, claim gate.** A flag counts only when declared at the start of a line (`flag: value` or `flag=value`, optionally as a list item) or in a `| flag | value |` table row. A mention inside a sentence, such as the `transport_stub: false` quoted here, is not a declaration. Before, the last match won, so a quotation after the real declaration could flip it. Two declarations of one flag that disagree now fail with `conflicting <flag> declarations`. The rule covers all three flags. Tests were written first; this PR's body is one of the fixtures.
- **I2, autopilot.** `legal-os-continue.yml` no longer leaves the transport stub flag to the agent's choice: it must be true while the filing transport stub markers remain, because the claim gate fails false then.
- **M1.** The docs say the audit row is written in the step transaction that writes its merge event.
- **M2.** The `ops.ts` late-dispute comment cites P3-46 and E-45(c).
- **M3.** The skip on an existing merge event is logged by code and ids only. The assertion was written first and seen failing. O-52 records the inconsistent state in which the deterministic id cannot be recreated.
- **M4.** O-50 records that never-eligible pairs can fill the 2,000-row scan window and the 480-pair slice, starving other pairs. This is recorded, not fixed.
- **M5.** `gate_g4_phase3c.sh` derives its expected count from its name arrays.

## Decisions (autonomy instruction)
- **Skipped positions on a retry delay pairs by a day; they don't lose them.** Correctness rests on the per-pair re-check and the deterministic event id, not on the step id.
- **The run stops at the first step that finds L17.2 off.**
- **The O-50, O-51 and O-52 edge cases are recorded as open items**, not built. O-50 covers mixed pairs and the scan starvation they can cause; O-51 covers the unused `period` field; O-52 covers a pair whose deterministic event id is already taken.
- **Flag values keep the gate's existing vocabulary** (true/false, pass/fail, yes/no, 1/0); only where a declaration may sit changed.

## Verification (local, after the merge)
- `d1.entity-autoconfirm`: 14/14.
- `npm run gate:g4:phase3c`: PASSED.
  - 29 named tests passed and 0 failed; the expected count now comes from the gate's name arrays.
  - Routes 21 + 4.
  - G-2: 387 tested, 0 allowed.
- Claim-gate tests: 34/34 (was 25). Of the 9 new tests, 6 failed before the parser change; the other 3 (a prose mention beside a table row, one flag declared twice with the same value, and this body) guard behaviour the old parser already had.
- This body replayed through `ci_gates/check_pr_phase_claims.py` against `origin/main..HEAD`: PASS.
- Typecheck is clean for both `functions` and the root, and `eslint --max-warnings 0 functions` is clean.
- Before the merge (not re-run): `d1.entity*`, `d1.conflict*` and `p2.registry-*` 138/138; the full functions emulator suite 844/844 at Task 1.

## Phase claim flags

| flag | value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |

Not a COMPLETE / product-done claim.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DtzafHsrLji6x2SM4jCSWT
