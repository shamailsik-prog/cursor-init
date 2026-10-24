# FA-D3C-001 and FA-D3C-002: no headless browser in the corpus runtime, and corpus embeddings through P1 (design)

**Findings** (`docs/audit/2026-10-14-forensic-audit-v2.md`, lines 128-129, remediation order line 177):

- **FA-D3C-001 HIGH** `corpus_service/requirements.txt:11`: Playwright in the app repo (OR-4, L17.12).
- **FA-D3C-002 HIGH** `corpus_service/scraper/tasks/embeddings.py:14-15`: a direct OpenAI call outside P1.
- Remediation order (v2 :177): "FA-D3C-001/002 (move corpus_service out or route via P1)."

Written against `origin/main` f39d007. Line numbers below are main's.

## 1. The rules these findings apply

**OR-4** (v2 audit §2, line 37) is the audit's full-tree "scraper" grep: "OR-4 scraper: `corpus_service/requirements.txt:11 playwright`, `corpus_service/Dockerfile:5 playwright install chromium`, `scraper/config.py:129-131 PLAYWRIGHT_ENABLED=True`. Architecture Layer 18 W-6 (v19 txt ~L7929-7932): 'The corpus service is a separate repository (Layer 17 L17.12)'. FAIL." The same section (line 38) records the second failure: "Provider SDKs outside P1: `corpus_service/scraper/tasks/embeddings.py:14-15`. FAIL."

**L17.12** (`docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt`, line 7309), External Corpus Service Governance: "Purpose. Keep the corpus service outside the application, lawful in its sources, and compliant with the interface contract — so that the application's 'no scraper ships in the product' decision remains true in fact and not only in wording." Step 65 (line 7317): "Deployment boundary: separate repository, separate cloud project, separate credentials; the application holds only a read-only connection string to the corpus (Module 10)." Step 70 (line 7331): "Embedding model: one model, recorded in corpus metadata".

**Layer 18 W-6** (lines 7922-7932): "v11.1 N1 puts supremecourt.gov.pk and sindhhighcourt.gov.pk in the in-app allowlist and bans Playwright by CI. … the external corpus service, which legitimately uses Playwright. Banning Playwright repo-wide would forbid the corpus service if it shares the repo. … The corpus service is a separate repository (Layer 17 L17.12); the CI rule applies to the app repository." Layer 18 §10 (line 8465): "scraper guard (app repo) Any HTTP fetch to a host outside the L4.9 allowlist, or any Playwright/Puppeteer import in the app".

**Proposed erratum E-25** (`docs/architecture/ERRATUM_SET_2_PROPOSED.md`, line 42): `corpus_service/` moves out of this repository; "The Layer 18 CI rule banning Playwright applies to the application repository only; once `corpus_service/` has moved, it applies with no exemption."

**P1 is the only path to a provider.** `functions/src/p1/README.md` line 3: "A layer that needs a provider calls `callP1` with a classification and never calls a provider itself (Layer 18 §9, rule 6)." The pipeline (P3-61) is: classification guard, kill switch (platform, then firm), route, outbound mask, provider policy (`providerAllowedFor("ai-gateway", classification)`; at rank 3 and above `assertMinimised`), price, budget, credentials, reservation (F07), provider-attempt record (F08), transport, attempt outcome, trace, and one commit transaction (usage row, month total, alerts, audit row, event, reservation settled). L17.3 step 21 (line 6993): "P1 receives the composed prompt with its aggregate classification … privileged only to providers under an executed DPA"; step 19 names `embedding_row` as a classified artefact.

**What "app repo" and "P1 gateway" require here.** While `corpus_service/` sits in this repository it is in the app repository, so the Layer 18 scraper guard applies to it with no exemption, and every paid model call it makes must pass the same controls as any other paid call: the kill switches, a budget reservation and settlement, a row in the P1 ledger, the provider policy, and the outbound mask.

## 2. What main does today

**FA-D3C-001.**

