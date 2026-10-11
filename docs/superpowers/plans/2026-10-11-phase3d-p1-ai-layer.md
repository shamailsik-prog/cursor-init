# Phase 3d: P1 AI layer core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** P1 runs in Cloud Functions as the single AI chokepoint. It logs the cost of every call, enforces a monthly firm budget with alerts at 70% and 90%, honours firm and platform kill switches, and exports one masked Opik trace per decision. `committeeBrain` and the four governance routes are served on the HTTP `api`.

**Architecture:**
- `functions/src/p1/` holds pure building blocks: the cost table, the PKT month, UUIDv7, the Gateway transport and the Opik exporter.
- One pipeline, `callP1` (`gateway.ts`), decides, calls, traces, and writes one transaction per decision.
- The HTTP operations (`ops.ts`) sit on the existing router, `CallAudit` and `requirePermission`.
- The mask and the §4.6 provider policy are reused from `platform/p1` through the `@/` alias.

**Tech Stack:** TypeScript Cloud Functions (`functions/`), Firestore Admin SDK, Node `fetch`, vitest (unit, plus the Auth and Firestore emulators).

**Spec:** `docs/superpowers/specs/2026-10-11-phase3d-p1-ai-layer-design.md` (rulings P3-60 to P3-73, E-48, E-49, O-53 to O-57; O-58 opened in the final-review fix round).

## Global Constraints

- **Routes.** Under `/api/platform/brain/`: `committeeBrain` (POST, kind `p1`), `getAiUsage` (GET), `setBudgetAlerts` (POST), `setAiKillSwitch` (POST) and `setPlatformAiKillSwitch` (POST, firmless, `platformAdmin` claim). Every route except `committeeBrain` has kind `general`.
- **Task routing.** Task type `committee` goes to model `anthropic/claude-opus-5.5`, provider id `ai-gateway`.
- **Prices.** In nano-USD per token: input `4000`, output `20000`. Source "Vercel AI Gateway public model list, GET https://ai-gateway.vercel.sh/v1/models", fetched `2026-10-11`.
- **Cost arithmetic.** `max_tokens` is `4096`. Cost in micro-USD is `ceil((in*pin + out*pout)/1000)`. The token estimate is `ceil(utf8Bytes/3)`, of the masked body sent (input) and of the raw response (output; for the count only, final-review ruling R13).
- **Gateway transport.** URL `https://ai-gateway.vercel.sh/v1/chat/completions`, key env `AI_GATEWAY_API_KEY`, timeout `60_000` ms, `redirect: "error"` (a redirect is refused). A failure throws `P1TransportError` with a fixed code (`gateway_timeout`, `gateway_request_failed`, `gateway_status`, `gateway_not_json`, `gateway_no_text`) and a `billable` flag (final-review ruling R9). The transport and Opik test seams throw when `NODE_ENV === "production"`.
- **Opik.** URL `{OPIK_BASE_URL}/v1/private/traces/batch`. Export is enabled only with `OPIK_BASE_URL` set, `OPIK_SELF_HOSTED_CONFIRMED === "true"`, and a host that is not `comet.com` or `*.comet.com`. A plain-http base must name a loopback host (`localhost`, 127.0.0.0/8, `::1`), a private IPv4 literal (10/8, 172.16/12, 192.168/16) or a name ending in `.internal` or `.local`; anything else over plain http is `invalid_url`. The export sends `redirect: "error"` (a redirect is a failed export). The project is `OPIK_PROJECT_NAME`, default `sikander-p1`. Timeout `2000` ms. Trace ids are UUIDv7 (final-review ruling R11).
- **Block reasons.** These exact strings: `kill_switch_platform`, `kill_switch_firm`, `policy_denied`, `not_minimised`, `model_unpriced`, `budget_not_set`, `budget_exhausted`, `no_credentials`. The failed reason is `transport_error`.
- **Collections and docs.**
  - `ai_usage_logs/{auto}`
  - `ai_usage_months/{firmId}_{monthKey}`
  - `ai_budget_alerts/{firmId}_{monthKey}_{70|90}`
  - `ai_config/{firmId}`
  - doc `platform/p1`
  - All are server-only in `firestore.rules`.
