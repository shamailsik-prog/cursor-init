"""Quarantine review routes (audit F23): list, promote, reject.

A reviewer's promote or reject of a quarantine_queue record is one state transition in one
database transaction. Spec: docs/superpowers/specs/2026-10-18-f23-auditable-quarantine-promotion-design.md.

* Ruling 1, expected state under row locks. The queue row is read FOR UPDATE and only a pending row
  (reviewed false, resolution pending or NULL) is decided. For a promote, the staging row is then
  read FOR UPDATE (it must exist and not be promoted yet) and the record's source FOR SHARE. Lock
  order: queue row, staging row, source row, citation advisory lock (promotion takes staging row then
  advisory lock and never locks a queue row, so the orders cannot cycle).
* Ruling 2, status codes. 404 for an unknown id; 422 for a malformed id, body or Idempotency-Key
  (before any database work); 409 for a record that is not pending, and for a record whose state
  refuses promotion (staging_record_missing, staging_already_promoted, source_not_promotable,
  citation_already_published). A refusal writes nothing. An integrity error from a race the checks
  did not foresee is rolled back and answered 409, never 500.
* Ruling 3, replay. A request on a resolved record with the same Idempotency-Key and the same
  decision returns the stored result ("replayed": true) and writes nothing; anything else is 409.
* Ruling 4, stable identity. Publication key "quarantine/<id>"; the case_law_master id is
  uuid5(NAMESPACE_URL, "corpus-service:case_law_master:" + key), recorded on the decision, the
  staging row (promoted_to_id) and the response.
* Ruling 5, evidence. One append-only quarantine_decisions row per decision (reviewer, how the
  reviewer was authenticated, reason, prior and new state, source trust read now, publication, outbox
  row, Idempotency-Key, time), and the queue row's own review columns. One timestamp for all of them.
* Ruling 7, trust. The source is resolved from the staging row by promotion's own rule and its trust
  is read now; scraper.trust.human_review_decision refuses blocked and unknown sources.
* Ruling 8, destination. case_law_master, as on main, with source_site = the verified source.
* Ruling 9, outbox. One embedding_queue row (case_law_master, the published id) in the same
  transaction, exactly once by its unique key. The consumer is scraper/tasks/embeddings.py,
  unchanged (its lease and recovery are audit F27, its job outcome F28).
"""

from __future__ import annotations

import logging
import re
import unicodedata
import uuid
from datetime import datetime
from typing import Any, Dict, Final, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from scraper.auth import require_admin_api_key
from scraper.database import get_db
from scraper.models import (
    CaseLawMaster,
    EmbeddingQueue,
    QuarantineDecision,
    QuarantineQueue,
    ScraperSource,
    ScraperStaging,
)
# The single source-resolution rule (audit F20, re-audit MEDIUM-1) and the canonical per-citation lock
# key (F19): reused, not copied, so manual review and automatic promotion cannot drift apart.
from scraper.tasks.promotion import _resolve_source, citation_lock_key
from scraper.trust import human_review_decision

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/quarantine")

REVIEWER_AUTH: Final = "shared_admin_key"  # until named identities exist (audit F47)
PUBLISHED_TABLE: Final = "case_law_master"
PUBLICATION_NAMESPACE: Final = uuid.NAMESPACE_URL
PUBLICATION_NAME_PREFIX: Final = "corpus-service:case_law_master:"
# First key of pg_advisory_xact_lock(int, int) for "manually publishing this citation into
# case_law_master"; the second is hashtext(citation_lock_key(citation)).
CITATION_LOCK_NAMESPACE: Final = 0x0F23
MAX_REVIEWER_CHARS: Final = 255
MAX_REASON_CHARS: Final = 2000
_IDEMPOTENCY_KEY: Final = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_DECISION_FOR: Final = {"promote": "promoted", "reject": "rejected"}
_RESOLUTION_FOR: Final = {"promoted": "approved", "rejected": "rejected"}


def publication_key(quarantine_id: uuid.UUID) -> str:
    return f"quarantine/{quarantine_id}"