| Where | What |
|---|---|
| `corpus_service/requirements.txt:13` | `playwright` |
| `corpus_service/Dockerfile:5` | `pip install -r requirements.txt && playwright install chromium --with-deps` |
| `scraper/config.py:236-238` | `PLAYWRIGHT_ENABLED` (default True), `PLAYWRIGHT_HEADLESS`, `PLAYWRIGHT_TIMEOUT_MS` |
| `scraper/config.py:625` | `"PlaywrightTimeoutError"` in the Seat B failover names |
| `ci_gates/g0_guard_allowlist.json` | `fa_d3c_001_scraper`: `corpus_service/requirements.txt:playwright`, `corpus_service/Dockerfile:playwright_install` (G-0 [2] passes only by this allowlist) |

Nothing imports Playwright. An AST walk of the runtime roots (`scraper/`, `migrations/`, `bootstrap_harvest.py`) finds no `playwright` import, and `PLAYWRIGHT_*` is read nowhere. Since audit F25, `tests/test_f25_fetch_guard.py` forbids importing `playwright`, `pyppeteer` or `selenium` in any non-test corpus module, and every routed harvester takes its client from `fetch_policy.fetcher_for`. So the runtime installs a browser and about 150 MB of Chromium dependencies that no code can use.

**FA-D3C-002.** `process_embedding_queue` (`scraper/tasks/embeddings.py:839-851`):

```python
if not settings.OPENAI_API_KEY:
    ... return {**counts.summary(outcomes.OUTCOME_SKIPPED), "reason": "no_openai_api_key"}
import openai
client = openai.AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
await _Batch(client, counts).run()
```

`_Batch._attempt` (line 628) calls `self.client.embeddings.create(model=row.embedding_model, input=value)`. F27 put the work under a lease and records each request in the corpus database (`embedding_attempts`), but the request goes from the corpus worker straight to OpenAI with a key the corpus holds. No kill switch, budget, P1 ledger row, provider policy or mask sees it. `openai` is in `requirements.txt:20`; `ci_gates/g0_guard_allowlist.json` `fa_d3c_002_provider` allowlists both; `ci_gates/check_next_ai_egress.py` (G-0 [19]) exempts `corpus_service/` from rules (a)-(d) for the same reason; compose hands `OPENAI_API_KEY` to `worker-embed`.

## 3. Rulings

