# F11 plan: atomic request audit (outbox staged in the effect commit, drained by a reconciler)

Spec: `docs/superpowers/specs/2026-10-18-f11-atomic-request-audit-design.md`.
Branch: `claude/remediate-f11` from `origin/main` a9b0e06; main 957fe26 merged in a0802a5, main c02ebbc in f43e936, main ac69873 (F18) in 5e24c50.

## Tasks

1. **RED tests, run on main's code.**
   - `tests/f11-atomic-request-audit.e2e.firestore.test.ts`: the production-mode e2e through `POST /api/d1/clients` (crash after the entity commit, crash before the flush, atomicity, same-key retry on instance B, normal-path control, two firms).
   - `tests/f11-audit-outbox.firestore.test.ts`: helper staging (fenced, unfenced, transaction, external effect, excluded collections, no request, failed commit), reconciler (exactly once, poison, counted attempts, backlog alert, cross-firm), dead-letter `listByFirm` on Firestore.
   - `tests/f11-audit-outbox.unit.test.ts`: contract validation and recovered row, memory `listByFirm`, the sink seam guard, the client-SDK refusal.
   - `functions/test/f11-audit-outbox.emu.test.ts` (added after GREEN): the reconciler on the Functions package's own firebase-admin.
   - The modules F11 adds are loaded loosely (dynamic import with a catch) so each test fails on its assertion on main, not on the import.
2. **Contract** `platform/persistence/auditOutboxContract.ts`.
3. **Staging**: `firestoreDbModular.ts` (four helpers + external effect), `auditOutbox.ts` (session, rows, release), `withSession.ts` (open, release), F10 composition (`durableIdempotency.ts`, `idempotency.ts`).
4. **Reconciler**: `functions/src/p5/auditOutbox.ts`, `functions/src/p5/auditOutboxReconciler.ts`, export in `functions/src/index.ts`; the Functions export-list tests.
5. **Dead letter** firm scope (Firestore and memory adapters, Next writer).
6. **Rules and indexes**: `audit_outbox` server-only; field overrides.
7. **Seam guard**: `setRequestAuditSinkForTests`.
8. **Wiring**: `test:rules` and the vitest exclude list.
9. **Verification**: `test:unit`, `test:rules`, the Functions suite and typecheck, G-1, G-2, `typecheck`, `typecheck:tests`, lint, G-0.
10. **PR body** and the claim gate.

## RED/GREEN ledger

Commands (scratch emulator configs on private ports: firestore 8697, auth 9697, hub 4887, logging 4889; a second one on 8698, 9698, 4888, 4890 for parallel runs; UI off):

```
E="node_modules/.bin/firebase emulators:exec --config <scratch>/f11emu/firebase.json --only auth,firestore --project demo-sikander"
$E "METADATA_SERVER_DETECTION=none npx vitest run --no-file-parallelism tests/f11-audit-outbox.firestore.test.ts tests/f11-atomic-request-audit.e2e.firestore.test.ts"
$E "npm --prefix functions test -- test/f11-audit-outbox.emu.test.ts"
npx vitest run tests/f11-audit-outbox.unit.test.ts
```

"Effects without an audit row" is the e2e's measure: the effect documents the crashed request committed (every path its commits wrote, less the audit log, the outbox and F10's records) for which no `audit_log` row of the firm names them (in `effectPaths`, as `target`, or by document id), once whatever recovery the codebase has (none on main) has run past the grace.

| Step | Code | Command | Result |
| --- | --- | --- | --- |
| RED | main a9b0e06 + the F11 test files (dca740d) | e2e file | 5 failed, 1 passed (the completed-request control). Effects without an audit row: crash after the entity commit 1 of 1; crash after every effect write, before the flush, 2 of 2; retry on instance B: the entity has 0 audit rows |
| RED | same | `tests/f11-audit-outbox.firestore.test.ts` | 12 failed, 3 passed (non-effect, refused-commit and release controls) |
| RED | same | unit file | 7 failed |
| GREEN | f3005c8 | both emulator files | 21/21; effects without an audit row 0 of 1 and 0 of 2; documents left after both files: none |
| GREEN | f3005c8 | unit file | 7/7 |
| RED (final) | main 957fe26 (`git archive`) + the head's F11 test files | both emulator files | 17 failed, 4 passed (the four controls); effects without an audit row 1 of 1, 2 of 2; instance B retry: 0 audit rows |
| RED (final) | same | unit file | 7 failed |
| RED (final) | same | Functions F11 file | fails to load (`@/platform/persistence/auditOutboxContract` does not exist on main) |
| GREEN | head | Functions F11 file (Functions firebase-admin) | 2/2 |

