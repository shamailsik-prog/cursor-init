# Phase 3c close-out: the auto-confirm job's retry, audit and record fixes

Date: 2026-10-10. Status: rulings made under the owner's standing autonomy instruction (7 October 2026); pending the partner's signature with Erratum Set No. 2.

## Why

PR #17 (`9b78e2f`) shipped the 30-day auto-confirm job (`functions/src/d1/entity/autoConfirmJob.ts`, rulings P3-42 to P3-50 in `docs/superpowers/specs/2026-10-11-phase3c-autoconfirm-design.md`, Erratum E-45). An independent review against the same requirements confirmed the core:
- the per-pair re-read happens inside the transaction;
- a pair is confirmed whole or not at all;
- with the flag off, nothing is written;
- the registry is bumped;
- the un-merge round trip works;
- the gate has 20 named tests.

It also found the defects below. They should be fixed before the first production run, because `merge_events` rows are immutable and a dead-lettered run loses that day's work.

## Rulings

| Id | Ruling | Basis | Cost if wrong |
| --- | --- | --- | --- |
| P3-51 | **Positional step ids.** A fenced step is named by its position, `autoconfirm-<n>` for chunk n of the attempt, not by a hash of the pairs it holds. A retry therefore reuses the same at most 48 ids: positions already committed are skipped, and the pairs that now sit at those positions wait for the next day's run. Correctness does not depend on the step id: every pair is re-checked inside its own transaction. | Defect: content-hashed ids change on a retry (confirmed pairs leave the scan and chunk boundaries move), so a retry after 3 or more committed steps with about 480 or more pairs waiting exceeds `MAX_FENCED_STEPS` (50). `fenced_step_limit` is permanent, so the job dead-letters, and `retryFailedJob` fails the same way. | Pairs that shift into an already-committed position on a retry are confirmed a day later. They read as confirmed meanwhile. |
| P3-52 | **One audit row per materialised pair**, staged in the pair's transaction: `actorId: "system"`, `onBehalfOf: "system"`, `action: "entity.confirm"`, `target: "merge_events/<id>"`, `decision: "allow"`, `reason: "auto_confirm"`, classification the pair's label. Use the repository's existing audit stager. | E-42(i): worker-side changes are audited with actor `system`. Every human confirmation writes an `entity.confirm` row, so an automatic one must be findable in the same trail. | One audit row per pair. |
| P3-53 | **`priorState: "auto_confirmed"`.** The materialised `merge_events` row records the pair's prior *effective* state, as `confirmMerge` does (`ops.ts` `priorStateOf`). For every pair this job confirms, that state is `auto_confirmed`. This supersedes the "candidate" of O-28's wording and of E-45(a). | One field must mean one thing across immutable rows. No code reads `priorState` yet, so this is the last cheap moment to fix it. | None: no production rows exist yet. |
| P3-54 | **The flag inside each step.** Each step's transaction reads `firms/{firmId}` and skips the step (writing nothing) when L17_2 is off. A failed flag read at the start of the run throws a retryable `JobError` (`flag_read_failed`) instead of ending the run as done. | A firm that turns L17.2 off mid-run must not be confirmed for the rest of that run. A transient read failure must not silently cost a day. | One more read per step. |
| P3-55 | **Deterministic merge event id.** `"auto_" +` the first 32 hex characters of SHA-256(`firmId` NUL `pairId` NUL sorted link ids joined by commas), written with `tx.create`. An existing event means the pair is already done. | Belt and braces with P3-51: exactly-once no longer rests only on the state re-check. | None. |
| P3-56 | **Tests of the in-transaction re-check.** Each case is seeded directly or through a seam, so that the scan admits the pair and the transaction must reject it, writing nothing:<br>(a) an aged row with a young sibling for another key;<br>(b) a confirmed row plus an aged candidate row;<br>(c) a dispute that lands between the scan and the step;<br>(d) a row with an un-merge in progress.<br>Plus a retry test: the first attempt commits steps and then fails, and the retry never reaches `fenced_step_limit`. All are added to the Phase 3c gate's named tests, and its count rises to match. | Review finding: replacing the re-check with `true` left every existing test green. | None. |
| P3-57 | **Records and CI.**<br>• `gate:g4:phase3c` runs in the gates job after Phase 3b.<br>• E-45 is amended: P3-53's `priorState`, and its date corrected to 10 October 2026. The 3c spec and O-28 closure dates are corrected the same way.<br>• The `confirmMergeOp`-adjacent comment that still promises a late dispute after day 30 is updated.<br>• `AUTO_CONFIRM_MAX_STEPS` is derived from `MAX_FENCED_STEPS`.<br>• The claim gate (`ci_gates/check_pr_phase_claims.py`) fails `transport_stub: false` while `transport_stub_present()` is true. PR #17's body said false while the filing transport stub markers remain. | PR #17's follow-ups, plus the review's documentation findings. A false claim flag is exactly what the gate exists to stop. | None. |

## Out of scope, recorded as open items

| Id | Item | Owner |
| --- | --- | --- |
| O-50 | **Mixed pairs.** A pair whose rows are mixed (one row confirmed, a newer row for another key still a candidate) can be confirmed neither by `confirmMerge` (409 `link_not_candidate`) nor by the auto-confirm job (its re-check needs every row `auto_confirmed`). The new row reads `auto_confirmed` after 30 days but has no merge event of its own. Today `registerClient` writes all of a pair's rows in one commit, so this needs a future writer. Decide whether a new key on a confirmed pair joins the existing merge event or gets its own. | Engineering, with probabilistic resolution (L18 §7.2) |
| O-51 | **The `period` payload field is unused.** A backfill of N days creates N runs that each scan the same current state. They are idempotent by state, so this is wasteful rather than wrong. Either use the period as the run's "as of" time, or make the job a singleton per firm. | Engineering |

O-43, O-47, O-48 and O-49 stay open.
