# F18: the legacy Next/eve AI path closed (design)

Audit finding F18 (HIGH, `docs/audit/2026-10-13-forensic-audit.md`; v2 row `docs/audit/2026-10-14-forensic-audit-v2.md:91`):
"Legacy AI entry points bypass Functions budget and kill switches." `callCommitteeBrain` (platform/p1/internalAICaller.ts)
masks and applies provider policy, then sends through `platform/p1/gatewayTransport.ts` (`createGateway` + `generateText`
from the `ai` SDK) whenever `AI_GATEWAY_API_KEY` or `VERCEL_AI_GATEWAY_API_KEY` is set. That path writes no cost row,
checks no budget and reads no kill switch. Only an operating rule in `functions/src/p1/README.md` keeps the keys off the
Next service. The failure: one secret injected into the Next or eve runtime turns on paid calls outside the control plane.

The owner authorised every decision (standing autonomy instruction). The rulings below record each one and why.

## Observed (main 957fe26)

Entry points that reach `callCommitteeBrain`:

| Entry point | Caller identity | Paid path on main |
| --- | --- | --- |
| `POST /api/p1/committee-brain` (app/api/p1/committee-brain/route.ts) | Firebase session (production) or insecure-dev (local/tests only) | `gatewayTransport` when a key is set |
| eve bridge `committeeBrainLanguageModel` (platform/p1/committeeBrainModel.ts, used by agent/agent.ts) | none (no firm, no matter) | same |
| `requestTranslation` (platform/p1/translate.ts; test callers only) | none | same |

The canonical authenticated P1 entry point exists: Cloud Functions `POST /api/platform/brain/committeeBrain`
(functions/src/p1/ops.ts `committeeBrainOp`; ID token verified and bound to the firm, `ai.call` on the matter, kill
switches, budget reservation, cost log, 70/90 alerts, F09 idempotency, F15 mask, F16 roles, F17 grounding). The web
console already calls it directly (F02, lib/console/console-functions-dispatch.ts).

FA-D3C-002 (direct OpenAI calls outside P1) is `corpus_service/scraper/tasks/embeddings.py`, the embedding worker. It is
not in the Next or platform code this change touches. It stays out of this lane: the F27 builder owns `corpus_service/**`.

## Rulings

**R1. Route the Next committee route through the canonical endpoint.** In a Firebase session, when a Functions base URL is
configured, `POST /api/p1/committee-brain` forwards the request to `POST /api/platform/brain/committeeBrain` with the
caller's own `Authorization` header (the ID token the Next session already verified), the session's firm as `X-Firm-Id`
and the same `Idempotency-Key`. Next runs no P1 itself on that path and writes no `committee_outputs` row: Functions
writes it in the Next shape, and the route's GET already lists it. Why: the brief says to route through an existing
canonical endpoint, and it already runs the whole control plane. A second budget or kill-switch implementation in Next
would duplicate F07, F08 and F09 and could drift from them.

**R1, review round 1 (PR #88, Cursor Bugbot, thread 4307502869).** The route exports a static `maxDuration = 130`. It sits
above FORWARD_TIMEOUT_MS (125 s), so the platform never kills the request before the forward's own deadline. Without it,
the request could be killed with no 504, no `p1.next_forward_failed` line, and a Next key left in progress. The value is
Bugbot Autofix's commit 1d46d03, reviewed and kept. It follows the documents route's pattern.

Deadline order: Functions `api` timeout 120 s < FORWARD_TIMEOUT_MS 125 s < `maxDuration` 130 s <= 300 s.
- 300 s is the smallest Vercel plan's maximum: Hobby with Fluid compute (vercel.com/docs/functions/configuring-functions/
  duration, read 2026-10-18). Pro and Enterprise allow 800 s.
- This repo declares no Next deploy target (audit F32).
- A legacy non-Fluid Vercel project, or a Cloud Run or App Hosting service timeout, is outside `maxDuration`: keep it at or
  above 130 s at deploy [REQUIRES VERIFICATION].

Functions normally stops first, because its handler fits 115 s of its 120 s. A Functions answer can still land after
Next's 125 s, after a cold start or slow network before Functions starts its own clock. Then:
- Next answers 504 `p1_functions_timeout` with the alert and releases its own claim.
- Functions finishes, pays once, and stores its output row and its answer under the same Idempotency-Key (F09).
- A same-key retry gets that stored answer, and the provider is not called again (e2e row (k)).
- If the caller never retries, the call stays booked and its row is listed by the GET.

