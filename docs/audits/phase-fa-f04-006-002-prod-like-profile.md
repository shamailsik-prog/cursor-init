# FA-F04-006-002 — Prod/stage/unknown deploy profiles prod-like off-bundle

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F04-006-002** (child of FA-F04-006 / PR #153)

## Problem (RED baseline)

`isProdLikeOcrRuntime` (FA-F04-006) normalized `NODE_ENV` case on the `env` argument and treated manifest names `staging` / `production` as prod-like, but off-bundle runs still selected the OCR stub when `SIKANDER_DEPLOY_PROFILE` was the ME audit shorthand `prod` / `stage`, the explicit `unknown` bucket, or a non-manifest profile on a hosted runtime. The deployed bundle is always prod-like via `functions/build.mjs` (`define: { "process.env.NODE_ENV": '"production"' }`); off-bundle policy did not match.

## Correction

- Centralized policy in `functions/src/deployRuntimeProfile.ts` as `isProdLikeFunctionsRuntime`.
- Keeps a **literal** `process.env.NODE_ENV === "production"` for esbuild constant-folding (FA-F04-006-001).
- Adds case-normalized `NODE_ENV` for off-bundle host/argument values.
- Treats deploy profiles `production`, `prod`, `staging`, `stage`, and `unknown` as prod-like; manifest-bound profiles via `gcpProjectIdForDeployProfile`; unrecognized non-local profiles on a hosted runtime (`K_SERVICE` / `FUNCTION_TARGET`, not emulator) as prod-like (unknown bucket).
- `isProdLikeOcrRuntime` delegates to the shared helper.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Off-bundle `NODE_ENV=test`, `SIKANDER_DEPLOY_PROFILE=prod` (before fix) | `resolveOcrEngine` returned stub |
| RED | Same with `stage` or `unknown` | Stub selected |
| GREEN | `functions/test/deploy-runtime-profile.test.ts` — `FA-F04-006-002` | `prod` / `stage` / `unknown` and case-normalized `NODE_ENV` fail closed; `local` may use stub |
| GREEN | `functions/test/f04-ocr.unit.test.ts` — `FA-F04-006` / `FA-F04-006-001` | Prior FA-F04-006 proofs still pass |

## Focused verification

```bash
npm --prefix functions test -- --run deploy-runtime-profile.test.ts -t "FA-F04-006-002"
npm --prefix functions test -- --run f04-ocr.unit.test.ts -t "FA-F04-006"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (policy aligned off-bundle; no live deploy-path e2e in this slice) |
