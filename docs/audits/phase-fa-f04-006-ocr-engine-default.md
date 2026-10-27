# FA-F04-006 — OCR engine must not default to stub in prod-like runtimes

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F04-006** (parent audit F04, OCR worker / P1 admission path)

## Problem (RED baseline)

Before F04 PR #110, `resolveOcrEngine` in `functions/src/p1/ocrEngine.ts` selected `DeterministicLocalOcrEngine` whenever `OCR_PROVIDER` was unset or `local`, including in deployed Functions where real OCR credentials are not wired. That silently published stub text in production.

## Correction

- `isProdLikeOcrRuntime` treats `NODE_ENV=production` (constant-folded in the deployed bundle via `functions/build.mjs`) and `SIKANDER_DEPLOY_PROFILE` of `staging` or `production` as prod-like.
- `resolveOcrEngine` returns `null` in prod-like runtimes unless the provider name is registered in `OCR_EGRESS_PROVIDERS` (empty in this build → fail closed).
- Local/dev/test without a prod-like profile may still select the deterministic stub when `OCR_PROVIDER` is unset or `local`.
- `callP1Ocr` maps a null engine to `blockReason: provider_unsupported` and does not publish `ocr_texts`.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Main before #110: unset `OCR_PROVIDER` with production `NODE_ENV` | Stub engine selected; OCR text published |
| GREEN | `functions/test/f04-ocr.unit.test.ts` — `FA-F04-006: prod-like runtimes…` | `resolveOcrEngine` is `null` for production and staging profile; dev/test may use stub |
| GREEN | `functions/test/f04-ocr.e2e.emu.test.ts` — `FA-F04-006: prod-like runtime blocks upload→OCR…` (worker runs with `SIKANDER_DEPLOY_PROFILE=staging`) | Legacy row `ocrFailureCode: provider_unsupported`; no `ocr_texts`; `p1_ocr_operations` blocked |

## Focused verification

```bash
npx vitest run functions/test/f04-ocr.unit.test.ts -t "FA-F04-006"
npx vitest run functions/test/f04-ocr.e2e.emu.test.ts -t "FA-F04-006"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (OCR admission fail-closed; no real OCR provider wired in `OCR_EGRESS_PROVIDERS`) |

no COMPLETE/product-done claim