Pinned by `tests/f18-functions-forward.test.ts` (`maxDuration` * 1000 > FORWARD_TIMEOUT_MS, at most 300, a literal) and the
e2e (120 s < 125 s, row (k)).

**R2. Delete the Next provider transport.** `platform/p1/gatewayTransport.ts` and `readGatewayApiKey` are removed.
`callCommitteeBrain` keeps its size bound, system-message check, provider policy and minimisation, but has no provider
transport. Outside tests every call it makes is blocked `PHASE0_NO_CREDENTIALS`. That reason is kept, not renamed,
because it is persisted on committee rows and it stays true: the Next runtime holds no provider credential path. Why: a
transport that is off by configuration is one secret away from live, which is the F18 failure. No environment variable
can turn on code that does not exist.

**R3. Callers without an identity stay on the unpaid local pipeline.** The eve bridge and `requestTranslation` have no
signed-in caller, firm or matter. Functions cannot budget or authorise them, so they cannot be forwarded. They keep the
local mask and policy and are blocked. The route in insecure-dev mode also stays local: that mode is local-only (refused in
production and on hosted runtimes) and has no ID token to forward. Reaching Functions from eve needs a caller's token and
a matter, which is a follow-up.

**R4. When no Functions URL is configured, the route records a blocked row.** In a Firebase session with no Functions
base URL configured, the route uses the local pipeline: 200 with `blocked: true, reason: PHASE0_NO_CREDENTIALS` and a stored
row. That was the documented production behaviour on main without a key. In production it also logs the alert line
`[p1] ALERT p1.next_functions_not_configured`. Why not 503: the route's contract for "no paid path available" is a blocked
row. The disable-every-layer boot test holds every core route to answering without a 5xx.

When a URL is configured but Functions does not answer, the route does not fall back. An unreachable host or a failed fetch
answers 503 `p1_functions_unavailable`, a timeout answers 504 `p1_functions_timeout`, and a 2xx that is not a committee
answer gets 502 `p1_functions_bad_answer`. Each logs an alert line and releases the Next claim. Functions may already have
acted, so a local row could duplicate one. A same-key retry reaches Functions again, and Functions replays or resumes the
request without dispatching twice (F09).

**R5. A provider key in the runtime refuses in production.** The names are in `PROVIDER_KEY_ENV_NAMES`
(platform/p1/providerKeyGuard.ts): the AI Gateway pair and the provider keys the AI SDK and common provider SDKs read.
If any of them is non-blank in the Next or eve environment under `NODE_ENV=production`:
- every `callCommitteeBrain` call is blocked with `PROVIDER_KEY_IN_RUNTIME_REASON`;
- the route does not forward, and records that blocked row through the local pipeline;
- the alert line `[p1] ALERT p1.provider_key_in_next_runtime { runtime, keys }` is logged, naming the variables and never
  their values;
- eve refuses to start: agent/agent.ts throws at load. eve's framework has its own model calls outside
  `callCommitteeBrain`: its default agent, and self-modification in `eve dev`. They read the Gateway key from the
  environment directly, so only refusing to start covers them.

Outside production the alert line is logged and nothing is refused, because no paid path exists there to refuse.

*Amended by the re-audit follow-up (R5-FU below, FA-F18-005): "production" now means every `NODE_ENV` other than exactly
`development` or `test`, unset included.*