Debugging record (systematic debugging): two staging tests first failed on the branch with no entries. Root cause: a request with no audit rows has nothing to flush, so the failing sink cannot fail it, and the request released its entries (correct behaviour, spec A3). The tests now push a row and assert the 503; the dispatch case answers F10's terminal 409 for a 5xx after an effect (F10 ruling 9). The Functions F11 file first timed out (15 s default; the first test also pays the process's first Admin connection, 20 s measured): it has a 120 s hang bound.

## Verification (branch head content; the machine is shared, load 2 to 21 on 4 cores)

| Check | Result |
| --- | --- |
| F11 emulator files (`test:rules` set) | 21/21; no document left behind |
| F11 unit file | 7/7 |
| Functions F11 file | 2/2 |
| `test:unit` (full, load 13-20) | 204 of 209 files pass; 34 failed, 5938 passed, 54 skipped. Every failure is a wall-clock budget (`citations.time-budget`, `f15-r2/r4/r5-bounds`) or the `g0-gate-e2e` afterAll hook timeout. Alone at load 2: those files pass on the branch and on main (150/150 each). Same-load pair at load 17-20: branch 20 failed, main 36 failed |
| `test:rules` set (full, load 17) | 17 of 18 files pass; 701 passed, 19 skipped. `persistence.runtime-mode` times out in `beforeAll` (initializeTestEnvironment, 15 s) on the branch and on main at load 15-21; alone at load 2-8 it passes on both (19/19; 285.1 s branch, 280.8 s main) |
| Functions suite (`npm --prefix functions test` on the emulator, load 18-21) | 82 of 87 files pass; 9 failed, 2365 passed. All 9 are 15 s test timeouts in files this branch does not touch; the five files rerun alone: 70/70 on the branch and 70/70 on main |
| `npm run typecheck`, `npm run typecheck:tests`, `npm --prefix functions run typecheck` | exit 0 |
| `npm run lint` | 0 errors; 89 warnings (main: 90; the one gone is the memory dead-letter `listByFirm` that ignored its firm) |
| `BASE=origin/main bash ci_gates/gate_g0.sh` | PASSED (static) |
| `python3 ci_gates/gate_g1.py` | 10/10 |
| `bash ci_gates/gate_g2.sh` | PASS: 413 tested, 0 allowed (Next 138/138, Functions 8/8; the rules sweep now includes `audit_outbox`) |
| Secret scan before each push | gitleaks v8.30.1 `detect --source <worktree> --config .gitleaks.toml --redact --exit-code 1 --log-opts=origin/main..HEAD`: no leaks. The brief's equivalent subcommand form is refused by the worktree sandbox, so its v8 alias was used. |

## Review round 1 (PR #86)

Threads:
- Codex P1 4307160231 and P2 4307160234;
- Bugbot 4307209436 and 4307209440 (the same two);
- Bugbot 4307237669, 4307237674 and 4307255060 (on Autofix code);
- Bugbot 4307293100 (P1, filed on the revert).

Spec rulings 18 and 19, §4 survey, amendments A6 and A7.

Tasks:
1. RED tests (3665687):
   - the e2e "later write fails after the entity commits";
   - the ruling-18 cases in `tests/f11-audit-outbox.firestore.test.ts`;
   - the stagedAt-sweep cases;
   - the sweep cursor clean-up in every F11 file.
2. Review and revert the three Autofix commits (9ad5482; spec A7).
3. Ruling 18 (`withSession.reachedAuditedEnd`, `idempotency.requestClaimsCompleted`). Then survey every handler that writes more than once with temporary, uncommitted instrumentation over the `test:rules` suites. Fix the one gap found (`p1/committee-brain` action row), with its RED test in `tests/f16-next-output-size.firestore.test.ts`.
4. Ruling 19 (the sweep in `functions/src/p5/auditOutbox.ts`). The extended tests cover:
   - number, map, null and far-future values;
   - the cursor walk;
   - full then empty page;
   - a budget stop;
   - a full pending list;
   - the null sort;
   - the Functions-SDK walk.
5. Fix commit 72a3dce; merge main c02ebbc (f43e936).
6. Mutants, verification, PR body section, claim gate, thread replies.

