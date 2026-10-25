# F43 R1 follow-ups: implementation plan

Spec: `docs/superpowers/specs/2026-10-24-f43-durable-alert-delivery-design.md` section 8 (rulings R15 to R27). Branch `claude/remediate-f43-fu` from `origin/main` d3b857c. Method: test first; each new test fails on `origin/main` and passes on the branch through the real path (the emulator, the real HTTP router, the real sweeper, escalator, checker and `callP1Embedding`, and firebase-functions 6.6.0's real logger).

## Tasks

1. **Tests first (RED).**
   - `functions/test/deploy-contract-alert-runtime.test.ts` (rewritten, R15 to R17): HCL-subset parse of the rendered and committed `alerts.tf`; one policy per event with one log-match condition, a rate limit, auto-close and the on-call channel; the filter evaluator against the real logger's lines for every registered event; real emitters; the registry walk over the TypeScript AST. Helpers in `functions/test/alertPolicyTools.ts`.
   - `functions/test/f43-alerts-fu.e2e.emu.test.ts` (R18, R21 to R24): the acknowledgment hold through the real sweeper, router and escalator, and at its exact boundary; the level-2 re-page; clearing a derived condition; kill-switch alerts at level 0; the platform switch as one alert.
   - `functions/test/f43-alerts-escalation.e2e.emu.test.ts`: PROBE-06, 08, 09 ported (R19).
   - `functions/test/f43-alerts-p2.e2e.emu.test.ts`: PROBE-14, 15 ported (R19).
   - `functions/test/f43-alerts-checker-paging.e2e.emu.test.ts`: C2, C4, the quarantined order and the pass rotation (R19, R20).
   - `functions/test/f43-alerts-p1.e2e.emu.test.ts`: the embedding path (R26).
   - `functions/test/f43-alerts.unit.test.ts`: `ACK_HOLD_MS` and the other new constants.
2. **Renderer and manifest** (R16): `infra/render_terraform.py`, `infra/deploy-manifest.json` (`labels` on the page policy), `infra/terraform/alerts.tf` re-rendered.
3. **Emitters** (R15): `event` as the last field of every registered ERROR line in `functions/src`.
4. **Alerts module** (R18, R20 to R24): `model.ts`, `raise.ts`, `escalator.ts`, `checker.ts`, `notifier.ts`, `specs.ts`, `functions.ts`; `firestore.indexes.json` (`ai_reservations (state, quarantinedAt)`).
5. **P1** (R26): `embedding.ts` commit `nowMs`.
6. **G-2** (R25): `{ timeout: 60_000 }` on the route probe.
7. **Docs**: `functions/src/alerts/README.md` (hold, re-page, clearing, kill switch, runbook wording), this ledger, the PR body.
8. **GREEN**, neighbours, typecheck, eslint, G-0, G-1, G-2 (measured), the F32 deploy contract and its tests, `render --check`, the claim gate.
9. **Mutation**: at least 12 hand mutants (ledger below).

## Progress

- [x] Spec section 8 and this plan (4e5253b).
- [x] Tests first (e75bb30): 54 tests in the seven F43 files; on main 20 fail.
- [x] R1-001 renderer, manifest, 37 emitters (966b4dd); alerts module R18 to R24 (73c526e); R1-008 (794f4d6); the worklist's `clearedAt` (168a3dd); R1-007 (22f7bc0).
- [x] Merged main with the F34 follow-up (#129): re-rendered to 25 policies, `event` on `p1.opik_misconfigured`, and the F43 embedding test now deletes the learned overhead it teaches (a1d12bf).
- [x] Full Functions suite at a1d12bf (fresh private emulators, `CI=true`, `--no-cache`): 114 files, 111 passed, 2 failed, 1 skipped; 2,765 tests, 2,763 passed, 1 failed, 1 skipped; 3,858 s.
  - `fa-d3c-embedding.emu.test.ts`: its 120 s cleanup hook timed out, with all 41 tests passed. Alone it passed 41/41 twice on the branch (12.7 s, 12.3 s) and once on main 6b186a0 (10.6 s). Wall clock; the F43 builder saw the same on main.
  - `f43-alerts-fu` R1-006b: its escalator run at 2001-02-11 also stepped 6 alerts other suites had left open, which broke an exact `escalated: []`. Every escalator result in that file is now scoped to the test's own alert. Reproduced by planting a stray open alert due in 1990: the stray was stepped, and the scoped test passed.

## RED/GREEN ledger

Exact counts. main = `origin/main` d3b857c exported, with this branch's seven F43 test files copied in; branch = this branch; both on the private emulators (firestore 8797, auth 9797, `demo-f43-fu`).

| Finding | Tests | main | branch |
| --- | --- | --- | --- |
| R1-001 | `deploy-contract-alert-runtime.test.ts` | 6/6 FAIL (5: the committed file does not parse, `single-quoted string`; 1: 37 emitters without `event`) | 6/6 PASS |
| R1-002 | fu: the hold end to end; its boundary | 2/2 FAIL (`counted`, not `reopened`) | 2/2 PASS |
| R1-003 | PROBE-06, 08, 09, 14, 15; C2 | 6/6 PASS (correct code, now pinned) | 6/6 PASS |
| R1-003/004 | C4 | 1/1 FAIL (cursor kept; groups read were dropped) | 1/1 PASS |
| R1-004 | quarantine order; rotation | 2/2 FAIL | 2/2 PASS |
| R1-005 | fu re-page; escalation first test | 2/2 FAIL | 2/2 PASS |
| R1-006 | fu clearing, kill switch at level 0, platform switch; P1 kill-switch test | 4/4 FAIL | 4/4 PASS |
| R1-006 | fu partial read clears nothing (guard) | 1/1 PASS | 1/1 PASS |
| R1-008 | P1 embedding at the call's clock | 1/1 FAIL | 1/1 PASS |
| units | the R1 constants | 2/2 FAIL | 2/2 PASS |
| Total | 7 files, 54 tests | 20 failed, 34 passed | 54 passed |

Re-run after main moved to 6b186a0 (the F34 follow-up, #129), with the final test files: 21 failed, 33 passed (54) on main; 54 passed on the branch. The 21st is the worklist key list, which gained `clearedAt` (168a3dd) after the first RED run. The registry walk then found 38 emitters without `event` (main's new `p1.opik_misconfigured` line included).

R1-007, the G-2 route probe, whole G-2 gate on fresh ephemeral emulators, two runs each: main d3b857c timed out at 15,005 and 15,004 ms (G-2 FAIL both times); branch 24,182 and 19,072 ms (G-2 PASS, 445 tested, 0 allowed).

## Mutation ledger

22 hand mutants (the builder's `mutants.py`, kept in its scratchpad), one exact edit each, run at 794f4d6 against their targeted files on the private emulators, then restored. 22 of 22 killed.

| # | Mutant | Targeted | Result |
| --- | --- | --- | --- |
| M01 | HCL quoting: an embedded `"` not escaped | runtime | killed (5 of 6 failed) |
| M02 | two conditions in one log-match policy | runtime | killed (5/6) |
| M03 | no `notification_rate_limit` | runtime | killed (2/6) |
| M04 | filter on `jsonPayload.message` again | runtime | killed (3/6) |
| M05 | the page line without its `event` field | runtime | killed (2/6) |
| M06 | ack-hold boundary `>=` → `>` | fu | killed (2/7) |
| M07 | an acknowledgment absorbs every recurrence | fu | killed (2/7) |
| M08 | kill-switch alerts escalate | fu, P1, unit | killed (5/21) |
| M09 | no pass rotation | paging | killed (1/7) |
| M10 | C2: cursor without the id tiebreak | paging | killed (1/7) |
| M11 | C4: a budget stop wraps to the start | paging | killed (1/7) |
| M12 | no raise grace | paging | killed (2/7) |
| M13 | quarantined query ordered by lease, not quarantine time | paging | killed (1/7) |
| M14 | clearing after a partial read | fu | killed (1/7) |
| M15 | a cleared alert keeps its deadline | fu | killed (1/7) |
| M16 | a cleared alert observed again does not resume | fu | killed (1/7) |
| M17 | the ladder ends silently at level 2 | fu, escalation | killed (2/17) |
| M18 | re-page deadline from the old deadline | fu, escalation | killed (1/17) |
| M19 | platform kill switch raised per firm | fu, P1 | killed (2/13) |
| M20 | `observeOnly` ignored | fu, P1 | killed (1/13) |
| M21 | embedding alerts at the wall clock | P1 | killed (1/6) |
| M22 | page policy without its `page_id` extractor | runtime | killed (2/6) |

Known redundancy (recorded, not a defect): the escalator's `state !== "open"` check (the auditor's A17) still cannot be killed on its own, because an acknowledged, resolved or cleared alert has no deadline and the deadline re-read already refuses it.
