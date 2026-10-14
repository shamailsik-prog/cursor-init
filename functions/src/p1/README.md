# P1 AI gateway

The single routing point for every AI call in Cloud Functions (spec `docs/superpowers/specs/2026-10-11-phase3d-p1-ai-layer-design.md`, rulings P3-60 to P3-73; errata E-48 and E-49 in `docs/architecture/ERRATUM_SET_2_PROPOSED.md`). A layer that needs a provider calls `callP1` with a classification and never calls a provider itself (Layer 18 §9, rule 6). `callP1` records every decision, allowed or refused, in `ai_usage_logs`, and the provider guard and the fetch allowlist let only `functions/src/p1/`, `platform/p1` and `platform/committeeBrain` reach a provider.

P1 is CORE, with no layer flag. The Next.js `/api/p1/committee-brain` route is the transitional path (E-23) and has no cost log, kill switch or budget; it stays until the app calls the functions route (O-53). Until then the Next.js deployment must hold no AI Gateway key (`AI_GATEWAY_API_KEY` and `VERCEL_AI_GATEWAY_API_KEY` unset), so that route stays blocked (`PHASE0_NO_CREDENTIALS`): the kill switches, the budget and the cost log below govern the Cloud Functions path only (ruling R8).

## Entry point

`callP1(request, opts?)` in `gateway.ts` is the v6 `internalAICaller`. The request carries `firmId`, `actorId` (a uid or `"system"`), `matterId | null`, `jobId | null`, `taskType` (`committee` is the only one), `classification`, `body`, `purpose` and `partyNames?`. The result carries the outcome (`ok`, `failed` or `blocked`), the block reason, the masked `text` (only when `ok`), the usage row id, the trace id, the model, the token counts, `costMicroUsd`, the masked outbound body and purpose, and `accounting` (audit F08). `accounting` is `settled` when the usage row and month total are committed. It is `pending` when they are not, and then any provider spend is still held by the call's reservation until the reconciler settles it. So whether the result is available and whether its accounting is complete are told apart. `committeeBrain` returns and stores `accounting` too.

Spend is counted per provider call, not per request. A replay of a stored 2xx never reaches P1. A same-key retry after a 5xx can: the router stores no 5xx, so a `committeeBrain` whose output write failed for good after the provider call (500) runs again and is billed again, in its own usage row (O-58). A job attempt that calls the provider again has been billed again and gets its own row.

## Pipeline order (P3-61)

The first refusal wins. A refusal at steps 2 to 8c makes no provider call, costs 0, and is still traced and logged (steps 10 and 11) with outcome `blocked` and a fixed `blockReason`.

