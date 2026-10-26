"""The embedding queue's batch: claim under a lease, pay once per operation, retry on time, dead-letter
what cannot succeed, give back what a failed batch holds, and record and alert on every batch.

Audit F27 (spec docs/superpowers/specs/2026-10-18-f27-leased-embedding-claims-design.md, R1-R16):

1. Reclaim (R3): rows whose lease expired return to `pending`. Only a row the dead batch reached (a
   receipt under its lease) is charged, once (or goes to the dead letter at `max_attempts`); a row it
   never reached is not (review round 2). A reached row whose current operation has a paid answer
   held by a receipt is not charged and is due at once (review round 1); the lost store is counted on
   the receipt, and at STORE_RETRY_LIMIT the row is dead-lettered as `store_failed` with the answer
   kept for a requeue (review round 2). `started` receipts of the reclaimed rows become `abandoned`.
2. Claim (R1, R2): one `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50)` marks the due
   rows `processing` under this batch's lease token, committed before any provider call. Every later
   write to a claimed row is fenced on the token.
3. Per row: bad input is dead-lettered with a reason code (R9); an operation the record already holds
   completes with no call, and an answered vector held by a receipt is stored with no call (R6);
   otherwise a `started` receipt is committed, the provider is called, the `answered` receipt (tokens
   and vector) is committed, and the store verifies the operation under the record's lock (R5, R7). A
   failed attempt is charged once with backoff from `next_attempt_at`, or dead-lettered (R8).
4. A batch that ends abnormally gives back the rows it still holds, every write fenced (R10). The row
   in flight is charged once, except a row whose held, paid answer failed to store: that failure is
   counted on the receipt instead, the row backs off, and at STORE_RETRY_LIMIT it is dead-lettered as
   `store_failed` with the answer kept (review round 2). Alerts go through F28's line (R11).

Audit F28 (spec R4, R13, R19, R21-R26) is kept: a database error fails the batch at once; a batch that
tried items and completed none raises BatchFailed after its item outcomes are committed; the recording
wrapper owns the counters; an interruption is never counted against an item, and the item in flight
goes back to `pending` with its attempt count unchanged.
"""

import asyncio
import hashlib
import json
import logging
import math
import time
import uuid
from collections import Counter
from typing import Any, List, Optional, Tuple

from celery import shared_task
from sqlalchemy import func, select, text, update

from scraper import p1_client
from scraper.database import SessionLocal
from scraper.models import CaseLawMaster, EmbeddingAttempt, StatutesMaster
from scraper.tasks import embedding_chunks as ec
from scraper.tasks import job_record, outcomes
from scraper import harvest_control

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------------------------
# Bounds and vocabulary
# ---------------------------------------------------------------------------------------------
BATCH_SIZE = 50  # rows claimed per batch (R13)
RECLAIM_LIMIT = 50  # expired leases reclaimed per batch (R3, R13)
LEASE_SECONDS = 3900  # Celery's task_time_limit (3600 s) + 300 s: a live batch never outlasts it (R2)
PACE_SECONDS = 0.6  # pause after every provider request: 100 requests a minute (R15)
BACKLOG_ALERT_SECONDS = 24 * 3600  # backlog_stale when the oldest waiting row is older (R11)
DEAD_LETTER_COUNT_CAP = 10_000  # the dead-letter total in a summary is counted up to this (R13)
GIVE_BACK_LOCK_TIMEOUT = "5s"  # the give-back never waits long on a lock the failed batch may hold (R10)
# Review round 2: failed stores of one held, paid answer (refused by the database, or a batch lost while
# storing it) before the row goes to the dead letter as `store_failed`, the answer kept for a requeue.
STORE_RETRY_LIMIT = 3
OPERATION_VERSION = ec.OPERATION_VERSION
CHUNK_SPEC_VERSION = ec.CHUNK_SPEC_VERSION
# The models the vector(1536) columns can hold (R9).
SUPPORTED_MODELS = {"text-embedding-3-small": 1536}

PENDING, PROCESSING, COMPLETED, DEAD_LETTER = "pending", "processing", "completed", "dead_letter"
LEGACY_FAILED = "failed"  # main's terminal state before F27; counted with the dead letters (R11)

# Dead-letter and failure codes (error_type).
UNKNOWN_TABLE = "unknown_table"
UNSUPPORTED_MODEL = "unsupported_model"
RECORD_MISSING = "record_missing"
EMPTY_TEXT = "empty_text"
MALFORMED_TEXT = "malformed_text"
MAX_ATTEMPTS = "max_attempts"
LEASE_EXPIRED = "lease_expired"
MALFORMED_RESPONSE = "malformed_response"
OPERATION_IN_FLIGHT = "operation_in_flight"
STORE_FAILED = "store_failed"
P1_REFUSED = "p1_refused"  # FA-D3C-002 R14: the receipt of a request P1 refused before any provider call

LEASE_EXPIRED_TEXT = (
    "lease expired: the batch that held this row ended without giving it back; cause unknown"
)
LEASE_EXPIRED_ANSWERED_TEXT = (
    "lease expired after the provider answered: the held answer is stored by the next claim, with no new request"
)
LEASE_EXPIRED_UNREACHED_TEXT = (
    "lease expired before the batch reached this row: no request was made for it, so no attempt is charged"
)
STORE_FAILED_TEXT = (
    "store_failed: the paid answer held for this row could not be stored {n} times ({last}); it is kept in its "
    "receipt: fix the cause and requeue the row to store it with no new request"
)

# Columns per table: title-like, label-like, body; case law also exposes ``language`` for chunk metadata.
SOURCES = {
    "case_law_master": ("citation", "case_title", "full_text", "language"),
    "statutes_master": ("statute_name", "section_number", "section_text"),
}
_MODELS = {"case_law_master": CaseLawMaster, "statutes_master": StatutesMaster}


class LeaseLost(Exception):
    """A fenced write found the row no longer held by this batch (R2). Inside the time limits it
    cannot happen; if it does, the batch fails loudly instead of writing over another holder."""

    def __init__(self, queue_id: str):
        self.queue_id = queue_id
        super().__init__(queue_id)

    def __str__(self) -> str:
        return f"embedding_queue row {self.queue_id} is no longer held by this batch"


# ---------------------------------------------------------------------------------------------
# Rules (no database)
# ---------------------------------------------------------------------------------------------
def embed_text(title: Optional[str], label: Optional[str], body: Optional[str]) -> str:
    """The first chunk's provider input (F45); empty when there is no embeddable body."""
    chunks = ec.build_embedding_chunks(title, label, body)
    return chunks[0].embed_text if chunks else ""


def text_problem(value: str) -> Optional[str]:
    """R9: `empty_text` (empty or whitespace only), `malformed_text` (no letter or digit at all)."""
    if not value or not value.strip():
        return EMPTY_TEXT
    if not any(ch.isalnum() for ch in value):
        return MALFORMED_TEXT
    return None