- **Month and thresholds.** `monthKey` is `YYYY-MM` in Asia/Karachi (UTC+5, no DST). The thresholds are exactly 70 and 90.
- **Events and audit.**
  - Events: `ai.call.completed`, `ai.call.failed`, `ai.call.blocked` and `ai.budget.threshold_crossed`.
  - Audit actions: `ai.gateway.decision` (per P1 decision) and `ai.budget.threshold` (actor `system`). The HTTP operations' own actions are `ai.call`, `ai.usage.read`, `ai.budget.set`, `ai.kill_switch.set` and `ai.platform_kill_switch.set`.
- **Permission actions.** Add `ai.call` (matter-level; partner, associate, clerk), `ai.usage.read`, `ai.budget.set` and `ai.kill_switch.set` (partner).
- **Text handling.** No raw (unmasked) body, purpose or response text reaches the transport, a trace, a usage row, an event, an audit row or a log line. Provider error text is never returned or stored.
- **Tooling.** Functions lint must pass at zero warnings, and `npx tsc --noEmit -p functions` must be clean. Emulator tests run as `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- <files>"` from the repo root.
- **Existing tests.** Never weaken or skip an existing test. An existing assertion that pins the exact route list, the action list, the route count per domain or the rules collection list may be extended to include the new entries, and the commit says so.

## Review Focus

1. **Unmasked text leaking.**
   - A party name, a CNIC and a mobile number in `body` must reach none of the following raw: the fake transport, the Opik payload, the usage row, the event, the audit row, the `committee_outputs.outbound.body`, or any logger call.
   - The provider's response text, if it echoes a party name, must be masked before it is returned or stored.
2. **Budget race.**
   - Parallel calls that together cross 70% (and 90%) must create each alert exactly once.
   - The month total's `spentMicroUsd` must equal the sum of that month's rows.
3. **PKT month boundary.** A call at `2026-10-31T19:00:00Z` belongs to `2026-11`. A call at `2026-10-31T18:59:59Z` belongs to `2026-10`.
4. **Kill switch.**
   - A switch set between two calls must block the second.
   - The platform switch blocks a firm whose own switch is off.
   - `disabledModels` blocks only the named model.
5. **Bad transport results.** A timeout, a non-2xx, a 2xx with no `choices[0].message.content`, a 2xx that is not JSON, or a thrown fetch must each give outcome `failed`, reason `transport_error`, and no provider text stored, returned or logged. The charge follows whether the provider may have billed the request (final-review ruling R9):
   - cost 0 for a non-2xx and for a fetch that failed before any response (a refused connection, DNS, a refused redirect);
   - for a timeout, a 2xx that is not JSON and a 2xx without usable content, `costMicroUsd(model, reported input ?? estimateTokens(masked body), reported output ?? 4096)`, with `tokensEstimated: true` when either side was estimated; the month's spend and token totals move by it, and it counts toward `budget_exhausted`.
   A 2xx with content but no `usage` gives outcome `ok` with `tokensEstimated: true`.

---

### Task 1: P1 building blocks (P3-62, P3-67, P3-68)

**Files:**
- Create in `functions/src/p1/`: `types.ts`, `costTable.ts`, `month.ts`, `uuidv7.ts`, `transport.ts`, `opik.ts`
- Modify:
  - `ci_gates/check_fetch_allowlist.py` (add `functions/src/p1/` to `P1_PREFIXES`)
  - `ci_gates/gate_g0.sh` (provider-guard exclusion also allows `functions/src/p1`)
- Test: `functions/test/p1.units.test.ts`, `functions/test/p1.transport.test.ts`