**R5, review round 1 (PR #88, Codex P2, thread 4307495841).** The key check now runs first on every path through P1 in this
runtime, so its alert line is logged whatever the input. It runs as the first statement of `callCommitteeBrain`, before:
- the missing-classification throw;
- `buildOutbound`'s input throws;
- the 900 KiB storage bound.

The eve bridge's two refusals before `callCommitteeBrain` run it too: no classification in `providerOptions`, and a part P1
cannot carry. Each path logs the alert once, not twice.

On 72ff10f the storage bound returned first, so an oversized request in production with a key was reported only as
`stored_outbound_too_large` and logged no alert. The route's 400/403/404 answers are request validation and authorisation,
before any AI call; they are not P1 paths, and the next request that reaches P1 logs the alert.

Which reason the row carries when both hold: the key reason (`PROVIDER_KEY_IN_RUNTIME_REASON`), in the storage-safe shape
(no body, no messages). Why: the key refusal holds for every call this runtime could make, whatever its size, while the size
reason would tell an operator that a smaller request would go through. The throws stay throws: they are caller contract
errors with no row, and the alert has already been logged. The test
runner and the live evaluation suites keep working with a key in the shell. Next gets no start-up hook (Next 16
instrumentation would be a new surface). The gate (R9) proves no other Next code can use a key, so refusing each call is
enough.

**R6. Next marks no effect before forwarding.** The Functions route's Idempotency-Key fence (F09) is the fence for the paid
effect. If Next marked `p1_dispatch` on its own claim, a same-key retry after a lost answer would stop at Next with 409
`idempotency_effect_committed` and never reach Functions, so it could never replay or resume there. Next makes no
Firestore write on the forward path.

**R7. What is forwarded and what comes back.** Next keeps its pre-checks: actor, matter scope, document scope, clearance
and the H1/N1 classification. It then forwards:
- `matterId` and `body`;
- `purpose`;
- `classification`: the strictest of the matter, the documents, the caller's label and the `internal` floor. Functions
  takes the strictest of its own matter label, the floor and this, so the result is never lower;
- `partyNames`: Next's scope names and the caller's, trimmed, non-empty and de-duplicated.

`documentIds` are not forwarded. Functions refuses them (`documents_not_supported`), and their one effect, the label, travels
in `classification`.

The 2xx answer is Functions' own body (`outputId`, `blocked`, `reason`, `text`, `classification`, `usage`, `traceId`,
`accounting`, `grounding`, `advisory`, `model`, `modelReported`, `modelMatch`) plus `agent: "sikander-ai"`, wrapped as before
in `{ result, idempotencyKey, reused }`. `outbound` is no longer echoed in the HTTP answer; it is on the stored row, which
the GET returns. A Functions non-2xx is relayed with its status as `{ error: code, code }`, with `Retry-After` when present.

**R8. Base URL rules.** The base URL is `SIKANDER_FUNCTIONS_API_BASE_URL`, else `NEXT_PUBLIC_SIKANDER_FUNCTIONS_API_BASE_URL`
(the console's), else the Functions emulator host, which is never used under `NODE_ENV=production` (the F01 precedent for
emulator hosts). The URL must be `https:`, or `http:` to a loopback host only, with no credentials, query or fragment.
Anything else counts as not configured. The forward refuses redirects (`redirect: "error"`), so the bearer token goes only
to the configured host. It times out at 125 s: the `api` function's 120 s plus 5 s.

**R9. A new G-0 gate, [19] `ci_gates/check_next_ai_egress.py`.** It scans every file the G-0 walker scans, except
`functions/` (the control plane, governed by [3]) and `corpus_service/` (the F27 lane; FA-D3C-002 is allowlisted under
[3]). It fails on any of:
- (a) JS/TS importing `ai`, any `@ai-sdk/*` other than `@ai-sdk/provider` (types and error classes, no network code), or
  any provider SDK on [3]'s list or the extra list in the gate;
- (b) JS/TS naming a provider key variable, outside `platform/p1/providerKeyGuard.ts`;
- (c) JS/TS naming a provider API host;
- (d) a deploy surface (`.env*`, `*.env`, `apphosting*.y*ml`, `vercel.json`, Dockerfiles, compose files, `fly.toml`,
  `netlify.toml`, `app.yaml`, `cloudbuild*.y*ml`, `render.yaml`, `.github/workflows/*.y*ml`) binding a provider key: an
  `=` or `:` assignment (a commented template line counts), `secrets.NAME`, or `ENV`/`ARG NAME`.

**R9a (refined at GREEN).** A GitHub workflow is a deploy surface only for jobs that build, start or deploy the Next or
eve service (`next build|start|dev`, a root `npm run build|start|dev`, `eve dev|start|build|deploy`, `vercel`,
`firebase deploy`, `apphosting`, or a hosting or Cloud Run deploy action), plus the workflow-level `env` above such a job.
The first run of the gate on this repository flagged `legal-os-continue.yml` and `legal-os-watchdog.yml`. Those
workflows hand `ANTHROPIC_API_KEY` to `anthropics/claude-code-action`, the coding agent that opens remediation PRs. That
is CI tooling, not the product runtime, and its spend is not committee work. Why not an allowlist: the rule should say
what a Next deploy is, so a new tooling workflow does not need an entry and a new Next deploy job is caught. Residual: a
job that deploys through a command or action outside that list passes [19] (text analysis).

