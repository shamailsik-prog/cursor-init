# F24 Bounded Public Corpus Queries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the public corpus routes return only published rows, as summary DTOs, in bounded keyset pages, under a per-request statement timeout and a per-client quota; the admin export is published-only, capped and streamed in bounded chunks.

**Architecture:**
- `corpus_service/scraper/public_corpus.py` owns the published-only predicates, the DTOs and their column lists, the query-text and cursor rules, and the read-only timed session.
- `corpus_service/scraper/rate_limit.py` owns the in-process token bucket and the FastAPI dependency.
- `routers/search.py` and `routers/export.py` call only those modules; the AST scan in `tests/test_trust_policy.py` enforces that.

**Tech Stack:** Python 3.12 (CI) / 3.11 (local), FastAPI 0.142.2, SQLAlchemy 2.1.3 asyncio, asyncpg 0.32.0, pytest 9.1.1, Postgres 16 + pgvector (the CI `pgvector/pgvector:pg16` service; locally a dedicated Debian cluster on port 55442).

**Spec:** `docs/superpowers/specs/2026-10-18-f24-bounded-public-corpus-queries-design.md`

## Global Constraints

- Do not edit `scraper/tasks/*` (F25 builder), and keep shared files (`config.py`, `main.py`, `conftest.py`, `requirements*.txt`) untouched or additively changed: only `config.py` gains one block.
- Do not edit the files owned by PRs #44 and #47, or `app/api/**`.
- Never skip or weaken a test. The only existing-test change is the reviewed read-only allowlist in `tests/test_trust_policy.py` (search and export leave it, `scraper.public_corpus` joins it), which makes the existing scan stricter.
- Synthetic data only; citations are 2099-dated.
- The e2e file imports no new module, so it fails on main by behaviour.

## Review Focus

- Every public read goes through `public_corpus` (the AST allowlist), and the published predicate is an exact `IN` list from `scraper.trust`.
- No public response carries `embedding`; no list carries a text column.
- A malformed cursor is 400 and is decoded before any database work; invalid input never opens a session.
- The timeout is transaction-local (`set_config(..., true)`), so a pooled connection never keeps it.
- The limiter's key table is bounded.

### Task 1: Spec and plan

- [x] Write the spec with rulings, steelman and devil's advocate, and residuals.
- [x] Write this plan.

### Task 2: RED tests on main's sources

- [x] `tests/test_f24_public_corpus_db.py`: e2e (a)-(e) through the real app, migrate, the runtime role and real Postgres.
- [x] `tests/test_f24_public_corpus_bounds.py`: unit tests for escaping, bounds, cursor, DTOs, SQL columns, token bucket.
- [x] Run both on main's `scraper/`; record the failing output in the ledger below and in the evidence log.

### Task 3: Settings and the rate limiter

- [x] Add the F24 settings block to `Settings`.
- [x] `scraper/rate_limit.py`: `TokenBucketLimiter` (capacity, refill, Retry-After, LRU bound, reset) and `public_rate_limit` (429 + Retry-After).

### Task 4: The published-only helper

- [x] `scraper/public_corpus.py`: predicates, DTO models and column lists, `normalise_query_text`, `escape_like` / `like_contains`, cursor codec, `public_read_session`, `is_statement_timeout`.

### Task 5: The routers

