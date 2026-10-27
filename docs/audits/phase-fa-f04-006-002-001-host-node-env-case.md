# FA-F04-006-002-001 — Pin host `NODE_ENV` case normalization off-bundle

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F04-006-002-001** [LOW] (child of FA-F04-006-002 / PR #175)

## Problem (RED baseline)

`nodeEnvIsProduction` in `functions/src/deployRuntimeProfile.ts` lowercases host `process.env.NODE_ENV` when the `env` argument omits `NODE_ENV`, but ME mutation testing showed a surviving mutant that removed that lowercasing. Existing unit tests always passed `NODE_ENV` on the `env` argument (`{ NODE_ENV: "Production" }`), so they exercised the argument path only and never the host-env branch.

## Correction

- **Test-only pin:** assert prod-like behavior when `process.env.NODE_ENV` is `Production` (mixed case) and the caller passes an `env` object without `NODE_ENV` (host path).
- **Product code:** unchanged unless the pin exposed a real bug (it did not).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | ME mutant removing `process.env.NODE_ENV?.trim().toLowerCase()` on the host branch | `isProdLikeFunctionsRuntime({})` false while host is `Production` |
| RED | Prior `FA-F04-006-002` test `normalizes NODE_ENV case off-bundle` | Passes via `env.NODE_ENV` argument only — does not kill host mutant |
| GREEN | `functions/test/deploy-runtime-profile.test.ts` — `FA-F04-006-002-001` | Host `Production` + empty `env` → prod-like; OCR stub (`resolveOcrEngine` → `null`) |

## Focused verification

```bash
npm --prefix functions test -- --run deploy-runtime-profile.test.ts -t "FA-F04-006-002-001"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (host-env branch pinned in unit tests; no live deploy-path e2e in this slice) |