def publication_id(quarantine_id: uuid.UUID) -> uuid.UUID:
    """The case_law_master id a promotion of this quarantine record publishes under (ruling 4)."""
    return uuid.uuid5(PUBLICATION_NAMESPACE, PUBLICATION_NAME_PREFIX + publication_key(quarantine_id))


# -- ruling 12: bounded inputs ----------------------------------------------------------------------
def _clean_text(field: str, value: str, limit: int, *, multiline: bool) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{field} must not be empty")
    if len(cleaned) > limit:
        raise ValueError(f"{field} must be at most {limit} characters")
    allowed = {"\t", "\n", "\r"} if multiline else set()
    for ch in cleaned:
        if ch not in allowed and unicodedata.category(ch) in ("Cc", "Cf", "Cs"):
            raise ValueError(f"{field} must not contain control or format characters")
    return cleaned


class ReviewDecisionIn(BaseModel):
    """The reviewer's name (asserted under the shared admin key, ruling 6) and the reason."""

    model_config = ConfigDict(extra="forbid")

    reviewer: str
    reason: str

    @field_validator("reviewer")
    @classmethod
    def _reviewer(cls, value: str) -> str:
        return _clean_text("reviewer", value, MAX_REVIEWER_CHARS, multiline=False)

    @field_validator("reason")
    @classmethod
    def _reason(cls, value: str) -> str:
        return _clean_text("reason", value, MAX_REASON_CHARS, multiline=True)


