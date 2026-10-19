"""Audit F21: the corpus lifecycle's registered consumers.

Spec: docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md (R4, R5, R10, R11, R15).

Four Celery tasks, each on the beat schedule (scraper.tasks.celery_app):

    normalise-corpus  every 300 s   parsed -> normalised | failed | duplicate      (tasks/normalise.py)
    promote-corpus    every 300 s   normalised -> quarantined | approved             (tasks/promotion.gate)
    publish-corpus    every 300 s   F23 decisions, then approved -> published -> embedded (tasks/publish.py)
    reconcile-corpus  every 3600 s  F23 decisions, review rows, published rows; the report and alerts

A tick claims at most ``LIMITS[consumer]`` records, one per transaction: the transaction's first
statement selects the oldest record in the phase's state ``FOR UPDATE SKIP LOCKED`` (the WHERE clause
is re-checked on the locked row, so a record moved since the scan is not returned), excluding records
this tick already tried; the step then moves it and the transaction commits. Two workers never move one
record; a record locked elsewhere is skipped, never waited on; a worker killed mid-move takes its
uncommitted writes with it and the record is claimable again (R15).

A failed record is classified as promotion classifies one (scraper.tasks.promotion.failure_kind): a
transient or systemic failure leaves it where it is (counted ``failed``; after SYSTEMIC_FAILURE_LIMIT
consecutive systemic failures with the same SQLSTATE or class the tick stops early); a record-specific
one is settled in a fresh transaction: the gate keeps F19's quarantine (promotion_error:<Class>,
batch_invalid:<code>), the other consumers move the record to ``dead_letter``
(``<consumer>_error:<SQLSTATE or class>``). An interruption (outcomes.INTERRUPTIONS) is re-raised
before any ``except Exception`` (F28 R23) and the tick is recorded as failed.

A tick that claimed a record, or failed, writes one scraper_jobs row (job_record.record_consumer_run;
every reconcile tick writes one, holding the report). A tick that tried records and moved none raises
outcomes.BatchFailed after recording, so Celery records FAILURE (F28 R13's rule). No Celery retry: beat
runs the next tick.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Tuple

from celery import shared_task
from sqlalchemy import exists, func, or_, select

from scraper import database
from scraper.models import QuarantineQueue, ScraperStaging, StatutesStaging
from scraper.publication import retrieval
from scraper.tasks import job_record, lifecycle, normalise, outcomes, promotion, publish, reconcile

logger = logging.getLogger(__name__)

LIMITS = {
    lifecycle.JOB_TYPE_NORMALISE: 200,
    lifecycle.JOB_TYPE_PROMOTE: 100,
    lifecycle.JOB_TYPE_PUBLISH: 100,
    lifecycle.JOB_TYPE_RECONCILE: 200,
}
SYSTEMIC_FAILURE_LIMIT = promotion.SYSTEMIC_FAILURE_LIMIT
MODELS = (ScraperStaging, StatutesStaging)
REASON_QUARANTINED_WITHOUT_REVIEW_ROW = "quarantined_without_review_row"


def _queue_column(model):
    return QuarantineQueue.statutes_staging_id if model is StatutesStaging else QuarantineQueue.staging_id


def _review_moved(model):
    """The record has a review row a reviewer has acted on (F23 sets reviewed on promote and reject)."""
    return exists().where(
        _queue_column(model) == model.id,
        or_(QuarantineQueue.reviewed.is_(True), func.coalesce(QuarantineQueue.resolution, "pending") != "pending"),
    )


def _no_review_row(model):
    return ~exists().where(_queue_column(model) == model.id)


# phase: (name, state, extra conditions(model) -> list, step, on record-specific failure)
@dataclass(frozen=True)
class Phase:
    name: str
    state: str
    conditions: Callable[[Any], Sequence[Any]]
    step: Callable[..., Awaitable[Optional[str]]]
    on_record_error: str  # "quarantine" (the gate) or "dead_letter"


async def _orphan_step(db, row, *, job_id=None) -> str:
    lifecycle.move(db, row, lifecycle.DEAD_LETTER, actor=lifecycle.ACTOR_RECONCILE, job_id=job_id,
                   reason=REASON_QUARANTINED_WITHOUT_REVIEW_ROW)
    return lifecycle.DEAD_LETTER


async def _published_step(db, row, *, job_id=None) -> str:
    """A published record without its outbox row (a pre-F21 record, or an outbox row an operator
    removed): enqueue it and move it on; a record whose retrieval row has gone is dead-lettered."""
    table = publish.table_of(row)
    outbox = await retrieval.outbox_row(db, table, row.published_id)
    requeued = False
    if outbox is None:
        if not await retrieval.retrieval_row_exists(db, table, row.published_id):
            lifecycle.move(db, row, lifecycle.DEAD_LETTER, actor=lifecycle.ACTOR_RECONCILE, job_id=job_id,
                           reason=publish.REASON_PUBLISHED_RECORD_MISSING,
                           details=lifecycle.summary_details(published_table=table, published_id=row.published_id))
            return lifecycle.DEAD_LETTER
        outbox, requeued = await retrieval.enqueue_embedding(db, table, row.published_id), True
    lifecycle.move(db, row, lifecycle.EMBEDDED, actor=lifecycle.ACTOR_RECONCILE, job_id=job_id,
                   details=lifecycle.summary_details(embedding_outbox_id=outbox, requeued=requeued or None))
    return lifecycle.EMBEDDED


# The steps look their function up when called (late binding), so a test can wrap one.
async def _normalise_step(db, row, *, job_id=None) -> str:
    return await normalise.normalise(db, row, job_id=job_id)


async def _gate_step(db, row, *, job_id=None) -> str:
    return await promotion.gate(db, row, job_id=job_id)


async def _sync_step(db, row, *, job_id=None) -> Optional[str]:
    return await publish.sync_review(db, row, job_id=job_id)


async def _publish_step(db, row, *, job_id=None) -> str:
    return await publish.publish(db, row, job_id=job_id)


_SYNC = Phase("review_sync", lifecycle.QUARANTINED, lambda m: [_review_moved(m)], _sync_step, "dead_letter")
PHASES: Dict[str, Tuple[Phase, ...]] = {
    lifecycle.JOB_TYPE_NORMALISE: (
        Phase("normalise", lifecycle.PARSED, lambda m: [], _normalise_step, "dead_letter"),
    ),
    lifecycle.JOB_TYPE_PROMOTE: (
        Phase("gate", lifecycle.NORMALISED,
              lambda m: [m.normalised.is_(True), m.promoted.is_(False), m.quarantined.is_(False)],
              _gate_step, "quarantine"),
    ),
    lifecycle.JOB_TYPE_PUBLISH: (
        _SYNC,
        Phase("publish", lifecycle.APPROVED, lambda m: [], _publish_step, "dead_letter"),
    ),
    lifecycle.JOB_TYPE_RECONCILE: (
        _SYNC,
        Phase("orphan_review", lifecycle.QUARANTINED, lambda m: [_no_review_row(m)], _orphan_step, "dead_letter"),
        Phase("outbox", lifecycle.PUBLISHED, lambda m: [], _published_step, "dead_letter"),
    ),
}


@dataclass
class TickCounts:
    claimed: int = 0
    failed: int = 0
    moved: Counter = field(default_factory=Counter)
    errors: Counter = field(default_factory=Counter)
    aborted: Optional[str] = None

    @property
    def moved_total(self) -> int:
        return sum(n for outcome, n in self.moved.items() if outcome != "unchanged")

    @property
    def outcome(self) -> str:
        if self.claimed == 0 and self.failed == 0:
            return outcomes.OUTCOME_EMPTY
        if self.failed and not self.moved_total:
            return outcomes.OUTCOME_FAILED
        return outcomes.OUTCOME_PARTIAL if self.failed or self.aborted else outcomes.OUTCOME_OK

    def summary(self) -> Dict[str, Any]:
        out = {"outcome": self.outcome, "claimed": self.claimed, "moved": dict(self.moved), "failed": self.failed,
               "errors": dict(self.errors)}
        if self.aborted:
            out["aborted"] = self.aborted
        return out


def _claim(model, phase: Phase, seen: List[uuid.UUID]):
    return (
        select(model)
        .where(model.lifecycle_state == phase.state, *phase.conditions(model), model.id.not_in(seen))
        .order_by(model.created_at, model.id)
        .limit(1)
        .with_for_update(skip_locked=True)
        .execution_options(populate_existing=True)
    )


async def _claim_oldest(db, phase: Phase, seen: Dict[Any, List[uuid.UUID]]):
    """Claim the oldest claimable row in the phase across case and statute staging (created_at, then
    id; R4). Each table's oldest row is taken with FOR UPDATE SKIP LOCKED (``_claim``) before the
    tables are compared, so a row locked elsewhere is skipped, never stalls the tick, and never lets
    a newer row of its table jump ahead of the other table's older one (FA-F21-001). The other
    table's candidate stays locked only until this row's transaction ends."""
    claimed = [row for model in MODELS
               if (row := (await db.execute(_claim(model, phase, seen[model]))).scalars().first()) is not None]
    return min(claimed, key=lambda row: (row.created_at, row.id), default=None)


def _error_code(exc: BaseException) -> str:
    return promotion._sqlstate(exc) or type(exc).__name__


async def _dead_letter_after_error(db, model, record_id, state: str, reason: str, actor: str, job_id) -> None:
    """Settle a record-specific failure in a fresh transaction, if the record is still where it was."""
    try:
        async with db.begin():
            row = (await db.execute(
                select(model).where(model.id == record_id, model.lifecycle_state == state)
                .with_for_update(skip_locked=True)
                .execution_options(populate_existing=True)
            )).scalars().first()
            if row is not None:
                lifecycle.move(db, row, lifecycle.DEAD_LETTER, actor=actor, job_id=job_id, reason=reason)
            else:  # locked elsewhere (SKIP LOCKED) or no longer in `state`: left for the next tick
                logger.warning("lifecycle.dead_letter_skipped table=%s id=%s state=%s", model.__tablename__,
                               record_id, state)
    except outcomes.INTERRUPTIONS:
        raise
    except Exception as second:  # noqa: BLE001 - the tick goes on; the record stays where it was
        logger.error("lifecycle.dead_letter_failed table=%s id=%s error=%s", model.__tablename__, record_id,
                     type(second).__name__)


async def _drain(phase: Phase, consumer: str, counts: TickCounts, job_id: uuid.UUID, limit: int) -> None:
    seen: Dict[Any, List[uuid.UUID]] = {model: [] for model in MODELS}
    streak_key, streak = None, 0
    async with database.SessionLocal() as db:
        while counts.claimed < limit:
            claimed: Optional[Tuple[Any, uuid.UUID]] = None
            outcome: Optional[str] = None
            try:
                async with db.begin():
                    row = await _claim_oldest(db, phase, seen)
                    if row is None:
                        return
                    claimed = (type(row), row.id)
                    seen[type(row)].append(row.id)
                    counts.claimed += 1
                    outcome = await phase.step(db, row, job_id=job_id)
            except outcomes.INTERRUPTIONS:
                raise  # F28 R23: never counted as a record's failure
            except Exception as exc:  # noqa: BLE001 - one record must not stop the tick
                if claimed is None:
                    raise  # the claim itself failed: a database fault, the tick fails
                model, record_id = claimed
                code = _error_code(exc)
                kind, reason = promotion.failure_kind(exc)
                counts.failed += 1
                counts.errors[code] += 1
                (logger.error if kind == promotion.FAILURE_SYSTEMIC else logger.warning)(
                    "lifecycle.record_failed consumer=%s phase=%s table=%s id=%s error=%s sqlstate=%s kind=%s",
                    consumer, phase.name, model.__tablename__, record_id, type(exc).__name__,
                    promotion._sqlstate(exc) or "none", kind,
                )
                if kind == promotion.FAILURE_RECORD:
                    if phase.on_record_error == "quarantine":
                        await promotion._quarantine_after_error(db, record_id, exc, reason, model=model, job_id=job_id)
                    else:
                        await _dead_letter_after_error(db, model, record_id, phase.state, f"{phase.name}_error:{code}",
                                                       consumer, job_id)
                if kind != promotion.FAILURE_SYSTEMIC:
                    streak_key, streak = None, 0
                    continue
                streak = streak + 1 if code == streak_key else 1
                streak_key = code
                if streak >= SYSTEMIC_FAILURE_LIMIT:
                    counts.aborted = f"systemic:{code}"
                    logger.error("lifecycle.aborted consumer=%s phase=%s key=%s consecutive=%d", consumer, phase.name,
                                 code, streak)
                    return
                continue
            streak_key, streak = None, 0
            counts.moved[outcome or "unchanged"] += 1


async def run_tick(consumer: str, *, celery_task_id: Optional[str] = None, worker: Optional[str] = None) -> Dict[str, Any]:
    """One scheduled tick of ``consumer`` (a lifecycle job type). Returns its summary."""
    job_id = uuid.uuid4()
    started = job_record.utcnow()
    counts = TickCounts()
    report: Optional[Dict[str, Any]] = None
    alerts: List[Tuple[str, str]] = []

    async def record(status: str, exc: Optional[BaseException] = None, extra: Optional[Dict[str, Any]] = None) -> None:
        summary = {**counts.summary(), **(extra or {})}
        if exc is not None:
            summary["outcome"] = outcomes.OUTCOME_FAILED
        await job_record.record_consumer_run(
            job_id=job_id, job_type=consumer, status=status, summary=summary, started=started,
            attempted=counts.claimed, written=counts.moved_total, failed=counts.failed,
            celery_task_id=celery_task_id, worker=worker, exc=exc,
        )

    try:
        for phase in PHASES[consumer]:
            await _drain(phase, consumer, counts, job_id, LIMITS[consumer])
            if counts.aborted:
                break
        if consumer == lifecycle.JOB_TYPE_RECONCILE:
            async with database.SessionLocal() as db:
                report, alerts = await reconcile.lifecycle_report(db)
            reconcile.log_alerts(alerts)
    except outcomes.INTERRUPTIONS as exc:
        await _record_failure(record, outcomes.RunInterrupted.of(exc), consumer)
        raise
    except Exception as exc:
        await _record_failure(record, exc, consumer)
        raise
    extra = {"report": report, "alerts": reconcile.alert_lines(alerts)} if consumer == lifecycle.JOB_TYPE_RECONCILE else {}
    tick_failed = counts.outcome == outcomes.OUTCOME_FAILED
    if consumer == lifecycle.JOB_TYPE_RECONCILE or counts.claimed or counts.failed:
        try:
            await record(job_record.STATUS_FAILED if tick_failed else job_record.STATUS_COMPLETED, extra=extra)
        except outcomes.INTERRUPTIONS:
            raise
        except Exception as exc:
            logger.error("F21 tick record failed: %s tick %s could not be recorded (%s)", consumer, job_id,
                         outcomes.describe_error(exc))
            raise outcomes.RunRecordFailed(f"corpus_lifecycle:{consumer}") from exc
    if tick_failed:
        raise outcomes.BatchFailed(dict(counts.errors))
    return {**counts.summary(), **extra, "job_id": str(job_id)}


async def _record_failure(record, exc: BaseException, consumer: str) -> None:
    try:
        await record(job_record.STATUS_FAILED, exc=exc)
    except outcomes.INTERRUPTIONS:
        raise  # F28 R23
    except Exception as record_exc:  # noqa: BLE001 - never mask the tick's own failure
        logger.error("F21: could not record the failed %s tick (%s); the tick's own error follows: %s", consumer,
                     outcomes.describe_error(record_exc), outcomes.describe_error(exc))


def _run(task, consumer: str):
    return asyncio.run(job_record.in_task_loop(run_tick(
        consumer, celery_task_id=task.request.id, worker=task.request.hostname,
    )))


@shared_task(name="scraper.tasks.corpus_pipeline.normalise_corpus", bind=True)
def normalise_corpus(self):
    return _run(self, lifecycle.JOB_TYPE_NORMALISE)


@shared_task(name="scraper.tasks.corpus_pipeline.promote_corpus", bind=True)
def promote_corpus(self):
    return _run(self, lifecycle.JOB_TYPE_PROMOTE)


@shared_task(name="scraper.tasks.corpus_pipeline.publish_corpus", bind=True)
def publish_corpus(self):
    return _run(self, lifecycle.JOB_TYPE_PUBLISH)


@shared_task(name="scraper.tasks.corpus_pipeline.reconcile_corpus", bind=True)
def reconcile_corpus(self):
    return _run(self, lifecycle.JOB_TYPE_RECONCILE)