1. Classification guard: a missing or unknown label throws, before any read or write (L8473).
2. Kill switch: the platform's, then the firm's (P3-66). Both are read fresh on every call.
3. Route: task type to model (P3-62).
4. Outbound mask of the body and the purpose, with the party names (`maskOutboundPII`).
5. Provider policy: `providerAllowedFor("ai-gateway", classification)`, and at rank 3 and above `assertMinimised` on the masked body and the masked purpose.
6. Price: the model must have one.
7. Budget: one must be set, and the call's worst case must fit beside the month's spend and the holds of its live reservations (P3-64, audit F07). This first look uses the pre-call read; step 8b decides again on fresh figures.
8. Credentials: `AI_GATEWAY_API_KEY` must be set.
8b. Reservation (audit F07). One transaction re-reads both kill switches, the month total and the firm's config and creates `ai_reservations/{usageLogId}` holding the worst case, adding it to the month's `reservedMicroUsd`. The worst case is the input ceiling of the masked body (one token per UTF-8 byte plus `REQUEST_OVERHEAD_TOKENS`, 64) plus the 4,096-token output ceiling, at the model's price (re-audit R1-D1). It refuses, in this order: `kill_switch_platform` and `kill_switch_firm` (a switch set after step 2's read still stops the call here, re-audit R1-D3); `budget_not_set`; `accounting_indeterminate` (the firm has a provider attempt whose lease lapsed unsettled, or a reservation the reconciler quarantined, F08); `budget_exhausted` unless spent + reserved + the new reservation is at most the budget; and `concurrency_exhausted` when the firm already holds `maxConcurrentCalls` live reservations (default 4). If the reservation cannot be written within its deadline, the call is refused `reservation_failed`. In every refusal nothing is sent.
8c. Provider attempt (audit F08). A second small transaction records `providerAttempt: { attemptedAt, outcome: "pending" }` on the reservation, only while it is still held. If that write fails, the call is refused `reservation_failed`, nothing is sent and the commit releases the hold.
9. Transport call, then the response mask. Any transport error is outcome `failed`, reason `transport_error`. It is charged when the provider may have billed it (a timeout or abort, a 2xx that is not JSON, a 2xx without usable content): the usage the response reported where it is a valid count, else the estimated input and the 4,096-token ceiling, with `tokensEstimated: true`. A non-2xx and a request that never left (a refused connection, DNS, a refused redirect) cost 0. A transport that resolves without text is billed like `gateway_no_text`; any error that is not a billable `P1TransportError` costs 0.
9b. What the provider answered and what the call is charged go on the reservation's attempt (`outcome: "returned"`, `result`, the token counts, `costMicroUsd`), with the provider's response id (`responseId`, the body's `id`) and the Gateway's request id (`requestId`, the `x-request-id` or `x-vercel-id` header) when each is a plain id (re-audit R1-D5). Which request-id header the Gateway sets is to be confirmed at G-1 (O-57). This write is fail-open, and lands only while the reservation is still held, so it never rewrites the attempt of a reservation the reconciler has settled. It lets the reconciler settle at that charge if the commit fails.
10. Trace export (P3-67), fail-open.
11. One transaction: the usage row, the month total, any threshold alerts, the audit row and the event. The same transaction settles the reservation: the actual cost is added to `spentMicroUsd`, the hold leaves `reservedMicroUsd`, and the reservation takes `state: "settled"` (an ok call or a billed failure) or `"released"` (an unbilled failure, or a call refused after it reserved), with `actualMicroUsd`. A reservation the reconciler already settled is never counted twice: the commit fails on it and finds the reconciler's usage row.

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
- **Budget (audit F07).** Per firm per PKT calendar month (`YYYY-MM`, Asia/Karachi, UTC+5). With no budget set every call is refused `budget_not_set`. The budget is a limit on spend plus holds: a call is sent only after its reservation commits, and a reservation commits only if spent + reserved + its worst case is at most the budget. Once the remainder is smaller than a call's worst case (82,288 micro-USD for a 28-byte prompt; 482,176 for a 100,000-byte one), that call is refused `budget_exhausted` until the partner raises the budget, a hold is released, or the month turns.
- **The bound, precisely (re-audit R1-D1).** A call's worst case is `costMicroUsd(model, utf8Bytes(maskedBody) + 64, 4096)`. It is an upper bound on what the provider can bill for the call under two conditions:
  - its tokenizer is byte-level: every token covers at least one byte, so input tokens never exceed the body's UTF-8 bytes plus the 64-token template allowance;
  - it honours `max_tokens`, so output tokens never exceed 4,096.

  Under those conditions spent + reserved never exceeds the budget, for one call or for many in flight together. The charge estimate used when no usage is reported (`estimateTokens`, bytes / 3, P3-62) is lower than the bound and is not used for the reservation.

  A provider that reports more than the bound breaks the condition, not the books:
  - its charge is still recorded in full, because it is owed;
  - the excess is recorded on the reservation (`exceededMicroUsd`);
  - the same transaction writes the event `ai.reservation.exceeded` (`{ monthKey, reservedMicroUsd, actualMicroUsd, excessMicroUsd }`);
  - `logger.error("p1.reservation_exceeded", ...)` feeds Cloud Monitoring.

  In that case, and only then, spent can pass the budget, by the excess.
- **Concurrency (audit F07).** A firm holds at most `ai_config/{firmId}.maxConcurrentCalls` live reservations, an integer from 1 to 64, default 4 (`DEFAULT_MAX_CONCURRENT_CALLS`). A further call is refused `concurrency_exhausted`. No route sets it; it is server-set config. Within one instance a firm's reservation and commit transactions run one at a time through a per-firm queue, because transactions that overlap on the month total only abort each other. Across instances the transactions contend, and each one's re-read keeps the budget whatever the interleaving.
- **Time budget.** The phases after a call's first reads fit the 120 s function timeout (116 s in all, enforced at import): the reservation 5 s plus one attempt in flight 5 s, the attempt record 2 s, the transport 60 s, the attempt outcome 2 s, the trace 2 s, the commit 30 s plus one attempt in flight 10 s. The reservation's lease is the function timeout plus 60 s (180 s), so no live call can still settle a reservation the reconciler acts on.
- **Alerts.** At 70 and 90 percent. The transaction that takes the month total across a threshold creates `ai_budget_alerts/{firmId}_{monthKey}_{70|90}` with `tx.create`, so each fires once per firm per month, even for parallel calls. The same transaction stages the audit row `ai.budget.threshold` (actor `system`) and the event `ai.budget.threshold_crossed`; after commit `logger.warn("p1.budget_threshold", ...)` feeds Cloud Monitoring. Raising the budget does not re-arm a threshold already crossed that month. Delivery to people is P4 (O-54).
- **Failed commit (audit F08).** If the transaction fails after a successful provider call, the result is still returned (the spend has happened), with `accounting: "pending"`, and `logger.error("p1.usage_log_failed", record)` logs the record. The spend is not lost from the books: the reservation keeps holding its worst case with its provider attempt. Once its lease lapses, the firm is refused `accounting_indeterminate` until the reconciler settles it. `accounting` is `settled` whenever the call's usage row and month total are committed. The commit paces its own retries: one SDK attempt each (`maxAttempts: 1`, so the SDK never waits, and never applies its 60 s reset after RESOURCE_EXHAUSTED), with jittered waits from 100 ms doubling to 2 s that never run past the deadline; no attempt starts 30 s after the commit starts (`COMMIT_DEADLINE_MS`, code `commit_deadline`). The 60 s transport, the 2 s trace, the 30 s window and one attempt in flight (`COMMIT_ATTEMPT_SLACK_MS`) fit in the 120 s function timeout; an import-time check enforces it. Before any failure is logged the usage row is read: a commit whose answer was lost is done, nothing is logged as failed, and the thresholds it crossed are read back from its alert docs for the `p1.budget_threshold` warning.

## Kill switch

Two scopes, each `{ disableAll, disabledModels, reason, setBy, setAt }`: the firm's in `ai_config/{firmId}.killSwitch`, the platform's in `platform/p1.killSwitch`. Both govern the Cloud Functions path only until O-53 closes (see the top of this file). The platform switch's `reason` is shown to every firm's partners in `getAiUsage` (its `setBy` is shown as `"platform"`), so it must never name a firm or a client. Only `disableAll === true` and an exact model id in `disabledModels` block. A request replaces the whole state; `disableAll: false` with no models re-enables. The reason is required (1 to 500 characters) and both writes are audited. P1 reads both on every call with no cache, so a switch takes effect on the next call; calls already in flight complete. Block reasons `kill_switch_platform` and `kill_switch_firm`.

## Block reasons

| Reason | Step | Meaning |
| --- | --- | --- |
| `kill_switch_platform` | 2, 8b | the operator's switch blocks every model, or this one |
| `kill_switch_firm` | 2, 8b | the firm's switch blocks every model, or this one |
| `policy_denied` | 5 | the classification may not go to `ai-gateway` (no executed DPA, or out of region at rank 4; `data/provider_dpa.json` is empty until O-21 is recorded, so only `public` and `internal` reach a provider) |
| `not_minimised` | 5 | at rank 3 and above, the masked body or purpose would still be masked again |
| `model_unpriced` | 6 | the routed model has no price |
| `budget_not_set` | 7 | the firm has no valid monthly budget |
| `budget_exhausted` | 7, 8b | the call's worst case does not fit beside the month's spend and holds (audit F07) |
| `no_credentials` | 8 | no `AI_GATEWAY_API_KEY` |
| `accounting_indeterminate` | 8b | the firm has a provider attempt whose lease lapsed unsettled (until the reconciler settles it), or a reservation the reconciler quarantined (until an operator settles it) (audit F08) |
| `concurrency_exhausted` | 8b | the firm already holds `maxConcurrentCalls` live reservations (default 4) (audit F07) |
| `reservation_failed` | 8b, 8c | the reservation or the provider-attempt record could not be written, so nothing was sent (audit F07, F08) |

A provider failure is not a block: the outcome is `failed` and the reason `transport_error`, charged by step 9's rule.

## Collections and documents

All are server-only: `firestore.rules` denies every client read and write (partners read through `getAiUsage`). One query needs a composite index (`firestore.indexes.json`): the reservation transaction's `ai_reservations` by `firmId` and `state` (`in` reserved, reconcile_failed). The reconciler's query (`state == "reserved"` in document-id order) is served by the single-field index.

| Path | Holds |
| --- | --- |
| `ai_usage_logs/{auto id}` | one row per P1 decision: `firmId`, `actorId`, `matterId`, `jobId`, `taskType`, `provider`, `model`, `classification`, `outcome`, `blockReason`, `inputTokens`, `outputTokens`, `tokensEstimated`, `costMicroUsd`, `fxPkrPerUsd`, `costPkr`, `monthKey`, `trace: { id, status }`, `createdAt`. No prompt or response text. |
| `ai_usage_months/{firmId}_{monthKey}` | the month total: `spentMicroUsd`, token totals and `calls: { ok, failed, blocked }` |
| `ai_budget_alerts/{firmId}_{monthKey}_{70\|90}` | one alert per threshold per month |
| `ai_config/{firmId}` | `monthlyBudgetMicroUsd`, `pkrPerUsd`, `killSwitch`, `maxConcurrentCalls` (server-set, audit F07) |
| `ai_reservations/{usageLogId}` | one per call that passed step 8 (audit F07, F08): `firmId`, `actorId`, `matterId`, `jobId`, `taskType`, `model`, `classification`, `provider`, `traceId`, `usageLogId`, `monthKey`, `reservedInputTokens`, `reservedOutputTokens`, `reservedMicroUsd`, `state` (`reserved`, `settled`, `released` or `reconcile_failed`), `leaseUntil`, `createdAt`; then `providerAttempt` (`attemptedAt`, `outcome` `pending` or `returned`, and after the call `returnedAt`, `result`, the token counts, `tokensEstimated`, `costMicroUsd`, `responseId?`, `requestId?`); when closed, `actualMicroUsd`, `exceededMicroUsd` (only when the charge passed the hold), `settledAt`, `settledBy` (`gateway` or `reconciler`); after a failed reconciler run, `reconcileFailures`, `lastReconcileError` (a code) and, once quarantined, `quarantinedAt`. No prompt or response text. |
| `platform/p1` | the platform `killSwitch` |

`committeeBrain` also writes `committee_outputs/{id}` in the Next.js shape (`id` and `createdAt` in epoch milliseconds), plus `usageLogId` and `traceId`. The write makes up to 3 attempts on a non-HTTP error (waits of 100 and 200 ms between them). An attempt that fails with ALREADY_EXISTS after an earlier attempt's commit was lost finds the row by its `usageLogId` and is a success. A write that fails for good answers 500 after the provider call (O-58).

## Events and audit

Each decision writes one `events` row (`ai.call.completed`, `ai.call.failed` or `ai.call.blocked`, payload `traceId`, `task`, `model`, `classification`, `costMicroUsd`, `blockReason?`) and one `audit_log` row (`ai.gateway.decision`, allow or deny, target `ai_usage_logs/<id>`). There is no `ai.call.requested` (E-48). A `committeeBrain` request therefore leaves three audit rows: the permission check's `ai.call` decision, the route's `ai.call` row, and the gateway's `ai.gateway.decision`. The setters audit as `ai.budget.set`, `ai.kill_switch.set` and `ai.platform_kill_switch.set`. A reservation the reconciler settles gets its missing usage row (outcome `reconciled`), the event `ai.call.reconciled` (id `{usageLogId}_reconciled`, same payload) and an audit row `ai.gateway.reconciled` (actor `system`, reason `recorded` or `worst_case`).

## Lease reconciler (audit F07, F08)

`p1ReservationReconciler` (`reconciler.ts`) runs every minute in `asia-south1`. It follows the job sweeper's pattern: a pinned 45 s timeout, a 30 s wall-clock budget checked before each page and each reservation, and no retry count, because the next minute's run is its retry. It pages through every reservation still `reserved`, in document-id order with a cursor, 100 a page and at most 5 pages a run, and acts on those whose lease has passed (re-audit R1-D2).
- **Leases are read in code.** So a lease in any shape is seen: a Timestamp or a number of milliseconds is compared with the clock, and anything else counts as lapsed. The gateway always writes a Timestamp, so no live call owns such a record.
- **A failed record never stops the run.** The cursor moves past it.

Each lapsed reservation is handled in its own transaction that re-reads it:

- **No `providerAttempt`.** Nothing was sent. The reservation is released: its hold leaves `reservedMicroUsd` and it takes `state: "released"`, `actualMicroUsd: 0`. No usage row is written.
- **A `providerAttempt`.** The reservation is settled through the same staging as a call's commit. The charge is the one the attempt recorded after the provider answered, when it did (`reconciledFrom: "recorded"`). Otherwise it is the reserved worst case: the input ceiling and the 4,096-token ceiling, with `tokensEstimated: true` (`reconciledFrom: "worst_case"`). The usage row is the call's own id, so a late commit of a live call can never add a second row or charge. A charge above the hold takes the excess path described under the bound.
- **Malformed records.** Fields a settlement can do without are defaulted: a missing `traceId` is recorded as null, a missing actor as `system`, and an unreadable classification as the strictest label (`privileged-restricted`). A record whose firm, month (`YYYY-MM`) or hold (`reservedMicroUsd`, a non-negative integer) cannot be read fails, because settling it would mean guessing what to take off which month total.
- **Quarantine.** Each failed run is counted on the record (`reconcileFailures`, `lastReconcileError`). At the third (`RECONCILE_MAX_FAILURES`) the record is quarantined: `state: "reconcile_failed"`, `quarantinedAt`, and `logger.error("p1.reconcile_quarantined", { firmId, usageLogId, failures, code })`. It keeps its hold. Its firm is refused `accounting_indeterminate` until an operator settles it: fail closed, because the firm's accounting really is unknown.

### Runbook: settling a quarantined reservation

There is no route for this. It is an operator action with the Admin SDK or the Firestore console, on `ai_reservations/{usageLogId}`, recorded in the incident log.

1. **Find it.** The `p1.reconcile_quarantined` log line names the firm and the id. `lastReconcileError` gives the code: `reservation_malformed` means a firm, month or hold that cannot be read.
2. **Preferred: repair and requeue.**
   - Correct the unreadable field from the evidence: the `committee_outputs` row with this `usageLogId`, the month total, and the Gateway's records for `providerAttempt.responseId` or `requestId`.
   - Set `state` back to `"reserved"` and `reconcileFailures` to 0.
   - The next minute's run settles it through the normal path: usage row, month total, audit row and event.
3. **Otherwise, settle it by hand in one transaction:**
   - create `ai_usage_logs/{usageLogId}`: outcome `reconciled`, `reconciledFrom: "manual"`, and the charge the Gateway's records show (or the reserved worst case if they show none);
   - add the charge to the month's `spentMicroUsd`, and take the reservation's original hold off `reservedMicroUsd`;
   - set the reservation to `state: "settled"` with `actualMicroUsd` and `settledBy: "operator"` (or `state: "released"` with `actualMicroUsd: 0` if the provider was never called);
   - write an `audit_log` row `ai.gateway.reconciled` (actor: the operator's uid; reason `manual`).
4. **Confirm.** The firm's next call must no longer be refused `accounting_indeterminate`.

The Gateway gives this code no per-request receipt, so no charge is matched against the provider's own bill here. The attempt keeps the provider's `responseId` and the Gateway's `requestId` so this can later be done per request. That remains O-57: reconcile `costMicroUsd` against the Gateway's records at G-1.

## Trace (Opik)

One trace per decision, posted to `{OPIK_BASE_URL}/v1/private/traces/batch`. The trace id is a UUIDv7 and is the usage row's `trace.id`. Ranks 0 to 3 carry the masked outbound body and the masked response; rank 4 and blocked calls carry metadata only (E-49). Export has a 2-second timeout and is fail-open: a failed export never fails the call, the row records `trace.status` (`exported`, `failed` or `disabled`) and the failure is logged as `p1.trace_export_failed`.

## Test seams

`p1TestSeam` (`gateway.ts`: `beforeCommit`, `failCommit`, `modelOverride`, `wallClock`, `commitAttemptFailures`, `lostCommitAnswers`, and for audit F07/F08 `reserveAttemptFailures`, `attemptMarkFailures`, `crashAt`, `unqueued`), `p1OpsTestSeam` (`ops.ts`: `outputWriteFailures`, `lostCommitAnswers`, `sleep`), `setP1TransportForTests` (`transport.ts`) and `setOpikFetchForTests` (`opik.ts`) exist for tests only. Production code never references them. As defence in depth, the first two are inert and the last two throw when `NODE_ENV` is `production`, and the deployable bundle (`lib/index.js`) is built with `NODE_ENV` defined as `"production"` (`functions/build.mjs`), so they stay inert there whatever the host sets.

## Tests and gate

`functions/test/p1.units.test.ts` and `p1.transport.test.ts` need no emulator. `p1.gateway.emu.test.ts` and `p1.api.emu.test.ts` run under the Auth and Firestore emulators, with a local HTTP server standing in for the Gateway. `f07-f08-ai-spend.e2e.emu.test.ts` is the end-to-end proof for audit findings F07 and F08, through `callP1` and through the HTTP router. It fails on the code before the fix: ten calls against a 100 micro-USD budget committed 140,000 micro-USD, and a failed usage commit left no record. The rules are covered by `tests/firestore.rules.p1-phase3d.test.ts` and the new permission actions by `tests/p5.permission-ai-actions.test.ts`. `npm run gate:g4:phase3d` (`ci_gates/gate_g4_phase3d.sh`) checks route coverage, runs the named P1 tests (and the bundle's `NODE_ENV` test in `deploy.test.ts`) by exact name, lints `functions` at zero warnings and runs G-2; it runs in CI after the Phase 3c gate.

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
