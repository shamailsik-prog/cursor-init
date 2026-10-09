# Phase 3b: the un-merge saga (design)

Status: approved under the owner's standing autonomy instruction (CLAUDE.md, 2026-10-07): every design decision below is a recorded ruling, not a question.
Governing text: `docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt` ("Lnnnn" = line). Erratum Set No. 2 (`docs/architecture/ERRATUM_SET_2_PROPOSED.md`) is PROPOSED and unsigned; this spec builds on it under the same instruction as 2a, 2b-A and 3a. Specs it continues: 2a (P2-1..P2-22), 2b-A (P2-23..P2-41; its 2b-B row is this slice), 3a (P3-1..P3-23). Numbering continues at P3-24.

## 1. What this builds and why

L17.2 #16 (L6939): "un-merge replays the event in reverse, restoring both entities and re-pointing every matter, document and correspondence reference to its pre-merge owner". L18 §7.5 (L8411-8414): `unmergeEntity` writes `reverted=true` and enqueues one P2 job per referencing collection with `idempotencyKey = mergeEventId + collection`; each job re-points by the pre-merge snapshot; any failure dead-letters and alerts; a partner approves the retry; "there is no half-state visible to users because the entity remains marked 'unmerge in progress' until all jobs complete". 2b-A built `confirmMerge` as link-confirm only (P2-24) and 3a built the engine, whose contracts were written against this consumer (saga flag, partner-only retry, no cancel).

Success: a partner un-merges a human-confirmed pair; the pair reads as unresolved identity at once; two saga jobs finish the reversal and the saga closes itself; every check that relied on the pair is stale; the pair is reopened for a partner decision; `entity.unmerged` is emitted once; nothing about the saga leaks a payload value; a dead-lettered job leaves the pair visibly "in progress" until a partner retries it.

Not built (recorded): O-28 auto-confirm materialisation (3c: an auto-confirmed pair has no merge event, so it cannot be un-merged; a late dispute reopens it, P2-28); probabilistic `resolveEntity` scoring and its 400-pair evaluation set (L8408); `explainConflictBasis` as its own function; a survivor view.

## 2. Rulings

Each ruling: what, why, cost if wrong.

