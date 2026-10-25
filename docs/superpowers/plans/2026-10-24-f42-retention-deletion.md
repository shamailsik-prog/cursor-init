# F42 retention and deletion: implementation plan

Spec: `docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md`. Branch `claude/remediate-f42` from
`origin/main` (99681ba). Emulators on private ports (Firestore 8697, Auth 9697, hub 4793, logging 4795, websocket
8698), project `demo-f42`.

## Files

| Path | Purpose |
| --- | --- |
| `infra/retention/inventory.json`, `infra/retention/policy.json` | R2, R3 |
| `ci_gates/check_data_inventory.py`, `ci_gates/test_check_data_inventory.py`, `ci_gates/gate_g0.sh` step 22 (21 until F34 #129 took that number on main) | R3 |
| `platform/retention/tombstone.ts` | shared tombstone shape and the row-to-matter key (both stacks) |
| `platform/p5/permissionDecision.ts` | `matter-deleted`, retention actions (R4, R6) |
| `functions/src/retention/{model,config,ops,saga,acks,apply,watch,alert,functions}.ts` | R4, R5, R7 to R11 |
| `functions/src/p5/permission.ts`, `functions/src/d1/matter/ops.ts`, `functions/src/p2/{worker,errors,registry,scheduled}.ts`, `functions/src/http/router.ts`, `functions/src/index.ts` | R6, R7, R11, routes, exports |
| `platform/persistence/{firestoreSpineRepositories,firmScopedList,matterTombstones}.ts`, `app/api/d1/reporting/route.ts` | R6 (Next), R12 |
| `firestore.rules`, `firestore.indexes.json`, `infra/deploy-manifest.json`, `infra/terraform/alerts.tf` | R13, deploy |
| `functions/test/f42-*.test.ts`, `tests/f42-tombstone-next.e2e.firestore.test.ts`, `functions/test/g2.cross-firm.test.ts` | tests |
| `functions/test/{http,p5.identity,runtime-options,p2.boot,p2.engine,p2.scheduled,f09-effect-marker-guard}.test.ts`, `tests/g0-gate-e2e.test.ts`, `tests/f13-004-reporting-index.e2e.firestore.test.ts`, `package.json` (`test:rules`), `vitest.config.ts` | neighbour lists: new routes, exports, operations module, G-0 tree, reporting membership |
| `docs/runbooks/retention-deletion.md`, `functions/src/p2/README.md` | runbook |
| `functions/test/f42-mutants.json`, `functions/scripts/f42-mutants.mjs` | mutation |

## Tasks

1. Spec and plan (this file). Commit.
2. RED: write the e2e and gate tests against the planned interfaces; run each on the branch before implementation and
   record the failures below (they are the main behaviour: no routes, no gate, copies remain readable).
3. Inventory, policy, gate (Python), G-0 wiring; gate tests GREEN.
4. Shared table, Functions permission and list filter, worker refusal; units GREEN.
5. Retention module: config, ops, saga, acks; deletion e2e GREEN.
6. Next repository filter, reporting membership; Next e2e GREEN. (A change to `committeeScope.loadMatter` was
   tried and reverted: it broke 15 Committee Brain unit tests, and the route's `syncFirmMatters` already drops the
   tombstoned matter through the repository filter.)
7. Retention job, watch, alert seam, deploy manifest, indexes, rules, G-2 entries; apply e2e GREEN.
8. Mutants (at least 12) on the tombstone check, acknowledgement completeness, legal-hold check, authorisation and the
   inventory gate.
9. Verification: typechecks, eslint, suites and neighbours, G-0, G-1, G-2, deploy contract, claim gate; RED on an
   export of `origin/main`; gitleaks; PR body.

## RED/GREEN ledger

(The same numbers are in the PR body. RED: an export of `origin/main` 99681ba with the F42 test files copied in.)

| Suite | RED on main (count, reason) | GREEN on branch |
| --- | --- | --- |
| `tests/f42-tombstone-next.e2e.firestore.test.ts` | 2 of 2 failed; the soft-assertion probe failed 12 assertions (lists, search and document reads still serve the tombstoned matter; a docId read 400, a matter-named read 200 without `matter_deleted`; four repository reads return rows; a revoked clerk and a never-member still find the matter in search) | 2 of 2 |
| `functions/test/f42-retention-deletion.e2e.emu.test.ts` | file fails: no `infra/retention/policy.json`, no `/api/platform/retention` routes; main probe: `getMatter` 200, `getDraft` 200, `listMatters` lists the matter, the matter's queued job runs `done` | 10 of 10 (alone twice, and in the final full Functions run) |
| `functions/test/f42-retention-apply.e2e.emu.test.ts` | file fails (no policy) | 5 of 5 |
| `functions/test/f42-retention.units.test.ts` | file fails (no policy) | 12 of 12 |
| `ci_gates/test_check_data_inventory.py` | `ModuleNotFoundError`: no gate | 18 of 18 |
| Postgres views (gate test added after FA-D5-003 landed) | RED on the merged branch before the fix: views unfound, `CREATE TABLE public.x` read as `public` | GREEN |
| Watch page window (added test) | RED on the branch before the fix: `expected [] to have a length of 1` | GREEN |
| F34 decision records (added assertions after F34 landed) | RED on the merged branch before the fix: Opik request held 1 trace, not 3; `retention.apply` left an old decision record | GREEN (27 of 27 F42 Functions tests) |
| F43 durable alert (watch tests rewritten after F43 landed) | RED on the merged branch before the switch: 2 failed (no `ops_alerts` row) | GREEN, 5 of 5 |

## Verification log

(Code head a9fb3c4, after merging main 0d9af65; full output in the evidence log, `scratchpad/evidence-f42.txt`.)

- Typecheck: `tsc --noEmit -p .`, `tsc --noEmit -p tsconfig.tests.json`, `functions: tsc --noEmit -p .`: exit 0 each.
- `eslint --max-warnings 0` on every touched TS file: exit 0 (two pre-existing unused imports removed from
  `firestoreSpineRepositories.ts`; `functions/scripts/f42-mutants.mjs` is outside the lint config).
- G-0 (`BASE=origin/main bash ci_gates/gate_g0.sh`): PASSED, step 21 PASS (323 stores).
- G-1 (`python3 ci_gates/gate_g1.py`): 10 of 10.
- G-2 (the gate's suites and coverage evaluation on the private emulator): PASS, 457 tested, 0 allowed; the five
  retention routes tested with 12 attempts each.
- Deploy contract: static PASS, bundle mode PASS (`--profile staging`), its tests 30 OK.
- Mutation: 29 mutants; the full set on a9fb3c4 is in the PR body (earlier: 27 of 27 on 6aacb5b, G1 to G6 on 6a6fdcb).
- Functions full suite: 2703 tests passed, 0 failed (two hook timeouts, each file green alone on the branch and on main).
- Root unit suite: 6280 passed; the 31 failures are wall-clock (timeouts and time budgets), green alone. Root emulator
  neighbours: 419 of 419. Details and reruns in the PR body.

## Codex P2 follow-up (PR #128)

Three P2 findings from Codex on f8ff0f4, fixed test-first (RED: the final test files on an export of f8ff0f4; GREEN:
f2b7e13; both under a private emulator, project `demo-f42-fu`, ports 8297/9297/4291/4293/8298/5797).

Decisions (spec R4a, R7b, R7c):
- `saga.ts` `runPurge`: at the budget the job acknowledges the finished purge and anonymise stores (`ack-{part}-p{i}`),
  then hands the rest and the vault lock to a numbered continuation (`g0c1`, `g0c2`). Carrying the finished stores
  into the continuation's acknowledgement would also work; acknowledging at once records each store when it is done
  and keeps every continuation to the stores it still has to purge.
- Found while fixing it: the budget restarted at 0 on each attempt while P2 keeps every attempt's step ids, so a retry
  late in the budget failed permanently with `fenced_step_limit`. The budget now counts the job's recorded steps.
- `saga.ts` external: a summary plus parts (5,000 ids, 256 KiB each, at most 24) written in the one step that
  acknowledges the store, before the enqueue step. Chosen over one step per part: a retry would re-split a shifted id
  set and could skip an id at a part boundary. Past 24 parts: the permanent `external_ids_over_limit`, never a cut.
- `ops.ts`: a lapsed request ends as `expired` (approval attempt, or the next request, which audits
  `retention.request_expired`). No cancel route (FU-6): the window, the second partner and the hold cover every case.

| Case | RED on f8ff0f4 | GREEN on f2b7e13 |
| --- | --- | --- |
| Lapsed request blocks deletion (new) | `409 deletion_request_open` | passed |
| Budget spill drops a finished store (new; 1 document, 9,000 versions) | `firestore_documents` never acknowledged | passed |
| Retry budget (new; 10,000 versions, crash after the 44th chunk) | the job dead-lettered `fenced_step_limit` | passed |
| More than 10,000 traces (new; 10,001) | the 10,001st id not recorded | passed |
| Changed: approval past the window; Opik summary shape | `409 approval_expired`; no `parts` | passed |
| Units: part naming, trace id parts (new) | not functions at f8ff0f4 | passed |

RED totals: deletion e2e 6 failed, 8 passed (14); units 2 failed, 12 passed (14). GREEN: 14 of 14 each.

Verification on f2b7e13 (the code head of the follow-up; the commit after it adds this ledger only):
- F42 suites: deletion e2e 14 of 14, apply e2e 5 of 5, units 14 of 14, the F09 effect-marker guard 6 of 6, inventory
  gate tests 18 of 18.
- Neighbours: `http` 83, `p2.jobs-worker` 29, `p2.registry-discipline` 10, `p2.jobs-enqueue` 8, `p2.jobs-invariants` 5,
  `p2.engine` 8, `p2.scheduled` 7, `p2.boot` 2, `f34-decision-trace` 10, `f34-decision-units` 17, `f43-alerts-p2` 8,
  `f43-alerts.unit` 6: 12 of 12 files, 193 of 193 tests.
- G-0 (`BASE=origin/main`): PASSED, step 21 PASS (323 stores).
- G-2 (the gate's own suites and coverage, on a copy of `gate_g2.sh` pointed at the follow-up emulator): PASS, 457
  tested, 0 allowed; Next 138 of 138, Functions 8 of 8; the five retention routes 12 attempts each, 0 allowed.
- Typecheck: root, tests and functions `tsc --noEmit`, exit 0 each. `eslint --max-warnings 0` on the five touched TS
  files: exit 0.
- Mutation: 16 of 16 killed (the nine new mutants and the seven earlier ones on `saga.ts` and `ops.ts`, Z4 moved).
- Not rerun for the follow-up: the full Functions and root suites, G-1 and the deploy contract (the follow-up changes
  only `functions/src/retention/{saga,ops,model}.ts`, F42's tests, mutants and docs).
