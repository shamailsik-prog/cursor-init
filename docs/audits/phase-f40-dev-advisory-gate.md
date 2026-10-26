# Phase audit — F40 development supply-chain advisory gate

Finding **F40** (issue #30): development supply-chain risk was excluded because
`npm audit --omit=dev` gated only production dependencies while CI runs
`firebase-tools`, `vitest`, and related tooling with repository credentials.

## RED / GREEN (ledger)

| State | Evidence | Result |
| --- | --- | --- |
| RED | `f4103b3` (main after PR #145): `.github/workflows/security.yml` collected only `npm audit --omit=dev` JSON; `known-advisories.md` stated dev-only advisories were out of scope | Full-tree `npm audit` on 2026-10-26: 13 high/critical gating rows at root (3 critical) vs 0 high/critical with `--omit=dev` |
| GREEN | Branch `cursor/f40-dev-advisory-gate-b7f7`: full-tree reports `audit/npm-root-dev.json` and `audit/npm-functions-dev.json` wired into `check_known_advisories.mjs`; triaged allowlist rows under `npm:root:dev` / `npm:functions:dev`; non-breaking overrides for `vite@7.3.7` and `@grpc/grpc-js@1.14.6` | Local gate: `node ci_gates/check_known_advisories.mjs` with prod + dev + pip scopes PASS |

## Scope note

This closes the **gate gap** (visibility + fail-on-new dev advisories). It does
not claim every listed dev advisory is exploitable in this CI layout; rows carry
owners and review dates for upgrade backlog work (firebase-tools 15, vitest 5).

| Claim | Value |
| --- | --- |
| OR-1..OR-4 | unchanged |
| backend_real | false |
| frontend_real | false |
| transport_stub | true |