**Interfaces (produces):**
- `types.ts`:
  - `type TaskType = "committee"`
  - `type BlockReason = "kill_switch_platform" | "kill_switch_firm" | "policy_denied" | "not_minimised" | "model_unpriced" | "budget_not_set" | "budget_exhausted" | "no_credentials"`
  - `type P1Outcome = "ok" | "failed" | "blocked"`
  - `const TRANSPORT_ERROR = "transport_error"`
- `costTable.ts`:
  - `TASK_MODEL: Readonly<Record<TaskType, string>>`
  - `MODEL_PRICES: Readonly<Record<string, { inputNanoUsdPerToken: number; outputNanoUsdPerToken: number; source: string; fetchedAt: string }>>`
  - `MAX_OUTPUT_TOKENS = 4096`
  - `costMicroUsd(model: string, inputTokens: number, outputTokens: number): number | null`, which returns null when the model is unpriced
  - `estimateTokens(text: string): number`
  - `PROVIDER_ID = "ai-gateway"`
- `month.ts`:
  - `monthKeyPkt(nowMs: number): string`
  - `isMonthKey(value: unknown): value is string`, which accepts `YYYY-MM` with months 01-12 only
- `uuidv7.ts`: `uuidv7(nowMs?: number): string`
- `transport.ts`:
  - `type P1Transport = { send(req: { model: string; body: string; maxTokens: number }): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> }`
  - `GATEWAY_URL`, `TRANSPORT_TIMEOUT_MS`
  - `gatewayTransport(apiKey: string, url?: string): P1Transport`
  - `activeTransport(): P1Transport | null`. It returns the test transport if one is set, else the gateway transport if `AI_GATEWAY_API_KEY` is non-empty, else null.
  - `setP1TransportForTests(t: P1Transport | null): void`
  - `send` throws on a non-2xx response, a timeout, or a missing `choices[0].message.content`.
- `opik.ts`:
  - `type OpikConfig = { enabled: true; baseUrl: string; project: string } | { enabled: false; reason: "unset" | "invalid_url" | "unconfirmed" | "third_party_host" }`, checked in that order; `invalid_url` covers an unparseable URL, a non-http(s) scheme, a query or fragment, and credentials (ruling R4)
  - `opikConfig(env?: NodeJS.ProcessEnv): OpikConfig`
  - `type TraceRecord = { traceId: string; startMs: number; endMs: number; taskType: string; classification: Classification; outcome: P1Outcome; blockReason: string | null; model: string; provider: string; inputTokens: number; outputTokens: number; costMicroUsd: number; firmId: string; matterId: string | null; usageLogId: string; maskedBody: string | null; maskedResponse: string | null }`
  - `buildTrace(r: TraceRecord, project: string): Record<string, unknown>`, with `input`/`output` only when the rank is 3 or less and the outcome is not `blocked`
  - `exportTrace(r: TraceRecord, cfg?: OpikConfig): Promise<"exported" | "failed" | "disabled">`
  - `setOpikFetchForTests(f: typeof fetch | null): void`

- [ ] **Step 1: Write failing unit tests** (`p1.units.test.ts`):
  - `TASK_MODEL.committee === "anthropic/claude-opus-5.5"`; the price row is `{4000, 20000}` with `fetchedAt: "2026-10-11"`.
  - `costMicroUsd("anthropic/claude-opus-5.5", 1000, 500) === 14000`.
  - `costMicroUsd(m, 1, 0) === 4` (`ceil(4000/1000)`).
  - `costMicroUsd(m, 0, 0) === 0`; `costMicroUsd("x/unknown", 1, 1) === null`.
  - `estimateTokens("abc") === 1`; `estimateTokens("abcd") === 2`; `estimateTokens("") === 0`; `estimateTokens("ک") === 1` (2 bytes).
  - `monthKeyPkt(Date.parse("2026-10-31T19:00:00Z")) === "2026-11"` and `monthKeyPkt(Date.parse("2026-10-31T18:59:59Z")) === "2026-10"`.
  - `isMonthKey` accepts `"2026-01"` and rejects `"2026-13"`, `"2026-1"` and `"x"`.
  - `uuidv7(t)` matches `/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`, and its first 12 hex digits are `t` in hex.
  - `opikConfig({})` gives `{enabled:false, reason:"unset"}`.
  - `opikConfig({OPIK_BASE_URL:"http://opik.internal/api"})` gives `"unconfirmed"`.
  - With confirmation, `https://www.comet.com/opik/api` and `https://comet.com/x` give `"third_party_host"`, while `https://notcomet.com/api` is enabled with project `sikander-p1`.
  - `buildTrace` at rank 4, and for a blocked call, has no `input` or `output` keys. At rank 2, `input` holds the masked body. `metadata.classification` is set in every case.