def operation_id(table_name: str, record_id: Any, model: str, dimensions: int, text: str) -> str:
    """R4 (F45): operation id for chunk 0 when ``text`` is exactly the provider input."""
    chunk = ec.EmbeddingChunk(
        chunk_index=0,
        embed_text=text,
        content_hash=ec.content_hash(text),
        char_start=0,
        char_end=max(len(text), 0),
        paragraph_start=0,
        paragraph_end=0,
        language="en",
    )
    return ec.chunk_operation_id(table_name, record_id, model, dimensions, chunk)


def retry_delay_seconds(attempts: int) -> int:
    """R8: the wait after failed attempt number ``attempts`` (1 = the first): F28's backoff, 300, 600,
    1200, 2400, then 3600. The SQL below computes the same from the stored attempt count."""
    return outcomes.retry_countdown(int(attempts) - 1)


def _tokens(response: Any) -> Optional[int]:
    usage = getattr(response, "usage", None)
    for name in ("total_tokens", "prompt_tokens"):
        value = getattr(usage, name, None)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return None


def _vector(response: Any, dimensions: int) -> Optional[List[float]]:
    """The answered vector, or None when the answer is not ``dimensions`` finite numbers (R8)."""
    try:
        values = response.data[0].embedding
    except (AttributeError, IndexError, KeyError, TypeError):
        return None
    if not isinstance(values, (list, tuple)) or len(values) != dimensions:
        return None
    vector = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return None
        vector.append(float(value))
    return vector


# ---------------------------------------------------------------------------------------------
# SQL. Every time is the database's now(); every write to a claimed row is fenced on the token.
# ---------------------------------------------------------------------------------------------
# R8: after failed attempt n = attempts + 1, wait retry_delay_seconds(n) = min(base * 2^attempts, cap),
# computed from the stored (pre-update) attempts; at n >= max_attempts the row is a dead letter.
_CHARGE_SET = """
       attempts = q.attempts + 1,
       status = CASE WHEN q.attempts + 1 >= q.max_attempts THEN 'dead_letter' ELSE 'pending' END,
       next_attempt_at = CASE WHEN q.attempts + 1 >= q.max_attempts THEN NULL
                              ELSE now() + make_interval(secs => LEAST(:base * power(2, q.attempts), :cap)) END,
       error_type = CASE WHEN q.attempts + 1 >= q.max_attempts THEN 'max_attempts' ELSE :error_type END,
       error_message = :message,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = now()"""

# R3: the expired rows this batch reclaims, locked until its reclaim commits (two reclaims never take
# the same row). `reached` (review round 2, auditor finding 5): the dead batch left a receipt for this
# row under its lease, so it got as far as this row (a `started` receipt is committed with the row's
# operation mark before any request; R6 (b) takes the held receipt over before it stores). A row it
# claimed but never reached is given back with nothing charged.
EXPIRED_SQL = """
SELECT q.id, q.table_name, q.record_id, q.embedding_model, q.embedding_dimensions,
       EXISTS (SELECT 1 FROM embedding_attempts a WHERE a.queue_id = q.id AND a.lease_owner = q.lease_owner) AS reached
  FROM embedding_queue q
 WHERE q.status = 'processing' AND q.lease_expires_at <= now()
 ORDER BY q.lease_expires_at, q.id
 LIMIT :limit
 FOR UPDATE OF q SKIP LOCKED"""

# R3 (review round 1): which of these operations already has a paid answer held by a receipt.
HELD_ANSWERS_SQL = """
SELECT operation_id FROM embedding_attempts
 WHERE operation_id = ANY(:ops) AND outcome = 'answered' AND embedding IS NOT NULL"""

# R3 (review round 2): the dead batch reached these rows while their answer was held, so it was lost
# storing it: one failed store each, counted on the receipt, with the new count returned.
COUNT_LOST_STORES_SQL = """
UPDATE embedding_attempts SET store_failures = store_failures + 1
 WHERE operation_id = ANY(:ops) AND outcome = 'answered' AND embedding IS NOT NULL
RETURNING operation_id, store_failures"""

# R3 (review round 2, auditor finding 5): an expired row the dead batch never reached. No request was
# made for it, so no attempt is charged: back to `pending`, due at once.
RECLAIM_UNREACHED_SQL = """
UPDATE embedding_queue SET status = 'pending', next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
       error_type = :error_type, error_message = :message, updated_at = now()
 WHERE id = ANY(:ids)"""

# Review round 2: a held answer whose stores have failed STORE_RETRY_LIMIT times. The row goes to the
# dead letter (`store_failed`), its attempts untouched; the receipt keeps the vector, so a requeue
# stores it through R6 (b) with no new request.
RECLAIM_STORE_FAILED_SQL = """
UPDATE embedding_queue SET status = 'dead_letter', next_attempt_at = NULL, lease_owner = NULL,
       lease_expires_at = NULL, error_type = 'store_failed', error_message = :message, updated_at = now()
 WHERE id = ANY(:ids)"""

# The give-back's count of one failed store of the held answer the batch was storing (review round 2).
# None when the receipt holds no answer any more.
COUNT_STORE_FAILURE_SQL = """
UPDATE embedding_attempts SET store_failures = store_failures + 1
 WHERE id = :receipt AND outcome = 'answered' AND embedding IS NOT NULL
RETURNING store_failures"""

# An expired row with no usable held answer: the lost attempt is charged once (R3, R8).
RECLAIM_CHARGE_SQL = f"""
UPDATE embedding_queue q SET {_CHARGE_SET}
 WHERE q.id = ANY(:ids)
RETURNING q.id, q.status"""

# An expired row whose current operation has a held answer: the attempt was paid and answered, so it
# is not charged; the row is due at once and R6 (b) stores the answer on its next claim.
RECLAIM_ANSWERED_SQL = """
UPDATE embedding_queue SET status = 'pending', next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
       error_type = :error_type, error_message = :message, updated_at = now()
 WHERE id = ANY(:ids)"""

# R7 in the reclaim: a held answer for one of these records under another operation (its text
# changed, or the record cannot be embedded any more) can never be stored; its vector is dropped.
SUPERSEDE_STALE_SQL = """
UPDATE embedding_attempts a SET outcome = 'superseded', embedding = NULL, finished_at = now()
  FROM unnest(CAST(:tables AS text[]), CAST(:records AS uuid[]), CAST(:ops AS text[])) AS k(table_name, record_id, op)
 WHERE a.table_name = k.table_name AND a.record_id = k.record_id AND a.outcome = 'answered'
   AND (k.op IS NULL OR a.operation_id <> k.op)"""