The gate has no allowlist. It runs in `gate_g0.sh`, which the Gates job of `.github/workflows/gate-g0.yml` runs. G-0 [3] is
unchanged: it still lists which trees may hold a provider SDK at all; [19] is stricter for the Next and eve runtime.
`--print-key-names` prints the gate's key list, and a test holds it equal to the TypeScript guard's list.

*Amended by the re-audit follow-up (R9-FU and R13 below, FA-F18-001a, FA-F18-002): [19] also forbids any JS/TS outside
`functions/` to import the Functions tree, with one allowlist (root test files only, never the transport or the gateway);
reads workflows at any indentation; covers `.envrc`, string `model:` values under `agent/`, symlinked directories and five
more provider SDKs; and its residuals are listed in R9-FU.*

**R10. The secrets template.** `.env.example` no longer offers `AI_GATEWAY_API_KEY=` / `VERCEL_AI_GATEWAY_API_KEY=` as an
"optional P1 live path". It says the Next and eve runtime must hold no provider key, and that the key belongs only to the
Cloud Functions `api` function.

**R11. What stays.** `COMMITTEE_BRAIN_GATEWAY_MODEL` stays: it is eve's model id and an input to G-0 [17].
`agent/instructions.md` is unchanged, because changing it re-pins the F16 digest; its line "Public may leave once a Gateway
key exists" is now stale and is a follow-up. Existing tests of masking, scope and idempotency on the Next route run in
insecure-dev with a test transport. They still exercise the local pipeline the route keeps for that mode.

**R12. Tests changed because their subject changed.**
- `tests/f16-next-transport.test.ts` tested the deleted transport. It now proves the Next tree has no provider transport.
- `tests/p1.eve-committee-brain.test.ts` read `readGatewayApiKey`. It now reads the guard.
- `tests/g0-gate-e2e.test.ts` planted a provider import under `platform/p1/` as legitimate. It is not legitimate any more
  under [19], so the plant moves to the [19] failure cases.
- The F16 live block (`tests/f16-injection-structure.test.ts`, run only with a key) sent through the deleted Next transport.
  It now sends the bridge's messages through the Functions P1 transport, the only one that can serve a call.

## Design

```
POST /api/p1/committee-brain (Next)
  withSession ─▶ Idempotency-Key claim ─▶ actor, scope, clearance (unchanged)
  ├─ Firebase session, Functions URL valid, no provider key in production
  │     └─▶ forwardCommitteeBrain (platform/p1/functionsCommitteeBrain.ts)
  │           POST {base}/api/platform/brain/committeeBrain   Bearer + X-Firm-Id + Idempotency-Key
  │           2xx committee answer ─▶ claim.complete, 200 { result: {...functions body, agent}, ... }
  │           non-2xx ─▶ relayed status { error: code, code }        (claim released)
  │           unreachable / timeout / bad answer ─▶ 503 / 504 / 502 + alert line (claim released)
  └─ otherwise (insecure-dev, no URL, or key present in production)
        └─▶ callCommitteeBrain (local, unpaid) ─▶ blocked row, 200 (as on main without a key)

callCommitteeBrain (eve bridge, translate, local route path)
  classification ─▶ size bound ─▶ provider-key guard ─▶ system check ─▶ policy ─▶ minimisation
  ─▶ transport: the test seam (non-production only) or none ─▶ blocked PHASE0_NO_CREDENTIALS
```

Units:
- `platform/p1/providerKeyGuard.ts`: the key names, `providerKeysPresent(env)`, `providerKeyRefusal(env)` (refuses in production,
  alerts always), `assertNoProviderKeyAtStartup(runtime, env)`, the alert line. It is the only runtime file that names a
  provider key.
- `platform/p1/functionsCommitteeBrain.ts`: `functionsP1BaseUrl(env)` and `forwardCommitteeBrain(input, deps)`. It is the
  only Next code that sends committee work anywhere, and only to our own Functions API.
