# P1 AI gateway

The single routing point for every AI call in Cloud Functions (spec `docs/superpowers/specs/2026-10-11-phase3d-p1-ai-layer-design.md`, rulings P3-60 to P3-73; errata E-48 and E-49 in `docs/architecture/ERRATUM_SET_2_PROPOSED.md`). A layer that needs a provider calls `callP1` with a classification and never calls a provider itself (Layer 18 §9, rule 6). `callP1` records every decision, allowed or refused, in `ai_usage_logs`, and the provider guard and the fetch allowlist let only `functions/src/p1/`, `platform/p1` and `platform/committeeBrain` reach a provider.

P1 is CORE, with no layer flag. The Next.js `/api/p1/committee-brain` route is the transitional path (E-23) and has no cost log, kill switch or budget; it stays until the app calls the functions route (O-53). Until then the Next.js deployment must hold no AI Gateway key (`AI_GATEWAY_API_KEY` and `VERCEL_AI_GATEWAY_API_KEY` unset), so that route stays blocked (`PHASE0_NO_CREDENTIALS`): the kill switches, the budget and the cost log below govern the Cloud Functions path only (ruling R8).

## Entry point

`callP1(request, opts?)` in `gateway.ts` is the v6 `internalAICaller`. The request carries `firmId`, `actorId` (a uid or `"system"`), `matterId | null`, `jobId | null`, `taskType` (`committee` is the only one), `classification`, `body`, `purpose` and `partyNames?`. The result carries the outcome (`ok`, `failed` or `blocked`), the block reason, the masked `text` (only when `ok`), the usage row id, the trace id, the model, the token counts, `costMicroUsd` and the masked outbound body and purpose.

Spend is counted per provider call, not per request. A replay of a stored 2xx never reaches P1. A same-key retry after a 5xx can: the router stores no 5xx, so a `committeeBrain` whose output write failed for good after the provider call (500) runs again and is billed again, in its own usage row (O-58). A job attempt that calls the provider again has been billed again and gets its own row.

## Pipeline order (P3-61)

The first refusal wins. A refusal at steps 2 to 8 makes no provider call, costs 0, and is still traced and logged (steps 10 and 11) with outcome `blocked` and a fixed `blockReason`.

1. Classification guard: a missing or unknown label throws, before any read or write (L8473).
2. Kill switch: the platform's, then the firm's (P3-66). Both are read fresh on every call.
3. Route: task type to model (P3-62).
4. Outbound mask of the body and the purpose, with the party names (`maskOutboundPII`).
5. Provider policy: `providerAllowedFor("ai-gateway", classification)`, and at rank 3 and above `assertMinimised` on the masked body and the masked purpose.
6. Price: the model must have one.
7. Budget: one must be set, and the month's spend must be below it (P3-64).
8. Credentials: `AI_GATEWAY_API_KEY` must be set.
9. Transport call, then the response mask. Any transport error is outcome `failed`, reason `transport_error`. It is charged when the provider may have billed it (a timeout or abort, a 2xx that is not JSON, a 2xx without usable content): the usage the response reported where it is a valid count, else the estimated input and the 4,096-token ceiling, with `tokensEstimated: true`. A non-2xx and a request that never left (a refused connection, DNS, a refused redirect) cost 0. A transport that resolves without text is billed like `gateway_no_text`; any error that is not a billable `P1TransportError` costs 0.
10. Trace export (P3-67), fail-open.
11. One transaction: the usage row, the month total, any threshold alerts, the audit row and the event.

No raw (unmasked) body, purpose or response text reaches the transport, a trace, a usage row, an event, an audit row or a log line. Provider error text is never returned, stored or logged: the transport throws a `P1TransportError` whose code (`gateway_timeout`, `gateway_request_failed`, `gateway_status`, `gateway_not_json`, `gateway_no_text`) and message are fixed, and the gateway logs only the code (`p1.transport_failed`). The transport refuses redirects (`redirect: "error"`), so the key and the masked body go to the Gateway URL only.

## Routes

On the existing HTTP `api` under `/api/platform/brain/` (E-37: no onCall).

