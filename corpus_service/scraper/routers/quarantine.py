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

Re-audit round 2 (spec section 7):

* Ruling 13, the key before the body. The two review routes declare no FastAPI body parameter:
  FastAPI reads a declared body before it runs any dependency, so an unauthenticated body used to be
  buffered and parsed whole. The admin key is checked by require_admin_api_key, the dependency every
  admin route uses, and only then does the endpoint read the body itself (read_review_body).
* Ruling 14, at most MAX_BODY_BYTES (32 KiB, the largest valid body under ruling 12's bounds with
  every character \\u-escaped): a larger Content-Length is 413 before anything is read, a streamed
  body is 413 as soon as it passes the cap.
* Ruling 15, the body must arrive within BODY_READ_SECONDS (10 s) of the start of the read, or 408.
* Ruling 16, a response sent before the body was completely received carries Connection: close, so
  the server closes the connection instead of draining whatever the client keeps sending.
* Ruling 18, every 422 on these routes is rendered here (ReviewRoute): type, loc and msg only, never
  the input, every string encodable and cut short, at most ten errors.
* Ruling 19, contention is never a 500: after rollback, SQLSTATE 40001 / 40P01 are 409
  transaction_aborted and 55P03 / 57014 are 503 database_busy with Retry-After.
* Ruling 20, a decision stores its request_fingerprint (request_fingerprint()); an Idempotency-Key
  with another body on a resolved record is 422 idempotency_key_reused, not a replay.
* Ruling 22, a reviewer name and a reason must contain a visible letter or digit, and no line or
  paragraph separator.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import unicodedata
import uuid
from datetime import datetime
from typing import Any, Dict, Final, List, Optional

import anyio
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, ValidationError, field_validator
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError, IntegrityError
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


def request_fingerprint(decision: str, reviewer: str, reason: str) -> str:
    """Ruling 20: SHA-256 (hex) of the canonical JSON of the decision and the validated reviewer and
    reason (keys sorted, no whitespace, non-ASCII escaped). Stored on every decision; an
    Idempotency-Key replays a decision only for a request with the same fingerprint."""
    canonical = json.dumps({"decision": decision, "reason": reason, "reviewer": reviewer},
                           sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("ascii")).hexdigest()


def _fingerprint_of(decision: QuarantineDecision) -> str:
    """The stored fingerprint, or, for a row written before migration 003, the same formula over the
    row's own decision, reviewer and reason (exactly the values a fingerprint is made from)."""
    return decision.request_fingerprint or request_fingerprint(decision.decision, decision.reviewer, decision.reason)


# -- ruling 12: bounded inputs ----------------------------------------------------------------------
# Ruling 22 (re-audit round 2, L7): the only letters or digits that are Default_Ignorable_Code_Point
# (Unicode 15.0) are the Hangul fillers; they render as nothing, so they are not visible.
_INVISIBLE_LETTERS: Final = frozenset("\u115f\u1160\u3164\uffa0")
_SEPARATORS: Final = ("Zl", "Zp")  # U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR


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
        if unicodedata.category(ch) in _SEPARATORS:
            raise ValueError(f"{field} must not contain line or paragraph separators")
    # Stored as given; only this check sees the NFC form.
    if not any(unicodedata.category(ch)[0] in "LN" and ch not in _INVISIBLE_LETTERS
               for ch in unicodedata.normalize("NFC", cleaned)):
        raise ValueError(f"{field} must contain a visible letter or digit")
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


# -- rulings 13-18: the body is read here, after the admin key, bounded in size and time -----------
# 255 + 2000 characters (ruling 12) at up to 12 bytes each in valid JSON (a non-BMP character as a
# \uXXXX\uXXXX escape) is 27,060 bytes of field text; 32 KiB never refuses a valid body.
MAX_BODY_BYTES: Final = 32 * 1024
BODY_READ_SECONDS = 10  # read at call time, so a test may shorten it
_BODY_COMPLETE: Final = "corpus.review_body_complete"  # request scope flag
_MAX_ERRORS: Final = 10
_JSON_TYPE: Final = re.compile(r"application/(?:json|[^/;\s]+\+json)")
_DIGITS: Final = re.compile(r"[0-9]+")  # str.isdigit() also accepts digits int() refuses