- `platform/p1/internalAICaller.ts`: no gateway transport, plus the key guard.
- `app/api/p1/committee-brain/route.ts`: the dispatch choice and the forward mapping.
- `agent/agent.ts`: refuses to start in production with a key present.

## Tests (e2e is the proof)

`tests/f18-legacy-ai-path.e2e.firestore.test.ts` is the real Next route under `NODE_ENV=production`, Firebase auth with real
Auth-emulator ID tokens, and Firestore mode on the emulator (the F01/F12 harness from #44). The real Functions router
(`createRouter(ROUTES)`) is served on a loopback port with the Functions P1 test transport counting sanctioned calls. The
legacy provider boundary (the `ai` SDK's `createGateway`/`generateText`) is replaced by a counting fake. A fetch tripwire
counts and refuses any non-loopback request. No network, no real key: the fake key is an obviously fake value.

Rows:
- (a) key set: zero direct calls, a refusal with the documented reason, the alert line, no cost row;
- (b) key set with both kill switches on: zero direct calls;
- (c) no key and Functions configured: forwarded, one sanctioned call, one `ok` cost row with a cost, zero direct calls;
- (d) the firm kill switch: blocked `kill_switch_firm`, a `blocked` cost row, zero sanctioned calls;
- (e) the platform kill switch: blocked `kill_switch_platform`, as (d);
- (f) budget not set: blocked `budget_not_set`, as (d);
- (g) budget too small: blocked `budget_exhausted`, as (d);
- (h) Functions configured but unreachable: 503 `p1_functions_unavailable` with the alert line, zero calls;
- (i) the eve bridge with a key, in production: blocked with the documented reason, alert line, zero direct calls; eve's
  agent module refuses to load;
- (j) control: the eve bridge without a key, blocked `PHASE0_NO_CREDENTIALS`.

Rows (a), (b), (c) to (h) and (i) fail on main. Row (j) passes on main and on the branch.

Every document the suite creates (firms, users, matters, members, `ai_*`, `committee_outputs`, idempotency, audit, events,
rate limits, `platform/p1`) and every Auth user is deleted after each test. A final check asserts none is left.

Gate tests: `tests/f18-next-ai-egress-gate.test.ts` plants each kind of violation in a temporary tree, and [19] must fail and
name it. [19] passes on the cleaned repository and fails on main's tree (gatewayTransport imports `ai`; `.env.example` binds
the keys).

Unit tests: `tests/f18-provider-key-guard.test.ts` and `tests/f18-functions-forward.test.ts` cover the guard and the forward
client: URL rules, redirect refusal, timeout and answer mapping.

## Residual risks

- eve framework internals: on a host where Vercel OIDC federation is enabled, the AI SDK's Gateway provider can authenticate
  with `VERCEL_OIDC_TOKEN`, which the platform injects and the guard does not treat as a provider key. Our code holds no
  Gateway call site (the gate), and eve's agent model is the P1 bridge. eve's own framework model calls (self-modification,
  `eve dev` tooling) could still use OIDC on such a host. Mitigation: eve is not mounted on Next (`withEve` is not used).
  Follow-up: decide eve's deployment and refuse OIDC-backed Gateway use there.
- Text analysis only: the gate reads imports, names and hosts as text. A provider reached through an indirection it cannot
  see (a host assembled at runtime, a new SDK not on the list) passes it. The runtime guard and the absence of any transport
  in Next are the other two layers.
- The route depends on Functions availability in production: when Functions is down, committee requests fail with 503 or
  504 instead of answering blocked.
- Party names: Functions accepts at most 50, and requests over that are relayed as 400 `invalid_party_names`.

## Follow-ups

- The ops console posts committee requests without `matterId` (app/ops/operator-audit-console.tsx), and its Functions
  dispatch (lib/console/console-functions-dispatch.ts) forwards none, so Functions answers 400 `matter_required`. That is the
  F02 console lane.
- eve to Functions: give the bridge a signed-in caller's token and a matter so eve's calls are budgeted (O-53 follow-on).
- Narrow G-0 [3]'s `ALLOWED_PREFIXES` to `functions/src/p1/` now that [19] forbids provider code in `platform/p1`.
- Update `agent/instructions.md` ("Public may leave once a Gateway key exists") with its F16 digest re-pin.
- FA-D3C-002 (`corpus_service` embeddings): F27's lane.

## Re-audit follow-up (2026-10-18)

PR #88 merged as ac69873. The independent re-audit of that code was FAIL 7/10. The core path held (the e2e was RED on main
and GREEN on the head; 27 of 32 mutants were killed), but one MEDIUM was open: Next code could import the Functions P1
transport. This section records the rulings that close FA-F18-001 to FA-F18-005. It also records FA-F18-006 and
FA-F18-007, which are not fixed here.

