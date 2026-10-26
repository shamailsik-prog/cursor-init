# F36 — Event fan-out production subscriber and reconciliation

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **F36** (`docs/audit/2026-10-13-forensic-audit.md`)

## Mechanism

- **Production subscriber:** `entity.candidate` → `d1.entity.candidateSignal` (`functions/src/d1/entity/candidateSignalJob.ts`), registered in `SUBSCRIBERS` (`functions/src/p2/fanout.ts`).
- **Delivery ledger:** `event_fanout_deliveries/{sha256(fanOutKey)}` written in the same Firestore transaction as job enqueue (`functions/src/p2/eventFanoutDelivery.ts`).
- **Reconciliation (O-37):** `eventFanoutReconciler` every five minutes scans `events` and re-runs `fanOutEvent` when a delivery row is missing (`functions/src/p2/fanoutReconcile.ts`).

## RED / GREEN (ledger)

| Step | Command / evidence | Result |
| --- | --- | --- |
| RED | `78b728ba` (main): `SUBSCRIBERS.length === 0`; no `event_fanout_deliveries` or `eventFanoutReconciler` export | Empty registry; O-37 comment only in `onEventCreated` |
| GREEN | Branch: emulator tests below | PASS |

## Focused verification

```bash
cd functions
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npx vitest run test/p2.fanout-production.emu.test.ts test/p2.jobs-events.emu.test.ts"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (P2 event fan-out slice; not COMPLETE while transport_stub=true) |

no COMPLETE/product-done claim
