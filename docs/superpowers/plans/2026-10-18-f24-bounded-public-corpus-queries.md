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
