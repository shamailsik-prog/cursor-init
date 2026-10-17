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

- [ ] `tests/test_f24_public_corpus_db.py`: e2e (a)-(e) through the real app, migrate, the runtime role and real Postgres.
- [ ] `tests/test_f24_public_corpus_bounds.py`: unit tests for escaping, bounds, cursor, DTOs, SQL columns, token bucket.
- [ ] Run both on main's `scraper/`; record the failing output in the ledger below and in the evidence log.

### Task 3: Settings and the rate limiter

- [ ] Add the F24 settings block to `Settings`.
- [ ] `scraper/rate_limit.py`: `TokenBucketLimiter` (capacity, refill, Retry-After, LRU bound, reset) and `public_rate_limit` (429 + Retry-After).

### Task 4: The published-only helper

- [ ] `scraper/public_corpus.py`: predicates, DTO models and column lists, `normalise_search_text`, `like_contains_pattern`, cursor codec, `public_read_session`, `is_statement_timeout`.

### Task 5: The routers

- [ ] `routers/search.py`: `/search`, `/cases/{case_id}`, `/statutes`, `/statutes/{statute_id}` through the helper; rate-limited; 422/400/404/503 as specified.
- [ ] `routers/export.py`: published-only, `csv|jsonl`, probe for truncation, stream in chunks, cap, timeout.
- [ ] `tests/test_trust_policy.py`: move the read-only allowlist entries to `scraper.public_corpus`.

### Task 6: Docs

- [ ] Corpus README: the public API section and the allowlist sentence.

### Task 7: Verification

- [ ] Full corpus suite the way CI runs it (`CI=1`, `CORPUS_TEST_DATABASE_URL`, Annex A applied twice first).
- [ ] `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [ ] Claim gate on the PR body.
- [ ] Ledger and evidence log updated with exact counts.

## Ledger (RED / GREEN evidence)

The full output is in the session evidence log (`evidence-f24.txt` in the builder's scratchpad); the counts and the decisive lines are copied here.

### RED

_Recorded after Task 2._

### GREEN

_Recorded after Task 5._

### Verification

_Recorded after Task 7._
