# F27 plan: leased embedding claims, operation identity, receipts, retry timing, dead letters

Spec: `docs/superpowers/specs/2026-10-18-f27-leased-embedding-claims-design.md` (rulings R1-R16).
Branch: `claude/remediate-f27` from origin/main f670d62. Evidence log: scratchpad `evidence-f27.txt`.

## Tasks

1. **Spec and plan** (this file). Commit, push.
2. **RED tests**, written against database state and provider call counts only, so they run on main's code and fail by assertion:
   - `corpus_service/tests/test_f27_embedding_claims_e2e.py`: the `process-embeddings` beat entry, its task run in process (`Task.apply`), real Postgres. Missing and malformed rows and the window; retry timing and the dead letter; two concurrent batches in two threads over 120 rows; a re-queued unchanged operation; a record changed during the call; a crash left in the database (expired lease, `started` receipt); alerts; the runtime role; migration 004 on a pre-F27 queue.
   - `corpus_service/tests/test_f27_embedding_prefork_e2e.py`: a real `celery worker --pool=prefork` (F28's filesystem broker harness). Two children over the same 50 rows; a child killed (SIGKILL) while its store transaction waits, after the provider answered.
   - `corpus_service/tests/test_f27_embedding_rules.py`: operation identity, backoff, text checks, the lease against Celery's time limit (no database).
   - Run each on main's code and record the failing output below. Commit, push.
3. **Model and migration**: `EmbeddingQueue` columns, CHECKs and indexes; `EmbeddingAttempt`; `migrations/004_embedding_queue_leases.py`; the entry in `scraper/migrate.py`; `embedding_attempts` in the test fixture's `ORM_TABLES`.
4. **`scraper/tasks/embeddings.py`**: reclaim (R3), claim (R1, R2), reuse (R6), receipts (R5), store under the record lock (R7), retry timing (R8), dead letters (R9), give-back on abnormal exit (R10), alerts (R11), summary (R12).
5. **GREEN**: the F27 files, the F28 files unchanged, then the full suite as CI runs it (CI=1, real PG 16 + pgvector, Annex A twice). G-0, the F31 import contract, gitleaks, the claim gate.
6. **Mutation check**: at least 10 mutants on the claim, the lease, the operation id, the receipt, the retry timing and the dead letter, one at a time on a scratch copy.
7. **README** (corpus service): the queue states, the receipts, the requeue procedure, the migration.

## RED / GREEN ledger

Filled in as the work runs; exact commands and counts are in the evidence log.

| Step | Command | Result |
| --- | --- | --- |
