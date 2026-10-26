# F35 R1-001 — `JobContext.signal` aborts on lease loss

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F35-R1-001** (re-audit after PR #138 handler budget abort)

## Mechanism

While a handler runs, `runWithHandlerAbort` in `functions/src/p2/worker.ts` races the handler against:

1. The existing handler budget timer (`handler_timeout` on `ctx.signal`).
2. `startLeaseFenceWatch` (`functions/src/p2/leaseWatch.ts`), which re-reads the job row immediately and every `JOB_LEASE_WATCH_POLL_MS` (500 ms). When `status !== "running"` or `lease.owner` no longer matches this claim, the worker aborts `ctx.signal` with `LeaseLostError`.

Cooperative handlers use `abortableDelay` (or pass `signal` to `fetch`); `abortErrorFromSignal` maps lease-loss aborts to `LeaseLostError` so they are not mis-labelled as `handler_timeout`. The finish commit still re-checks the fence; a cooperative handler that stops after abort does not stage a late `apply`.

## RED / GREEN (ledger)

| Step | Evidence | Result |
| --- | --- | --- |
| RED | `f36bad04` (main after #138): `lease loss aborts cooperative work` emulator test and `startLeaseFenceWatch` unit test fail — handler keeps waiting after fence loss; no lease poll | FAIL |
| GREEN | Same tests on this branch | PASS |

## Focused verification

```bash
npm --prefix functions test -- p2.engine.test.ts -t "leaseFenceHolds|LeaseLostError"
npm --prefix functions test -- p2.jobs-worker.emu.test.ts -t "lease loss aborts"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (P2 worker slice; not COMPLETE while transport_stub=true) |

no COMPLETE/product-done claim