Each ruling records the decision and the reason (owner's standing instruction).

### FA-D3C-001

**R1. Playwright leaves the corpus runtime; its dead configuration is deleted.** `playwright` leaves `requirements.txt`, the Dockerfile no longer installs Chromium, and `PLAYWRIGHT_ENABLED`, `PLAYWRIGHT_HEADLESS`, `PLAYWRIGHT_TIMEOUT_MS` and the `PlaywrightTimeoutError` failover name are deleted rather than defaulted to False. *Reason:* nothing reads them (section 2), and a setting that switches on a browser nobody wires is exactly the "true in wording, not in fact" gap L17.12 forbids. `Settings` has `extra="ignore"`, so a deployment that still sets `PLAYWRIGHT_*` starts as before.

**R2. No separate browser harvester image now.** No harvester needs a browser: every routed source is fetched by the F25 boundary over plain HTTPS, and F25 forbids browser modules. *Ruling against OR-4 and L17.12:* if a source ever needs a rendered page, the browser belongs in the separate corpus repository (L17.12 step 65, W-6), or at the least in a separate, optional harvester image and requirements set that the `api`, `worker-embed`, `celery-beat` and `migrate` images never install. It never returns to `requirements.txt` or `Dockerfile` while `corpus_service/` sits in this repository. Moving `corpus_service/` out (E-25) is a partner decision with infrastructure and is not done here.

**R3. The guard.** (a) The two `fa_d3c_001_scraper` allowlist entries are removed, so G-0 [2] (`check_scraper_libraries.py`, full tree) fails if Playwright or Puppeteer returns to any corpus requirements file, Dockerfile, shell script or import (its stale-entry rule would fail the build anyway once the findings are gone). (b) A corpus test, `corpus_service/tests/test_fa_d3c_runtime_boundary.py`, run by the existing `corpus-service` CI job, fails on a wider set of headless-browser distributions (Playwright, Pyppeteer, Selenium, SeleniumBase, undetected-chromedriver, Splinter, Helium, requests-html, nodriver, zendriver, Camoufox, Botasaurus, browser-use) in any corpus requirements file, a browser install (`playwright install`, a Chromium, Chrome, Firefox or chromedriver/geckodriver package) in any corpus Dockerfile, a browser module imported by any runtime module, and a browser setting in `Settings`.

### FA-D3C-002

**R4. Option (a): the corpus calls a P1 endpoint in Cloud Functions.** *Reason:* the architecture's rule is that a layer "never calls a provider itself" (P1 README, Layer 18 §9 rule 6), and P1 is where the kill switches, the reservation, the ledger, the provider policy and the mask already live. Option (b), a Python P1 client writing the same Firestore control documents, would duplicate each of those policies in a second language and give the corpus service write credentials to the application's Firestore, against L17.12 step 65 ("separate cloud project, separate credentials"). Under (a) the corpus holds one thing: an identity that may invoke one function.

**R5. `callP1Embedding` (`functions/src/p1/embedding.ts`) runs P1's pipeline on the shared ledger code.** Order, first refusal wins: classification guard (throws); kill switch, platform then firm, on the routed model; route (the corpus model name to a Gateway model, `EMBEDDING_ROUTES`); outbound mask; provider policy (`providerAllowedFor("ai-gateway", classification)`, and `assertMinimised` at rank 3 and above); price; budget first look; credentials; the reservation (gateway.ts `reserve`, with an output ceiling of 0 tokens); the provider-attempt record (`markAttempt`); the transport; the attempt outcome (`recordAttemptOutcomeRetrying`); the trace (fail-open); the commit (`commit`, which stages the usage row, the month total, threshold alerts, the audit row `ai.gateway.decision`, the event `ai.call.*` and the reservation's settlement). The lease reconciler settles a lapsed embedding reservation by its existing path: it reads `taskType`, `reservedOutputTokens` and the hold from the reservation. gateway.ts changes are additive: `reserve`, `markAttempt`, `recordAttemptOutcomeRetrying` and `commit` are exported, `reserve` takes an optional output ceiling (default `MAX_OUTPUT_TOKENS`, so `callP1` is unchanged), and the ledger's task type widens to `LedgerTaskType = TaskType | "embedding"`. `TASK_MODEL` is not touched: G-0 [17] binds it to the committee evaluation set, which says nothing about embeddings. *Steelman:* "a second entry point is a second chokepoint." *Answer:* the policy is not duplicated. Every check calls the same functions on the same documents, and the reservation, settlement, reconciler, ledger queue and month total are the same code. The precedent is `callP1Ocr` (`ocrCall.ts`), P1's admission for another modality.

**R6. The firm the corpus spends is fixed server-side.** `P1_CORPUS_FIRM_ID` in the Functions deployment names the firm whose P1 ledger, budget and kill switch govern corpus embeddings. The request cannot name a firm. *Reason:* L17.12 calls the corpus "the firm's store", and partners already see and set that firm's spend, budget and kill switch (`getAiUsage`, `setBudgetAlerts`, `setAiKillSwitch`), so corpus spend is visible and controllable with no new route. A firm taken from the request would let one leaked corpus credential spend any firm's budget. *Steelman:* a platform-only ledger. *Answer:* no route, rule or report manages a firm-less budget, so it would be spend nobody sees. Revisit if one corpus ever serves several firms (residual).

**R7. Actor, caller and classification.** The actor is `system` (P1's documented non-user actor). The usage row also carries `caller` (the verified service account email) and `corpusOperationId` (F27's operation id), so a P1 charge can be matched to the corpus receipt. The request must carry a known classification label. The corpus sends `public`: its master tables hold published public law, and Annex A's `judgment.classification` defaults to `public`. With `data/provider_dpa.json` empty, P1 refuses rank 2 and above (`policy_denied`).

**R8. The outbound mask applies.** The input is masked (`maskOutboundPII`, no party names: the corpus has no matter) before it reaches the transport, and the residual detector's counts are recorded. *Reason:* P1's invariant is that no unmasked text reaches a transport. F27's operation id is still computed by the corpus over the text it composed (F45 owns that representation). The stored vector embeds the masked text. For published law the masked spans are CNICs, phone numbers, emails, IBANs and labelled NTNs and passports, which carry no retrieval value (consumer impact, section 6).

