# F24: bounded, published-only public corpus queries

Date: 2026-10-18. Base: `origin/main` @ 1f0cc27. Status: approved by the remediation builder under the owner's standing autonomy instruction (brainstorming self-approved and recorded here). The orchestrator's design intent is kept as numbered rulings below; where the code required a refinement, the ruling says what changed and why.

Audit sources:
- `docs/audit/2026-10-13-forensic-audit.md` F24 (:550) and its threat row (:992).
- `docs/audit/REMEDIATION.md`: rule 1 (fix-first freeze), rule 2 (closed = merged PR with an end-to-end test of a real user flow, RED before and GREEN after), rule 3 (ticked only after an independent re-audit). This document claims neither closure nor a tick.

Scope: `corpus_service/scraper/routers/search.py`, `corpus_service/scraper/routers/export.py`, two new modules (`scraper/public_corpus.py`, `scraper/rate_limit.py`), one additive settings block in `scraper/config.py`, the reviewed read-only allowlist in `tests/test_trust_policy.py`, new tests, and the corpus README. Not touched: `scraper/tasks/*` (F25 builder), `conftest.py`, `requirements*.txt`, `main.py`, every file owned by PRs #44 and #47, and `app/api/**`.

## 1. Root cause, traced from the code (main @ 1f0cc27)

`scraper/routers/search.py` is mounted without authentication ("Intentionally unauthenticated", :6-8):

| Route | Code on main | Problem |
| --- | --- | --- |
| `GET /search` (:10-13) | `q: str = Query(...)`, `limit: int = 10`; `select(CaseLawMaster).where(or_(citation.ilike(f"%{q}%"), case_title.ilike(f"%{q}%"))).limit(limit)` | `limit` is any integer (1,000,000,000 is accepted). `q` is interpolated into the LIKE pattern unescaped, so `q='%'` or `q='_'` matches every row. `select(CaseLawMaster)` loads every column, including `full_text`, `full_text_urdu` and the 1536-float `embedding`, and FastAPI serialises all of them (pgvector returns the vector as a JSON-encodable `list[float]`). No `is_promoted` or trust predicate. No ordering, so no stable pagination. |
| `GET /cases/{id}` (:14-17) | `id: str`; `select(CaseLawMaster).where(CaseLawMaster.id == id)` | Any row, promoted or not, with full text and embedding. A missing row returns `200 null`; a malformed id reaches Postgres and fails as a 500 (`DataError`). |
| `GET /statutes` (:18-24) | `limit: int = 20`; optional `statute_name` interpolated into ILIKE | Same unbounded limit and unescaped pattern; every `statutes_master` row, with `section_text` and `embedding`, whatever its source's trust. |

`scraper/routers/export.py` (:10-26) is behind `require_admin_api_key`, but `r.scalars().all()` loads every `case_law_master` row as a full ORM object (text and embedding included) before the first byte is sent; the CSV branch then builds the whole file in one `StringIO`. Any `format` other than `jsonl` silently becomes CSV. No publication predicate.

No request runs with a statement timeout, and nothing limits how often an anonymous client may call these routes.

### What "published" means in these tables

