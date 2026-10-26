# F35 — Timed-out job handlers are cancelled (AbortSignal)

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **F35** (`docs/audit/2026-10-13-forensic-audit.md`)

## Mechanism

When `withinBudget` records `handler_timeout`, it aborts an `AbortController` and passes `ctx.signal` into every handler `run()`. Cooperative handlers use `abortableDelay` (or pass `signal` to `fetch`) so in-flight work stops instead of completing after the failure commit.

Production touchpoints:

- `functions/src/p2/worker.ts` — budget race aborts `signal` on overrun.
- `functions/src/p2/registry.ts` — `JobContext.signal`.
- `functions/src/p2/abortable.ts` — `abortableDelay` / `handlerTimeoutFromSignal`.
- `functions/src/p2/diagnostic.ts` — `hang` behaviour honours the signal (chaos/diagnostic path).

Non-cooperative handlers may still run until the Cloud Functions instance ends; fenced Firestore steps remain the commit fence (unchanged at-least-once model).

## RED / GREEN (ledger)

| Step | Command / evidence | Result |
| --- | --- | --- |
| RED | `0384933c` (main): cooperative timeout test and `abortableDelay` unit test fail — `JobContext` had no `signal`, `hang` ignored budget | `functions/test/p2.engine.test.ts` F35 case fails; `p2.jobs-worker.emu.test.ts` F35 case fails (late `apply` would leak) |
| GREEN | Same tests on this branch | PASS |

## Focused verification

```bash
npm --prefix functions test -- p2.engine.test.ts -t "abortableDelay"
npm --prefix functions test -- p2.jobs-worker.emu.test.ts -t "handler_timeout"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (P2 worker slice; not COMPLETE while transport_stub=true) |

no COMPLETE/product-done claim
