"""Audit F21: the publication steps of the corpus lifecycle.

Spec: docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md (R8, R9, R10).

* ``sync_review`` (R10): a ``quarantined`` record whose review has moved. F23's promote is one
  transaction that writes ``case_law_master``, the outbox row, ``scraper_staging.promoted`` and a
  ``quarantine_decisions`` row, so a promoted decision moves the record ``quarantined`` -> ``approved``
  -> ``published`` -> ``embedded`` with the decision's ids (the outbox row is re-enqueued through
  ``retrieval.enqueue_embedding`` only if it has gone). Every review row resolved with no promoted
  decision: ``rejected`` (``review_rejected``). A review row marked reviewed before F23 with no decision
  (F23 residual 8): ``dead_letter`` (``review_resolved_without_evidence``); no evidence is invented.
  The F23 route is not edited and its lock order is kept: this takes only the record's row.
* ``publish`` (R8, R9): an ``approved`` record. The source is resolved again and read ``FOR SHARE``,
  and F20's ``publication_decision`` must still promote (else ``dead_letter``,
  ``source_not_promotable:<reason>``); then the retrieval projection and the outbox row, and
  ``approved`` -> ``published`` -> ``embedded``, all in the caller's transaction.

Each runs on a record the consumer claimed ``FOR UPDATE SKIP LOCKED`` (scraper.tasks.corpus_pipeline).
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy import func, select

from scraper.models import QuarantineDecision, QuarantineQueue, ScraperSource, StatutesStaging
from scraper.publication import retrieval
from scraper.tasks import lifecycle
from scraper.tasks.promotion import _resolve_source, publication_decision

REASON_REVIEW_REJECTED = "review_rejected"
REASON_RESOLVED_WITHOUT_EVIDENCE = "review_resolved_without_evidence"
REASON_PUBLISHED_RECORD_MISSING = "published_record_missing"
REASON_SOURCE_NOT_PROMOTABLE = "source_not_promotable"
# Review-queue resolutions that keep an open review (F23's CHECK vocabulary; nothing writes them today).
_OPEN_RESOLUTIONS = ("needs_edit", "escalated")


def _waiting(row, decided) -> bool:
    """A review row still waits on a reviewer: no decision, and either never reviewed (pending) or an
    open escalation. A row marked reviewed with no decision was resolved before F23 (residual 8)."""
    if row.id in decided:
        return False
    resolution = row.resolution or "pending"
    if resolution in _OPEN_RESOLUTIONS:
        return True
    return not row.reviewed and resolution == "pending"


def _queue_column(st):
    return QuarantineQueue.statutes_staging_id if isinstance(st, StatutesStaging) else QuarantineQueue.staging_id


def table_of(st) -> str:
    return retrieval.STATUTE_MASTER if isinstance(st, StatutesStaging) else retrieval.CASE_MASTER


async def sync_review(db, st, *, job_id=None) -> Optional[str]:
    """Record what F23 decided about a quarantined record; None when it still waits on a reviewer."""
    queue = (await db.execute(
        select(QuarantineQueue.id, QuarantineQueue.reviewed, QuarantineQueue.resolution).where(_queue_column(st) == st.id)
    )).all()
    if not queue:
        return None
    decisions = (await db.execute(
        select(QuarantineDecision).where(QuarantineDecision.quarantine_id.in_([row.id for row in queue]))
        .order_by(QuarantineDecision.decided_at)
    )).scalars().all()
    promoted = next((d for d in decisions if d.decision == "promoted"), None)
    if promoted is not None:
        return await _record_review_publication(db, st, promoted, job_id)
    decided = {d.quarantine_id for d in decisions}
    if any(_waiting(row, decided) for row in queue):
        return None
    rejected = [d for d in decisions if d.decision == "rejected"]
    if rejected:
        lifecycle.move(db, st, lifecycle.REJECTED, actor=lifecycle.ACTOR_REVIEW_SYNC, job_id=job_id,
                       reason=REASON_REVIEW_REJECTED,
                       details=lifecycle.summary_details(decision_id=rejected[-1].id, reviewer=rejected[-1].reviewer,
                                                         reviewer_auth=rejected[-1].reviewer_auth))
        return lifecycle.REJECTED
    lifecycle.move(db, st, lifecycle.DEAD_LETTER, actor=lifecycle.ACTOR_REVIEW_SYNC, job_id=job_id,
                   reason=REASON_RESOLVED_WITHOUT_EVIDENCE,
                   details={"quarantine_ids": [str(row.id) for row in queue]})
    return lifecycle.DEAD_LETTER


async def _record_review_publication(db, st, decision: QuarantineDecision, job_id) -> str:
    table = decision.published_table or table_of(st)
    lifecycle.move(db, st, lifecycle.APPROVED, actor=lifecycle.ACTOR_REVIEW_SYNC, job_id=job_id,
                   details=lifecycle.summary_details(decision_id=decision.id, reviewer=decision.reviewer,
                                                     reviewer_auth=decision.reviewer_auth))
    if not await retrieval.retrieval_row_exists(db, table, decision.published_id):
        lifecycle.move(db, st, lifecycle.DEAD_LETTER, actor=lifecycle.ACTOR_REVIEW_SYNC, job_id=job_id,
                       reason=REASON_PUBLISHED_RECORD_MISSING,
                       details=lifecycle.summary_details(published_table=table, published_id=decision.published_id))
        return lifecycle.DEAD_LETTER
    st.published_id = decision.published_id
    lifecycle.move(db, st, lifecycle.PUBLISHED, actor=lifecycle.ACTOR_REVIEW_SYNC, job_id=job_id,
                   details=lifecycle.summary_details(published_table=table, published_id=decision.published_id,
                                                     publication_key=decision.publication_key, decision_id=decision.id))
    outbox = await retrieval.outbox_row(db, table, decision.published_id)
    requeued = outbox is None
    if requeued:
        outbox = await retrieval.enqueue_embedding(db, table, decision.published_id)
    lifecycle.move(db, st, lifecycle.EMBEDDED, actor=lifecycle.ACTOR_REVIEW_SYNC, job_id=job_id,
                   details=lifecycle.summary_details(embedding_outbox_id=outbox, requeued=requeued or None))
    return lifecycle.EMBEDDED


async def publish(db, st, *, job_id=None) -> str:
    """Publish one approved record into the retrieval store and hand it to the embedding outbox."""
    src, resolved_by = await _resolve_source(db, st)
    if src is not None:
        # F23 ruling 1's pattern: a concurrent trust change waits for this publication, or it sees it.
        src = (await db.execute(
            select(ScraperSource).where(ScraperSource.id == src.id).with_for_update(read=True)
            .execution_options(populate_existing=True)
        )).scalars().first()
    decision = publication_decision(src.trust_level if src is not None else None, st.confidence_score)
    if not decision.promote:
        lifecycle.move(db, st, lifecycle.DEAD_LETTER, actor=lifecycle.ACTOR_PUBLISH, job_id=job_id,
                       reason=f"{REASON_SOURCE_NOT_PROMOTABLE}:{decision.reason}",
                       details=lifecycle.summary_details(source_resolved_by=resolved_by,
                                                         trust_level=src.trust_level if src is not None else None))
        return lifecycle.DEAD_LETTER
    table = table_of(st)
    changed = None
    if table == retrieval.CASE_MASTER:
        published_id, attached = await retrieval.publish_case(db, st, src)
    else:
        published_id, attached, changed = await retrieval.publish_statute(db, st, src)
        st.promoted = True
        st.promoted_at = func.now()
        st.promoted_to_id = published_id
    st.published_id = published_id
    lifecycle.move(db, st, lifecycle.PUBLISHED, actor=lifecycle.ACTOR_PUBLISH, job_id=job_id,
                   details=lifecycle.summary_details(published_table=table, published_id=published_id,
                                                     attached=attached, content_changed=changed or None,
                                                     source=src.source_name))
    outbox = await retrieval.enqueue_embedding(db, table, published_id)
    lifecycle.move(db, st, lifecycle.EMBEDDED, actor=lifecycle.ACTOR_PUBLISH, job_id=job_id,
                   details=lifecycle.summary_details(embedding_outbox_id=outbox))
    return lifecycle.EMBEDDED