def _body_received(request: Request) -> bool:
    """Whether the whole request body has been received: read to its end here, or declared empty."""
    if request.scope.get(_BODY_COMPLETE):
        return True
    headers = request.headers
    return "transfer-encoding" not in headers and headers.get("content-length", "0").strip() == "0"


def _too_large() -> HTTPException:
    return HTTPException(status_code=413, detail={"error": "body_too_large", "max_bytes": MAX_BODY_BYTES})


def _body_error(kind: str, message: str) -> RequestValidationError:
    return RequestValidationError([{"type": kind, "loc": ("body",), "msg": message}])


async def read_review_body(request: Request) -> ReviewDecisionIn:
    """The request body as a ReviewDecisionIn, read only by this function, after the route's
    dependencies (the admin key among them) have run. 422 for a body that is not JSON or not valid,
    413 past MAX_BODY_BYTES (declared or streamed), 408 when it has not arrived within
    BODY_READ_SECONDS."""
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if not _JSON_TYPE.fullmatch(content_type):
        raise _body_error("json_required", "Content-Type must be application/json")
    declared = request.headers.get("content-length")
    if declared is not None and _DIGITS.fullmatch(declared.strip()) and int(declared) > MAX_BODY_BYTES:
        raise _too_large()
    chunks: List[bytes] = []
    size = 0
    try:
        with anyio.fail_after(BODY_READ_SECONDS):
            while True:
                message = await request.receive()
                if message["type"] == "http.disconnect":
                    raise HTTPException(status_code=400, detail={"error": "client_disconnected"})
                data = message.get("body", b"")
                size += len(data)
                if size > MAX_BODY_BYTES:
                    raise _too_large()
                chunks.append(data)
                if not message.get("more_body", False):
                    request.scope[_BODY_COMPLETE] = True
                    break
    except TimeoutError:
        raise HTTPException(status_code=408, detail={"error": "body_timeout", "seconds": BODY_READ_SECONDS}) from None
    try:
        return ReviewDecisionIn.model_validate_json(b"".join(chunks))
    except ValidationError as exc:
        errors = exc.errors(include_url=False, include_context=False, include_input=False)
        raise RequestValidationError([{**e, "loc": ("body", *e["loc"])} for e in errors]) from None


def _bounded(value: Any, limit: int) -> str:
    """``value`` as text that always encodes (a lone surrogate becomes its escape) and is cut short."""
    text = str(value).encode("utf-8", "backslashreplace").decode("utf-8")
    return text if len(text) <= limit else text[: limit - 3] + "..."


def validation_response(errors: List[Dict[str, Any]]) -> JSONResponse:
    """A 422 that never echoes the input (ruling 18): type, loc and msg of at most _MAX_ERRORS errors."""
    entries = [
        {"type": _bounded(e.get("type", "value_error"), 64),
         "loc": [part if isinstance(part, int) else _bounded(part, 64) for part in e.get("loc", ())],
         "msg": _bounded(e.get("msg", ""), 200)}
        for e in errors[:_MAX_ERRORS]
    ]
    if len(errors) > _MAX_ERRORS:
        entries.append({"type": "too_many_errors", "loc": ["body"],
                        "msg": f"{len(errors) - _MAX_ERRORS} more errors not shown"})
    return JSONResponse(status_code=422, content={"detail": entries})


