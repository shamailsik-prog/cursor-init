# F11 plan: atomic request audit (outbox staged in the effect commit, drained by a reconciler)

Spec: `docs/superpowers/specs/2026-10-18-f11-atomic-request-audit-design.md`.
Branch: `claude/remediate-f11` from `origin/main` a9b0e06.

## Tasks

1. **RED tests, run on main's code.**
   - `tests/f11-atomic-request-audit.e2e.firestore.test.ts`: the production-mode e2e through `POST /api/d1/clients` (crash after the entity commit, crash before the flush, atomicity, same-key retry on instance B, normal-path control, two firms).
   - `tests/f11-audit-outbox.firestore.test.ts`: helper staging (fenced, unfenced, transaction, external effect, excluded collections, no request, failed commit), reconciler (exactly once, poison, counted attempts, backlog alert, cross-firm), dead-letter `listByFirm` on Firestore.
   - `tests/f11-audit-outbox.unit.test.ts`: contract validation and recovered row, memory `listByFirm`, the sink seam guard.
   - The modules F11 adds are loaded loosely (dynamic import with a catch) so each test fails on its assertion on main, not on the import.
2. **Contract** `platform/persistence/auditOutboxContract.ts`.
3. **Staging**: `firestoreDbModular.ts` (four helpers + external effect), `auditOutbox.ts` (session, rows, release), `withSession.ts` (open, release), F10 composition (`durableIdempotency.ts`, `idempotency.ts`).
4. **Reconciler**: `functions/src/p5/auditOutbox.ts`, `functions/src/p5/auditOutboxReconciler.ts`, export in `functions/src/index.ts`; the Functions export-list tests.
5. **Dead letter** firm scope (Firestore and memory adapters, Next writer).
6. **Rules and indexes**: `audit_outbox` server-only; field overrides.
7. **Seam guard**: `setRequestAuditSinkForTests`.
8. **Wiring**: `test:rules` and the vitest exclude list.
9. **Verification**: `test:unit`, `test:rules`, Functions `test:emu` (touched suites) and typecheck, G-1, G-2, `typecheck`, `typecheck:tests`, lint, G-0.
10. **PR body** and the claim gate.

## RED/GREEN ledger

Commands (scratch emulator config, private ports):

```
E="node_modules/.bin/firebase emulators:exec --config /tmp/claude-0/-home-user/7c93b457-ba66-5c9c-b05b-44e0b66b7f92/scratchpad/f11emu/firebase.json --only auth,firestore --project demo-sikander"
$E "npx vitest run --no-file-parallelism tests/f11-atomic-request-audit.e2e.firestore.test.ts tests/f11-audit-outbox.firestore.test.ts"
npx vitest run tests/f11-audit-outbox.unit.test.ts
```

| Step | Code | Result |
| --- | --- | --- |
| RED | main a9b0e06 + the F11 test files only | recorded below |
| GREEN | branch head | recorded below |

(Filled in as the work proceeds.)