- [x] `routers/search.py`: `/search`, `/cases/{case_id}`, `/statutes`, `/statutes/{statute_id}` through the helper; rate-limited; 422/400/404/503 as specified.
- [x] `routers/export.py`: published-only, `csv|jsonl`, probe for truncation, stream in chunks, cap, timeout.
- [x] `tests/test_trust_policy.py`: move the read-only allowlist entries to `scraper.public_corpus` (committed with the RED tests in e09bd5b, so the scan was RED on main's routers).

### Task 6: Docs

- [x] Corpus README: the public API section and the allowlist sentence.

### Task 7: Verification

- [x] Full corpus suite the way CI runs it (`CI=1`, `CORPUS_TEST_DATABASE_URL`, Annex A applied twice first).
- [x] `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [x] Claim gate on the PR body.
- [x] Ledger and evidence log updated with exact counts.

## Ledger (RED / GREEN evidence)

The full output is in the session evidence log (`evidence-f24.txt` in the builder's scratchpad); the counts and the decisive lines are copied here.

### RED

Commit e09bd5b: the tests on origin/main 1f0cc27's `scraper/` (unchanged at that commit). Real Postgres 16 + pgvector on 127.0.0.1:55442, Annex A 001/003/004 applied twice, `CI=1`, the CI-pinned requirements.

| Command | Result |
| --- | --- |
| `python -m pytest corpus_service/tests/test_f24_public_corpus_db.py corpus_service/tests/test_trust_policy.py -q -rfE` | **10 failed, 28 passed**, 84 subtests passed |
| `python -m pytest corpus_service/tests/test_f24_public_corpus_bounds.py -q` | **1 error** (collection): `ImportError: cannot import name 'public_corpus' from 'scraper'` |
| baseline: `python -m pytest corpus_service/tests -q` on main | 221 passed, 131 subtests passed, 0 skipped |

Decisive lines:
- (a) `q='%' with limit=1e9 was served: status 200: 29 rows, unpublished rows ['2099 YLR 901', '2099 YLR 902', '2099 YLR 903', '2099 YLR 904'], text fields ['full_text', 'full_text_urdu'], embedding of 1536 floats`
- (b1, b2, b5) `not a keyset page ({items, next_cursor})`, with `full_text` / `section_text` and 1536-float embeddings in every list row
- (b3) `cursor 'not-a-cursor!!': status 200` (the cursor is ignored)
- (b4) the detail returns every column, `embedding` included
- (c) `unpublished rows exported: ['2099 YLR 901', '2099 YLR 902', '2099 YLR 903', '2099 YLR 904']`
- (d) `request 4 of a quota of 3 was served: status 200`
- (e) `slow query not cancelled: status 200 ... after 8.06s` (the request waited for the lock, then succeeded)
- trust-policy scan: `['scraper.routers.export', 'scraper.routers.search'] != []` (both routers read the master tables directly)

### GREEN

Commit 2e9d6a4 (the implementation), same environment.

| Command | Result |
| --- | --- |
| `python -m pytest corpus_service/tests/test_f24_public_corpus_bounds.py -q -rfE` | **81 passed** |
| `python -m pytest corpus_service/tests/test_f24_public_corpus_db.py corpus_service/tests/test_trust_policy.py -q -rfE` | **39 passed**, 84 subtests passed (the 38 RED-run tests plus e2) |

Tests changed after RED, both stricter:
- `test_search_sql_escapes_and_filters_published`: the RED version accepted either of two literal renderings of the escaped pattern (joined by `or`), because the rendering was unknown before the helper existed. It now pins the asyncpg rendering, requires it for both columns (`count == 2`), and checks that the pattern reaches asyncpg as a bind parameter (`ILIKE $1::VARCHAR ESCAPE '\'`), never spliced into the SQL.
- `test_e2_public_transaction_is_read_only_and_its_timeout_never_stays_on_a_pooled_connection`: added as a regression guard, not part of the RED record (on main it fails at import, which is not a behavioural RED). The test engines are NullPool, so (e) cannot see a timeout leaked onto a pooled connection.

Mutation checks (`public_corpus.py` mutated, then restored and its sha256 verified):

| Mutant | Result |
| --- | --- |
| M1 `set_config('statement_timeout', ..., false)` (session-level) | (e) still passes; e2 fails: `statement_timeout '1234ms' outlived the public transaction` |
| M2 no `SET TRANSACTION READ ONLY` | e2 fails: `assert 'off' == 'on'` |
| M3 `escape_like` returns its input | 10 failed: 8 escaping cases, `test_search_sql_escapes_and_filters_published`, and e2e b2 `'100%' must not match '1005 Holdings'` |

### Verification

| Check | Result |
| --- | --- |
| Full corpus suite as CI runs it: `CI=1 CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@127.0.0.1:55442/corpus_ci python -m pytest corpus_service/tests -q` | **312 passed**, 131 subtests passed, 0 skipped, 249.53s (main: 221 passed; +81 unit, +10 e2e) |
| `BASE=origin/main bash ci_gates/gate_g0.sh` | `=== Gate G-0 PASSED (static) ===` (all 17 checks) |
| Claim gate `ci_gates/check_pr_phase_claims.py` on the PR body | recorded in the PR body |

No TypeScript changed, so the root unit, typecheck and lint gates do not apply. Local Python is 3.11.15 with the CI pins (fastapi 0.142.2, sqlalchemy 2.1.3, asyncpg 0.32.0); CI runs 3.12.

## Re-audit round (FAIL 7/10 at 4cbc081)

Findings: MEDIUM R1 (a: IPv6 /64 rotation, b: LRU eviction resets buckets, c: no aggregate DB load cap, d: pool exhaustion is 500); LOWs L1 (trusted proxy implicit), L2 (limiter header policy, mutant M39), L3 (export deadline per FETCH only, mutant M46), L4 (CSV formula injection), L5 (AST guard blind to read SQL and re-exports), M14 (export buffering mutant), strict `limit` parsing, the anonymous pages outside the router. Copilot thread 4305228825 (export transaction held across `yield`) is folded into L3. Rulings: spec section 5.

### Tasks

- [x] Merge `origin/main` (F25, #65) into the branch: 7f92853 (clean). Baseline there: 484 passed, 131 subtests.
- [x] RED tests: `tests/test_f24_r2_bounds.py` (no database), `tests/test_f24_r2_db.py` (real Postgres), `PublicCorpusReadGuardTests` in `tests/test_trust_policy.py`. Commit 3f6885e.
- [x] Settings: `PUBLIC_DB_CONCURRENCY`, `EXPORT_MAX_CONCURRENT`, `EXPORT_DEADLINE_SECONDS`.
- [x] `scraper/rate_limit.py`: `client_key` (/64, /32, mapped, non-IP), reclaim-only-refilled plus the overflow bucket, `RateLimitedPathsMiddleware`.
- [x] `scraper/client_identity.py`: startup and once-per-process warnings for `FORWARDED_ALLOW_IPS`.
- [x] `scraper/public_corpus.py`: `ConcurrencyGate` (public and export), connection acquisition apart (`DatabaseUnavailable`) and the 503 mapping, `limit_param`, the routers' API, keyset export batches with the deadline.
- [x] Routers on the public API; `DeadlineStreamingResponse`; `csv_safe_cell`; `main.py` (middleware, startup warning); `app.env` (`FORWARDED_ALLOW_IPS`).
- [x] AST guard: re-export resolution, `scan_source_for_master_reads`, `public_router_violations`, `public_corpus_read_violations`.
- [x] Mutation check of the new tests; full suite; compose policy; G-0; spec, README, ledger; PR body; claim gate.

### Ledger: RED (round 2)

Tree 7f92853 (F24 code as at 4cbc081, F25 merged); same environment as round 1.

| Command | Result |
| --- | --- |
| `python -m pytest corpus_service/tests/test_f24_r2_bounds.py corpus_service/tests/test_f24_r2_db.py "corpus_service/tests/test_trust_policy.py::PublicCorpusReadGuardTests" -q -rfE` | **60 failed, 15 passed** |

Decisive lines:
- R1a: `one /64, a new address per request: [200, 200, ..., 200]` (20 x 200 at quota 3)
- R1b: `1010 of 1010 requests allowed`; `303 of 303 requests got past the quota` (through the app)
- R1c: `the third concurrent read: status 200 ... after 5.91s` (no cap: it waited for the lock)
- R1d: `pool exhausted: 500 after 0.51s: Internal Server Error`; 500 for each simulated acquisition failure
- strict limit: `/search limit='10.0' was served: status 200: 10 rows` (also `+10`, ` 10`, `1_0`)
- L3 + Copilot: `a stalled download kept 1 pooled connection(s) checked out`; `DID NOT RAISE` (an export ran past a 1 s deadline); `pooled connections checked out at each yield: [1, 1, 1]`
- L4: `[['=HYPERLINK("http://evil.invalid","x")', "+cmd|' /C calc'!A0", '@SUM(1+1)', '2099']]`
- pages: `/openapi.json`, `/docs`, `/redoc`, `/dashboard` at quota 2: `[200, 200, 200]`
- L5: four re-export forms missed by the scan; the read scan, router guard and read policy did not exist

The 15 passes at RED are by design: six limit values 4cbc081 already refused, four plain-digit acceptances, the control that a programming error stays 500, and the mutant killers for M02, M39 (two) and M46, which pass on correct code.

### Ledger: GREEN (round 2)

Commit 6d947d2.

| Command | Result |
| --- | --- |
| the round-2 set (as above) | **75 passed**, 26 subtests |
| all F24 files plus `test_trust_policy.py` | **195 passed**, 110 subtests |
| full suite: `CI=1 CORPUS_TEST_DATABASE_URL=... python -m pytest corpus_service/tests -q` | **559 passed**, 157 subtests, 0 skipped (merged baseline 484 + 75) |
| `python3 ci_gates/check_compose_policy.py corpus_service/docker-compose.yml`; `python3 ci_gates/test_check_compose_policy.py` | PASS; 19 tests OK |
| `BASE=origin/main bash ci_gates/gate_g0.sh` | `=== Gate G-0 PASSED (static) ===` |

Mutation check (`scratchpad/f24r2_mutants.py`; each mutant applied to a source file, the targeted tests run, the file restored and its sha256 verified): **23 of 24 killed**. It ran on the fix just before two cleanups: the dead branch named in the last row was removed, and the compose edit was reverted (see the test change below). Neither touches a mutated line other than the removed branch.

| Mutant | Killed by |
| --- | --- |
| R1a-1 raw address as key; R1a-2 mapped IPv6 not folded; R1a-3 non-IP values keep own key | `test_r1a_client_key_groups_ipv6_by_64_and_ipv4_by_32`, `test_r1a_non_ip_peers_share_one_key` |
| R1b-1 LRU eviction resets buckets; R1b-2 no overflow bucket | `test_r1b_more_keys_than_the_table_cannot_bypass_the_quota[101]` |
| R1c-1 no cap; R1c-2 slot leaked on failure | `test_r1c_the_cap_refuses_the_next_concurrent_read_with_503` |
| R1d-1 acquisition failures not mapped | `test_r1d_connection_acquire_failures_are_503_through_the_app[...]` |
| strict-1 lax integer parsing | `test_strict_limit_refuses_anything_but_ascii_digits[10.0]` |
| M39 limiter keys on X-Forwarded-For | `test_m39_forwarding_headers_never_change_the_key` |
| L1-1 no startup call; L1-2 loopback-only accepted | `test_l1_startup_logs_the_warning`, `test_l1_startup_warning_when_the_proxy_looks_unset[...]` |
| L3-1 no response deadline; L3-2 no deadline at all; Copilot: one transaction held across every yield | `test_l3_stalled_consumer_releases_the_connection_at_the_deadline` |
| M14 one batch of everything | `test_m14_export_reads_bounded_batches_and_holds_no_connection_between_them` |
| M46 export reads without the statement timeout | `test_m46_the_export_statement_timeout_applies_to_its_reads` |
| L4 cells not neutralised | `test_l4_csv_cells_starting_with_a_formula_character_are_quoted[...]` |
| pages middleware not installed | `test_unauthenticated_pages_are_rate_limited[/openapi.json]` |
| L5-1 re-exports unresolved; L5-2 helper API unenforced; L5-3 read SQL unscanned | `PublicCorpusReadGuardTests` |
| M02 NULL trust accepted | `test_m02_published_predicates_have_no_null_escape` |
| **survived:** R1d-2 the separate pool `TimeoutError` branch in the 503 mapper removed | equivalent: a checkout timeout only arises in `session.connection()`, which already maps it. The branch was dead code and was removed. |

Tests changed after RED (round 2): `test_l1_compose_and_app_env_make_the_proxy_setting_explicit` no longer requires `--proxy-headers` in the compose command. That edit broke 14 F30 compose-policy fixtures, and the flag is uvicorn's default, so the test now requires `FORWARDED_ALLOW_IPS` in `app.env`, `env_file: app.env` on `api`, and no override in the command. The round-1 `test_buckets_are_per_key_and_the_table_is_bounded` had its comment changed only.

Environment note: during the round the shared disk filled transiently (another builder's work) and the local Postgres cluster stopped. It was restarted, recovered cleanly, one leftover per-test database from the interrupted run was dropped, and every run recorded above was taken after that.