| Step | Code | Command | Result |
| --- | --- | --- | --- |
| RED | 35e093e + 3665687 tests | both F11 emulator files | 9 failed (the 9 new tests), 22 passed. e2e: entity committed 1, outbox entries after the response 0, audit rows naming it 0 before and after a reconciler run |
| Autofix check | 1e141d3 + my round-1 tests | both F11 emulator files | 18 failed, 15 passed of 33: every reconciler run threw on the v13 `FieldPath` value import |
| RED | 9ad5482 sources (= 3665687) + the extended round-1 tests | both F11 emulator files | 15 failed (every round-1 test but the P1 control), 22 passed |
| RED | same | Functions F11 file | 1 failed, 2 passed (the sweep test; the cursor constant inlined for the old module) |
| RED | 72a3dce sources without the route row | F16 Firestore file | 1 failed (no `committee_brain_output_create` row), 2 passed |
| GREEN | 72a3dce | both F11 emulator files; Functions F11 file; F16 Firestore file | 37/37; 3/3; 3/3 |
| GREEN | 72a3dce | memory-mode committee-brain files (15) | 869/869 |
| Mutants | f43e936 | both F11 emulator files, one mutant at a time | 11 of 11 killed (unconditional release; no action-row, claims or 2xx condition; no sweep; cursor to the page end on a budget stop; no wrap on an empty page; number readable; full pending list advances; unrestricted oldest-age query; unreadable not alerting). A first no-sweep mutant was a syntax error; its run was discarded and the mutant rerun |

Verification at f43e936 (main c02ebbc merged):

| Check | Result |
| --- | --- |
| F11, F10, F01, F12 and F16 unit files, and the committee-brain unit files (9 files) | 312/312 |
| `test:rules` set (18 files: F11, F10, F01/F12, F16 Firestore and the rest) | 18/18 files, 744/744 |
| Functions suite, local (`npm --prefix functions test` on a private emulator, load 4-10) | Ran to the end: 87 of 89 files, 2389 passed, 10 failed. `p2.jobs-sweeper` (9): each whole-collection sweep saw one extra `jobs` row left in the shared emulator by another file. `p2.jobs-invariants` (1): a 15 s test timeout. This branch changes neither file nor the code they test, and F11's three Functions tests passed in the run. Not rerun alone (stopped on the coordinator's ruling), so a clean local run is NOT DEMONSTRATED |
| Functions suite, CI on f43e936 | "Cloud Functions" check: success (read from the GitHub check runs) |
| `npm run typecheck`, `typecheck:tests`, functions typecheck | exit 0 |
| `npm run lint` | 0 errors, 89 warnings (unchanged) |
| G-0 (`BASE=origin/main bash ci_gates/gate_g0.sh`) | PASSED (static) |
| G-2 (`bash ci_gates/gate_g2.sh`), local | Stopped after 25 s on the coordinator's ruling: NOT DEMONSTRATED locally |
| G-2, CI on f43e936 and the independent auditor | CI "Gates G-0, G-1, G-2": success. The auditor's run (their numbers, not run here): PASS, 414 tested, 0 allowed; a 15 s timeout on their first run under load passed alone |
| gitleaks before each push | no leaks |

Independent re-audit at f43e936 (the coordinator's report, not run here): **PASS 8/10**.
- The ruling-18 fix (Codex P1 4307160231, Bugbot 4307293100) was checked by 32 fault-injection route runs: 10 of 32 failed on the pre-fix code, and none fails now.
- The ruling-19 fix (Codex P2 4307160234) was checked by sweep attacks E1-E5.
- The Autofix revert is confirmed.
- No HIGH or MEDIUM finding is open.

Follow-ups (LOW, open, not fixed in this PR; the code stays as at f43e936):
- O1. `stageableRows` (platform/persistence/auditOutbox.ts) measures the 512 KiB row cap in JSON string length (UTF-16 code units), not UTF-8 bytes. Non-ASCII text takes up to 3 UTF-8 bytes per code unit, so a row set under the cap can exceed 512 KiB in bytes. Past Firestore's 1 MiB document limit, the entry would be refused, and the effect's commit with it.
- O2. The auditor's surviving mutants M02, M03, M05, M25, M30 and M44 (their numbering) need tests that kill them.
- O3. `tests/f11-audit-outbox.firestore.test.ts` leaves 5 `audit_log` documents per run in the emulator; its clean-up should delete them.

Merge of main ac69873 (F18 #88) in 5e24c50 (spec A9):
- **Conflicts.** `package.json` `test:rules` and `vitest.config.ts` conflicted; both sides' test entries were kept.
- **The committee-brain route** merged automatically and was reviewed by hand. On F18's forward path Next writes nothing, so it stages no entry. A forward failure stages none either. The local pipeline stages its output entry and releases it through `committee_brain_output_create`.
- **Tests.** A new F18 e2e case pins all three paths (no outbox entry, one action row, no recovered row). It passes on the merge, and dropping the route's row fails it.
- **Verification after the merge.** See the PR body's Review round 1 section.
