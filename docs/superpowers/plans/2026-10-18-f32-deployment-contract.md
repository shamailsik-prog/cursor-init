# F32 deployment contract: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production deployment contract a versioned manifest that CI proves the code, `firebase.json`, `firestore.indexes.json`, the rules, the alert lines and the Next routes agree with; make an unsafe proxy/ingress combination refuse to start; give operators a preflight, a runbook and a staging promotion; make `/health` report the contract it can verify.

**Architecture:** `infra/deploy-manifest.json` is the source of truth. A stdlib Python script (`ci_gates/check_deploy_contract.py`) runs static checks (G-0 [20]) and, with `--bundle`, compares every endpoint of the built Functions bundle with the manifest. Terraform for what `firebase deploy` cannot own is rendered from the manifest and byte-compared. The Functions code states every limit and identity explicitly; `deployConfig.ts` refuses unsafe environments when it loads.

**Tech Stack:** TypeScript (Functions v2, vitest), Python 3 standard library (`unittest`), bash, JSON, generated HCL. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-18-f32-deployment-contract-design.md` (rulings R1 to R13).

## Global Constraints

- Region `asia-south1` everywhere; runtime account `sikander-functions@`; `PROJECT_ID` is a literal placeholder, never a real project id, key or address.
- No `npm ci`; `node_modules` are symlinks. Vitest with `--no-cache`. Emulator ports 8797 (Firestore), 8798 (websocket), 9797 (Auth), 4891 (hub), 4893 (logging), 5197 (Functions); UI off; stop emulators when done.
- Lane: the manifest, `infra/**`, `firebase.json`, `firestore.indexes.json` (TTL only), `functions/src/deployConfig.ts`, `health.ts`, function option blocks only, the new gate and its workflow line, docs. Not touched: `corpus_service/**`, `functions/src/d1/**` logic, `ci_gates/check_next_ai_egress.py`, `platform/p1/**`, `platform/http|persistence|audit/**`, `.gitleaks.toml`. G-0 [19] must keep passing.
- Every commit ends with the two trailer lines the brief fixes. Merge only; never rebase or force-push.
- Never skip, disable or weaken a test; a changed expectation keeps its intent and is listed in the PR.

## Review Focus

The inputs the spec implies but a first draft of the tests would miss, most likely first:
1. `TRUSTED_PROXY_HOPS` written with padding or a sign (`" 1"`, `"+1"`, `"01"`): must be a violation or a clean integer, never a quiet 0. Pinned in Task 1 (`proxy_hops_invalid` rows).
2. The bundle is built with `NODE_ENV` baked to production, so a deployed bundle with no ingress setting must refuse, while the same source under vitest must not. Pinned in Task 1 (deployed context rows) and Task 7 (bundle dump needs the profile env).
3. A function present in the manifest and exported under a different case (`jobworker`). Pinned in Task 4 (export parity is case-sensitive).
4. A TTL entry whose collection is under a client-readable rules block. Pinned in Task 4 (rules check).
5. Health metadata probe that hangs: the 500 ms timeout returns `unknown`, not a hung request. Pinned in Task 3.

---

## File structure

- `functions/src/runtimeOptions.ts` (new, leaf): `REGION`, `RUNTIME_SERVICE_ACCOUNT`, `RUNTIME_DEFAULTS`, `INTERNAL_ONLY`.
- `functions/src/deployConfig.ts` (changed): env readers, `deployContractViolations`, `DeployContractError`, `isDeployedRuntime`, the load-time check.
- `functions/src/health.ts` (changed): `createHealthHandler`, `contractReport`.
- Function option blocks: `http/router.ts`, `p2/functions.ts`, `p2/scheduled.ts`, `p1/reconciler.ts`, `p5/auditOutboxReconciler.ts`, `d1/conflict/registryTriggers.ts` (options only).
- `infra/deploy-manifest.json`, `infra/render_terraform.py`, `infra/terraform/*.tf`, `infra/README.md`.
- `ci_gates/check_deploy_contract.py`, `ci_gates/test_check_deploy_contract.py`.
- `functions/scripts/dump-endpoints.cjs`, `scripts/deploy-preflight.sh`, `docs/deploy/RELEASE_RUNBOOK.md`.
- Tests: `functions/test/deploy-contract.test.ts`, `functions/test/runtime-options.test.ts`, `functions/test/health.test.ts`, `functions/test/f32-deploy-contract.e2e.test.ts`, `tests/f32-firestore-indexes.test.ts`.

---

### Task 1: Fail closed at start-up

**Files:** Create `functions/test/deploy-contract.test.ts`; modify `functions/src/deployConfig.ts`, `functions/test/deploy.test.ts`.

**Interfaces:**
- Produces: `type ContractCode = "ingress_not_set" | "ingress_invalid" | "proxy_hops_invalid" | "proxy_trust_with_open_ingress" | "gclb_ingress_without_trusted_hop"`; `deployContractViolations(env: Env, ctx: { deployed: boolean }): ContractCode[]`; `class DeployContractError extends Error { codes: ContractCode[] }`; `isDeployedRuntime(): boolean`; `CONTRACT_ALERT = "deploy.contract_violation"`.

- [ ] **Step 1: tests (RED).** Table: hops `0/1`, ingress each of the three plus unset plus `allow_all`, `deployed` both; expected code sets as in spec R6. Module-load rows: `vi.resetModules()` + `vi.stubEnv` then `import("../src/deployConfig")` rejects with `DeployContractError` for `{hops:"1", ingress:"ALLOW_ALL"}`, `{hops:"0", ingress:"ALLOW_INTERNAL_AND_GCLB"}`, `{hops:"x"}`; resolves for `{hops:"1", ingress:"ALLOW_INTERNAL_AND_GCLB"}`, `{}`; the logger's `error` is called once with `deploy.contract_violation` and codes only (no env values). `deploy.test.ts` rows changed in step 3.
- [ ] **Step 2: run, expect FAIL** (`deployContractViolations is not a function`, load does not throw): `cd functions && npx vitest run --no-cache test/deploy-contract.test.ts`.
- [ ] **Step 3: implement** the signatures above in `deployConfig.ts`; `ingressWarning` is removed; `trustedProxyHops` and `ingressSettings` keep their contracts; the module evaluates once at load, logs and throws. Update `deploy.test.ts`: the warning test becomes the refusal test, the bundle-load test passes `SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB` and `TRUSTED_PROXY_HOPS=1` to the child process.
- [ ] **Step 4: run, expect PASS**, plus `test/http.test.ts`, `test/deploy.test.ts`.
- [ ] **Step 5: commit** `fix(F32): refuse an unsafe proxy/ingress combination at start-up`.

### Task 2: Explicit function options

**Files:** Create `functions/src/runtimeOptions.ts`, `functions/test/runtime-options.test.ts`; modify the option blocks listed; modify `functions/test/p2.boot.test.ts`.

**Interfaces:**
- Produces: `REGION`, `RUNTIME_SERVICE_ACCOUNT = "sikander-functions@"`, `RUNTIME_DEFAULTS = { region, serviceAccount, memory: "256MiB", concurrency: 1, minInstances: 0 } as const`, `INTERNAL_ONLY = "ALLOW_INTERNAL_ONLY"`. `health.ts` re-exports `REGION`.

- [ ] **Step 1: test (RED).** For every export of `../src/index`: `availableMemoryMb`, `concurrency`, `minInstances`, `maxInstances`, `serviceAccountEmail`, `timeoutSeconds` are not null; `serviceAccountEmail === "sikander-functions@"`; every non-HTTP function has `ingressSettings === "ALLOW_INTERNAL_ONLY"`; `health` is `ALLOW_ALL`; `jobWorker` `taskQueueTrigger.invoker` equals `["sikander-functions@"]`.
- [ ] **Step 2: run, expect FAIL** (all null on main).
- [ ] **Step 3: implement** `runtimeOptions.ts` and spread `RUNTIME_DEFAULTS` into each option block with the per-function `maxInstances`, `timeoutSeconds` and `ingressSettings` of the manifest table. `p2.boot.test.ts`: the invoker assertion is the runtime account and not `public`.
- [ ] **Step 4: run, expect PASS**, plus `p2.boot`, `p5.identity` (index exports), `p2.scheduled`.
- [ ] **Step 5: commit.**

### Task 3: Health reports the contract

**Files:** modify `functions/src/health.ts`, `functions/test/health.test.ts`.

**Interfaces:**
- Produces: `type Verdict = "ok" | "violated" | "unknown"`; `contractReport(deps?): Promise<Record<"region"|"database_location"|"ingress"|"proxy_trust"|"required_env"|"runtime_identity", Verdict>>`; `createHealthHandler(deps?)`; `healthHandler`. `deps = { env, deployed, metadata: () => Promise<{ region?: string; serviceAccount?: string }>, now }`.

- [ ] **Step 1: tests (RED).** 200 with all `ok` when the metadata probe agrees; 503 `unhealthy` with the one violated key when region, database location (`FIREBASE_CONFIG` `{"locationId":"us-central1"}`), identity or ingress disagrees; `unknown` without failing when the probe returns nothing or `locationId` is absent; the body holds only the verdict words and `region`; the probe is called once inside 5 minutes (injected `now`); a probe that never settles resolves `unknown` within the 500 ms bound (fake timers).
- [ ] **Step 2: run, expect FAIL.**
- [ ] **Step 3: implement.** The default probe reads the metadata server (`Metadata-Flavor: Google`, 500 ms `AbortSignal.timeout`), cached per instance for 300 000 ms.
- [ ] **Step 4: run, expect PASS.**
- [ ] **Step 5: commit.**

### Task 4: The manifest and the static gate

**Files:** Create `infra/deploy-manifest.json`, `ci_gates/check_deploy_contract.py`, `ci_gates/test_check_deploy_contract.py`.

**Interfaces:**
- Produces (Python): `load_manifest(root)`, `run_static(root, manifest) -> list[Finding]`, `compare_endpoints(manifest, endpoints, profile) -> list[Finding]`, `check_env_file(manifest, profile, text) -> list[Finding]`, `print_env(manifest, profile) -> str`, `main(argv)`; `Finding(check, message)`; stable check ids: `manifest`, `exports`, `functions`, `queues`, `ttl`, `ttl-writers`, `rules`, `alerts`, `alert-lines`, `environments`, `firebase-json`, `indexes`, `next`, `iam`, `terraform`, `runbook`, `endpoints`, `env-file`.
- Tests copy the files the gate reads into a temp tree and plant one mismatch each (list in spec section 5); the shipped tree yields no findings.

- [ ] **Step 1: write the manifest** from the code (13 functions, the queue, TTL list, alert registry, profiles, Next routes, IAM).
- [ ] **Step 2: tests (RED):** `ci_gates/test_check_deploy_contract.py` with the shipped-tree test and the planted mismatches; run `python3 ci_gates/test_check_deploy_contract.py -v`; expect every test to fail (module missing).
- [ ] **Step 3: implement checks one id at a time**, running the suite after each until green.
- [ ] **Step 4: commit.**

### Task 5: Terraform projection

**Files:** Create `infra/render_terraform.py`, `infra/terraform/*.tf`, `infra/README.md`; extend the gate's `terraform` check and the test module.

**Interfaces:**
- Produces: `render(manifest) -> dict[str, str]` (file name to text), `validate_hcl(text) -> list[str]` (structure, allowlisted resource types and attributes, resolvable references).

- [ ] **Step 1: tests (RED):** drift (edit a role in the manifest, the committed files differ), validator rejects an unknown attribute, an unbalanced brace, an unresolved reference, a literal that looks like a key or a real project id.
- [ ] **Step 2: implement renderer and validator; generate the files.**
- [ ] **Step 3: commit.**

### Task 6: Firebase files

**Files:** modify `firebase.json`, `firestore.indexes.json`; create `tests/f32-firestore-indexes.test.ts`.

- [ ] **Step 1: test (RED):** `firebase-tools`' `validateIndex` and `validateField` accept every entry; every manifest TTL has a `ttl: true` override with the three default indexes; `firebase.json` names `asia-south1` and `nodejs22`.
- [ ] **Step 2: edit the two files; run the test and the gate.**
- [ ] **Step 3: commit.**

### Task 7: Bundle tier, preflight, runbook, CI

**Files:** create `functions/scripts/dump-endpoints.cjs`, `scripts/deploy-preflight.sh`, `docs/deploy/RELEASE_RUNBOOK.md`; modify `ci_gates/gate_g0.sh`, `.github/workflows/gate-g0.yml`, `package.json`, `functions/package.json`, docs READMEs.

- [ ] **Step 1: tests (RED):** `compare_endpoints` fails on a wrong region, a wrong cap, a missing export, an extra export and a wrong ingress; the runbook-order check fails when `firebase deploy` precedes the preflight.
- [ ] **Step 2: implement; run `bash scripts/deploy-preflight.sh --profile staging --env-file <printed>` on this tree.**
- [ ] **Step 3: wire G-0 [20] and the CI steps; run `BASE=origin/main bash ci_gates/gate_g0.sh`.**
- [ ] **Step 4: commit.**

### Task 8: The Functions emulator end to end

**Files:** create `functions/test/f32-deploy-contract.e2e.test.ts`, `functions/scripts/f32-e2e.sh` if the test needs a launcher; modify `functions/vitest.config.ts`, `functions/package.json`.

- [ ] **Step 1: test (RED on main):** unsafe combination: the emulator serves nothing and logs `deploy.contract_violation`; safe combination: `/health` 200 with the contract, `api` 401.
- [ ] **Step 2: run on main's bundle (a `git archive` export) for the RED, on this tree for the GREEN.**
- [ ] **Step 3: commit.**

### Task 9: Verify, mutate, report

- [ ] Whole functions suites touched, deploy, p2.boot, p5.identity, health, http; typecheck; `eslint --max-warnings 0 functions`; root typecheck and lint if touched; G-0, G-1, G-2, the new gate; gitleaks; the claim gate on the PR body.
- [ ] At least ten mutants over the gate, the start-up condition and health; record which tests kill each.
- [ ] Open the draft PR with the body at the path the brief fixes.

## RED/GREEN ledger

Filled in as the tasks run (evidence log: the scratchpad `evidence-f32.txt`).

| Task | Test | RED (main or pre-change) | GREEN |
| --- | --- | --- | --- |
| 1 | `deploy-contract.test.ts` | pending | pending |
| 2 | `runtime-options.test.ts` | pending | pending |
| 3 | `health.test.ts` | pending | pending |
| 4 | `test_check_deploy_contract.py` | pending | pending |
| 5 | renderer and validator tests | pending | pending |
| 6 | `f32-firestore-indexes.test.ts` | pending | pending |
| 7 | bundle tier, runbook order | pending | pending |
| 8 | `f32-deploy-contract.e2e.test.ts` | pending | pending |