**R9. Authentication, in two layers.** (i) The platform layer: `p1CorpusEmbedding` is IAM-private (`invoker: "private"`) with ingress `ALLOW_ALL`, because the corpus runs in a separate cloud project (L17.12 step 65) and internal-only ingress could not reach it. The deployment grants `roles/run.invoker` on this one function to the corpus service account. (ii) The code layer: the handler verifies the Bearer token itself. It must be an RS256 Google-signed OIDC ID token whose key is found by `kid` in Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`, fetched with a 2 s timeout, redirects refused, cached for its `max-age` up to 1 h). The issuer must be `accounts.google.com`, the audience `P1_CORPUS_AUDIENCE`, the token unexpired with 60 s of skew and a lifetime of at most 1 h, `email_verified` true, and the email listed in `P1_CORPUS_CALLERS`. The code layer exists because project-level `run.invoker` holders (owners, editors) can invoke any private service, so only the allowlist confines spend to the corpus identity. It is also the only layer the emulator enforces, so it is what the e2e proves. The verifier uses `node:crypto` and adds no dependency: `functions/package.json` declares no JOSE library, an undeclared import of firebase-admin's transitive `google-auth-library` is fragile, and a lockfile change needs `npm install`, which this lane may not run. *Steelman:* use `google-auth-library`. *Answer:* that is the better long-term choice. Declaring it and swapping the verifier is a follow-up (section 8). The verifier here is small, fails closed on every branch and is mutation-tested.

**R10. The HTTP contract.** The handler accepts POST only (405), `application/json` only (415), and a body of at most 64 KiB (413). The body is a JSON object with exactly `operationId` (64 lowercase hex), `model` (a routed corpus model, `text-embedding-3-small`), `dimensions` (the route's, 1536), `input` (1 to 8,000 characters) and `classification`; anything else is 400. When the firm, audience or caller list is unset, the answer is 503 `not_configured` and nothing is read or written. Every P1 decision answers 200 with `{ outcome, blockReason, embedding?, dimensions, model, modelReported, inputTokens, tokensEstimated, costMicroUsd, usageLogId, traceId, accounting }`. Request faults answer 400, 401, 403, 405, 413 or 415, an unavailable key set 503 `identity_keys_unavailable`, and anything else 500 `internal`. No provider text is ever returned.

**R11. The embedding transport** (`functions/src/p1/embeddingTransport.ts`). It POSTs `{ model, input }` to the Gateway's OpenAI-compatible `https://ai-gateway.vercel.sh/v1/embeddings` (Vercel docs, "OpenAI-Compatible Embeddings API") with the Bearer `AI_GATEWAY_API_KEY`. Redirects are refused and the timeout is 20 s. Errors carry a fixed code (`gateway_timeout`, `gateway_request_failed`, `gateway_status`, `gateway_not_json`, `gateway_no_embedding`) and the chat transport's billable rule: a timeout, a non-JSON 2xx or a 2xx without a usable vector may have been billed; a non-2xx or a request that never left cannot. The transport is built only in the Functions runtime (`inFunctionsRuntime`) with a key; otherwise the call is `no_credentials`. `setP1EmbeddingTransportForTests` is refused in production.

**R12. Price and bound.** `MODEL_PRICES` gains `openai/text-embedding-3-small`: 20 nano-USD per input token (`"pricing": {"input": "0.00000002"}`, `GET https://ai-gateway.vercel.sh/v1/models`, fetched 2026-10-24), output 0, `inputOverheadTokens` 16 (unverified until G-1). The reservation holds `ceil((bodyTokenCeiling(masked input) + overhead) x 20 / 1000)` micro-USD with an output ceiling of 0. A vector that is not exactly the route's dimensions of finite numbers is a billed failure: the provider answered.

