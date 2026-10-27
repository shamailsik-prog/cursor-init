# FA-F04-006-002-002 — Pin hosted-bucket prod-like edges off-bundle

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F04-006-002-002** [LOW] (child of FA-F04-006-002 / PR #175)

## Problem (RED baseline)

`isProdLikeFunctionsRuntime` in `functions/src/deployRuntimeProfile.ts` applies the “unknown profile on hosted runtime” bucket only when the deploy profile is non-empty, not in `NON_PROD_LIKE_PROFILES`, and `isHostedRuntime(env)` is true. ME mutation testing (reaudit PR #175) left survivors around:

1. **Local-on-hosted** — `local` / `dev` / `development` / `test` with `K_SERVICE` or `FUNCTION_TARGET` must stay **non-prod-like** (must not fall through to the hosted unknown bucket).
2. **Emulator + odd profile** — `FUNCTIONS_EMULATOR=true` with an unrecognized profile and hosted signals must **not** be treated as hosted (emulator path must keep runtime non-prod-like unless an earlier prod-like bucket already matched).

Prior `FA-F04-006-002` tests covered local off-bundle without hosted signals and odd profile on hosted without the emulator; they did not kill mutants that drop the `NON_PROD_LIKE_PROFILES` guard or the emulator short-circuit in `isHostedRuntime`.

## Correction

- **Test-only pin:** `functions/test/deploy-runtime-profile.test.ts` — `FA-F04-006-002-002` cases for local-family profiles on `K_SERVICE`, emulator + odd profile + `K_SERVICE`, and control case odd profile on real hosted runtime.
- **Product code:** unchanged unless the pin exposed a real bug (it did not).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | ME mutant removing `!NON_PROD_LIKE_PROFILES.has(profile)` in hosted branch | `local` + `K_SERVICE` → prod-like (wrong) |
| RED | ME mutant forcing `isHostedRuntime` true when `FUNCTIONS_EMULATOR=true` | emulator + odd profile + `K_SERVICE` → prod-like (wrong) |
| GREEN | `FA-F04-006-002-002` — local/dev/development/test + `K_SERVICE` | non-prod-like; OCR local engine |
| GREEN | `FA-F04-006-002-002` — emulator + odd profile + `K_SERVICE` | non-prod-like; OCR local engine |
| GREEN | `FA-F04-006-002-002` — odd profile + `K_SERVICE` (no emulator) | prod-like; OCR stub (`null`) |

## Focused verification

```bash
npm --prefix functions test -- --run deploy-runtime-profile.test.ts -t "FA-F04-006-002-002"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (hosted-bucket edges pinned in unit tests; no live deploy-path e2e in this slice) |
