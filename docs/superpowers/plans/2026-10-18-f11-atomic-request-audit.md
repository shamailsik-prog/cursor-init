# F11 plan: atomic request audit (outbox staged in the effect commit, drained by a reconciler)

Spec: `docs/superpowers/specs/2026-10-18-f11-atomic-request-audit-design.md`.
Branch: `claude/remediate-f11` from `origin/main` a9b0e06; main 957fe26 merged in a0802a5.

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