- [ ] **Step 2: Write failing transport tests** (`p1.transport.test.ts`), against a local `node:http` server on port 0:
  - The request is POST with `authorization: Bearer k`, a JSON body `{model, messages:[{role:"user",content}], max_tokens:4096}`.
  - A 200 `{choices:[{message:{content:"hi"}}], usage:{prompt_tokens:7, completion_tokens:3}}` gives `{text:"hi", inputTokens:7, outputTokens:3}`.
  - A 200 with no `usage` gives null tokens.
  - A 500, a 200 with `{choices:[]}`, and a server that never answers (with `TRANSPORT_TIMEOUT_MS` lowered through a test-only option) each reject.
  - `activeTransport()` is null when there is no key and no seam.
  - `exportTrace` posts `{traces:[…]}` to `/v1/private/traces/batch` and returns `"exported"` on 204, `"failed"` on 500 or a hang past 2 s, and `"disabled"` when the config is disabled.
- [ ] **Step 3: Run them and see them fail.** `npm --prefix functions test -- p1.units p1.transport` should report module-not-found failures.
- [ ] **Step 4: Implement the six modules.** `fetch` gets `AbortSignal.timeout`. The `opik.ts` payload is `{ id, project_name, name: "p1." + taskType, start_time, end_time, input?, output?, metadata, tags: [classification, outcome] }` with ISO times. `error_info` is `{ exception_type: "transport_error", traceback: "" }` on failed calls.
- [ ] **Step 5: Run the tests and see them pass.** Then run typecheck, lint, `python3 ci_gates/check_fetch_allowlist.py` and `bash ci_gates/gate_g0.sh`.
- [ ] **Step 6: Commit.** `feat(p1): cost table, PKT month, UUIDv7, Gateway transport and self-hosted Opik exporter in Cloud Functions (P3-62, P3-67, P3-68)`

### Task 2: `callP1` — decide, call, trace, record (P3-61, P3-63..P3-66, P3-69)

**Files:**
- Create: `functions/src/p1/gateway.ts`, `functions/src/p1/config.ts`
- Test: `functions/test/p1.gateway.emu.test.ts`

**Interfaces:**
- Consumes: everything from Task 1. Also `maskOutboundPII` (`@/platform/p1/maskOutboundPII`), `providerAllowedFor`, `assertMinimised` and `setProviderConfigForTests` (`@/platform/p1/providerPolicy`), `isClassification` and `classificationRank` (`@/platform/p1/types`), and `stageAudit` (`functions/src/p5/audit.ts`).
- Produces in `config.ts`:
  - `type KillSwitch = { disableAll: boolean; disabledModels: string[]; reason: string; setBy: string; setAt: unknown }`
  - `type FirmAiConfig = { monthlyBudgetMicroUsd?: number; pkrPerUsd?: number; killSwitch?: KillSwitch }`
  - `firmConfigRef(firmId)`, `platformConfigRef()` (the doc `platform/p1`), `monthRef(firmId, monthKey)`, `alertRef(firmId, monthKey, threshold: 70 | 90)`
  - `THRESHOLDS = [70, 90] as const`