# Receipts left `started` by the reclaimed rows' dead batch, and any `started` receipt older than a
# lease (its batch's lease has expired, so the batch is gone: R2).
ABANDON_SQL = """
UPDATE embedding_attempts SET outcome = 'abandoned', finished_at = now()
 WHERE outcome = 'started'
   AND (queue_id = ANY(:ids) OR started_at <= now() - make_interval(secs => :lease))"""

CLAIM_SQL = """
WITH due AS (
  SELECT id FROM embedding_queue
   WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
   ORDER BY priority DESC, created_at, id
   LIMIT :limit
   FOR UPDATE SKIP LOCKED)
UPDATE embedding_queue q
   SET status = 'processing', lease_owner = :owner, lease_expires_at = now() + make_interval(secs => :lease),
       last_attempt_at = now(), updated_at = now()
  FROM due WHERE q.id = due.id
RETURNING q.id, q.table_name, q.record_id, q.attempts, q.max_attempts, q.embedding_model,
          q.embedding_dimensions, q.stored_operation_id, q.priority, q.created_at"""

_FENCE = "WHERE id = :id AND lease_owner = :owner AND status = 'processing'"

CHARGE_SQL = f"UPDATE embedding_queue q SET {_CHARGE_SET} {_FENCE.replace('id =', 'q.id =', 1)} RETURNING q.status"

# R6 (b), review round 2: the batch takes over the held receipt before it stores it, so a reclaim
# after this batch dies knows it reached the row (EXPIRED_SQL's `reached`).
TAKE_OVER_RECEIPT_SQL = """
UPDATE embedding_attempts SET lease_owner = :owner, queue_id = :queue_id
 WHERE id = :receipt AND outcome = 'answered' AND embedding IS NOT NULL"""

# The give-back's fence (R2, review round 2: Bugbot 4307442940): the row is still this batch's, and
# stays locked until the give-back commits. No row: another batch holds it, and nothing is written.
HOLD_SQL = f"SELECT 1 FROM embedding_queue {_FENCE} FOR UPDATE"

# Review round 2 (Bugbot 4307417933, 4307442945): the give-back for a row whose held, paid answer
# failed to store. Not a provider attempt, so `attempts` is untouched, and the answer is never charged
# into the max_attempts dead letter. The row waits R8's delay for the n-th failure (300 s, 600 s), so a
# store the database keeps refusing cannot fail the next batches back to back; at the receipt's
# STORE_RETRY_LIMIT-th failed store it goes to the dead letter as `store_failed`, the vector kept in
# the receipt for a requeue. Fenced on the batch's token like every write.
GIVE_BACK_STORE_FAILED_SQL = f"""
UPDATE embedding_queue SET status = CASE WHEN :exhausted THEN 'dead_letter' ELSE 'pending' END,
       next_attempt_at = CASE WHEN :exhausted THEN NULL
                              ELSE now() + make_interval(secs => LEAST(:base * power(2, CAST(:failures AS int) - 1), :cap)) END,
       error_type = CASE WHEN :exhausted THEN 'store_failed' ELSE CAST(:error_type AS text) END,
       error_message = :message, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
 {_FENCE}"""

DEAD_LETTER_SQL = f"""
UPDATE embedding_queue SET status = 'dead_letter', error_type = :reason, error_message = :message,
       next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
 {_FENCE}"""

REQUEUE_SQL = f"""
UPDATE embedding_queue SET status = 'pending', next_attempt_at = NULL, lease_owner = NULL,
       lease_expires_at = NULL, updated_at = now()
 {_FENCE}"""

COMPLETE_SQL = f"""
UPDATE embedding_queue SET status = 'completed', operation_id = :op, stored_operation_id = :op,
       next_attempt_at = NULL, error_type = NULL, error_message = NULL,
       token_count = COALESCE(:tokens, token_count), processing_time_ms = COALESCE(:ms, processing_time_ms),
       lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
 {_FENCE}"""

MARK_OPERATION_SQL = f"UPDATE embedding_queue SET operation_id = :op, updated_at = now() {_FENCE}"

START_RECEIPT_SQL = """
INSERT INTO embedding_attempts (operation_id, queue_id, table_name, record_id, model, dimensions,
                                lease_owner, attempt, outcome)
VALUES (:op, :queue_id, :table_name, :record_id, :model, :dims, :owner, :attempt, 'started')
ON CONFLICT (operation_id) WHERE outcome IN ('started', 'answered') DO NOTHING
RETURNING id"""

FAIL_RECEIPT_SQL = """
UPDATE embedding_attempts SET outcome = 'failed', error_type = :error_type, token_count = :tokens,
       answered_at = CASE WHEN :answered THEN now() ELSE answered_at END, finished_at = now()
 WHERE id = :id AND outcome = 'started'"""

DROP_RECEIPT_SQL = """
UPDATE embedding_attempts SET outcome = 'superseded', embedding = NULL, finished_at = now()
 WHERE id = :id AND outcome = 'answered'"""

STORE_RECEIPT_SQL = """
UPDATE embedding_attempts SET outcome = 'stored', embedding = NULL, finished_at = now(), reconciled = :reconciled
 WHERE id = :id AND outcome = 'answered'"""

# R7: a record's held vectors of other operations can never be stored; drop them with the store.
SUPERSEDE_OTHERS_SQL = """
UPDATE embedding_attempts SET outcome = 'superseded', embedding = NULL, finished_at = now()
 WHERE table_name = :table_name AND record_id = :record_id AND outcome = 'answered' AND operation_id <> :op"""

RELEASE_SQL = """
UPDATE embedding_queue SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
 WHERE lease_owner = :owner AND status = 'processing'
RETURNING id"""

INTERRUPT_RECEIPTS_SQL = """
UPDATE embedding_attempts SET outcome = 'interrupted', finished_at = now()
 WHERE lease_owner = :owner AND outcome = 'started'"""

FAIL_STARTED_RECEIPTS_SQL = """
UPDATE embedding_attempts SET outcome = 'failed', error_type = :error_type, finished_at = now()
 WHERE lease_owner = :owner AND outcome = 'started' AND queue_id = :queue_id"""

ALERT_STATE_SQL = """
SELECT now(),
       (SELECT min(created_at) FROM embedding_queue WHERE status IN ('pending', 'processing')),
       (SELECT count(*) FROM (SELECT 1 FROM embedding_queue WHERE status IN ('dead_letter', 'failed')
                               LIMIT :cap_plus_one) d)"""


CHUNK_STATE_SQL = """
SELECT chunk_index, content_hash FROM record_embedding_chunks
 WHERE table_name = :table_name AND record_id = :record_id AND chunk_spec_version = :spec
   AND embedding_model = :model AND embedding IS NOT NULL"""


def _record_sql(table_name: str, lock: bool) -> str:
    cols = SOURCES[table_name]
    title, label, body = cols[0], cols[1], cols[2]
    language = cols[3] if len(cols) > 3 else "'en'"
    return (
        f"SELECT {title}, {label}, {body}, {language}, embedding IS NOT NULL "
        f"FROM {table_name} WHERE id = :id" + (" FOR UPDATE" if lock else "")
    )


