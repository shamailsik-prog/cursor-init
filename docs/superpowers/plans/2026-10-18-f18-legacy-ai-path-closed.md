# F18 legacy AI path closed: plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** no paid AI call can leave the Next or eve runtime except through the Cloud Functions P1 control plane, whatever
environment variables are present (audit F18).

**Spec:** `docs/superpowers/specs/2026-10-18-f18-legacy-ai-path-closed-design.md` (rulings R1 to R12).

**Constraints:**
- Synthetic data only, with no real or key-shaped secret.
- Never skip or weaken a test. Every changed expectation is in the ledger.
- Stay out of `corpus_service/**`, `functions/src/d1/**`, `platform/http/**`, `platform/persistence/**`,
  `platform/audit/**` and `.gitleaks.toml`.

### Task 1: RED tests, spec and plan
- [x] `tests/f18-legacy-ai-path.e2e.firestore.test.ts`: rows (a) to (j) of the spec. It imports nothing new to F18; the
  documented reasons and codes are literals.
- [x] `tests/f18-next-ai-egress-gate.test.ts`: planted violations fail [19], and the repository passes.
- [x] Unit tests: `tests/f18-provider-key-guard.test.ts` and `tests/f18-functions-forward.test.ts`.
- [x] Run the e2e and the gate test against main's source on private emulators (firestore 8997, auth 9997, hub 4991,
  logging 4993). **Expected: FAIL.** Record the counts as ledger RED 1 and RED 2.
- [x] Commit the spec, the plan and the RED tests; run gitleaks; push.

### Task 2: guard and forward client
- [x] `platform/p1/providerKeyGuard.ts` (R5).
- [x] `platform/p1/functionsCommitteeBrain.ts` (R7, R8).
- [x] Unit tests GREEN.

### Task 3: remove the transport
- [x] Delete `platform/p1/gatewayTransport.ts`. Drop `readGatewayApiKey` from `platform/p1/index.ts`.
- [x] `callCommitteeBrain`: the test seam or no transport, plus the key guard after the size bound (R2, R5).
- [x] `agent/agent.ts`: refuse to start in production with a key present.

### Task 4: route dispatch
- [x] `app/api/p1/committee-brain/route.ts`: forward in a Firebase session with a valid URL and no key refusal; otherwise
  the local pipeline (R1, R4, R6, R7).

### Task 5: gate [19]
- [x] `ci_gates/check_next_ai_egress.py` (R9), with `--print-key-names`. Refined at GREEN (R9a): workflow jobs count only when they build, start or deploy the Next/eve service.
- [x] `gate_g0.sh` [19]. Update `tests/g0-gate-e2e.test.ts`: move the plant under `platform/p1/` from the clean base to a
  failing case (R12).
- [x] `.env.example` (R10). Update the console card text that named the key.
- [x] The rules job of `.github/workflows/gate-g0.yml` installs `functions/` (the F18 e2e serves the Functions router in process); the e2e joins `test:rules` and the emulator-only exclude list.

### Task 6: tests whose subject changed (R12)
- [x] `tests/f16-next-transport.test.ts`, `tests/p1.eve-committee-brain.test.ts` and the F16 live block.

### Task 7: docs
- [x] `functions/src/p1/README.md` (top paragraph and the kill-switch scope), `README.md`, `docs/architecture/README.md`
  ([19]) and `CORRECTION_LOG.md` (the transport entry).

### Task 8: verification
- [x] `npm run typecheck`, `npm run typecheck:tests`, `npm --prefix functions run typecheck`, `npm run lint`, `test:unit`,
  `test:rules` (with the F18 e2e added to its list), the P1 Functions suites (F15/F16/F17, f07-f08, f09, p1.api,
  p1.gateway), G-0 (`BASE=origin/main`), G-1, G-2 and [19].
- [x] Re-run any wall-clock failure alone and compare it with main under the same load.
- [ ] Write the PR body, run the claim gate, run gitleaks, push.

## RED/GREEN ledger

Counts per e2e row: direct calls are the legacy `ai` SDK boundary (`generateText`, `createGateway`); sanctioned calls are the
Functions P1 transport; cost rows are the firm's `ai_usage_logs`.

