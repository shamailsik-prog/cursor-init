# FA-F04-007 — Periodic OCR legacy drain sweep

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F04-007** (parent audit F04, legacy upload OCR rows)

## Problem (RED baseline)

Before F04 PR #110 (`7ed2d874`), `onJobCreatedCore` in `functions/src/p2/functions.ts` drained a well-formed legacy `ocr` row only when Firestore delivered the create event. If that handoff was missed (no redelivery, row predating the trigger, or engine job dead-lettered while the legacy row stayed non-terminal), the upload stayed queued indefinitely with no periodic recovery.

## Correction

- **Create-time drain retained:** `onJobCreatedCore` still calls `acceptLegacyOcrJob` for complete legacy OCR rows (FA-F04-001 fail-open retry on transient enqueue errors).
- **Periodic sweep added:** `ocrLegacySweep` (`onSchedule`, every 1 minute, `asia-south1`, 45 s timeout, `maxInstances: 1`, internal ingress only) runs `sweepLegacyOcr` from `functions/src/p2/ocrSweep.ts`.
- **Sweep behaviour:** Pages non-terminal legacy `ocr` rows (`ocrStatus` not `done`/`failed`), bounded by `SWEEP_BUDGET_MS` / `SWEEP_LIMIT` / `SWEEP_MAX_PAGES`. Rows with no engine job are drained via the same `acceptLegacyOcrJob` path (idempotent `enqueueJob` + dispatch). Rows whose engine job is `dead_lettered` are manually requeued up to `MAX_MANUAL_RETRIES`, then the legacy row is closed `failed`. Terminal engine states (`queued`, `running`, `failed`) are left to the engine job sweeper.
- **Legacy backfill:** `backfillLegacyOcrStatusForSweep` stamps missing `ocrStatus` so pre-status rows enter the sweep query (FA-F04-013).
- **Deploy surface:** Exported from `functions/src/index.ts`; listed in `infra/deploy-manifest.json` as schedule `every 1 minutes`.
- **FA-F04-006 interaction:** The sweep only enqueues/dispatches; prod-like OCR admission fail-closed (`resolveOcrEngine` → `null`, PR #153) is enforced in the worker/P1 path, not bypassed by the sweep.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Main before #110: legacy row written with `writeLegacy` only, no create handler | Row stays `ocrStatus: queued`; no engine job; no `ocr_texts` |
| RED | Issue #30 FA-F04-007: drain only at `functions.ts` create path (~46–52) | No scheduled `ocrLegacySweep` / `sweepLegacyOcr` |
| GREEN | `functions/test/p2.boot.test.ts` — `ocrLegacySweep` endpoint | Schedule `every 1 minutes`, region `asia-south1`, timeout 45 s, no HTTP trigger |
| GREEN | `functions/test/f04-ocr.e2e.emu.test.ts` — `FA-F04-007: create-time drain still hands off without running the sweep` | `onJobCreatedCore` alone completes legacy row and publishes stub OCR text |
| GREEN | `functions/test/f04-ocr.e2e.emu.test.ts` — `FA-F04-007: a sweep drains an older legacy row the create trigger never saw` | `sweepLegacyOcr` only (no create): row → `done`, text extracted |
| GREEN | `functions/test/f04-ocr.e2e.emu.test.ts` — `FA-F04-007: the sweep picks up a row whose engine retries are exhausted` | Dead-lettered engine revived, dispatch, legacy `done` |
| GREEN | `functions/test/f04-ocr.e2e.emu.test.ts` — `FA-F04-007: a dead-lettered OCR job at the manual retry cap is closed instead of requeued` | Legacy `failed`; engine stays dead-lettered; no duplicate processing |

## Focused verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- --run f04-ocr.e2e.emu.test.ts -t 'FA-F04-007'"
npm --prefix functions test -- --run p2.boot.test.ts -t "ocrLegacySweep"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (OCR drain + sweep wired; production OCR provider still not registered in `OCR_EGRESS_PROVIDERS`) |

no COMPLETE/product-done claim