class ReviewRoute(APIRoute):
    """Route class of the two review routes. Renders their 422s (ruling 18), and closes the
    connection after any response sent before the request body was completely received (ruling 16):
    uvicorn would otherwise keep the connection and drain whatever the client goes on sending."""

    def get_route_handler(self):
        handler = super().get_route_handler()

        async def review_handler(request: Request) -> Response:
            try:
                response = await handler(request)
            except RequestValidationError as exc:
                response = validation_response(list(exc.errors()))
            except HTTPException as exc:  # the admin key's 401, and every refusal raised in this module
                if _body_received(request):
                    raise
                raise HTTPException(status_code=exc.status_code, detail=exc.detail,
                                    headers={**(exc.headers or {}), "Connection": "close"}) from None
            if not _body_received(request):
                response.headers["Connection"] = "close"
            return response

        return review_handler


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
    fingerprint = request_fingerprint(decision, body.reviewer, body.reason)
    qq = await _locked(db, QuarantineQueue, quarantine_id)
    if qq is None:
        raise _Refused(404, {"error": "not_found"})
    if not _is_pending(qq):
        existing = await _decision_for(db, quarantine_id)
        if (existing is not None and request_key is not None and existing.request_key == request_key
                and existing.decision == decision):
            # Ruling 20: the key replays only the request it was sent with (IETF idempotency-key draft: 422).
            if _fingerprint_of(existing) != fingerprint:
                raise _Refused(422, {"error": "idempotency_key_reused",
                                     "rule": "an Idempotency-Key replays only a request with the same body"})
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
        request_fingerprint=fingerprint,
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


# Ruling 19: contention the transaction lost, by SQLSTATE. 40001 / 40P01: aborted for a concurrent
# transaction (a conflict; resend). 55P03 / 57014: the server stopped waiting for a lock or a
# statement (temporarily unavailable; retry after the delay). Never 500, never the SQL.
_CONTENTION: Final = {
    "40001": (409, "transaction_aborted"),  # serialization_failure
    "40P01": (409, "transaction_aborted"),  # deadlock_detected
    "55P03": (503, "database_busy"),  # lock_not_available
    "57014": (503, "database_busy"),  # query_canceled
}


def _sqlstate(exc: DBAPIError) -> Optional[str]:
    orig = exc.orig
    return (getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
            or getattr(getattr(orig, "__cause__", None), "sqlstate", None))


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
    except DBAPIError as exc:
        sqlstate = _sqlstate(exc)
        if sqlstate not in _CONTENTION:
            raise
        await db.rollback()
        status, error = _CONTENTION[sqlstate]
        logger.warning("quarantine.review_contended quarantine_id=%s action=%s sqlstate=%s status=%d",
                       quarantine_id, action, sqlstate, status)
        raise HTTPException(status_code=status, detail={"error": error, "sqlstate": sqlstate, "retryable": True},
                            headers={"Retry-After": "1"} if status == 503 else None) from None
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


# The body is not a FastAPI parameter (ruling 13); its schema is still published.
_REVIEW_BODY_OPENAPI: Final = {"requestBody": {"required": True, "content": {
    "application/json": {"schema": ReviewDecisionIn.model_json_schema()}}}}


def _review_route(path: str):
    def register(endpoint):
        router.add_api_route(path, endpoint, methods=["POST"], route_class_override=ReviewRoute,
                             openapi_extra=_REVIEW_BODY_OPENAPI)
        return endpoint

    return register


@_review_route("/{quarantine_id}/promote")
async def promote(
    request: Request,
    quarantine_id: uuid.UUID,
    _: None = Depends(require_admin_api_key),
    idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    db: AsyncSession = Depends(get_db),
):
    request_key = _request_key(idempotency_key)
    return await _decide(db, quarantine_id, "promote", await read_review_body(request), request_key)


@_review_route("/{quarantine_id}/reject")
async def reject(
    request: Request,
    quarantine_id: uuid.UUID,
    _: None = Depends(require_admin_api_key),
    idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    db: AsyncSession = Depends(get_db),
):
    request_key = _request_key(idempotency_key)
    return await _decide(db, quarantine_id, "reject", await read_review_body(request), request_key)