- Produces in `gateway.ts`:
  - `type P1Request = { firmId: string; actorId: string; matterId: string | null; jobId: string | null; taskType: TaskType; classification: Classification; body: string; purpose: string; partyNames?: string[] }`
  - `type P1Result = { outcome: P1Outcome; blockReason: BlockReason | null; text?: string; usageLogId: string; traceId: string; model: string; classification: Classification; inputTokens: number; outputTokens: number; costMicroUsd: number; outbound: { body: string; purpose: string; redactionCounts: Record<string, number> } }`
  - `callP1(req: P1Request, opts?: { now?: () => number }): Promise<P1Result>`, which throws `Error("P1 call omitted classification")` on a missing or unknown label
  - `p1TestSeam: { beforeCommit?: () => Promise<void>; failCommit?: boolean }`

**Month total doc:** `{ firmId, monthKey, spentMicroUsd, inputTokens, outputTokens, calls: { ok, failed, blocked }, updatedAt }`. Each call updates it with `FieldValue.increment` in the decision's transaction. The transaction reads the month doc and `ai_config` to decide threshold crossings (`before*100 < t*budget <= after*100`). A blocked or failed call increments only `calls`.

- [ ] **Step 1: Write failing emulator tests.** Use a fake `P1Transport` that records what it received and returns `{text, inputTokens, outputTokens}`. Seed `ai_config/{firm}` with a budget. Cover the following.
  - **Happy path.**
    - The outcome is `ok` and the text is masked.
    - The row has every P3-63 field, with `costMicroUsd` from the table and `monthKey` from `now`.
    - The month total is incremented.
    - The event is `ai.call.completed` with `{traceId, task:"committee", model, classification, costMicroUsd}`.
    - There is one audit row: `ai.gateway.decision`, `allow`, `ok`.
    - `trace.status` is `"disabled"` when there is no Opik config.
  - **Masking.** The body contains a party name, CNIC `35202-1234567-1` and `0300-1234567`. The fake transport, the stored row, the event and the audit reason contain none of them. A fake response that echoes the party name is returned masked. When the Opik seam is enabled, the captured trace body is masked.
  - **Each refusal**, with no transport call, a row with outcome `blocked` and that `blockReason`, an `ai.call.blocked` event and a `deny` audit row:
    - the platform switch with `disableAll`;
    - the firm switch with `disableAll`;
    - the firm switch with `disabledModels` naming the routed model (a different model name does not block);
    - `confidential` with no DPA (`policy_denied`);
    - `model_unpriced` (via a seam that routes to an unpriced model id);
    - no budget (`budget_not_set`);
    - spend at or over budget (`budget_exhausted`);
    - no transport (`no_credentials`).
  - **Order.** The platform switch outranks policy. Policy outranks the budget.
  - **Classification guard.** A missing or unknown classification throws, and nothing is written.
  - **Transport failures.** A rejecting transport gives `failed` and `transport_error`, cost 0, an `ai.call.failed` event, and nothing from the error message stored.
  - **Usage absent.** The transport returns null tokens. The result is `ok` with `tokensEstimated: true`, and the cost is computed from `estimateTokens`.
  - **PKR.** With `pkrPerUsd: 280`, a call costing 14000 micro-USD stores `fxPkrPerUsd: 280` and `costPkr: 3.92`. Without a rate, both are null.
  - **Alerts.**
    - Budget 100000 micro-USD. Calls take the total from 60000 to 75000: one 70 alert doc, one `ai.budget.threshold` audit row (actor `system`) and one `ai.budget.threshold_crossed` event.
    - A further call to 95000 creates the 90 doc.
    - A single call from 60000 to 95000 creates both.
    - Ten parallel calls crossing 70% create exactly one 70 doc. The total's `spentMicroUsd` equals the sum of the rows.
  - **Commit failure.** With `p1TestSeam.failCommit`, the transport succeeded and `callP1` still resolves with the text. A `p1.usage_log_failed` log is emitted (spy on the logger).
  - **G-1 forensic 7 equivalent.** A `privileged` call with no DPA gives `ai.call.blocked`. With the Opik seam enabled, the exported trace metadata has `classification: "privileged"` and no input or output.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement `config.ts` and `gateway.ts`** in the P3-61 order. Read both kill switches and `ai_config` fresh on each call, outside the transaction. Trace before the transaction, then commit the row, total, alerts, audit and event in one `runTransaction`. Log the threshold warnings after commit.