def _fenced(result, row) -> None:
    if result.rowcount != 1:
        raise LeaseLost(str(row.id))


# ---------------------------------------------------------------------------------------------
# The batch
# ---------------------------------------------------------------------------------------------
class BatchCounts:
    """A batch's counters, owned by the caller that records the batch, so a batch that fails part way
    still records what it did (F28 R19, Copilot 4305705063). F27 adds the claim's own counts (R12)."""

    def __init__(self):
        self.tally = outcomes.Tally()
        self.claimed = 0
        self.missing = 0
        self.reclaimed = 0
        self.reclaimed_answered = 0  # review round 1: reclaimed rows not charged (a paid answer was held)
        self.reclaimed_unreached = 0  # review round 2: reclaimed rows the dead batch never reached (not charged)
        self.dead_lettered: Counter = Counter()
        self.reused = 0
        self.superseded = 0
        self.released = 0
        self.provider_calls = 0
        self.dead_letter_total: Optional[int] = None
        self.alerts: List[str] = []

    def summary(self, outcome):
        return {
            "outcome": outcome,
            "claimed": self.claimed,
            "completed": self.tally.succeeded,
            "failed": self.tally.failed,
            "missing": self.missing,
            "errors": dict(self.tally.errors),
            "reclaimed": self.reclaimed,
            "reclaimed_answered": self.reclaimed_answered,
            "reclaimed_unreached": self.reclaimed_unreached,
            "dead_lettered": sum(self.dead_lettered.values()),
            "dead_letter_reasons": dict(self.dead_lettered),
            "reused": self.reused,
            "superseded": self.superseded,
            "released": self.released,
            "provider_calls": self.provider_calls,
            "dead_letter_total": self.dead_letter_total,
            "alerts": list(self.alerts),
        }