- `case_law_master.is_promoted` (`models.py:292`, indexed `ix_case_law_is_promoted`) is the table's promotion marker. Every writer that ever promoted into it set it true: the pre-F19 promotion task (`git show f762d13:corpus_service/scraper/tasks/promotion.py`, `is_promoted=True`) and the manual reviewer route (`routers/quarantine.py:40`). Since F19 (#49) the promotion task publishes into Annex A instead and no longer writes `case_law_master`.
- `statutes_master` has no promotion column. Since F20 (#48) only the two `direct` dispatcher routes (PakistanCode, NationalAssembly) write it, and only for a source whose `trust_level` is exactly `trusted` (`trust.may_publish_directly`, `tasks/dispatcher.py:73-79`). Rows written before F20 may come from sources that were never trusted (the F20 re-audit found review sources writing 10 and 2 rows).
- FINAL_2 (`corpus_service/FINAL_CORPUS_SERVICE_PROMPT_2.md:231-232`): "Only review_status = 'promoted' rows are visible to research; the application shows quarantined rows to reviewers only."

### Consumers (checked before changing any contract)

`grep` over the repository (excluding `node_modules`) finds no HTTP caller of `/search`, `/cases/{id}`, `/statutes` or `/export/cases`:
- the draft gate's corpus reader (`functions/src/d4/corpusAuthorityStore.ts`) reads the Annex A `v_authority_*` views over Postgres, not this API;
- the admin dashboard (`scraper/templates/dashboard.html`) calls only `/health`, `/api/live-feed`, `/api/vault`, `/api/start`, `/api/stop`;
- `docs/` and the README mention the routes only as FINAL_2's planned surface (`FINAL_CORPUS_SERVICE_PROMPT_2.md:1156-1163`).

So no consumer relies on full rows, and no separate authenticated full-row path is needed. The contract changes in ruling 11 are recorded for any external caller.

## 2. Design rulings

### Ruling 1: one published-only query helper, failing closed

`scraper/public_corpus.py` is the only code that reads `case_law_master` / `statutes_master` for the public routes and the export. Its predicates:

- **Case law** is published when `is_promoted IS TRUE` **and** its `source_site` names a `scraper_sources` row whose `trust_level` is exactly `trusted` or `review`.
- **A statute section** is published when its `source_site` names a `scraper_sources` row whose `trust_level` is exactly `trusted`.

Anything else is unpublished and never returned: `is_promoted` false; a `blocked` source; a `source_site` that is NULL, empty, or names no source; any trust value outside the F20 vocabulary (the CHECK refuses them today, but a drifted row still fails closed because the test is an exact `IN` list built from `scraper.trust` constants). Staging and quarantine tables are never read.

Reasons:
- `is_promoted` is the only per-row review marker the table has, and FINAL_2 makes "promoted" the visibility rule.
- `review` stays visible for case law because FINAL_2's flow for a review source is quarantine, then a human promotion (`routers/quarantine.py`). Requiring `trusted` would hide every human-reviewed row.
- `blocked` is the owner's withdrawal of a source (FINAL_2 :252-253, "never harvested"); continuing to publish its rows would contradict it.
- An unresolvable source means the provenance of the row cannot be established. Annex A's own visibility rule (`postgres/ddl/004_authority_read_views.sql:11-17`) refuses a row without complete provenance; the legacy equivalent is a source that resolves.
- Statutes use `trusted` only because that is the only state in which F20 lets a `statutes_master` row be written at all.

*Why a query helper and not a database view.* A view needs DDL in `python -m scraper.migrate`, a `GRANT SELECT` to the runtime role in the PR 2b provisioning scripts, and new store-security e2e checks; it gives these routes no stronger guarantee than one helper that every route must use. The guard against a route bypassing the helper is the existing AST scan in `tests/test_trust_policy.py`: `scraper.routers.search` and `scraper.routers.export` leave its read-only allowlist and `scraper.public_corpus` joins it, so a future direct `CaseLawMaster` / `StatutesMaster` reference in either router fails that test.

*Steelman against ruling 1 (reviewer's strongest case).* Since F19 the authoritative published corpus is Annex A; the public API should read Annex A's promoted-only views, not a legacy table that only the manual-promotion route still writes. *Answer.* That is right as a destination and is recorded as follow-up 1. It needs the API's runtime role to gain a reader role on Annex A (provisioning, F05's reader allowlist, FA-DATA-003's unfiltered `corpus_reader` grants) and a new response shape built on `judgment`/`citation`: an architectural change the audit rates out of scope ("architectural redesign: No"). This PR closes the exposure on the routes that exist.

*Devil's advocate against ruling 1.* (a) `is_promoted` carries no review evidence: a pre-F20 auto-promotion of a then-`semi_trusted` source looks the same as a human review. F23 owns auditable manual promotion; this PR cannot manufacture evidence that was never recorded (residual 2). (b) Statute trust is read at query time: re-trusting a source re-exposes rows it wrote while untrusted (residual 3).

### Ruling 2: `limit` is 1-100; out of range is 422, never clamped

`limit: int = Query(default, ge=1, le=100)`. FastAPI rejects 0, negative, 101 and 1,000,000,000 with 422 before any database work. Defaults stay as on main: `/search` 10 (also FINAL_2 :1156), `/statutes` 20.

Refinement of the intent ("default 20"): keeping main's defaults changes nothing for callers that omit `limit`.

Why reject rather than clamp: a clamped page is indistinguishable from a short result; an explicit 422 makes misuse visible and keeps the contract testable.

### Ruling 3: query text is trimmed, bounded, checked and escaped

For `q` (`/search`, required) and `statute_name` (`/statutes`, optional):
- trimmed of surrounding whitespace, then 2-200 characters;
- refused when it contains a control character (Unicode category `Cc`, including NUL, which Postgres refuses in text and which would otherwise surface as a 500);
- refused when, after trimming, it consists only of LIKE metacharacters (`%`, `_`, `\`) and whitespace;
- then `\`, `%` and `_` are each escaped with a backslash and the pattern `%<escaped>%` is matched with `ILIKE ... ESCAPE '\'` (an explicit ESCAPE clause, not Postgres's default).

Violations are 422 with a fixed message that does not echo the input.

### Ruling 4: summary DTOs from explicit column lists

Lists select named columns only (no `select(Model)`), so the SQL never reads text or vector columns, and Pydantic response models serialise exactly those fields:

| DTO | Fields |
| --- | --- |
| `CaseSummary` (`/search` items) | `id`, `citation`, `case_title`, `court`, `year`, `reporter`, `decision_date`, `bench_type`, `case_type`, `is_overruled`, `is_landmark` |
| `CaseDetail` (`/cases/{id}`) | the summary fields plus `judge_names`, `petitioner`, `respondent`, `overruled_by`, `summary`, `headnotes`, `full_text` |
| `StatuteSummary` (`/statutes` items) | `id`, `statute_name`, `short_name`, `section_number`, `section_title`, `chapter`, `year_enacted`, `is_repealed` |
| `StatuteDetail` (`/statutes/{id}`) | the summary fields plus `section_text`, `effective_date`, `repealed_by` |

Never returned by any public route: `embedding`, `search_text`, `validation_errors`, `confidence_score`, `view_count`, and provenance (`source_site`, `source_url`, `source_file_path`). Provenance stays out for the same reason Annex A's `v_authority_*` views carry none (004 :24) and FA-DATA-003 treats unfiltered provenance as a finding. `is_overruled` is in every case summary so an overruled judgment cannot pass as good law.

### Ruling 5: keyset pagination on the primary key

Lists order by `id` (the UUID primary key: unique, immutable, btree-indexed) and return `{"items": [...], "next_cursor": <string or null>}`. The query fetches `limit + 1` rows with `id > :after`; the extra row only decides whether `next_cursor` is set. The cursor is opaque: base64url (no padding) of `<kind>:<uuid>`, where `kind` is `cl` for case law and `st` for statutes. There is no offset parameter.

A malformed cursor (over 128 characters, not base64url, not ASCII, wrong kind, not a UUID) is **400** `invalid cursor`, checked before any database work. A well-formed cursor naming another id is harmless: it only moves the start point, and the published predicate still applies.

Order by id is stable, not relevance; ranking is not in FINAL_2's contract for `/search` and is not added under the freeze.

### Ruling 6: a per-request statement timeout in a read-only transaction

Every public request that reaches the database (after validation, so an invalid request costs no connection) runs in one transaction that starts with `SET TRANSACTION READ ONLY` and `SELECT set_config('statement_timeout', '<n>ms', true)`. `set_config(..., true)` is `SET LOCAL`; it is used because `SET` cannot take a bind parameter. The timeout ends with the transaction, so a pooled connection never keeps it.

`PUBLIC_QUERY_TIMEOUT_MS` defaults to 3000. A cancelled statement (SQLSTATE 57014) becomes **503** `query timed out` with `Retry-After: 1` and no row data. `READ ONLY` is defence in depth: no public request can write, whatever a future change to the helper does.

### Ruling 7: a per-client token bucket, 429 with Retry-After

`scraper/rate_limit.py` holds an in-process token bucket per client address (`request.client.host`): capacity `PUBLIC_RATE_LIMIT_REQUESTS` (default 60), refilled evenly over `PUBLIC_RATE_LIMIT_WINDOW_SECONDS` (default 60). An empty bucket is **429** `rate limit exceeded` with `Retry-After` (whole seconds until one token is back). The key table is an LRU bounded by `PUBLIC_RATE_LIMIT_MAX_CLIENTS` (default 10,000), so a spray of addresses cannot turn the limiter into a memory sink.

It is a router dependency, so it runs before parameter validation: an invalid request spends a token too. `X-Forwarded-For` is not read (a client can forge it); behind the TLS proxy the compose file asks for, uvicorn's `--forwarded-allow-ips` must name the proxy so `client.host` is the real client (residual 4).

Why not slowapi: it is a new runtime dependency (and `limits`), would need adding to both requirement sets that the F25 builder is also editing, and buys nothing over a 60-line bucket for one process. A distributed limiter (Redis) is residual 4.

### Ruling 8: export stays admin-only, becomes published-only, streamed in bounded chunks with a cap

`GET /export/cases` keeps `require_admin_api_key` and its columns (CSV `citation,title,court,year`; JSONL `{"citation","title"}`). It now:
- uses the ruling-1 predicate and an explicit column list;
- accepts only `format=csv|jsonl` (422 otherwise; main silently fell back to CSV);
- streams from a server-side cursor (`AsyncSession.stream`, `yield_per=EXPORT_CHUNK_ROWS`, default 500), encoding one chunk at a time, inside its own read-only transaction with `EXPORT_QUERY_TIMEOUT_MS` (default 60,000);
- stops at `EXPORT_MAX_ROWS` (default 50,000) rows in id order;
- sends `X-Export-Row-Cap: <cap>` and `X-Export-Truncated: true|false`, decided before streaming by a bounded probe (`... ORDER BY id OFFSET <cap> LIMIT 1`) in its own timed transaction.

*Decision on the background job.* The audit prefers export on background jobs. Not built: under the fix-first freeze a job queue, result storage and a status route are a new feature, and the bounded design already caps one request's memory (one chunk), rows (the cap), time (the timeout) and audience (admin key). The truncation header is advisory: the probe and the stream are separate transactions, so a row promoted in between can change the boundary (residual 5).

### Ruling 9: detail routes; `/statutes/{id}` added as the bounded replacement

`GET /cases/{case_id}` takes a UUID (malformed is 422, not 500), applies the ruling-1 predicate, and returns `CaseDetail` or **404** `not found` for a missing *or* unpublished id (one response for both, so existence is not revealed).

`GET /statutes/{statute_id}` is new and works the same way with `StatuteDetail`. It is not a new capability: on main, statute section text was publicly readable through the unbounded `/statutes` list. Ruling 4 removes text from lists, and without this route the fix would silently drop the only way the text was served. It is the bounded form of an existing capability, which the freeze permits, and FINAL_2 :1158-1160 plans per-section statute reads.

Both detail routes are rate-limited and timed like the lists.

### Ruling 10: configuration

One additive block in `Settings` (`scraper/config.py`), each with pydantic bounds: `PUBLIC_QUERY_TIMEOUT_MS` (3000; 100-60000), `PUBLIC_RATE_LIMIT_REQUESTS` (60; 1-100000), `PUBLIC_RATE_LIMIT_WINDOW_SECONDS` (60; 1-86400), `PUBLIC_RATE_LIMIT_MAX_CLIENTS` (10000; 100-1000000), `EXPORT_MAX_ROWS` (50000; 1-1000000), `EXPORT_CHUNK_ROWS` (500; 10-10000), `EXPORT_QUERY_TIMEOUT_MS` (60000; 1000-600000). The contract constants (`limit` 1-100, `q` 2-200, cursor 128) are module constants, not settings: they are the API's contract, not an operator's tuning knob.

### Ruling 11: contract changes (no in-repo consumer; recorded for external callers)

| Route | Main | After |
| --- | --- | --- |
| `GET /search` | bare JSON list of full rows | `{"items": [CaseSummary...], "next_cursor": ...}`; published rows only; `limit` 1-100 (422); `q` 2-200, no control characters, not wildcard-only (422); `cursor` (400 when malformed) |
| `GET /cases/{id}` | full row or `200 null`; malformed id 500 | `CaseDetail`; 404 for missing or unpublished; malformed id 422 |
| `GET /statutes` | bare list of full rows | `{"items": [StatuteSummary...], "next_cursor": ...}`; trusted-source rows only; same bounds |
| `GET /statutes/{id}` | 404 (no route) | `StatuteDetail` or 404 |
| `GET /export/cases` | every row; any format | published rows only; `csv` or `jsonl` (422 otherwise); capped; streamed; two headers |
| all public routes | no quota, no timeout | 429 after the quota; 503 on timeout |

## 3. Tests (RED on main, GREEN after)

### End-to-end: `corpus_service/tests/test_f24_public_corpus_db.py`

The real app (`scraper.main.app`, startup included, via `TestClient`) against real Postgres 16 + pgvector, migrated by `python -m scraper.migrate` as the compose `migrate` service runs it, with the app bound to a DML-only runtime role (as PR 2b provisions it). Seed, all synthetic and 2099-dated:
- 25 published judgments (trusted and review sources) with full text and a 1536-dimension embedding;
- 4 unpublished judgments: `is_promoted` false, a blocked source, a source that does not exist, a NULL source;
- a staging row and a quarantine row with the same search marker;
- 3 trusted-source statute sections and 3 unpublished ones (review source, blocked source, NULL source).

The file imports no new module, so on main it fails on behaviour, not at import; settings that do not exist on main are skipped by the test's helper (main then runs with no bound, which is the finding).

| Test | Shows |
| --- | --- |
| (a) `test_a_wildcard_with_a_billion_limit_is_refused_and_only_published_summaries_come_back` | `q='%'&limit=1000000000` is 422 (main: 200 with every row, unpublished rows, full text and embeddings); `q='_'`, `q='%%'`, `limit=101`, `limit=0` are 422; a bounded search returns only published summaries |
| (b) `test_b1_search_pages_published_summaries_by_cursor`, `test_b2_like_metacharacters_in_the_query_match_literally`, `test_b3_cursor_tamper_is_400_never_500`, `test_b4_case_detail_serves_published_text_without_embedding`, `test_b5_statutes_serve_only_trusted_sections` | b1: the marker search pages 10 + 10 + 5 with `next_cursor`, no duplicates, exactly the 25 published rows, no unpublished, staging or quarantine row, summary keys only (no `embedding`, no `full_text`). b2: `100%`, `A_B` and `30_` match literally. b3: malformed cursors and a statutes cursor on `/search` are 400. b4: case detail, published 200 with text and without embedding, unpublished and missing 404, malformed 422. b5: statutes list and detail the same way, trusted sources only |
| (c) `test_c_export_is_published_only_and_capped` | with the cap at 5: 5 rows, all published, `X-Export-Truncated: true`; with the cap above the count: exactly the 25 published rows, `false`; CSV the same; `format=xml` 422 |
| (d) `test_d_rate_limit_returns_429_after_the_quota` | quota 3: three 200s, then 429 with `Retry-After`; another client address is unaffected |
| (e) `test_e_statement_timeout_cancels_a_slow_query` | another connection holds `ACCESS EXCLUSIVE` on `case_law_master`; with a 300 ms timeout the search returns 503 well before the lock is released, and the lock holder sees the query cancelled (main: waits for the lock, then 200) |
| (e2) `test_e2_public_transaction_is_read_only_and_its_timeout_never_stays_on_a_pooled_connection` | added at GREEN as a regression guard, not part of the RED record (on main it fails at import, which is not a behavioural RED). The test engines are NullPool, so (e) cannot see a timeout leaked onto a pooled connection; with the app bound to a one-connection pool, the same backend shows `1234ms` and `transaction_read_only = on` inside the public transaction, its baseline timeout and `off` after it, and a write inside it is refused. It kills the mutants `set_config(..., false)` and "no `SET TRANSACTION READ ONLY`", which (e) does not |

### Unit: `corpus_service/tests/test_f24_public_corpus_bounds.py`

No database: LIKE escaping of `%`, `_`, `\` (and their combinations); `q` bounds (1 and 201 refused, 2 and 200 accepted, trimming, wildcard-only and control characters refused); `limit` bounds through the app (0, -1, 101, 10^9 are 422); cursor round trip and tamper (bad base64, wrong kind, not a UUID, too long, non-ASCII: 400, never 500); DTO field sets and the compiled list SQL (no embedding or text columns); the token bucket (capacity, refill, Retry-After, per-key isolation, LRU bound).

## 4. Residual risks and follow-ups

1. **Legacy tables, not Annex A.** The public API still reads `case_law_master` / `statutes_master`. Repointing it at Annex A's promoted-only views needs a reader role for the API and a new response shape (F05, FA-DATA-003): follow-up.
2. **No per-row review evidence** on `case_law_master` beyond `is_promoted` (F23 owns auditable manual promotion).
3. **Statute visibility follows current source trust.** `statutes_master` has no per-row publication state; a source re-trusted later re-exposes rows it wrote while untrusted.
4. **Rate limiting is per process and per peer address.** Not distributed (one uvicorn process today); behind a proxy it needs `--forwarded-allow-ips` for the proxy, or every client shares one bucket.
5. **Export is not a background job.** One request is bounded by the cap, chunking and timeout; the truncation header is advisory. The probe runs before the response starts, so its timeout is a 503; a timeout or error once rows are streaming can only end the transfer early (the 200 status and headers are already sent), which an HTTP client sees as an incomplete chunked body, not as an error status. A full-corpus export belongs with the Annex A export (FINAL_2 :1162-1163).
6. **Admin list limits** on `/jobs` and `/quarantine` remain unbounded integers (admin-only, outside F24's affected routes; F23 is changing the quarantine router).
7. **`/health`** still counts `case_law_master` unauthenticated (F44's route).
8. **Short queries** (2 characters) cannot use the trigram indexes; they are bounded by the timeout and the quota.