**What the re-audit showed (FA-F18-001, MEDIUM).** Attack P17 was a Next route with
`import { activeTransport } from "@/functions/src/p1/transport"`:
- [19] exited 0;
- under `NODE_ENV=production` with a fake `AI_GATEWAY_API_KEY`, `activeTransport()` called from root code returned the
  Gateway transport;
- its `send()` built a POST to `ai-gateway.vercel.sh` with `Bearer <key>`;
- no alert was logged.

R5's premise ("the gate proves no other Next code can use a key") was false: [19] banned SDK packages, key names and hosts,
and `functions/` was exempt as a whole, so a specifier into it was never examined.

**R9-FU. [19] forbids the Functions tree outside `functions/` (FA-F18-001a).** Rule (f): no JS/TS outside `functions/`,
root `tests/` included, may import a module under `functions/`. The rule resolves, from literal specifiers:
- `@/functions/...` (the repository's `@` alias is applied even when no tsconfig names it);
- relative paths;
- every `paths` alias and `baseUrl` of the root `tsconfig*.json` / `jsconfig.json`, read as JSON with comments and trailing
  commas;
- bare `functions/...`.

It reads every loading form:
- `import`, `export ... from` and `import()`;
- `require()`, `require.resolve()` and createRequire loaders;
- vitest/jest `importActual`, `requireActual`, `importMock` and `requireMock`.

A root tsconfig that does not parse fails the gate (rule (i)), because its aliases could not be checked.

There is one allowlist, `FUNCTIONS_IMPORT_ALLOWLIST` in the gate. Each entry is (root test file, Functions module) with a
one-line reason. The gate refuses:
- an entry naming `functions/src/p1/transport` or `functions/src/p1/gateway`;
- an entry for a file outside `tests/`;
- an entry without a reason;
- a stale entry, whose file exists but no longer imports its module.

The entries:

| Importer | Module | Why |
|---|---|---|
| `tests/f18-legacy-ai-path.e2e.firestore.test.ts` | `functions/src/http/router` | the e2e serves the real `api` router in process |
| same | `functions/src/health` | pins the `api` timeout below the forward deadline |
| same | `functions/src/p1/transportTestSeam` | installs the Functions fake transport; no paid code |
| `tests/helpers/functions-router-fetch.ts` | `functions/src/http/router`, `functions/test/emu` | the F02 console e2e helper (not this lane; unchanged) |
| `tests/f11-atomic-request-audit.e2e.firestore.test.ts`, `tests/f11-audit-outbox.firestore.test.ts` | `functions/src/p5/auditOutbox` | F11 (#86, merged into this branch): runs the Functions audit-outbox reconciler; a Firestore handle in, no transport |
| `tests/f13-canonical-matter-shapes.e2e.firestore.test.ts`, `tests/f13-reaudit.e2e.firestore.test.ts`, `tests/f13-slice2.e2e.firestore.test.ts` | `functions/test/api`, `functions/test/emu` (and `functions/src/admin` for slice 2) | F13 (#92 to #94, merged into this branch): cross-stack e2e through the Functions router in process (`viaApi`), the suite's emulator tokens, the Functions Admin handle |
| `tests/p5.identity-policy.parity.test.ts` | `functions/src/p5/auth` | P5 parity |
| `tests/p5.permission-decision.parity.test.ts` | `functions/src/p5/permission` | P5 parity |

The router is not a pure module: it reaches the gateway and the transport transitively. It is allowlisted for the two
in-process e2e harnesses only. That is safe because R13 makes the transport build nothing paid outside the Functions bundle,
whatever imports it. `vi.mock(...)` and `vi.doMock(...)` are not counted: with a factory they replace the module and load
none of it.

Rule (g) is new: no JS/TS outside `functions/` may name the runtime marker (R13), so no Next code or root test can set it as
a global.

**R9-FU, F16's live block (decision).** `tests/f16-injection-structure.test.ts` imported the transport and `costTable` for its
live block, which runs only with a key. Three options were weighed:
- allowlist `costTable`: this does not help, because the block also needs `gatewayTransport`, which can never be allowlisted;
- a test seam: this would put a paid path within reach of a root test;
- move the block into `functions/test/` (chosen): the transport legitimately lives there.

The live block is now `functions/test/f16-injection-live.test.ts`. It sends `requestMessages(toolPrompt(c))`
(`tests/fixtures/f16-injection-prompts.ts`), which is the bridge's two building steps, `promptToTurns` then `buildOutbound`.
The root structure suite now asserts, for each of the 54 cases, that `requestMessages` equals the request the bridge itself
builds. So the move keeps (b)'s coverage: a live run sends exactly what the bridge would. Without a key the live block
reports NOT RUN, as before. With a key it opts in through R13's test allowance.

**R13. The Functions transport refuses outside the Functions runtime (FA-F18-001b, defence in depth).** `gatewayTransport()`
throws `PAID_TRANSPORT_OUTSIDE_FUNCTIONS_REASON` unless it runs in the Functions runtime. `activeTransport()` with a key
outside the runtime returns no transport, and logs
`[p1] ALERT p1.provider_key_in_next_runtime { runtime: "functions-transport-outside-functions", keys: ["AI_GATEWAY_API_KEY"], refused: true }`.
That alert names the variable and never its value. `callP1` then records `no_credentials`, as it does without a key.

- **The signal.** It is the compile-time constant `__SIKANDER_FUNCTIONS_RUNTIME__`. `functions/runtime-define.mjs` exports
  it, and `functions/build.mjs` defines it for:
  - `lib/index.js`: the deployed `api` function, which the emulator also loads;
  - the operator CLIs: `eval:committee-live` sends through the transport.

  Why not `FUNCTION_TARGET`, `K_SERVICE` or `FIREBASE_CONFIG`: Cloud Run and App Hosting set `K_SERVICE` and
  `FIREBASE_CONFIG` for a Next service too. Any environment variable can also be copied into the Next service along with
  the key, which is the very deployment error F18 is about. A constant compiled into the Functions bundle cannot be set by
  any deployment setting. Rule (g) stops Next code or a root test from naming it.
- **The test allowance.** `setPaidTransportAllowedForTests(on)` is accepted only under `NODE_ENV=test`. It counts only while
  `NODE_ENV` is still `test`, so it is inert in production even if it was set earlier. It is used explicitly by:
  - the Functions suites that drive the real transport against a loopback server: `p1.transport`, `f17-transport-model`
    and `p1.gateway.emu`;
  - the live F16 block.

  The fake-transport slot moved to `functions/src/p1/transportTestSeam.ts`. `transport.ts` re-exports its setter, so the
  Functions suites are unchanged. The F18 e2e imports the seam, never the transport. It serves the router in process and
  installs its fake there; the fake takes precedence, as before.
- **Lane deviation.** `functions/build.mjs` and the new `functions/runtime-define.mjs` are outside the stated lane
  (`functions/src/p1/transport*`). They were changed because the build is the only place the signal can come from.
- **Proof.** `functions/test/f18-transport-runtime.test.ts` covers four things:
  - outside the bundle, with a key under production: no transport, the alert, and nothing sent;
  - `gatewayTransport()` refuses;
  - the allowance's rules;
  - bundled with `FUNCTIONS_RUNTIME_DEFINE`, the transport is built and sends to the Gateway URL with the bearer key (to a
    local recorder); `build.mjs` applies the define to the index and CLI builds.

  E2E row (l): the Functions router, imported by this non-Functions process with a key and no fake, records
  `no_credentials` with the alert, and the tripwire sees nothing. On main, the transport was built there, and its POST to
  the Gateway was refused by the tripwire.

**R9-FU, deploy-surface gaps (FA-F18-002).** Fixed:
- workflows are read at any indentation: a job starts at the indentation of the first content line under `jobs:`, and
  top-level sections after `jobs:` count as workflow level (P27);
- `.envrc` and `.envrc.*` are env files (P33);
- rule (e): a string `model:` value under `agent/` fails. This covers JS/TS quotes and template literals, and `model:` in
  front matter, YAML or JSON (P39);
- rule (h): a symlinked directory anywhere outside `node_modules`, `.git` and `.next` fails, because the walkers do not
  follow links (P40);
- five SDK packages are added: `@anthropic-ai/vertex-sdk`, `@anthropic-ai/bedrock-sdk`, `@langchain/openai`,
  `@langchain/anthropic` and `@aws-sdk/client-bedrock-agent-runtime` (P35 to P37);
- a root tsconfig alias that resolves into `node_modules/<banned package>` (P12) is now caught, as a side effect of the
  alias resolution.

The auditor's 40 attacks: 19 caught on main ac69873, 28 caught on the branch.

**R9-FU, residuals ([19] is text analysis).** Each of these passes [19]:
- computed specifiers, hosts and key names (P8, P9, P19, P21);
- `package.json` `imports` maps (P13) and npm alias dependencies (P14);
- SDKs not on the lists;
- aliases set only in JS config (vitest, next, webpack);
- provider hosts in non-JS config files (P20);
- flow-style or anchored workflow YAML;
- jobs that deploy through `gcloud run deploy`, `docker build` or `pnpm build` (P28 to P30);
- shell scripts (P38).

The runtime layers stand behind the gate for these cases:
- the Next tree has no transport (R2);
- the key guard (R5);
- the Functions transport refuses outside its runtime (R13).

**R5-FU. A key refuses unless `NODE_ENV` is exactly `development` or `test` (FA-F18-005).** Next keeps a non-standard
`NODE_ENV` at run time. With `NODE_ENV=staging` and a key, eve started and the route forwarded. Now
`keyRefusingNodeEnv(env)` is true for every value but those two, unset included. Under it:
- `checkProviderKeys` refuses;
- eve refuses to start;
- the route's dispatch (`providerKeysRefused()`) keeps the call local.

E2E row (m) covers staging.

`next build` and `next start` run with `NODE_ENV=production`. With no key, nothing is refused under any value, and [19]
proves that no workflow job that serves Next holds a key. The guard runs only on a P1 call or at eve start-up, never at
build. A local `next build` is NOT DEMONSTRATED: Turbopack refuses this worktree's symlinked `node_modules`. CI runs it on
the PR.

Two rules are deliberately unchanged:
- The Functions emulator-host rule in `functionsP1BaseUrl` stays "never under production". An emulator URL is loopback and
  carries no paid path, and changing it would change R8's tested contract without a finding.
- The `set*ForTests` seams keep their production refusal.

The R5 review-round sentence "the gate (R9) proves no other Next code can use a key" is withdrawn. The gate now forbids the
import of the Functions tree (R9-FU), and the transport refuses outside its runtime (R13).

**FA-F18-003.** The e2e loads every module that is new in F18 or in this follow-up with `await import(...).catch(() => ({}))`:
- `platform/p1/functionsCommitteeBrain`;
- `functions/src/p1/transportTestSeam`.

It now runs on c02ebbc (main before F18) with real RED results. It uses the shared network tripwire
(`tests/helpers/network-tripwire.ts`), installed when the file loads. The tripwire refuses fetch and sockets (`net`, `tls`,
the agents' `path: null` form) to every non-loopback host, and the agent proxy's port. `tests/f18-network-tripwire.test.ts`
proves it first. Every root test file that could reach a transport mocks `ai` and installs it, as do the Functions suites
that build the real transport.

**FA-F18-004.** Tests now kill the five surviving mutants:
- M2: a pinned 21-name list, held equal in the gate and the guard;
- M15: unsafe refusal codes become `p1_functions_error`;
- M18: `setForwardTimeoutForTests` refuses in production;
- M27: a `firebase deploy --only hosting` job with a key;
- M31: `platform/p1/other.ts` naming a key.

**FA-F18-006 (recorded, not fixed; F02's lane).**
- The ops console and the foundation console post to Functions without `matterId`, and get 400 on main too.
- The foundation console expects `outbound`, and would throw on render.
- A 304 from Functions maps to 400.

**FA-F18-007 (recorded).** `maxDuration = 130` against the deploy target is [REQUIRES VERIFICATION] until F32 declares a
target.