- [ ] **Step 4: Run** `p1.*` plus `p2.registry-*` (the registry recorder must stay green), then typecheck and lint.
- [ ] **Step 5: Commit.** `feat(p1): callP1 — kill switch, policy, budget, cost log, 70/90 alerts, events, audit and trace per decision (P3-61, P3-63..P3-66, P3-69)`

### Task 3: HTTP routes, permissions and rules (P3-60, P3-66, P3-70..P3-72)

**Files:**
- Create: `functions/src/p1/ops.ts`
- Modify:
  - `platform/p5/permissionDecision.ts` (AI actions)
  - `functions/src/p5/permission.ts` (`requirePermission` accepts `AiAction`)
  - `functions/src/http/router.ts` (`PLATFORM_BRAIN` and the five routes)
  - `firestore.rules`
  - `package.json` (`test:rules` adds the new rules test)
  - `functions/test/g2.cross-firm.test.ts`
  - any existing test pinning route or action lists (extend only)
- Test:
  - `functions/test/p1.api.emu.test.ts`
  - `tests/firestore.rules.p1-phase3d.test.ts`
  - extend the permission table tests (`tests/` or `functions/test/p5.permission.test.ts`, wherever the table is pinned)

**Interfaces:**
- Consumes: `callP1` and `P1Result` (Task 2); `firmConfigRef`, `platformConfigRef`, `monthRef`, `alertRef` and `monthKeyPkt` (Tasks 1-2).
- Produces:
  - `AI_ACTIONS` / `AiAction` / `isAiAction` in `permissionDecision.ts`. Roles: `ai.call` goes to `["partner","associate","clerk"]` and is matter-level; `ai.usage.read`, `ai.budget.set` and `ai.kill_switch.set` go to `["partner"]`.
  - `committeeBrainOp`, `getAiUsageOp`, `setBudgetAlertsOp`, `setAiKillSwitchOp` (all `FirmOperation`) and `setPlatformAiKillSwitchOp` (`FirmlessOperation`; 403 `platform_admin_only` without the claim).

- [ ] **Step 1: Write failing API tests** through `viaApi`:
  - **`committeeBrain`, input checks.**
    - `matterId` missing gives 400 `matter_required`; `body` missing, empty or over 100,000 characters gives 400 `invalid_body`.
    - A `purpose` outside `["committee-brain","summarise","research","translate","ops-audit"]` gives 400 `invalid_purpose`; a classification that is not a label gives 400 `invalid_classification`.
    - `documentIds` present gives 400 `documents_not_supported`; `partyNames` with more than 50 entries or a non-string gives 400 `invalid_party_names`.
  - **`committeeBrain`, access.** An intern or a non-member is refused (403 through `requirePermission`). Clearance below the derived classification gives 403 `clearance`.
  - **`committeeBrain`, classification.**
    - An `internal` matter with no label goes to `internal`.
    - A `public` matter is floored to `internal`.
    - A caller label `confidential` on an `internal` matter raises it to `confidential`, which is then blocked `policy_denied` with no DPA.
    - A caller label `public` never lowers it.
  - **`committeeBrain`, masking.** A `matter_parties` name in `body` is masked in what the fake transport receives.
  - **`committeeBrain`, output.**
    - The output row in `committee_outputs` has `firmId`, `actorId`, `matterId`, `classification`, `purpose`, `blocked`, `reason?`, `text?`, `outbound.body` (masked), `usageLogId`, `traceId` and `createdAt`.
    - The response shape matches P3-70.
    - Replaying the same `Idempotency-Key` makes no second transport call and writes no second usage row.
  - **`setBudgetAlerts`.**
    - Partner only.
    - Rejects `monthlyBudgetUsd` that is 0, -1, 1000000.01 or 1.001, and `pkrPerUsd` that is 0 or 10001.
    - Stores `monthlyBudgetMicroUsd: 1500000` for `1.5`.
    - Audited.
  - **`setAiKillSwitch`.**
    - Partner only.
    - The reason must be 1-500 characters (`invalid_reason`), and `disabledModels` must be an array of at most 20 non-empty strings.
    - A request replaces the whole state; `{disableAll:false, disabledModels:[]}` re-enables, and the next `committeeBrain` call goes through.
  - **`setPlatformAiKillSwitch`.**
    - A caller without `platformAdmin` gets 403 `platform_admin_only`.
    - With the claim it is stored at `platform/p1`, and every firm's next call is blocked with `kill_switch_platform`.
  - **`getAiUsage`.**
    - Partner only.
    - `month` invalid gives 400 `invalid_month`. The default month is the current PKT month.
    - It returns `{ month, budgetMicroUsd, spentMicroUsd, spentPkr, pkrPerUsd, percentUsed, calls:{ok,failed,blocked}, inputTokens, outputTokens, alerts:[{threshold, at}], killSwitch:{ firm, platform } }`. A month with no calls returns zeros.
  - **Firestore rules** (`tests/firestore.rules.p1-phase3d.test.ts`): a signed-in partner of the same firm can neither read nor write `ai_usage_logs`, `ai_usage_months`, `ai_budget_alerts`, `ai_config` or `platform/p1`.
  - **G-2.** The four firm routes are probed cross-firm and denied. `setPlatformAiKillSwitch` is listed where the firmless `recordGatePass` is.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement** the actions, the operations, the routes and the rules. `committeeBrain` reads the matter (404 `not_found` if absent or cross-firm, as `getMatter` does) and its `matter_parties` rows (`firmId`, `matterId`), calls `callP1`, then writes the `committee_outputs` row.