| # | Ruling | Reason | Cost if wrong |
| --- | --- | --- | --- |
| P3-24 | **Scope and the referencing collections.** 3b builds `unmergeEntity`, two saga job types, the "in progress" state, `entity.unmerged`, and the eager staleness of P2-21. L18 §7.5 names matters, documents, evidence, propositions and correspondence as the referencing collections; today none of them holds an entity reference (confirmMerge re-points nothing, P2-24; documents, evidence, propositions and correspondence do not exist in `functions/`; `matters` and `matter_parties` point at clients and entities that stay as they are). So the saga has exactly the collections that reference a **link**: `entity_links` (the pair's rows) and `conflict_checks` (hits that relied on those rows). `UNMERGE_COLLECTIONS` lists them; a collection that later gains an entity reference adds one job type and one list entry. | The saga must revert what exists, not invent rewrites of rows nothing moved; the snapshot already stored on the event (P2-24) is what a future re-pointing job reads. | L18 §7.5's list is shorter than the text until those collections exist (E-43). |
| P3-25 | **The route.** `POST /api/d1/entity/unmergeEntity { linkId, note }`, rate `general`, action `entity.unmerge`, **partner only** (L17.2 Human control: "un-merge is partner-approved"), then the L17.2 layer gate (404 `feature_disabled`), body (400 `invalid_query`, `note_too_short`, as P2-35), then one transaction: `readPair` (the 404 gate, P2-34). Every row of the pair must be `confirmed` by one `confirmation.mergeEventId`, and that `merge_events` row must be this firm's, `kind: "link_confirmed"`, this pair's, `reverted: false` (else 409 `link_not_confirmed`; also the answer for a candidate, rejected, auto-confirmed-only or already-reopened pair). A pair whose saga runs is 409 `unmerge_in_progress`. Answer: `{ pairId, linkIds, mergeEventId, status: "in_progress", jobIds, classification }`. One `audit_log` allow row. | L17.2 and L18 §7.5; the 2b-A decision-route pattern. | None. |
| P3-26 | **"Unmerge in progress" is a link state.** The transaction sets `unmerge: { status: "in_progress", mergeEventId, by, role, at, note }` on every row of the pair; `effectiveLinkState` returns a new `unmerging` for any row whose `unmerge.status` is `in_progress` (with `L17_2_ENABLED` on; off, every row is already a candidate). `unmerging` is not confirmed (`isConfirmedState`), so the conflict engine reads the pair as unresolved identity from the moment of the call: a role-crossing key hit is POSSIBLE_CANDIDATE_REVIEW, never FLAG with `confirmed_identity`. Every decision route (confirm, dispute, reject, unmerge) refuses such a pair with 409 `unmerge_in_progress`, and the review queue hides it. `getEntity` shows `unmerging`. | L8414: no half-state visible; the strictest reading of a pair being reversed is "not confirmed". | A pair stuck in progress (a dead letter) is unresolved and closed to decisions until a partner retries; that is the specified behaviour. |
| P3-27 | **What the reversal restores: a disputed candidate, not a rejection.** The links job sets every row of the pair `state: "candidate", disputed: true` (the 2b-A fields `confirmation` and `dispute` are left as written; the history is on the event). The pair then reads as `disputed` (unresolved, never auto-confirmed) and only a partner can confirm or reject it (P2-27), which writes a fresh `merge_events` row. The original event keeps `reverted: true` and is never replayed again. Restoring `priorState` is refused: an `auto_confirmed` prior state would auto-confirm again at once. | "Candidate → confirmed → (optionally) split" (L6940): an un-merge says the human decision was wrong, not that the two are different people; fail toward review. | A partner who wants the pair gone rejects it after the reopen (one extra call). |
| P3-28 | **Two job types, both `saga: true`.** `d1.unmerge.links` (`entity_links`) and `d1.unmerge.checks` (`conflict_checks`), idempotencyKey `${mergeEventId}:${collection}` (L8411), created by `unmergeEntity` in its own transaction through `enqueueJobs` (P3-4), `createdBy` the partner, firm-level (`matterId: null`), classification the pair label. Payload ids only: `{ mergeEventId, pairId, leftId, rightId, linkIds }`, parsed strictly (a bad one is the permanent `invalid_payload`). Handler codes: `unmerge_event_invalid` (permanent: the event is missing, another firm's, not reverted, another pair, or a row is another firm's), `too_many_checks` (permanent, P3-31). The 3a contracts apply unchanged: partner-only retry, no cancel, `job.deadLettered` alert, sanitised errors. `jobKey()` is not used (keys derive from the event), so O-44 stays open and does not touch 3b. | L8411 "one P2 job per referencing collection"; the 3a saga flag was built for these. | None. |
| P3-29 | **Every effect is a fenced step.** `runFenced(stepId, fn)` commits its writes once per job across reclaims, retries and manual requeues (3a amendment). Links job: one step `reopen-links`. Checks job: one step per chunk (P3-31) then `complete-checks`. | Exactly-once effects under at-least-once delivery. | None. |
| P3-30 | **Completion is atomic and belongs to the last job.** Each job's last step reads the event and the pair's rows, then in one transaction records its collection as `done` on `merge_events/{id}.unmerge.jobs` and, if every collection in `UNMERGE_COLLECTIONS` is done, completes the saga in that same transaction: event `unmerge.status: "completed"` and `completedAt`, every row `unmerge.status: "completed"` (the pair now reads `disputed`), `events/{mergeEventId}_unmerged` (`entity.unmerged`, payload `{ entityIds, mergeEventId, score }`, L8194, classification the event's), and a registry-version bump (the pair's effective state moved, P2-30's guard). Whichever job finishes last completes it, in either order; the two jobs conflict only on the event doc, which Firestore serialises. A replay after completion finds `unmerge.status` not `in_progress` and writes nothing. | L8414 "until all jobs complete"; one event, once. | None. |
| P3-31 | **Eager staleness (P2-21).** The checks job reads the firm's `conflict_checks` (outside the transaction), keeps those not yet stale whose `hits[].reliedOnLinkIds` name any row of the pair, and marks them `stale: true`, `staleReason: { kind: "unmerge", mergeEventId }`, 200 per fenced step. The step id is a hash of the chunk's own check ids, so a retry that finds fewer checks never skips a different chunk. At most 48 chunks (9,600 checks) per job, else the permanent `too_many_checks` (the saga stays in progress for a partner and an engineer: O-47). Bound checks are marked too (the flag only changes the disclosure). | A waiver or clearance that rested on a reverted identity must not open a matter (2a P2-21, `openMatter` refuses a stale check, 409 `check_stale`). Nested hit arrays have no query index (P2-30), so this is a firm scan, as every registry read is (O-26). | A firm with very many checks needs the index of O-26/O-47. |
| P3-32 | **Rules and indexes.** None change: `merge_events`, `entity_links`, `conflict_checks` and `jobs` are server-only or already denied to the SDK for writes (P2-36, P3-14). The scan needs no composite index (`firmId` equality only). `merge_events` gains `reverted: true`, `revertedAt`, `revertedBy`, `revertedByRole`, `revertNote` and `unmerge {status, startedAt, jobs, completedAt}`: the one permitted mutation of an event, written only by Cloud Functions (L8411 step 2). | Smallest change. | None. |
| P3-33 | **Gate, CI and the earlier gates.** A new `ci_gates/gate_g4_phase3b.sh` (`npm run gate:g4:phase3b`; its CI step in `.github/workflows/gate-g0.yml` is NOT wired by this PR, because the autopilot token may not edit workflow files, so it is a one-step follow-up: run `npm run gate:g4:phase3b` after the 3a step): route coverage (21 `/api/d1` routes, 4 `/api/platform/jobs`), boot, the four saga tests, the five 3a job invariants and the two registry-discipline tests by exact name (eleven, each exactly once), `functions` lint, Gate G-2. The new route adds a G-2 probe and a `viaApi` test; the 2b-A and 3a gate scripts' expected `/api/d1` route count moves from 20 to 21 (a new route legitimately changes an earlier phase's count; no assertion is relaxed). | One script per phase (P2-38, P3-21). | None. |

## 3. Components

| Unit | Purpose |
| --- | --- |
| `functions/src/d1/entity/linkState.ts` (modify) | `unmerging` state, `isUnmergeInProgress`. |
| `functions/src/d1/entity/ops.ts` (modify) | `parseBody` exported; `runDecision` refuses an in-progress pair. |
| `functions/src/d1/entity/read.ts` (modify) | the queue hides in-progress pairs; `unmerging` first in the pair precedence; gate accepts `entity.unmerge`. |
| `functions/src/d1/entity/unmerge.ts` (new) | `unmergeEntityOp`. |
| `functions/src/d1/entity/unmergeJobs.ts` (new) | the two handlers, `UNMERGE_COLLECTIONS`, `UNMERGE_JOB_TYPES`, `checkReliesOn`. |
| `functions/src/p2/registry.ts` (modify) | registers both handlers. |
| `platform/p5/permissionDecision.ts` (modify) | `entity.unmerge` (partner). |
| `functions/src/http/router.ts` (modify) | the route. |

## 4. Data flow

```
POST unmergeEntity ──tx──► merge_events/{id}  reverted:true, unmerge{in_progress, jobs{pending,pending}}
                           entity_links rows   unmerge{in_progress}      (pair reads "unmerging")
                           jobs/{j1}, jobs/{j2} (saga, queued)           (3a trigger → Cloud Tasks → worker)
worker j1 (links)  ──fenced──► rows → candidate+disputed ; event.jobs.entity_links = done ; [last? finish]
worker j2 (checks) ──fenced──► stale chunks ; event.jobs.conflict_checks = done ; [last? finish]
finish (same tx)   ──► event unmerge.completed ; rows unmerge.completed ; events/{id}_unmerged ; registry bump
```

## 5. Errors

Route: 400 `invalid_query`, `note_too_short`; 403 `role_not_permitted`; 404 `not_found`, `feature_disabled`; 409 `link_not_confirmed`, `unmerge_in_progress`. Job codes: `unmerge_event_invalid`, `too_many_checks`, plus the engine's.

## 6. Testing

`functions/test/d1.entity-unmerge.emu.test.ts` (emulators, HTTP router, the real worker with the 3a in-process dispatcher and fake clock): start (event, rows, two queued saga jobs with payload ids only, unresolved reading, every decision refused, queue hides the pair); full saga in the checks-first order (stale marks, `entity.unmerged` once, redelivery is a no-op, re-confirm by a partner only); links-first order; dead letter then partner-only retry and cancel refused; refusals (role, body, other firm, low clearance, flag off, candidate, repeat, rejected); one audit row and no payload value in the job row; `checkReliesOn`. Unit: `d1.linkState.test.ts` (`unmerging`), `p5.permission-d1-actions.test.ts`. Route lists in `d1.boot`, `http`, G-2.

## 7. Review focus

1. The window between the call and the checks job: a check that relied on the link can still open a matter until its job runs (O-46). The engine already reads the pair as unresolved, so a fresh screen is never *less* severe than a confirmed-identity FLAG by a review-level resolution; the open item records the residual.
2. Chunk step ids under retries (P3-31) and the 48-chunk cap.
3. `completeCollection` merges row patches so no row is written twice in one transaction; the last-job-finishes race.
4. The reopen as `disputed` (P3-27) versus rejection.

## 8. Out of scope (recorded)

O-28 (3c), `resolveEntity` scoring, `explainConflictBasis`, re-pointing jobs for collections that do not yet hold an entity reference, an index for relying checks (O-47), an `openMatter` guard on in-progress links (O-46).
