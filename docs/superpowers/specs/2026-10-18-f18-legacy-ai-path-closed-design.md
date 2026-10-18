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

Outside production the alert line is logged and nothing is refused, because no paid path exists there to refuse. The test
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