- [ ] **Step 4: Run** `p1.*`, `g2.cross-firm`, `p5.*` and `http.test`, plus `npm run test:rules` and `npm run test:unit` (repo root, for the permission table), typecheck and lint.
- [ ] **Step 5: Commit.** `feat(p1): /api/platform/brain routes — committeeBrain, getAiUsage, setBudgetAlerts, firm and platform kill switches (P3-60, P3-66, P3-70..P3-72)`

### Task 4: Gate, CI and records (P3-73, E-48, E-49, O-53..O-57)

**Files:**
- Create:
  - `ci_gates/gate_g4_phase3d.sh`
  - `functions/src/p1/README.md` (pipeline order, env vars, collections, and what is out of scope)
- Modify:
  - `package.json` (`gate:g4:phase3d`)
  - `.github/workflows/gate-g0.yml` (step after Phase 3c)
  - `ci_gates/check_route_coverage.py`, if it pins per-domain counts (add `/api/platform/brain` with 5)
  - `docs/architecture/ERRATUM_SET_2_PROPOSED.md`:
    - E-48 and E-49;
    - O-13 closed with this PR's ruling reference; address masking stays recorded;
    - O-35 narrowed;
    - O-53 to O-57.
  - `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md` (Phase 3d rulings P3-60 to P3-73)

- [ ] **Step 1: Write the gate script**, modelled on `ci_gates/gate_g4_phase3c.sh`:
  - route coverage;
  - named tests by exact full name, with the count derived from the arrays: at least the happy path, the masking test, every refusal, the alerts-exactly-once parallel test, the G-1 forensic 7 equivalent, the kill-switch replacement test, and the platform kill switch test;
  - functions lint;
  - `ci_gates/gate_g2.sh`;
  - the same emulator configuration.
- [ ] **Step 2: Run** `npm run gate:g4:phase3d` locally. It must pass.
- [ ] **Step 3: Add the CI step and the records.**
- [ ] **Step 4: Run the full functions emulator suite once.** Then run `npm run gate:g0`, `npm run lint`, `npm run typecheck` and `npm run test:unit`.
- [ ] **Step 5: Commit.** `ci: gate:g4:phase3d in CI; record Phase 3d rulings and errata (E-48, E-49, O-13 closed, O-53..O-57)`