def _request_key(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    if not _IDEMPOTENCY_KEY.fullmatch(raw):
        raise HTTPException(status_code=422, detail={
            "error": "invalid_idempotency_key", "rule": "1-128 characters of A-Z a-z 0-9 . _ : -"})
    return raw


# -- the transition ---------------------------------------------------------------------------------
class _Refused(Exception):
    def __init__(self, status: int, detail: Dict[str, Any]):
        super().__init__(detail.get("error"))
        self.status = status
        self.detail = detail


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value is not None else None


def _uuid_text(value: Optional[uuid.UUID]) -> Optional[str]:
    return str(value) if value is not None else None


def _is_pending(qq: QuarantineQueue) -> bool:
    return qq.reviewed is False and (qq.resolution is None or qq.resolution == "pending")


def _snapshot(qq: QuarantineQueue, st: Optional[ScraperStaging]) -> Dict[str, Any]:
    """The states a decision moves between (ruling 5), as plain JSON values."""
    return {
        "quarantine": {
            "reviewed": qq.reviewed,
            "resolution": qq.resolution,
            "reviewed_by": qq.reviewed_by,
            "reviewed_at": _iso(qq.reviewed_at),
            "reason": qq.reason,
        },
        "staging": None if st is None else {
            "promoted": st.promoted,
            "promoted_to_id": _uuid_text(st.promoted_to_id),
            "quarantined": st.quarantined,
            "quarantine_reason": st.quarantine_reason,
        },
    }


def _summary(decision: Optional[QuarantineDecision]) -> Optional[Dict[str, Any]]:
    if decision is None:
        return None
    return {"id": str(decision.id), "decision": decision.decision, "reviewer": decision.reviewer,
            "decided_at": _iso(decision.decided_at)}


def _result(decision: QuarantineDecision, *, replayed: bool) -> Dict[str, Any]:
    return {
        "status": decision.decision,
        "quarantine_id": str(decision.quarantine_id),
        "decision_id": str(decision.id),
        "decision": decision.decision,
        "reviewer": decision.reviewer,
        "decided_at": _iso(decision.decided_at),
        "publication_key": decision.publication_key,
        "case_id": _uuid_text(decision.published_id),
        "embedding_outbox_id": _uuid_text(decision.embedding_outbox_id),
        "replayed": replayed,
    }


async def _decision_for(db: AsyncSession, quarantine_id: uuid.UUID) -> Optional[QuarantineDecision]:
    return (await db.execute(
        select(QuarantineDecision).where(QuarantineDecision.quarantine_id == quarantine_id)
    )).scalars().first()


async def _locked(db: AsyncSession, model, row_id, *, read: bool = False):
    return (await db.execute(
        select(model).where(model.id == row_id).with_for_update(read=read).execution_options(populate_existing=True)
    )).scalars().first()


async def _enqueue_embedding(db: AsyncSession, record_id: uuid.UUID) -> uuid.UUID:
    """The outbox row for a published record (ruling 9): exactly once by (table_name, record_id)."""
    inserted = (await db.execute(
        pg_insert(EmbeddingQueue)
        .values(id=uuid.uuid4(), record_id=record_id, table_name=PUBLISHED_TABLE, status="pending")
        .on_conflict_do_nothing(constraint="uq_embedding_table_record")
        .returning(EmbeddingQueue.id)
    )).scalar()
    if inserted is not None:
        return inserted
    return (await db.execute(select(EmbeddingQueue.id).where(
        EmbeddingQueue.table_name == PUBLISHED_TABLE, EmbeddingQueue.record_id == record_id))).scalar_one()


async def _publish(db: AsyncSession, qq: QuarantineQueue, st: Optional[ScraperStaging],
                   src: Optional[ScraperSource], decided_at: datetime) -> Dict[str, Any]:
    """The promote half of the transition: every check, then the master row, the outbox row and the
    staging lineage. Returns the decision's publication fields."""
    if st is None:
        raise _Refused(409, {"error": "staging_record_missing"})
    if st.promoted:
        raise _Refused(409, {"error": "staging_already_promoted", "promoted_to_id": _uuid_text(st.promoted_to_id)})
    trust = human_review_decision(src.trust_level if src is not None else None)
    if not trust.promote:
        raise _Refused(409, {"error": "source_not_promotable", "trust_reason": trust.reason,
                             "trust_level": src.trust_level if src is not None else None})
    citation = (qq.extracted_citation or "").strip() or None
    if citation is not None:
        await db.execute(text("SELECT pg_advisory_xact_lock(:namespace, hashtext(:citation))"),
                         {"namespace": CITATION_LOCK_NAMESPACE, "citation": citation_lock_key(citation)})
        holder = (await db.execute(
            select(CaseLawMaster.id).where(CaseLawMaster.citation == citation).limit(1))).scalar()
        if holder is not None:
            raise _Refused(409, {"error": "citation_already_published", "case_id": str(holder)})
    key = publication_key(qq.id)
    case_id = publication_id(qq.id)
    db.add(CaseLawMaster(
        id=case_id,
        citation=citation,
        case_title=qq.extracted_title,
        source_site=src.source_name,  # the source whose trust was just verified (ruling 8)
        source_url=qq.source_url,
        full_text=st.raw_text,
        is_promoted=True,
        promoted_at=decided_at,
    ))
    await db.flush()
    outbox_id = await _enqueue_embedding(db, case_id)
    st.promoted = True
    st.promoted_at = decided_at
    st.promoted_to_id = case_id
    return {"publication_key": key, "published_table": PUBLISHED_TABLE, "published_id": case_id,
            "embedding_outbox_id": outbox_id}


async def _transition(db: AsyncSession, quarantine_id: uuid.UUID, action: str, body: ReviewDecisionIn,
                      request_key: Optional[str]) -> Dict[str, Any]:
    decision = _DECISION_FOR[action]
    qq = await _locked(db, QuarantineQueue, quarantine_id)
    if qq is None:
        raise _Refused(404, {"error": "not_found"})
    if not _is_pending(qq):
        existing = await _decision_for(db, quarantine_id)
        if (existing is not None and request_key is not None and existing.request_key == request_key
                and existing.decision == decision):
            return _result(existing, replayed=True)
        raise _Refused(409, {"error": "already_resolved", "reviewed": qq.reviewed, "resolution": qq.resolution,
                             "decision": _summary(existing)})
    decided_at = (await db.execute(select(func.clock_timestamp()))).scalar_one()
    st = await _locked(db, ScraperStaging, qq.staging_id) if qq.staging_id is not None else None
    src, resolved_by = (await _resolve_source(db, st)) if st is not None else (None, None)
    if src is not None:
        src = await _locked(db, ScraperSource, src.id, read=True)
    prior = _snapshot(qq, st)

    publication = {"publication_key": None, "published_table": None, "published_id": None, "embedding_outbox_id": None}
    if decision == "promoted":
        publication = await _publish(db, qq, st, src, decided_at)

    qq.reviewed = True
    qq.reviewed_by = body.reviewer
    qq.reviewed_at = decided_at
    qq.resolution = _RESOLUTION_FOR[decision]
    qq.resolution_notes = body.reason
    record = QuarantineDecision(
        id=uuid.uuid4(),
        quarantine_id=qq.id,
        staging_id=st.id if st is not None else qq.staging_id,
        decision=decision,
        reviewer=body.reviewer,
        reviewer_auth=REVIEWER_AUTH,
        reason=body.reason,
        prior_state=prior,
        new_state=_snapshot(qq, st),
        source_id=src.id if src is not None else None,
        source_trust_level=src.trust_level if src is not None else None,
        source_resolved_by=resolved_by,
        request_key=request_key,
        decided_at=decided_at,
        **publication,
    )
    db.add(record)
    await db.flush()
    return _result(record, replayed=False)


async def _conflict_detail(db: AsyncSession, quarantine_id: uuid.UUID) -> Dict[str, Any]:
    """After an integrity error was rolled back: what the record looks like now."""
    qq = (await db.execute(select(QuarantineQueue).where(QuarantineQueue.id == quarantine_id)
                           .execution_options(populate_existing=True))).scalars().first()
    if qq is not None and not _is_pending(qq):
        return {"error": "already_resolved", "reviewed": qq.reviewed, "resolution": qq.resolution,
                "decision": _summary(await _decision_for(db, quarantine_id))}
    return {"error": "conflict"}


async def _decide(db: AsyncSession, quarantine_id: uuid.UUID, action: str, body: ReviewDecisionIn,
                  request_key: Optional[str]) -> Dict[str, Any]:
    try:
        result = await _transition(db, quarantine_id, action, body, request_key)
        await db.commit()
    except _Refused as refused:
        await db.rollback()
        logger.warning("quarantine.review_refused quarantine_id=%s action=%s status=%d error=%s",
                       quarantine_id, action, refused.status, refused.detail.get("error"))
        raise HTTPException(status_code=refused.status, detail=refused.detail) from None
    except IntegrityError as exc:
        await db.rollback()
        logger.warning("quarantine.review_conflict quarantine_id=%s action=%s error=%s",
                       quarantine_id, action, type(exc.orig).__name__ if exc.orig is not None else "IntegrityError")
        detail = await _conflict_detail(db, quarantine_id)
        await db.rollback()
        raise HTTPException(status_code=409, detail=detail) from None
    logger.info("quarantine.review_decided quarantine_id=%s decision=%s decision_id=%s replayed=%s",
                quarantine_id, result["decision"], result["decision_id"], result["replayed"])
    return result


# -- routes -----------------------------------------------------------------------------------------
@router.get("")
async def list_q(
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_admin_api_key),
):
    r = await db.execute(select(QuarantineQueue).order_by(QuarantineQueue.created_at.desc()).limit(limit))
    return r.scalars().all()


@router.post("/{quarantine_id}/promote")
async def promote(
    quarantine_id: uuid.UUID,
    decision: ReviewDecisionIn,
    idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_admin_api_key),
):
    return await _decide(db, quarantine_id, "promote", decision, _request_key(idempotency_key))


@router.post("/{quarantine_id}/reject")
async def reject(
    quarantine_id: uuid.UUID,
    decision: ReviewDecisionIn,
    idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_admin_api_key),
):
    return await _decide(db, quarantine_id, "reject", decision, _request_key(idempotency_key))