| Route | Method | Who | Notes |
| --- | --- | --- | --- |
| `committeeBrain` | POST | partner, associate, clerk on the matter (`ai.call`) | rate kind `p1` (10 per minute per user); body 1 to 100,000 characters; `documentIds` refused (`documents_not_supported`); classification is the strictest of the matter's label, the caller's label and the `internal` floor; writes one `committee_outputs` row |
| `getAiUsage` | GET | partner (`ai.usage.read`) | `?month=YYYY-MM`, default the current PKT month; reads the month total, not the logs; shows both kill switches (the platform's `setBy` is always `"platform"`) |
| `setBudgetAlerts` | POST | partner (`ai.budget.set`) | `{ monthlyBudgetUsd, pkrPerUsd? }`; the thresholds are fixed |
| `setAiKillSwitch` | POST | partner (`ai.kill_switch.set`) | `{ disableAll, disabledModels, reason }`; a request replaces the whole state |
| `setPlatformAiKillSwitch` | POST | platform admin (`platformAdmin` claim), firmless | same body; the operator's switch across every firm. Its `reason` is shown to every firm's partners in `getAiUsage`, so it must never name a firm or a client |

## Environment

| Variable | Meaning |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Bearer key for the Vercel AI Gateway. Unset or blank: every call is refused `no_credentials`. Held in Secret Manager in deployment, never in code (L962). |
| `OPIK_BASE_URL` | Base URL of the self-hosted Opik API (for example `http://localhost:5173/api` for a local server). Plain `http` only for a private host (below). Unset: tracing is off. |
| `OPIK_SELF_HOSTED_CONFIRMED` | Must be exactly `"true"` before any matter content is traced (L2067). |
| `OPIK_PROJECT_NAME` | Opik project; default `sikander-p1`. |

Tracing is on only when `OPIK_BASE_URL` is a usable `http(s)` URL (no credentials, no query or fragment; plain `http` only when the host is loopback (`localhost`, 127.0.0.0/8, `::1`), a private IPv4 literal (10/8, 172.16/12, 192.168/16) or a name ending in `.internal` or `.local`), `OPIK_SELF_HOSTED_CONFIRMED` is `"true"`, and the host is not `comet.com` or a subdomain of it. The checks run in that order and report `unset`, `invalid_url`, `unconfirmed`, then `third_party_host`. The export refuses redirects: a redirect is a `failed` export and nothing is sent to its target.

Nothing in `functions/src` binds the key as a function secret yet. Until the deployment supplies `AI_GATEWAY_API_KEY` to the `api` function, `committeeBrain` answers with a `blocked` row (`no_credentials`) and no provider is called.

## Cost, budget and alerts

- **Model and price.** `committee` goes to `anthropic/claude-opus-5.5` through provider id `ai-gateway`. Prices are integer nano-USD per token (input 4,000, output 20,000), with their source and the date fetched (2026-10-11) in `costTable.ts`. The routing and price tables are frozen. A model with no price is refused `model_unpriced`. Every call sends `max_tokens: 4096`.
- **Cost.** In micro-USD, `ceil((inputTokens x inputPrice + outputTokens x outputPrice) / 1000)`. When the response carries no usage, each side is estimated as `ceil(UTF-8 bytes / 3)` tokens and the row says `tokensEstimated: true`: the input from the masked body that was sent, the output from the raw response, because masking shortens it and the provider billed the raw length. The raw text is used for that count only; the masked text is the only one returned, stored, traced or logged. A failed call the provider may have billed is charged too (step 9), and moves the month's spend and token totals by the same rule as an ok call, so it can cross a threshold and counts toward `budget_exhausted`.
- **Currency.** Micro-USD integers are canonical. When the firm has set `pkrPerUsd`, the row stores the rate and `costPkr` to 2 decimal places. There is no default rate.
- **Budget.** Per firm per PKT calendar month (`YYYY-MM`, Asia/Karachi, UTC+5). With no budget set every call is refused `budget_not_set`; once the month's spend reaches the budget, every call is refused `budget_exhausted` until the partner raises it or the month turns. The check runs before the call, so calls in flight together can overshoot; the per-user rate limit and `max_tokens` bound it.
- **Alerts.** At 70 and 90 percent. The transaction that takes the month total across a threshold creates `ai_budget_alerts/{firmId}_{monthKey}_{70|90}` with `tx.create`, so each fires once per firm per month, even for parallel calls. The same transaction stages the audit row `ai.budget.threshold` (actor `system`) and the event `ai.budget.threshold_crossed`; after commit `logger.warn("p1.budget_threshold", ...)` feeds Cloud Monitoring. Raising the budget does not re-arm a threshold already crossed that month. Delivery to people is P4 (O-54).
- **Failed commit.** If the transaction fails after a successful provider call, the result is still returned (the spend has happened) and `logger.error("p1.usage_log_failed", record)` keeps the record. The commit stops retrying 30 s after it starts (`COMMIT_DEADLINE_MS`, code `commit_deadline`), so the 60 s transport, the 2 s trace and the commit fit in the 120 s function timeout. A commit whose answer was lost and whose retry then fails with ALREADY_EXISTS is confirmed by reading the usage row: it is done, nothing is logged as failed, and the thresholds it crossed are read back from its alert docs for the `p1.budget_threshold` warning.

## Kill switch

Two scopes, each `{ disableAll, disabledModels, reason, setBy, setAt }`: the firm's in `ai_config/{firmId}.killSwitch`, the platform's in `platform/p1.killSwitch`. Both govern the Cloud Functions path only until O-53 closes (see the top of this file). The platform switch's `reason` is shown to every firm's partners in `getAiUsage` (its `setBy` is shown as `"platform"`), so it must never name a firm or a client. Only `disableAll === true` and an exact model id in `disabledModels` block. A request replaces the whole state; `disableAll: false` with no models re-enables. The reason is required (1 to 500 characters) and both writes are audited. P1 reads both on every call with no cache, so a switch takes effect on the next call; calls already in flight complete. Block reasons `kill_switch_platform` and `kill_switch_firm`.

## Block reasons

| Reason | Step | Meaning |
| --- | --- | --- |
| `kill_switch_platform` | 2 | the operator's switch blocks every model, or this one |
| `kill_switch_firm` | 2 | the firm's switch blocks every model, or this one |
| `policy_denied` | 5 | the classification may not go to `ai-gateway` (no executed DPA, or out of region at rank 4; `data/provider_dpa.json` is empty until O-21 is recorded, so only `public` and `internal` reach a provider) |
| `not_minimised` | 5 | at rank 3 and above, the masked body or purpose would still be masked again |
| `model_unpriced` | 6 | the routed model has no price |
| `budget_not_set` | 7 | the firm has no valid monthly budget |
| `budget_exhausted` | 7 | the month's spend has reached the budget |
| `no_credentials` | 8 | no `AI_GATEWAY_API_KEY` |

A provider failure is not a block: the outcome is `failed` and the reason `transport_error`, charged by step 9's rule.

## Collections and documents

All are server-only: `firestore.rules` denies every client read and write (partners read through `getAiUsage`). No query needs an index.

| Path | Holds |
| --- | --- |
| `ai_usage_logs/{auto id}` | one row per P1 decision: `firmId`, `actorId`, `matterId`, `jobId`, `taskType`, `provider`, `model`, `classification`, `outcome`, `blockReason`, `inputTokens`, `outputTokens`, `tokensEstimated`, `costMicroUsd`, `fxPkrPerUsd`, `costPkr`, `monthKey`, `trace: { id, status }`, `createdAt`. No prompt or response text. |
| `ai_usage_months/{firmId}_{monthKey}` | the month total: `spentMicroUsd`, token totals and `calls: { ok, failed, blocked }` |
| `ai_budget_alerts/{firmId}_{monthKey}_{70\|90}` | one alert per threshold per month |
| `ai_config/{firmId}` | `monthlyBudgetMicroUsd`, `pkrPerUsd`, `killSwitch` |
| `platform/p1` | the platform `killSwitch` |

`committeeBrain` also writes `committee_outputs/{id}` in the Next.js shape (`id` and `createdAt` in epoch milliseconds), plus `usageLogId` and `traceId`. The write is retried up to 3 times on a non-HTTP error (waits of 100 and 200 ms). An attempt that fails with ALREADY_EXISTS after an earlier attempt's commit was lost finds the row by its `usageLogId` and is a success. A write that fails for good answers 500 after the provider call (O-58).

## Events and audit

Each decision writes one `events` row (`ai.call.completed`, `ai.call.failed` or `ai.call.blocked`, payload `traceId`, `task`, `model`, `classification`, `costMicroUsd`, `blockReason?`) and one `audit_log` row (`ai.gateway.decision`, allow or deny, target `ai_usage_logs/<id>`). There is no `ai.call.requested` (E-48). A `committeeBrain` request therefore leaves three audit rows: the permission check's `ai.call` decision, the route's `ai.call` row, and the gateway's `ai.gateway.decision`. The setters audit as `ai.budget.set`, `ai.kill_switch.set` and `ai.platform_kill_switch.set`.

## Trace (Opik)

One trace per decision, posted to `{OPIK_BASE_URL}/v1/private/traces/batch`. The trace id is a UUIDv7 and is the usage row's `trace.id`. Ranks 0 to 3 carry the masked outbound body and the masked response; rank 4 and blocked calls carry metadata only (E-49). Export has a 2-second timeout and is fail-open: a failed export never fails the call, the row records `trace.status` (`exported`, `failed` or `disabled`) and the failure is logged as `p1.trace_export_failed`.

## Test seams

`p1TestSeam` (`gateway.ts`: `beforeCommit`, `failCommit`, `modelOverride`, `wallClock`, `commitAttemptFailures`, `lostCommitAnswers`), `p1OpsTestSeam` (`ops.ts`: `outputWriteFailures`, `lostCommitAnswers`, `sleep`), `setP1TransportForTests` (`transport.ts`) and `setOpikFetchForTests` (`opik.ts`) exist for tests only. Production code never references them. As defence in depth, the first two are inert and the last two throw when `NODE_ENV` is `production`, and the deployable bundle (`lib/index.js`) is built with `NODE_ENV` defined as `"production"` (`functions/build.mjs`), so they stay inert there whatever the host sets.

## Tests and gate

`functions/test/p1.units.test.ts` and `p1.transport.test.ts` need no emulator. `p1.gateway.emu.test.ts` and `p1.api.emu.test.ts` run under the Auth and Firestore emulators, with a local HTTP server standing in for the Gateway. The rules are covered by `tests/firestore.rules.p1-phase3d.test.ts` and the new permission actions by `tests/p5.permission-ai-actions.test.ts`. `npm run gate:g4:phase3d` (`ci_gates/gate_g4_phase3d.sh`) checks route coverage, runs the named P1 tests (and the bundle's `NODE_ENV` test in `deploy.test.ts`) by exact name, lints `functions` at zero warnings and runs G-2; it runs in CI after the Phase 3c gate.

## Not in this phase

- L16.1 Automatic and Advanced modes and the deterministic-first gate (they need the clause library).
- L16.2 cross-model failover, and async-by-default through a provider-calling P2 job (O-56).
- Other task types: large-context, research, OCR, speech to text, text to speech and translation routing.
- The citation guardrail (L960-961): Phase 4.
- Opik evaluations (`runEvalExperiment`, `onlineEvalRule`).
- Address masking: `maskOutboundPII` has no address rule (a recorded gap under O-13).
- Per-firm daily limits (E-34).
- Retiring the Next.js route (O-53).
- Deployment: the Secret Manager binding and the self-hosted Opik server (O-55).

## Open items

O-53 retire the Next.js `/api/p1/committee-brain` route. O-54 deliver budget alerts through P4. O-55 Opik deployment, retention (a partner decision) and re-export of failed traces. O-56 failover and the provider-calling P2 job type. O-57 at G-1, verify the Gateway usage mapping, reconcile `costMicroUsd` against the Gateway's spend report (O-12), and record an executed DPA for `ai-gateway` (O-21); before a key is bound, measure the p95 latency of a ~4k-token Opus answer and choose streaming or a lower `max_tokens` (until then a timeout is charged at the 4,096-token ceiling). O-58 a same-key retry after a failed output write calls the provider again; fix by writing the output row in `callP1`'s commit or returning a storable result. O-13 is closed; O-35 is narrowed to job rows. All are in `docs/architecture/ERRATUM_SET_2_PROPOSED.md`, ES2-4.
