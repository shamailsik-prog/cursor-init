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
- [ ] `npm run typecheck`, `npm run typecheck:tests`, `npm --prefix functions run typecheck`, `npm run lint`, `test:unit`,
  `test:rules` (with the F18 e2e added to its list), the P1 Functions suites (F15/F16/F17, f07-f08, f09, p1.api,
  p1.gateway), G-0 (`BASE=origin/main`), G-1, G-2 and [19].
- [ ] Re-run any wall-clock failure alone and compare it with main under the same load.
- [ ] Write the PR body, run the claim gate, run gitleaks, push.

## RED/GREEN ledger

Counts per e2e row: direct calls are the legacy `ai` SDK boundary (`generateText`, `createGateway`); sanctioned calls are the
Functions P1 transport; cost rows are the firm's `ai_usage_logs`.

| Row | Command | Result |
| --- | --- | --- |
| RED 1 | `npx vitest run --no-cache tests/f18-legacy-ai-path.e2e.firestore.test.ts` on main 957fe26 source (emulators 8997/9997) | FAIL 9 of 11 (2 pass: control (j) and the cleanup check). (a) key set: 200 `blocked: false`, direct calls 1 (`generateText` 1, `createGateway` 1), cost rows 0, alert lines 0. (b) key set, firm and platform kill switches both on: direct calls 1, cost rows 0 (the kill switches are ignored). (c) to (g), no key: 200 `blocked: true` `PHASE0_NO_CREDENTIALS`, forwarded 0, sanctioned 0, cost rows 0 (no kill switch, no budget, no row). (h) unreachable Functions URL: 200 `PHASE0_NO_CREDENTIALS` (expected 503). (i) eve bridge with key: `finish: stop`, direct calls 1, eve agent module loaded. |
| RED 2 | `npx vitest run --no-cache tests/f18-next-ai-egress-gate.test.ts` on main source | FAIL 29 of 29: `ci_gates/check_next_ai_egress.py` does not exist. |
| RED 3 | `npx vitest run --no-cache tests/f18-provider-key-guard.test.ts tests/f18-functions-forward.test.ts` on main source | FAIL 16 of 17: neither module exists. One passes: without a key, in production, `callCommitteeBrain` is blocked `PHASE0_NO_CREDENTIALS` on main as well (control). |