**R13. The corpus client** (`scraper/p1_client.py`). `embedding_client()` returns None when `P1_EMBEDDING_URL` is empty; then the batch is skipped exactly as main skips with no key, with the reason `no_p1_embedding_url`. Otherwise its `embeddings.create(model, input, operation_id)` POSTs through the F25 boundary (`fetch_policy.p1_fetcher`: https, port 443, a host under `.run.app` or `.cloudfunctions.net`, public addresses only, no redirect, a 1 MiB body cap and a 100 s deadline, longer than the function's 90 s). The Bearer token is read fresh on every call from `P1_ID_TOKEN_FILE` (default `/run/secrets/p1_id_token`), which the deployment keeps current. The one call site in `_attempt` passes F27's operation id (`operation_id=op`).

**R14. Refusal semantics at the seam.** A P1 refusal sends nothing to any provider, so it is not an attempt. The refusals are: a `blocked` outcome; a 401 or 403; a 503 `not_configured`; a missing identity token; and an F25 refusal of the P1 URL. Each raises `P1Refused(reason)` and the batch stops. The row in flight is not charged (attempts unchanged). Its `started` receipt is closed `failed` with `error_type` `p1_refused`, not answered and with no tokens. R10's give-back returns every claimed row to `pending`, and the refused request is not counted in `provider_calls`. The batch returns the tally's outcome (`skipped` when nothing was attempted) with `reason: "p1_refused:<code>"`, and F28's run record records it like any completed batch. A P1 `failed` outcome, an unreachable P1, a timeout, a 5xx other than `not_configured`, and a 400 are an ordinary failed attempt, charged under R8 exactly as main charges a provider failure. *Steelman:* charge every refusal as main charges a provider failure, with fewer moving parts. *Answer:* a kill switch or an exhausted budget would then dead-letter the whole queue within five attempts (about 75 minutes of backoff). A switch meant to pause spend would destroy queue state, and R8 charges an attempt, which a refusal is not.

**R15. The corpus holds no provider key or SDK.** `OPENAI_API_KEY` is deleted from `Settings` and its redaction list. `openai` leaves `requirements.txt` and the F31 alias table. Compose hands `worker-embed` `P1_EMBEDDING_URL` (optional, empty = off) and no key. `.env.example` and `app.env` stop naming a provider key. A deployment that enables embeddings mounts the token as the compose secret `p1_id_token` in its override file (README).

**R16. The guards.** (a) The two `fa_d3c_002_provider` allowlist entries are removed, so G-0 [3] holds `corpus_service/` to no provider SDK import or requirement. (b) G-0 [19] (`check_next_ai_egress.py`) drops its `corpus_service/` exemption from rules (a)-(d), so a corpus compose file, Dockerfile or env file that names a provider key fails, as for Next. (c) `test_fa_d3c_runtime_boundary.py` also fails on a provider key setting in `Settings`, a provider host literal in runtime source, an F25 policy that admits a provider host, and a P1 fetcher that admits anything outside the Google serverless suffixes on 443.

**R17. The end-to-end proof runs through the real path.** `corpus_service/tests/test_fa_d3c_p1_embedding_e2e.py`, driven by `corpus_service/tests/e2e/p1_embedding_e2e.sh`, uses the real beat task, real Postgres, the real F25 boundary and the real `p1CorpusEmbedding` HTTP function in the Functions emulator. The test bundle (`functions/test/harness/fa-d3c-p1-emulator-entry.ts`) is the real export with two test seams set: a deterministic fake embedding transport that records each call in Firestore, and a test OIDC key set. The corpus reaches the emulator through a local TLS front, because the boundary allows https only, using F25's own test hooks. RED on main: the corpus code from `origin/main`, the real `openai` SDK (installed into a scratch `--target` directory) and `OPENAI_BASE_URL` pointing at a recording tripwire; the tripwire receives the direct requests and the P1 ledger stays empty. A CI job modelled on `authority-f05` runs the script.

## 4. Adversarial check

- **"Removing Playwright breaks a future JS-only court portal."** That is true, and it is the point: a browser in this repository is what OR-4 fails. R2 says where one would go.
- **"The corpus can still reach OpenAI with httpx."** It cannot: F25's guard forbids any HTTP client outside the boundary, and the boundary's registry admits no provider host (R16 c tests it).
- **"A blocked call per batch floods `ai_usage_logs`."** A batch stops at its first refusal, so a held kill switch costs one `blocked` row per beat tick (5 minutes).
- **"P1 is down for hours and rows dead-letter."** This is unchanged from main with OpenAI down. R14 keeps provider-side failures charged on purpose (F27 R8). Only P1's own decisions to refuse are batch stops.
- **"The token file is a new secret on disk."** It is a short-lived (1 h), audience-bound ID token rather than a long-lived key, and it replaces `OPENAI_API_KEY`, which was a long-lived key with spend authority.
- **Bias check.** Two premises are untested here. That Cloud Run passes the validated `Authorization` header through to the handler is [REQUIRES VERIFICATION] at deploy. That the Gateway's embeddings endpoint reports `usage.prompt_tokens` as in Vercel's documented example is [REQUIRES VERIFICATION] at G-1 (O-57); without it the charge is estimated at ceil(bytes / 3) and flagged `tokensEstimated`.

## 5. Tests (each e2e fails on main and passes on the branch)

| # | Test | Path | Expect on main |
|---|---|---|---|
| T1 | corpus runtime boundary guard | `corpus_service/tests/test_fa_d3c_runtime_boundary.py` | FAIL (playwright requirement, Chromium install, browser settings, provider key setting, openai requirement) |
| T2 | G-0 [2]/[3] with empty FA-D3C allowlists | `ci_gates/check_scraper_libraries.py`, `check_provider_imports.py` | FAIL on main's corpus files |
| T3 | G-0 [19] covers corpus deploy surfaces | `tests/f18-next-ai-egress-gate.test.ts` (corpus row flipped) | FAIL (corpus exempt) |
| T4 | P1 client unit tests | `corpus_service/tests/test_fa_d3c_p1_client.py` | FAIL (no module) |
| T5 | service auth unit tests | `functions/test/fa-d3c-service-auth.test.ts` | FAIL (no module) |
| T6 | embedding transport unit tests | `functions/test/fa-d3c-embedding-transport.test.ts` | FAIL (no module) |
| T7 | `callP1Embedding` and the HTTP handler under the Firestore emulator | `functions/test/fa-d3c-embedding.emu.test.ts` | FAIL (no module) |
| T8 | e2e: corpus to P1 in the Functions emulator, real Postgres | `corpus_service/tests/test_fa_d3c_p1_embedding_e2e.py` | FAIL (tripwire sees direct requests; P1 ledger empty) |

The F27 and F28 suites keep their assertions; their provider stand-in moves from `sys.modules["openai"]` to the new seam (section 6).

## 6. Consumer impact

- **Deployment.** Embeddings need `P1_EMBEDDING_URL`, a mounted `p1_id_token`, and the Functions env `P1_CORPUS_FIRM_ID`, `P1_CORPUS_AUDIENCE`, `P1_CORPUS_CALLERS` and `AI_GATEWAY_API_KEY` bound to `p1CorpusEmbedding`. Without them embeddings are skipped (corpus) or refused 503 (Functions), and nothing is spent. `OPENAI_API_KEY` is no longer read.
- **The firm's budget.** Corpus embeddings count against the firm's monthly P1 budget, kill switch and live-reservation limit, and appear in `getAiUsage` (calls, tokens, micro-USD).
- **Vectors.** Masked identifiers in published text change those vectors slightly (R8). The model and dimensions are unchanged, so existing vectors stay comparable.
- **Image.** The corpus image no longer carries Chromium (about 150 MB less), Playwright or the OpenAI SDK.
- **Tests.** The provider stand-in in `test_f27_embedding_claims_e2e.py`, `test_f27_embedding_prefork_e2e.py`, `test_f28_source_outcomes_e2e.py` and `test_f28_fu_e2e.py` is installed at `p1_client.embedding_client` instead of `sys.modules["openai"]`, and accepts `operation_id`. The pinned export lists in `functions/test/p2.boot.test.ts`, `p5.identity.test.ts`, `runtime-options.test.ts` and `g2.cross-firm.test.ts` gain `p1CorpusEmbedding`. The F18 gate test's corpus row now expects findings.

## 7. Not in scope

F45 (the embedding representation), F46-F48, `scraper/tasks/pakistancode.py` (FA-F21-017), `functions/src/health.ts` (F44), `firestore.rules` (Cursor F32 follow-up), and moving `corpus_service/` to its own repository (E-25).

## 8. Residuals and follow-ups

- Live deployment is NOT DEMONSTRATED: the IAM invoker binding, Cloud Run passing the `Authorization` header, a real Google ID token, the Gateway's real embeddings answer, and the deployment's token refresher.
- No P1-side de-duplication by operation: an answer lost between P1 and the corpus is paid again on retry, as on main. Both charges are in the P1 ledger, keyed by `corpusOperationId`.
- Follow-up: declare `google-auth-library` in `functions/package.json` (a lockfile change) and swap the verifier for its `OAuth2Client.verifyIdToken`.
- Follow-up: E-25, moving `corpus_service/` to its own repository and cloud project.