| Row | Command | Result |
| --- | --- | --- |
| RED 1 | `npx vitest run --no-cache tests/f18-legacy-ai-path.e2e.firestore.test.ts` on main 957fe26 source (emulators 8997/9997) | FAIL 9 of 11 (2 pass: control (j) and the cleanup check). (a) key set: 200 `blocked: false`, direct calls 1 (`generateText` 1, `createGateway` 1), cost rows 0, alert lines 0. (b) key set, firm and platform kill switches both on: direct calls 1, cost rows 0 (the kill switches are ignored). (c) to (g), no key: 200 `blocked: true` `PHASE0_NO_CREDENTIALS`, forwarded 0, sanctioned 0, cost rows 0 (no kill switch, no budget, no row). (h) unreachable Functions URL: 200 `PHASE0_NO_CREDENTIALS` (expected 503). (i) eve bridge with key: `finish: stop`, direct calls 1, eve agent module loaded. |
| RED 2 | `npx vitest run --no-cache tests/f18-next-ai-egress-gate.test.ts` on main source | FAIL 29 of 29: `ci_gates/check_next_ai_egress.py` does not exist. |
| RED 3 | `npx vitest run --no-cache tests/f18-provider-key-guard.test.ts tests/f18-functions-forward.test.ts` on main source | FAIL 16 of 17: neither module exists. One passes: without a key, in production, `callCommitteeBrain` is blocked `PHASE0_NO_CREDENTIALS` on main as well (control). |
| RED 1b | RED 1 again on the merge of main c02ebbc (F38 #84) with the RED tests, before any fix | FAIL 9 of 11, the same counts row for row. |
| RED 4 | branch's `python3 ci_gates/check_next_ai_egress.py` run on main c02ebbc's tree | FAIL, 6 findings: `platform/p1/gatewayTransport.ts` imports `ai` and names both Gateway keys; `.env.example` binds both; `app/foundation-console.tsx` names `AI_GATEWAY_API_KEY`. |
| GREEN 1 | RED 1's command on the branch | PASS 11 of 11. (a) key set: 200 `blocked: true` with `PROVIDER_KEY_IN_RUNTIME_REASON`, direct calls 0, forwarded 0, cost rows 0, alert line `p1.provider_key_in_next_runtime` naming the variable only. (b) key set with both kill switches on: direct calls 0. (c) no key: forwarded 1 with the caller's bearer, `X-Firm-Id` and Idempotency-Key, sanctioned calls 1, one cost row `ok/null/14000`, Functions wrote the output row; a same-key retry answers `reused: true` with still 1 sanctioned call. (d) to (g): `kill_switch_firm`, `kill_switch_platform`, `budget_not_set`, `budget_exhausted`, each with one `blocked` cost row at 0 and 0 sanctioned calls. (h) 503 `p1_functions_unavailable` with the alert `p1.next_forward_failed`, 0 calls, 0 rows. (i) eve bridge `finish: error` with the key reason, direct calls 0, alert, and agent/agent.ts refuses to load. (j) unchanged. Non-loopback requests 0 in every row. |
| GREEN 2 | RED 2's command on the branch | PASS 31 of 31 (19 planted failures named, 8 passing shapes including the coding-agent workflow, the clean tree, the repository, key-name parity with the runtime guard, [19] in `gate_g0.sh`). |
| GREEN 3 | RED 3's command on the branch | PASS 17 of 17. |
| GREEN 4 | `python3 ci_gates/check_next_ai_egress.py` on the branch | PASS. Its first run flagged the two coding-agent workflows (`ANTHROPIC_API_KEY` to `anthropics/claude-code-action`): ruling R9a. |
| Incident | the guard-unit file on an intermediate tree (guard present, transport not yet deleted) | Before the `ai` mock and the fetch tripwire were added to it, its production-with-key row ran main's real transport twice with the fake placeholder key: `transport_error` both times; whether the requests reached the Gateway host is NOT ESTABLISHED; nothing billable was possible. Fixed in the file (counting fake + tripwire asserted empty); recheck on the same tree: the call reached the fake. Recorded in the evidence log. |
| test:rules | its 17 files (the F18 e2e included) at 528247c on the private emulators | PASS 717 of 717. |
| Functions P1 | 22 files (p1.units, p1.transport, p1.gateway.emu, p1.api.emu, f07-f08, f09 x2, f15, f16 x2, f17 x12) at 528247c | PASS 1,086 of 1,086. |
| Unit | `npm run test:unit -- --no-cache` at load 13 to 17 | 206 of 211 files pass; 5,994 pass, 21 fail, 54 skipped. The 21 are wall-clock bounds (`citations.time-budget` 15; `f15-r3/r4/r5-bounds` 6) and `g0-gate-e2e`'s `afterAll` cleanup hook (its 22 tests pass). Alone and against main c02ebbc at comparable load: g0-gate-e2e hits the same hook timeout on main (20 of 20 pass there); the bound files fail 7 of 130 on the branch and 4 of 130 on main, the same tests, varying with load; the timed code has no diff here. |
| Gates | `BASE=origin/main bash ci_gates/gate_g0.sh`, `python3 ci_gates/gate_g1.py`, `bash ci_gates/gate_g2.sh` | G-0 PASSED [1] to [19]; G-1 10 of 10; G-2 PASS (413 tested, 0 allowed, 10 not built). |
| Typecheck and lint | `npm run typecheck`, `npm run typecheck:tests`, `npm --prefix functions run typecheck`, `npm run lint` | All pass; lint 0 errors, 90 warnings, none in a changed file. |
| Build | `npm run build` | NOT DEMONSTRATED here: Turbopack refuses the symlinked `node_modules` (outside the workspace root) the builder's install uses; CI's Next.js build job runs it. |
