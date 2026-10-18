# F23 Auditable Quarantine Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a reviewer's promote or reject of a quarantined record is one locked, state-checked transaction that publishes at most once under a stable identity, refuses blocked and unknown sources, records who decided what, why, from which state, in an append-only table, writes the embedding outbox row in the same transaction, and answers 404 / 409 instead of a false "promoted".

**Architecture:**
- `corpus_service/scraper/routers/quarantine.py` owns the transition (promote and reject), the request model, the deterministic publication id and the 404 / 409 mapping. It stays the only reviewed manual writer of `case_law_master` (`tests/test_trust_policy.py` allowlist, unchanged).
- `corpus_service/scraper/models.py` gains `QuarantineDecision` (table `quarantine_decisions`), created by `create_all` like every application table.
- `corpus_service/scraper/trust.py` gains `human_review_decision` (F20 vocabulary, fail closed).
- `corpus_service/migrations/002_quarantine_decisions.py` adds the append-only trigger; `scraper/migrate.py` runs it from `NUMBERED_MIGRATIONS`.
- Source resolution and the citation lock key are reused from `scraper/tasks/promotion.py` (imported, not edited).

**Tech Stack:** Python 3.12 (CI and local venv), FastAPI 0.142.2, SQLAlchemy 2.1.3 asyncio, asyncpg 0.32.0, httpx 0.28.1, pytest 9.1.1, Postgres 16 + pgvector (CI: `pgvector/pgvector:pg16`; locally a private cluster on 127.0.0.1:55451 under `/tmp/f23-pg`).

**Spec:** `docs/superpowers/specs/2026-10-18-f23-auditable-quarantine-promotion-design.md`

## Global Constraints

- Do not edit `scraper/tasks/*` (F28 owns `dispatcher.py` and `embeddings.py`), `scraper/net/*` or `tests/test_f25_*` (PR #67), F24's `routers/search.py`, `routers/export.py`, `public_corpus.py`, `requirements*.txt`, the Dockerfile (F31), `config.py`, `main.py`, `init.sql`, `migrations/001_initial.py`, `app/api/**`, or the platform files of PRs #44 and #47.
- Shared files change additively only: `models.py` (one class), `trust.py` (one function), `conftest.py` (one table name), `migrate.py` (the numbered-migration call).
- Never skip or weaken a test. No existing test expectation changes.
- Synthetic data only; citations are 2099-dated.
- The e2e file imports no module main lacks, so it fails on main by behaviour.

## Review Focus

- The queue row is locked `FOR UPDATE` before any decision; only a pending row is decided; the loser of a race gets 409.
- Nothing is written on any refusal (404, 409, 422); the record stays pending.
- The published id is deterministic and recorded on the decision, the staging row and the response.
- The decision table is append-only in the database (trigger), not just in code.
- `blocked` and unknown sources are refused at decision time, from the staging row's current source.
- The outbox row is in the same transaction and exactly once.

### Task 1: Spec and plan

- [x] Write the spec with rulings, steelman and devil's advocate, bias check and residuals.
- [x] Write this plan.

### Task 2: RED e2e on main's sources

- [x] `corpus_service/tests/test_f23_quarantine_review_db.py`: (a)-(f) through the real app, real admin key, migrate, the runtime role, real promotion-made quarantine rows and real Postgres.
- [x] Run it on main's code; record the failing output below.

### Task 3: Trust decision and model

- [ ] `trust.human_review_decision(trust_raw) -> PublicationDecision`: trusted / review promote; blocked -> `blocked_source`; anything else -> `unknown_source`.
- [ ] `models.QuarantineDecision` with the columns, CHECKs and unique key of spec ruling 5.

### Task 4: Migration 002 and the migrate call

- [ ] `migrations/002_quarantine_decisions.py`: idempotent `upgrade(conn)` for the append-only function and triggers, in the table's schema.
- [ ] `scraper/migrate.py`: `NUMBERED_MIGRATIONS = ("002_quarantine_decisions",)`, loaded by path, run in the upgrade transaction; a missing file or `upgrade` stops migrate.
- [ ] `tests/conftest.py`: add `quarantine_decisions` to `ORM_TABLES`.

### Task 5: The transition

- [ ] Request model (reviewer, reason; `extra = forbid`), `Idempotency-Key` validation, UUID path ids.
- [ ] Promote: lock queue row, pending check / replay, lock staging, resolve and share-lock source, trust decision, citation lock and collision check, write master row (deterministic id), outbox row, staging lineage, queue review columns, decision row; commit; IntegrityError -> 409.
- [ ] Reject: lock queue row, pending check / replay, snapshot staging and trust evidence, write decision and queue review columns; commit.

### Task 6: Unit tests

- [ ] `corpus_service/tests/test_f23_quarantine_review_rules.py`: `human_review_decision` on every value; the deterministic id formula; 422 for bad bodies, keys and ids before any database connection.

### Task 7: Docs

- [ ] Corpus README: the review transition, the decision table, the outbox hand-off.

### Task 8: Verification

- [ ] The new e2e and unit files GREEN; the full corpus_service suite the way CI runs it.
- [ ] `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [ ] gitleaks over the diff.
- [ ] The claim gate on the PR body.

## Ledger (RED / GREEN evidence)

Commands run from the repository root with `scratchpad/f23-pytest.sh` (Python 3.12 venv from `requirements-test.txt`, `CI=1`, `CORPUS_TEST_DATABASE_URL` on the private PG16 + pgvector cluster, Annex A 001/003/004 applied twice to `corpus_ci` exactly as the CI job does). Full logs and the evidence file are in the builder's scratchpad (`evidence-f23.txt`).

### Baseline (main @ f3bbcc9)

`python -m pytest corpus_service/tests -q`: **559 passed, 157 subtests passed** (455 s).

### RED (main's sources + the new e2e file only)

`python -m pytest corpus_service/tests/test_f23_quarantine_review_db.py -q -rA`: **6 failed** (16.5 s), every one on an assertion about behaviour:

| Test | Observed on main | Expected |
| --- | --- | --- |
| (a) repeated approval | uncited record promoted twice: statuses (200, 200), **2 master rows**, no decision table; cited duplicate: (200, **500**) | (200, 409) `already_resolved`, 1 row, 1 decision; (200, 409) `citation_already_published` |
| (b) racing decisions | promote vs promote: [200, **500**], resolution still `pending`, no decision; promote vs reject: [200, **404**] (no reject route), resolution `pending` | [200, 409] `already_resolved`, one decision, resolution `approved` / `rejected` |
| (c) missing records | unknown id **200** (`{"error": "not found"}`), malformed id **500**, queue row without staging **200** (`{"message": "promoted"}`) | 404, 422, 409 `staging_record_missing` |
| (d) decision record | `no quarantine_decisions table: the promotion left no decision record` | the decision row with reviewer, reason, prior and new state |
| (e) untrusted source | blocked, later-blocked and unknown sources all **200**, each with a master row, no longer pending | 409 `source_not_promotable` (`blocked_source` / `unknown_source`), nothing written |
| (f) outbox | statuses (200, **500**, **500**, **404**), **0 outbox rows** | (200, 200, 409, 200), exactly one pending `embedding_queue` row named by the decision |

### GREEN

(filled in at Task 8)