class _Batch:
    def __init__(self, client, counts: BatchCounts):
        self.client = client
        self.counts = counts
        self.owner = uuid.uuid4()  # this batch's lease token
        self.db = None
        self.current = None  # the claimed row being processed
        self.held = None  # review round 2: the receipt whose paid answer the batch is storing for that row

    def _params(self, row, **extra):
        return {"id": row.id, "owner": self.owner, **extra}

    @staticmethod
    def _backoff():
        return {"base": float(outcomes.RETRY_BASE_SECONDS), "cap": float(outcomes.RETRY_MAX_SECONDS)}

    async def run(self) -> None:
        try:
            await self._run()
        except (Exception, *outcomes.INTERRUPTIONS) as exc:
            await self._evaluate_alerts(exc)  # R11: a failed batch alerts too (review round 1)
            raise
        await self._evaluate_alerts(None)

    async def _run(self) -> None:
        async with SessionLocal() as db:
            self.db = db
            await self._reclaim()
            rows = await self._claim()
            try:
                for row in rows:
                    await harvest_control.cooperative_cancel_if_paused_async()
                    self.current, self.held = row, None
                    paid = await self._process(row)
                    self.current, self.held = None, None
                    if paid:
                        await asyncio.sleep(PACE_SECONDS)  # after every provider request: 100 RPM (R15)
            except (Exception, *outcomes.INTERRUPTIONS) as exc:
                # F28 R4/R19: the failing item is counted before the batch fails; R23/R26: an
                # interruption is never an item failure.
                if self.current is not None and not outcomes.is_interruption(exc):
                    self.counts.tally.item_failed(exc)
                await self._give_back(exc)
                raise

    # -- R3 ------------------------------------------------------------------------------------
    async def _reclaim(self) -> None:
        """Reclaim up to RECLAIM_LIMIT expired leases in one transaction (R3). Each expired row is one of:

        - not reached: the dead batch left no receipt for it under its lease, so no request was made;
          it goes back to `pending`, due at once, with nothing charged (review round 2, auditor
          finding 5: at fa56eee-132957c such rows were charged and could reach the dead letter with
          no request ever made);
        - reached, with a paid answer held for its current operation: the batch was lost storing it.
          Review round 1 (Codex 4307196399): not charged, due at once, R6 (b) stores it with no
          request. Review round 2: the lost store is counted on the receipt, and at the
          STORE_RETRY_LIMIT-th the row goes to the dead letter as `store_failed` with the answer
          kept, so a row whose storing batch keeps dying stops cycling;
        - reached, no answer held (a `started` receipt: the request's outcome is unknown): charged
          once, or dead-lettered at max_attempts (R8).

        Held answers of these records under any other operation are superseded (R7)."""
        expired = (await self.db.execute(text(EXPIRED_SQL), {"limit": RECLAIM_LIMIT})).all()
        current = {row.id: await self._current_operation(row) for row in expired}
        ops = sorted({op for op in current.values() if op is not None})
        held = set((await self.db.execute(text(HELD_ANSWERS_SQL), {"ops": ops})).scalars()) if ops else set()
        unreached = [row.id for row in expired if not row.reached]
        lost_stores = sorted({current[row.id] for row in expired if row.reached and current[row.id] in held})
        failures = dict((await self.db.execute(text(COUNT_LOST_STORES_SQL), {"ops": lost_stores})).all()) if lost_stores else {}
        spared = [row.id for row in expired if row.reached and failures.get(current[row.id], STORE_RETRY_LIMIT) < STORE_RETRY_LIMIT]
        exhausted = [row.id for row in expired if row.reached and current[row.id] in failures and row.id not in spared]
        charged = [row.id for row in expired if row.reached and current[row.id] not in failures]
        if unreached:
            await self.db.execute(text(RECLAIM_UNREACHED_SQL), {
                "ids": unreached, "error_type": LEASE_EXPIRED, "message": LEASE_EXPIRED_UNREACHED_TEXT,
            })
        if spared:
            await self.db.execute(text(RECLAIM_ANSWERED_SQL), {
                "ids": spared, "error_type": LEASE_EXPIRED, "message": LEASE_EXPIRED_ANSWERED_TEXT,
            })
        if exhausted:
            await self.db.execute(text(RECLAIM_STORE_FAILED_SQL), {
                "ids": exhausted,
                "message": STORE_FAILED_TEXT.format(n=STORE_RETRY_LIMIT, last="the batch storing it was lost"),
            })
            self.counts.dead_lettered[STORE_FAILED] += len(exhausted)
        statuses = []
        if charged:
            statuses = (await self.db.execute(text(RECLAIM_CHARGE_SQL), {
                "ids": charged, "error_type": LEASE_EXPIRED, "message": LEASE_EXPIRED_TEXT, **self._backoff(),
            })).all()
        if expired:
            await self.db.execute(text(SUPERSEDE_STALE_SQL), {
                "tables": [row.table_name for row in expired], "records": [row.record_id for row in expired],
                "ops": [current[row.id] for row in expired],
            })
        await self.db.execute(text(ABANDON_SQL), {"ids": [row.id for row in expired], "lease": float(LEASE_SECONDS)})
        await self.db.commit()
        self.counts.reclaimed = len(expired)
        self.counts.reclaimed_answered = len(spared)
        self.counts.reclaimed_unreached = len(unreached)
        for row in statuses:
            if row.status == DEAD_LETTER:
                self.counts.dead_lettered[MAX_ATTEMPTS] += 1
        if expired:
            logger.warning("F27: reclaimed %d embedding row(s) whose lease expired: %d never reached (not charged), "
                           "%d charged, %d with a paid answer held (not charged), %d dead-lettered after %d failed "
                           "stores of their answer", len(expired), len(unreached), len(charged), len(spared),
                           len(exhausted), STORE_RETRY_LIMIT)

    async def _current_operation(self, row) -> Optional[str]:
        """The operation a row would embed now (next chunk, or the manifest when complete), or None
        when it cannot be embedded (R9 would dead-letter it on its next claim)."""
        if row.table_name not in SOURCES or SUPPORTED_MODELS.get(row.embedding_model) != row.embedding_dimensions:
            return None
        parsed = await self._read_record(row, lock=False)
        if parsed is None:
            return None
        chunks, manifest, _ = parsed
        if not chunks or text_problem(chunks[0].embed_text) is not None:
            return None
        stored = await self._stored_chunks(row)
        pending = ec.first_incomplete_chunk(chunks, stored)
        if pending is None:
            return manifest
        return ec.chunk_operation_id(
            row.table_name, row.record_id, row.embedding_model, row.embedding_dimensions, pending,
        )

    # -- R1 ------------------------------------------------------------------------------------
    async def _claim(self) -> List[Any]:
        rows = (await self.db.execute(text(CLAIM_SQL), {
            "limit": BATCH_SIZE, "owner": self.owner, "lease": float(LEASE_SECONDS),
        })).all()
        await self.db.commit()
        self.counts.claimed = len(rows)
        return sorted(rows, key=lambda r: (-r.priority, r.created_at, r.id))

    # -- one row -------------------------------------------------------------------------------
    async def _process(self, row) -> bool:
        """Settle one claimed row. True when a provider request was made (the caller paces)."""
        if row.table_name not in SOURCES:
            return await self._dead_letter(row, UNKNOWN_TABLE, f"{UNKNOWN_TABLE}: the queue names a table that is not embedded")
        if SUPPORTED_MODELS.get(row.embedding_model) != row.embedding_dimensions:
            return await self._dead_letter(
                row, UNSUPPORTED_MODEL,
                f"{UNSUPPORTED_MODEL}: only " + ", ".join(f"{m}/{d}" for m, d in SUPPORTED_MODELS.items()) + " is stored",
            )
        parsed = await self._read_record(row, lock=False)
        if parsed is None:
            self.counts.missing += 1
            return await self._dead_letter(row, RECORD_MISSING, f"{RECORD_MISSING}: no {row.table_name} row with this id")
        chunks, manifest, has_vector = parsed
        problem = text_problem(chunks[0].embed_text) if chunks else EMPTY_TEXT
        if problem is not None:
            return await self._dead_letter(row, problem, f"{problem}: nothing to embed in this record")
        if row.stored_operation_id == manifest and has_vector and ec.first_incomplete_chunk(chunks, await self._stored_chunks(row)) is None:
            _fenced(await self.db.execute(text(COMPLETE_SQL), self._params(row, op=manifest, tokens=None, ms=None)), row)
            await self.db.commit()
            self.counts.tally.item_ok(0)
            self.counts.reused += 1
            return False
        paid_any = False
        while True:
            stored = await self._stored_chunks(row)
            pending = ec.first_incomplete_chunk(chunks, stored)
            if pending is None:
                _fenced(await self.db.execute(text(COMPLETE_SQL), self._params(row, op=manifest, tokens=None, ms=None)), row)
                await self.db.commit()
                self.counts.tally.item_ok(0 if not paid_any else 1)
                return paid_any
            op = ec.chunk_operation_id(
                row.table_name, row.record_id, row.embedding_model, row.embedding_dimensions, pending,
            )
            held = (await self.db.execute(
                select(EmbeddingAttempt.id, EmbeddingAttempt.embedding, EmbeddingAttempt.token_count)
                .where(EmbeddingAttempt.operation_id == op, EmbeddingAttempt.outcome == "answered",
                       EmbeddingAttempt.embedding.is_not(None))
                .order_by(EmbeddingAttempt.answered_at.desc())
                .limit(1)
                .with_for_update()
            )).first()
            if held is not None:
                _fenced(await self.db.execute(text(TAKE_OVER_RECEIPT_SQL), {
                    "owner": self.owner, "queue_id": row.id, "receipt": held.id,
                }), row)
                _fenced(await self.db.execute(text(MARK_OPERATION_SQL), self._params(row, op=op)), row)
                await self.db.commit()
                self.held = held.id
                await self._store_chunk(
                    row, chunks, manifest, pending, op, list(held.embedding), held.id, held.token_count, None,
                    reconciled=True,
                )
                continue
            paid = await self._attempt(row, op, pending.embed_text, chunks, manifest, pending)
            if not paid:
                return False
            paid_any = True
            await asyncio.sleep(PACE_SECONDS)

    async def _read_record(self, row, *, lock: bool) -> Optional[Tuple[List[ec.EmbeddingChunk], str, bool]]:
        found = (await self.db.execute(text(_record_sql(row.table_name, lock)), {"id": row.record_id})).first()
        if found is None:
            return None
        title, label, body, language, has_vector = found[0], found[1], found[2], found[3], found[4]
        chunks = ec.build_embedding_chunks(title, label, body, language=language or "en")
        manifest = ec.manifest_operation_id(
            row.table_name, row.record_id, row.embedding_model, row.embedding_dimensions, chunks,
        )
        return chunks, manifest, bool(has_vector)

    async def _stored_chunks(self, row) -> List[Tuple[int, str]]:
        rows = (await self.db.execute(text(CHUNK_STATE_SQL), {
            "table_name": row.table_name,
            "record_id": row.record_id,
            "spec": CHUNK_SPEC_VERSION,
            "model": row.embedding_model,
        })).all()
        return [(int(r[0]), str(r[1])) for r in rows]

    async def _dead_letter(self, row, reason: str, message: str) -> bool:
        _fenced(await self.db.execute(text(DEAD_LETTER_SQL), self._params(row, reason=reason, message=message)), row)
        await self.db.commit()
        self.counts.dead_lettered[reason] += 1
        return False

    async def _attempt(
        self,
        row,
        op: str,
        value: str,
        chunks: List[ec.EmbeddingChunk],
        manifest: str,
        chunk: ec.EmbeddingChunk,
    ) -> bool:
        """R5: the `started` receipt is committed before the request, the `answered` one right after."""
        receipt = (await self.db.execute(text(START_RECEIPT_SQL), {
            "op": op, "queue_id": row.id, "table_name": row.table_name, "record_id": row.record_id,
            "model": row.embedding_model, "dims": row.embedding_dimensions, "owner": self.owner,
            "attempt": row.attempts + 1,
        })).scalar()
        if receipt is None:
            # R5's backstop: another unresolved attempt holds this operation. Never pay twice; charge
            # the row so it backs off while R3 abandons the orphan.
            await self._charge(self.db, row, OPERATION_IN_FLIGHT, f"{OPERATION_IN_FLIGHT}: another attempt holds this operation")
            await self.db.commit()
            self.counts.tally.item_failed(OPERATION_IN_FLIGHT)
            return False
        _fenced(await self.db.execute(text(MARK_OPERATION_SQL), self._params(row, op=op)), row)
        await self.db.commit()

        started = time.monotonic()
        self.counts.provider_calls += 1
        try:
            # FA-D3C-002: the request goes through P1 (scraper/p1_client.py), never to a provider directly.
            response = await self.client.embeddings.create(
                model=row.embedding_model, input=value, dimensions=row.embedding_dimensions, operation_id=op,
            )
        except Exception as exc:
            if outcomes.is_interruption(exc):
                raise  # F28 R26: the batch's time limit, not this item's failure
            if outcomes.is_database_error(exc):
                raise  # F28 R4 (the provider client never raises one; kept for symmetry)
            if isinstance(exc, p1_client.P1Refused):
                await self._refused(row, receipt, exc)
                raise  # FA-D3C-002 R14: the batch stops; process_embedding_queue reports it
            await self._failed(row, receipt, exc, tokens=None, answered=False)
            return True
        tokens = _tokens(response)
        vector = _vector(response, row.embedding_dimensions)
        if vector is None:
            await self._failed(row, receipt, MALFORMED_RESPONSE, tokens=tokens, answered=True)
            return True
        answered = await self.db.execute(
            update(EmbeddingAttempt)
            .where(EmbeddingAttempt.id == receipt, EmbeddingAttempt.outcome == "started")
            .values(outcome="answered", answered_at=func.now(), token_count=tokens, embedding=vector)
            .execution_options(synchronize_session=False)
        )
        _fenced(answered, row)  # the receipt is this batch's until it is stored
        await self.db.commit()
        self.held = receipt
        await self._store_chunk(row, chunks, manifest, chunk, op, vector, receipt, tokens, started, reconciled=False)
        return True

    async def _refused(self, row, receipt, refused: "p1_client.P1Refused") -> None:
        """FA-D3C-002 R14: P1 refused before any provider request (a kill switch, the budget, the policy, no credentials,
        the caller not admitted). That is not an attempt, so the row is not charged (R8 charges attempts): its `started`
        receipt is closed `failed` (`p1_refused`, not answered, no tokens), the request leaves `provider_calls`, and the
        row stops being the row in flight, so R10's give-back returns it to `pending` with its attempts unchanged, like
        every other row this batch claimed."""
        logger.warning("FA-D3C-002: P1 refused the embedding of row %s (%s); the batch stops", row.id, refused.reason)
        await self.db.execute(text(FAIL_RECEIPT_SQL), {"id": receipt, "error_type": P1_REFUSED, "tokens": None, "answered": False})
        await self.db.commit()
        self.counts.provider_calls -= 1
        self.current = None

    async def _failed(self, row, receipt, error, *, tokens: Optional[int], answered: bool) -> None:
        error_type = outcomes.error_key(error)
        message = outcomes.describe_error(error) if isinstance(error, BaseException) else error
        logger.error("Embedding failed %s: %s", row.id, message)
        await self.db.execute(text(FAIL_RECEIPT_SQL), {
            "id": receipt, "error_type": error_type, "tokens": tokens, "answered": answered,
        })
        await self._charge(self.db, row, error_type, message)
        await self.db.commit()
        self.counts.tally.item_failed(error)

    async def _charge(self, db, row, error_type: str, message: str) -> Optional[str]:
        """R8: one failed attempt: back off, or dead-letter at max_attempts. Returns the new status
        (None when the row is no longer this batch's)."""
        status = (await db.execute(text(CHARGE_SQL), self._params(
            row, error_type=error_type, message=message, **self._backoff(),
        ))).scalar()
        if status is None:
            raise LeaseLost(str(row.id))
        if status == DEAD_LETTER:
            self.counts.dead_lettered[MAX_ATTEMPTS] += 1
        return status

    async def _store_chunk(
        self,
        row,
        chunks: List[ec.EmbeddingChunk],
        manifest: str,
        chunk: ec.EmbeddingChunk,
        op: str,
        vector,
        receipt,
        tokens,
        started,
        *,
        reconciled: bool,
    ) -> None:
        """R7 (F45): store one chunk vector when the record still matches this chunk's content hash."""
        record = await self._read_record(row, lock=True)
        if record is None:
            await self.db.execute(text(DROP_RECEIPT_SQL), {"id": receipt})
            self.counts.missing += 1
            await self._dead_letter(row, RECORD_MISSING, f"{RECORD_MISSING}: the record was deleted while it was embedded")
            return
        live_chunks, live_manifest, _ = record
        expected = next((c for c in live_chunks if c.chunk_index == chunk.chunk_index), None)
        if (
            live_manifest != manifest
            or expected is None
            or expected.content_hash != chunk.content_hash
            or ec.chunk_operation_id(
                row.table_name, row.record_id, row.embedding_model, row.embedding_dimensions, expected,
            )
            != op
        ):
            await self.db.execute(text(DROP_RECEIPT_SQL), {"id": receipt})
            _fenced(await self.db.execute(text(REQUEUE_SQL), self._params(row)), row)
            await self.db.commit()
            self.counts.superseded += 1
            logger.info("F27: embedding row %s superseded: its record changed while it was embedded", row.id)
            return
        await self.db.execute(
            text(
                """
INSERT INTO record_embedding_chunks (
  table_name, record_id, chunk_index, chunk_spec_version, content_hash,
  char_start, char_end, paragraph_start, paragraph_end, language,
  embedding_model, embedding_dimensions, operation_id, embedding, updated_at
) VALUES (
  :table_name, :record_id, :chunk_index, :spec, :content_hash,
  :char_start, :char_end, :paragraph_start, :paragraph_end, :language,
  :model, :dims, :op, CAST(:vec AS vector), now()
)
ON CONFLICT (table_name, record_id, chunk_index, chunk_spec_version, embedding_model)
DO UPDATE SET
  content_hash = EXCLUDED.content_hash,
  char_start = EXCLUDED.char_start,
  char_end = EXCLUDED.char_end,
  paragraph_start = EXCLUDED.paragraph_start,
  paragraph_end = EXCLUDED.paragraph_end,
  language = EXCLUDED.language,
  embedding_dimensions = EXCLUDED.embedding_dimensions,
  operation_id = EXCLUDED.operation_id,
  embedding = EXCLUDED.embedding,
  updated_at = now()
"""
            ),
            {
                "table_name": row.table_name,
                "record_id": row.record_id,
                "chunk_index": chunk.chunk_index,
                "spec": CHUNK_SPEC_VERSION,
                "content_hash": chunk.content_hash,
                "char_start": chunk.char_start,
                "char_end": chunk.char_end,
                "paragraph_start": chunk.paragraph_start,
                "paragraph_end": chunk.paragraph_end,
                "language": chunk.language,
                "model": row.embedding_model,
                "dims": row.embedding_dimensions,
                "op": op,
                "vec": vector,
            },
        )
        if chunk.chunk_index == 0:
            master = _MODELS[row.table_name]
            await self.db.execute(
                update(master).where(master.id == row.record_id).values(embedding=vector)
                .execution_options(synchronize_session=False)
            )
        _fenced(await self.db.execute(text(MARK_OPERATION_SQL), self._params(row, op=op)), row)
        _fenced(await self.db.execute(text(STORE_RECEIPT_SQL), {"id": receipt, "reconciled": reconciled}), row)
        await self.db.execute(text(SUPERSEDE_OTHERS_SQL), {
            "table_name": row.table_name, "record_id": row.record_id, "op": op,
        })
        await self.db.commit()
        if reconciled:
            self.counts.reused += 1

    # -- R10 -----------------------------------------------------------------------------------
    async def _give_back(self, exc: BaseException) -> None:
        """Give back what the batch still holds, in a fresh session, never replacing the batch's own
        exception. On an interruption nothing is charged (F28 R26) and a request still out is
        `interrupted`; otherwise the row in flight is settled by `_give_back_row`. Every other claimed
        row goes back to `pending` untouched. If this cannot run, the leases expire and the next batch
        reclaims the rows (R3)."""
        await self._discard_session()
        charge = None if outcomes.is_interruption(exc) else self.current
        try:
            async with SessionLocal() as db:
                await db.execute(text(f"SET LOCAL lock_timeout = '{GIVE_BACK_LOCK_TIMEOUT}'"))
                if charge is not None:
                    try:
                        await self._give_back_row(db, charge, exc)
                    except LeaseLost:
                        logger.error("F27: embedding row %s is held by another batch now; the failed batch "
                                     "leaves it and its receipts to that holder", charge.id)
                released = (await db.execute(text(RELEASE_SQL), {"owner": self.owner})).all()
                if outcomes.is_interruption(exc):
                    await db.execute(text(INTERRUPT_RECEIPTS_SQL), {"owner": self.owner})
                await db.commit()
                self.counts.released = len(released)
        except Exception as cleanup:
            if outcomes.is_interruption(cleanup):
                raise
            logger.error(
                "F27: the failed embedding batch could not give back its rows (%s); their leases expire "
                "and the next batch reclaims them. The batch's own error: %s",
                outcomes.describe_error(cleanup), outcomes.describe_error(exc),
            )

    async def _give_back_row(self, db, row, exc: BaseException) -> None:
        """R10 for the row in flight (never on an interruption). Every write is fenced on the batch's
        token, the fence checked first: a row another batch holds now (the fence matches nothing:
        LeaseLost) is left to it with its receipts, and nothing is counted or written (review round 2:
        Bugbot 4307442940, against Autofix ee8ee02's unfenced write).

        - The batch was storing a paid answer it holds (`self.held`: the `answered` receipt committed,
          or taken over for R6 (b)): the failed store is not a provider attempt and is not charged, so
          the answer is never charged into the max_attempts dead letter (Bugbot 4307417933). It is
          counted on the receipt; the row waits R8's delay, and at STORE_RETRY_LIMIT failed stores it
          is dead-lettered as `store_failed` with the answer kept for a requeue (bounded: Bugbot
          4307442945, against ee8ee02's always-due, never-charged row).
        - Otherwise the row is charged once (R8) and its `started` receipt is `failed` with the row's
          error type (review round 1, Bugbot 4307214719; kept from Autofix c2266ae)."""
        error_type, message = outcomes.error_key(exc), outcomes.describe_error(exc)
        if self.held is not None and await self._store_failed(db, row, error_type, message):
            return
        await self._charge(db, row, error_type, message)
        await db.execute(text(FAIL_STARTED_RECEIPTS_SQL), {
            "owner": self.owner, "queue_id": row.id, "error_type": error_type,
        })

    async def _store_failed(self, db, row, error_type: str, message: str) -> bool:
        """Count one failed store of the held answer and give the row back (see `_give_back_row`).
        False when the receipt holds no answer any more (the row is then charged as usual)."""
        if (await db.execute(text(HOLD_SQL), self._params(row))).first() is None:
            raise LeaseLost(str(row.id))
        failures = (await db.execute(text(COUNT_STORE_FAILURE_SQL), {"receipt": self.held})).scalar()
        if failures is None:
            return False
        exhausted = failures >= STORE_RETRY_LIMIT
        if exhausted:
            message = STORE_FAILED_TEXT.format(n=failures, last=message)
        _fenced(await db.execute(text(GIVE_BACK_STORE_FAILED_SQL), self._params(
            row, exhausted=exhausted, failures=failures, error_type=error_type, message=message, **self._backoff(),
        )), row)
        if exhausted:
            self.counts.dead_lettered[STORE_FAILED] += 1
        logger.error("F27: embedding row %s: storing its paid answer failed (%d of %d): %s", row.id, failures,
                     STORE_RETRY_LIMIT, message)
        return True

    async def _discard_session(self) -> None:
        """End the batch session's transaction so its locks are gone before the give-back; if a
        rollback is impossible (a connection cut off mid-statement), drop the connection."""
        try:
            await self.db.rollback()
            return
        except Exception as exc:
            if outcomes.is_interruption(exc):
                raise
            logger.warning("F27: rolling back the failed embedding batch: %s", outcomes.describe_error(exc))
        try:
            await self.db.invalidate()
        except Exception as exc:
            if outcomes.is_interruption(exc):
                raise
            logger.warning("F27: dropping the failed embedding batch's connection: %s", outcomes.describe_error(exc))

    # -- R11 -----------------------------------------------------------------------------------
    async def _evaluate_alerts(self, exc: Optional[BaseException]) -> None:
        """R11 on every keyed batch, failed ones included (review round 1, Bugbot 4307214725 and
        4307237211), in a fresh session (a failed batch's own may be rolled back or invalidated). An
        alert that cannot be evaluated is logged at ERROR: it never fails a batch whose work stands and
        never replaces a failed batch's own exception (``exc``); only a new interruption propagates
        (F28 R23)."""
        try:
            async with SessionLocal() as db:
                await self._alerts(db)
        except Exception as alert_exc:
            if outcomes.is_interruption(alert_exc):
                raise
            logger.error(
                "F27: could not evaluate the embedding alerts (%s)%s", outcomes.describe_error(alert_exc),
                "" if exc is None else f"; the batch failed with its own error: {outcomes.describe_error(exc)}",
            )

    async def _alerts(self, db) -> None:
        now, oldest, total = (await db.execute(text(ALERT_STATE_SQL), {
            "cap_plus_one": DEAD_LETTER_COUNT_CAP + 1,
        })).one()
        await db.commit()
        self.counts.dead_letter_total = min(int(total), DEAD_LETTER_COUNT_CAP)
        total_text = f"{DEAD_LETTER_COUNT_CAP}+" if total > DEAD_LETTER_COUNT_CAP else str(total)
        alerts = []
        if oldest is not None and (now - oldest).total_seconds() > BACKLOG_ALERT_SECONDS:
            hours = int((now - oldest).total_seconds() // 3600)
            alerts.append(f"backlog_stale: the oldest waiting row was queued {oldest.isoformat()} ({hours} h ago)")
        if self.counts.dead_lettered:
            reasons = ", ".join(f"{reason} x{n}" for reason, n in sorted(self.counts.dead_lettered.items()))
            alerts.append(
                f"dead_letter: {sum(self.counts.dead_lettered.values())} row(s) dead-lettered by this batch "
                f"({reasons}); {total_text} in the dead letter"
            )
        self.counts.alerts = alerts
        for alert in alerts:
            logger.error("F28 source alert: %s %s", job_record.EMBED_SITE, alert)


async def process_embedding_queue(counts=None):
    counts = counts if counts is not None else BatchCounts()
    # FA-D3C-002 (R13, R14): every paid embedding goes through the P1 gateway; the corpus holds no provider key or SDK.
    try:
        client = p1_client.embedding_client()
        if client is None:
            logger.info("No P1_EMBEDDING_URL, skip embeddings")
            return {**counts.summary(outcomes.OUTCOME_SKIPPED), "reason": "no_p1_embedding_url"}
        await _Batch(client, counts).run()
    except p1_client.P1Refused as refused:
        # No provider request was made for the refused row; it and every other claimed row are back in the queue.
        logger.warning("FA-D3C-002: P1 refused the embedding batch (%s)", refused.reason)
        tally = counts.tally
        outcome = outcomes.OUTCOME_SKIPPED if tally.attempted == 0 else tally.result().outcome
        return {**counts.summary(outcome), "reason": f"p1_refused:{refused.reason}"}
    tally = counts.tally
    if tally.all_failed:
        raise outcomes.BatchFailed(errors=tally.errors)
    return counts.summary(tally.result().outcome)


async def run_embedding_batch(*, celery_task_id=None, worker=None):
    """One batch with its run record: a `scraper_jobs` row (job type `embed`) when the batch claimed
    or reclaimed work, or failed; an empty queue or a skipped batch writes none (F28 R13, F27 R12)."""
    if await harvest_control.is_paused_async():
        logger.info("Harvester paused by operator; skipping scheduled embedding batch")
        counts = BatchCounts()
        return {**counts.summary(outcomes.OUTCOME_SKIPPED), "reason": "harvest_paused"}
    started = job_record.utcnow()
    counts = BatchCounts()
    try:
        summary = await process_embedding_queue(counts)
    except outcomes.HarvestOperatorPaused:
        summary = {
            **counts.summary(outcomes.OUTCOME_SKIPPED),
            "reason": outcomes.REASON_HARVEST_STOPPED,
        }
        tally = counts.tally
        if counts.claimed or counts.reclaimed:
            try:
                await job_record.record_batch(
                    status=job_record.STATUS_CANCELLED,
                    summary=summary,
                    started=started,
                    attempted=tally.attempted,
                    written=tally.succeeded,
                    failed=tally.failed,
                    celery_task_id=celery_task_id,
                    worker=worker,
                )
            except Exception as record_exc:
                logger.error(
                    "F29: could not record operator-cancelled embedding batch (%s)",
                    outcomes.describe_error(record_exc),
                )
        return summary
    except (Exception, *outcomes.INTERRUPTIONS) as exc:
        # F28 R19: the failed record comes from the batch's own counters, so items done before the
        # failure are kept (an exception escaping the item loop carries no counts of its own).
        # F28 R26: a batch cut off by the time limit (or cancelled) is recorded the same way, as
        # RunInterrupted; the original is re-raised.
        tally = counts.tally
        recorded = outcomes.RunInterrupted.of(exc) if outcomes.is_interruption(exc) else exc
        extra = {"interrupted_by": recorded.interrupted_by} if recorded is not exc else {}
        try:
            await job_record.record_batch(
                status=job_record.STATUS_FAILED,
                summary={**counts.summary(outcomes.OUTCOME_FAILED), "error_class": type(recorded).__name__, **extra},
                started=started, attempted=tally.attempted, written=tally.succeeded, failed=tally.failed,
                celery_task_id=celery_task_id, worker=worker, exc=recorded,
            )
        except Exception as record_exc:
            logger.error(
                "F28: could not record the failed embedding batch (%s); the batch's own error follows: %s",
                outcomes.describe_error(record_exc), outcomes.describe_error(exc),
            )
        raise
    if summary["claimed"] or summary["reclaimed"]:
        try:
            await job_record.record_batch(
                status=job_record.STATUS_COMPLETED, summary=summary, started=started,
                attempted=summary["completed"] + summary["failed"], written=summary["completed"], failed=summary["failed"],
                celery_task_id=celery_task_id, worker=worker,
            )
        except Exception as exc:
            # F28 R18: the batch's work stands; only its record failed (the same mechanism as a run).
            logger.error(
                "F28 run record failed: %s %s batch could not be recorded (%s)",
                job_record.EMBED_SITE, summary["outcome"], outcomes.describe_error(exc),
            )
            raise outcomes.RunRecordFailed(job_record.EMBED_SITE) from exc
    return summary


def process_embedding_queue_sync(celery_task_id=None, worker=None):
    return asyncio.run(job_record.in_task_loop(run_embedding_batch(celery_task_id=celery_task_id, worker=worker)))


@shared_task(name="scraper.tasks.embeddings.process_embedding_queue", bind=True)
def process_embedding_queue_task(self):
    # No Celery retry (F28 R7): beat fires this every 5 minutes and each row has its own attempt
    # bound and next_attempt_at (F27 R8). Pause is checked inside run_embedding_batch (F29) so the
    # gate shares the task's one asyncio.run / in_task_loop lifecycle (F27 prefork).
    return process_embedding_queue_sync(celery_task_id=self.request.id, worker=self.request.hostname)
