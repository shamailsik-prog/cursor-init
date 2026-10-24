"""Publish a batch into the Annex A corpus contract (audit F19).

``publish_batch`` is the only writer of the Annex A tables in corpus_service. It runs on the caller's
connection and transaction, as ``corpus_writer`` (``SET LOCAL ROLE``, D14), inside one audited
corpus publication (postgres/ddl/003_corpus_publication.sql):

    corpus_publication_begin  -> advisory lock, audit row, transaction-scoped grant (idempotent per
                                 batch_key and content hash; a reused key with other content is refused)
    one SAVEPOINT per item    -> plan, write the contract rows (publication_id set), write the audit
    research term index       -> the terms of the judgments and citations it wrote (FA-D5-003 R1, research_index.py)
    corpus_publication_finish -> counts recomputed and checked, grant removed, corpus_metadata refreshed

Decisions (spec §5 and the plan's D-rulings):
* structural problems never reach here (batch.BatchError);
* an item is rejected (nothing written) for incomplete provenance, an invalid bench / treatment kind /
  jurisdiction / statute status / history, an unresolvable judgment, citations that resolve to two
  judgments (D11), no citation, or a change that would demote or rewrite a promoted row (D9);
* an item is written but quarantined for a non-trusted source, a missing bench (ruling 9), a
  citation that is not canonical (including a key the normaliser would rewrite again, re-audit D5), a
  treatment below 0.7 (B-7), or a treatment whose treating or treated judgment is not promoted
  (re-audit D3: the database refuses it promoted);
* identical content is ``unchanged`` (no write); changed content is ``updated`` with the previous hash.
* A guard error from the database (SKP03-SKP06) rolls back that item only and records it rejected;
  any other error aborts the whole publication (D15), and the caller must roll back.

Every statement uses bound parameters; nothing logs or raises row data.
"""

from __future__ import annotations

import logging
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, Final, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection

from scraper.publication import vocabulary as v
from scraper.publication.batch import (
    JudgmentItem,
    PartsInput,
    Provenance,
    PublicationBatch,
    StatuteSectionHistoryItem,
    TreatmentItem,
    batch_sha256,
    canonical_json,
    entity_sha256,
)
from scraper.publication.citations import CitationError, CitationParts, build_canonical, is_canonical, parse_parts, ts_court
from scraper.publication.research_index import index_research_terms, research_index_present
from scraper.trust import publication_decision

logger = logging.getLogger(__name__)


class PublicationError(Exception):
    """A publication that cannot proceed. ``code`` is one of: transaction_required, superuser_session,
    not_corpus_writer, batch_key_reused, publication_state, and for the term index research_index_missing (006 not
    applied). The caller must roll back."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ItemOutcome:
    item_key: str
    entity_type: str  # judgment|citation|treatment|statute|statute_section|statute_section_version
    entity_id: Optional[uuid.UUID]
    decision: str  # promoted|quarantined|updated|unchanged|rejected
    reason: Optional[str]
    content_sha256: Optional[str]
    prev_sha256: Optional[str]
    review_status: Optional[str]  # the entity's review_status after this publication


_PRIMARY_TYPES: Final = ("judgment", "treatment", "statute_section")


@dataclass(frozen=True)
class PublicationResult:
    publication_id: uuid.UUID
    batch_key: str
    input_sha256: str
    already: bool
    seq: int
    counts: Mapping[str, int]  # items, promoted, quarantined, updated, unchanged, rejected
    outcomes: Tuple[ItemOutcome, ...]

    def primary(self, item_key: str) -> ItemOutcome:
        """The judgment / treatment / statute_section outcome of an item (its first outcome when the
        item was rejected)."""
        mine = [o for o in self.outcomes if o.item_key == item_key]
        if not mine:
            raise KeyError(item_key)
        for outcome in mine:
            if outcome.entity_type in _PRIMARY_TYPES:
                return outcome
        return mine[0]


# Guard tokens (003, SKP03-SKP06) -> the durable item reason.
GUARD_REASONS: Final[Mapping[str, str]] = {
    "provenance_incomplete": v.REASON_PROVENANCE_INCOMPLETE,
    "bench_required": v.REASON_MISSING_BENCH,
    "treatment_confidence": v.REASON_TREATMENT_UNCERTAIN,
    "treatment_judgment_missing": v.REASON_UNRESOLVABLE_JUDGMENT,
    "treatment_judgment_not_promoted": v.REASON_UNRESOLVABLE_JUDGMENT,
    "version_effective_from_required": v.REASON_HISTORY_MISSING_EFFECTIVE_FROM,
    "version_range_invalid": v.REASON_HISTORY_OUT_OF_ORDER,
    "version_overlap": v.REASON_HISTORY_OVERLAP,
}
_GUARD_STATES: Final = frozenset({"SKP03", "SKP04", "SKP05", "SKP06"})
# SKP12 (publication_not_finished) reaches begin() only when the caller made the commit checks
# immediate (SET CONSTRAINTS ... IMMEDIATE), which cannot publish: fail closed.
_STATE_ERRORS: Final = frozenset({"SKP02", "SKP07", "SKP08", "SKP09", "SKP10", "SKP11", "SKP12"})
COUNT_KEYS: Final[Tuple[str, ...]] = ("items", "promoted", "quarantined", "updated", "unchanged", "rejected")
_ENTITY_TABLES: Final = {
    "judgment": "judgment", "citation": "citation", "treatment": "treatment", "statute": "statute",
    "statute_section": "statute_section", "statute_section_version": "statute_section_version",
}


# ---- database error classification ------------------------------------------------------------
def _pg_error(exc: BaseException) -> Tuple[Optional[str], Optional[str]]:
    """(SQLSTATE, message) of the database error behind ``exc``: the driver (asyncpg) exception
    carries both; SQLAlchemy's adapter carries the SQLSTATE."""
    orig = getattr(exc, "orig", None)
    driver = getattr(orig, "__cause__", None)
    code = message = None
    for candidate in (driver, orig, exc):
        if candidate is None:
            continue
        code = code or getattr(candidate, "sqlstate", None) or getattr(candidate, "pgcode", None)
        if message is None and getattr(candidate, "sqlstate", None) and isinstance(getattr(candidate, "message", None), str):
            message = candidate.message
    return code, message


class _ItemRejected(Exception):
    def __init__(self, reason: str, entity_id: Optional[uuid.UUID] = None):
        super().__init__(reason)
        self.reason = reason
        self.entity_id = entity_id


# ---- shared helpers ---------------------------------------------------------------------------
def _present(value: object) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _provenance_complete(p: Provenance) -> bool:
    """The guard's predicate (003 corpus_provenance_complete), plus a method inside the 001 set, which
    the column CHECK would otherwise refuse as a database error."""
    return (
        _present(p.source_name)
        and p.fetched_at is not None
        and _present(p.content_hash)
        and p.extraction_method in v.EXTRACTION_METHODS
        and (_present(p.source_url) or _present(p.raw_storage_key))
    )


def _provenance_identity(p: Provenance) -> Dict[str, Optional[str]]:
    """What a re-fetch of the same content shares (D10): fetched_at is excluded."""
    return {
        "source_name": p.source_name, "source_url": p.source_url, "raw_storage_key": p.raw_storage_key,
        "content_hash": p.content_hash, "extraction_method": p.extraction_method,
        "extractor_version": p.extractor_version,
    }


def _iso(value: Optional[date]) -> Optional[str]:
    return value.isoformat() if value is not None else None


class _Run:
    """One publication in progress on one connection."""

    def __init__(self, conn: AsyncConnection, publication_id: uuid.UUID):
        self.conn = conn
        self.publication_id = publication_id
        self.outcomes: List[ItemOutcome] = []
        self.judgment_by_item: Dict[str, uuid.UUID] = {}
        self.judgment_owner: Dict[uuid.UUID, str] = {}

    async def scalar(self, sql: str, **params: Any) -> Any:
        return (await self.conn.execute(text(sql), params)).scalar()

    async def rows(self, sql: str, **params: Any) -> Sequence[Any]:
        return (await self.conn.execute(text(sql), params)).all()

    async def latest_hash(self, entity_type: str, entity_id: uuid.UUID) -> Tuple[Optional[str], Optional[str]]:
        row = (await self.conn.execute(text(
            "SELECT content_sha256, reason FROM public.corpus_publication_item "
            "WHERE entity_type = :t AND entity_id = :id AND decision <> 'rejected' ORDER BY id DESC LIMIT 1"
        ), {"t": entity_type, "id": entity_id})).first()
        return (row[0], row[1]) if row else (None, None)

    async def audit(self, item_key: str, entity_type: str, entity_id: Optional[uuid.UUID], decision: str,
                    reason: Optional[str], content: Optional[str], prev: Optional[str]) -> None:
        await self.conn.execute(text(
            "INSERT INTO public.corpus_publication_item "
            "(publication_id, item_key, entity_type, entity_id, decision, reason, content_sha256, prev_sha256) "
            "VALUES (:pid, :key, :type, :id, :decision, :reason, :content, :prev)"
        ), {"pid": self.publication_id, "key": item_key, "type": entity_type, "id": entity_id,
            "decision": decision, "reason": reason, "content": content, "prev": prev})
        self.outcomes.append(ItemOutcome(item_key, entity_type, entity_id, decision, reason, content, prev, None))

    async def insert_provenance(self, p: Provenance) -> uuid.UUID:
        return await self.scalar(
            "INSERT INTO public.source_provenance (source_name, source_url, fetched_at, content_hash, "
            "extraction_method, extractor_version, raw_storage_key, publication_id) "
            "VALUES (:source_name, :source_url, :fetched_at, :content_hash, :extraction_method, "
            ":extractor_version, :raw_storage_key, :pid) RETURNING id",
            source_name=p.source_name.strip(), source_url=p.source_url, fetched_at=p.fetched_at,
            content_hash=p.content_hash, extraction_method=p.extraction_method,
            extractor_version=p.extractor_version, raw_storage_key=p.raw_storage_key, pid=self.publication_id,
        )

    async def item(self, item_key: str, entity_type: str, body) -> None:
        """Run one item in its own savepoint. A guard rejection (or a planned rejection) leaves only a
        'rejected' audit row; any other database error propagates and aborts the publication."""
        await self.conn.execute(text("SAVEPOINT corpus_pub_item"))
        mark = len(self.outcomes)
        try:
            await body()
        except _ItemRejected as rejected:
            await self.conn.execute(text("ROLLBACK TO SAVEPOINT corpus_pub_item"))
            del self.outcomes[mark:]
            self._forget(item_key)
            await self.audit(item_key, entity_type, rejected.entity_id, "rejected", rejected.reason, None, None)
        except DBAPIError as exc:
            code, token = _pg_error(exc)
            if code not in _GUARD_STATES:
                raise
            await self.conn.execute(text("ROLLBACK TO SAVEPOINT corpus_pub_item"))
            del self.outcomes[mark:]
            self._forget(item_key)
            reason = GUARD_REASONS.get(token or "", v.REASON_PROVENANCE_INCOMPLETE if code == "SKP03" else "guard_refused")
            logger.info("publication.item_rejected_by_guard item=%s sqlstate=%s reason=%s", item_key, code, reason)
            await self.audit(item_key, entity_type, None, "rejected", reason, None, None)
        await self.conn.execute(text("RELEASE SAVEPOINT corpus_pub_item"))

    def _forget(self, item_key: str) -> None:
        jid = self.judgment_by_item.pop(item_key, None)
        if jid is not None and self.judgment_owner.get(jid) == item_key:
            del self.judgment_owner[jid]


# ---- judgments and citations ------------------------------------------------------------------
@dataclass
class _CitationPlan:
    text: str
    canonical: bool
    parts: Optional[CitationParts]


def _display_text(p: PartsInput) -> str:
    """A non-canonical citation text for structured parts the key builder refused (stored quarantined,
    never matched by the gate)."""
    bracket = lambda x: f"({x})" if x else None  # noqa: E731
    if p.reporter == "PLD" or (p.court and p.reporter in ("PLJ", "NLR", "KLR")):
        tokens = [p.reporter, p.year, p.court, bracket(p.series), p.page, bracket(p.note)]
    else:
        tokens = [p.year, p.reporter, p.court, bracket(p.series), p.page, bracket(p.note)]
    return " ".join(t.strip() for t in tokens if t and t.strip())


def _plan_citations(item: JudgmentItem) -> List[_CitationPlan]:
    plans: Dict[str, _CitationPlan] = {}
    for citation in item.citations:
        given = getattr(citation, "parts", None)
        if given is not None:
            parts = CitationParts(**given.model_dump())
            try:
                key: Optional[str] = build_canonical(parts)
            except CitationError:
                key = None
            # The key must be a fixed point of the normaliser (re-audit D5): one it would rewrite again
            # ("... Quetta(KAR) 12" -> "... Quetta(Sindh) 12") is never matched by the gate.
            if key is not None and is_canonical(key):
                plans.setdefault(key, _CitationPlan(key, True, parts))
            else:
                raw = _display_text(given)
                plans.setdefault(raw, _CitationPlan(raw, False, None))
            continue
        raw = citation.text.strip()
        if raw and is_canonical(raw):
            plans.setdefault(raw, _CitationPlan(raw, True, parse_parts(raw)))
        elif raw:
            plans.setdefault(raw, _CitationPlan(raw, False, None))
    return list(plans.values())


def _citation_columns(plan: _CitationPlan) -> Dict[str, Any]:
    parts = plan.parts
    if parts is None:
        return {"reporter": None, "year": None, "volume_or_court": None, "page": None}
    if parts.court:
        place = ts_court(parts.court) or parts.court.strip()
    else:
        place = parts.series.strip() if parts.series else None
    return {"reporter": parts.reporter, "year": int(parts.year), "volume_or_court": place, "page": int(parts.page)}


async def _publish_judgment(run: _Run, item: JudgmentItem) -> None:
    trust = item.trust
    decision = publication_decision(trust.level, trust.confidence)
    if not _provenance_complete(item.provenance):
        raise _ItemRejected(v.REASON_PROVENANCE_INCOMPLETE)
    citations = _plan_citations(item)
    if not citations:
        raise _ItemRejected(v.REASON_CITATION_MISSING)
    bench = v.canonical_bench(item.bench_type)
    if bench is None and not v.bench_is_missing(item.bench_type):
        raise _ItemRejected(v.REASON_INVALID_BENCH)

    texts = [c.text for c in citations]
    hits = await run.rows(
        "SELECT DISTINCT judgment_id FROM public.citation WHERE citation_text = ANY(:texts) AND judgment_id IS NOT NULL",
        texts=texts,
    )
    judgment_ids = {row[0] for row in hits}
    if len(judgment_ids) > 1:
        raise _ItemRejected(v.REASON_CITATION_CONFLICT)
    existing_id = next(iter(judgment_ids), None)
    if existing_id is not None and run.judgment_owner.get(existing_id, item.item_key) != item.item_key:
        # Another item of this batch wrote that judgment: two items may not merge into one authority.
        raise _ItemRejected(v.REASON_CITATION_CONFLICT)

    held = []
    if not decision.promote:
        held.append(decision.reason)
    if not any(c.canonical for c in citations):
        held.append(v.REASON_CITATION_NOT_CANONICAL)
    if bench is None:
        held.append(v.REASON_MISSING_BENCH)
    reason = v.first_quarantine_reason(held)
    status = "promoted" if reason is None else "quarantined"

    existing = None
    if existing_id is not None:
        existing = (await run.conn.execute(text(
            "SELECT id, review_status, source_id FROM public.judgment WHERE id = :id"
        ), {"id": existing_id})).first()
    existing_citations = {
        row[0]: row for row in await run.rows(
            "SELECT citation_text, id, review_status FROM public.citation WHERE citation_text = ANY(:texts)", texts=texts)
    }
    if status != "promoted":
        protected = (existing is not None and existing[1] == "promoted") or any(
            row[2] == "promoted" for row in existing_citations.values())
        if protected:
            raise _ItemRejected(v.REASON_PROMOTED_ROW_PROTECTED, existing_id)

    identity = _provenance_identity(item.provenance)
    fields = {
        "case_title": item.case_title, "bench_type": bench, "bench_size": item.bench_size,
        "decision_date": _iso(item.decision_date), "full_text": item.full_text, "headnotes": item.headnotes,
        "summary": item.summary, "confidence": trust.confidence,
    }
    content = entity_sha256("judgment", {**fields, "provenance": identity, "review_status": status})
    source_id: Optional[uuid.UUID] = None

    async def provenance_id() -> uuid.UUID:
        nonlocal source_id
        if source_id is None:
            source_id = await run.insert_provenance(item.provenance)
        return source_id

    params = {**fields, "decision_date": item.decision_date, "status": status, "pid": run.publication_id}
    if existing is None:
        jid = await run.scalar(
            "INSERT INTO public.judgment (case_title, bench_type, bench_size, decision_date, full_text, headnotes, "
            "summary, confidence, source_id, review_status, publication_id) VALUES (:case_title, :bench_type, "
            ":bench_size, :decision_date, :full_text, :headnotes, :summary, :confidence, :source_id, :status, :pid) "
            "RETURNING id",
            **params, source_id=await provenance_id(),
        )
        await run.audit(item.item_key, "judgment", jid, status, reason, content, None)
        judgment_source = source_id
    else:
        jid = existing[0]
        prev, prev_reason = await run.latest_hash("judgment", jid)
        if prev == content:
            await run.audit(item.item_key, "judgment", jid, "unchanged", prev_reason, content, prev)
            judgment_source = existing[2]
        else:
            await run.conn.execute(text(
                "UPDATE public.judgment SET case_title = :case_title, bench_type = :bench_type, "
                "bench_size = :bench_size, decision_date = :decision_date, full_text = :full_text, "
                "headnotes = :headnotes, summary = :summary, confidence = :confidence, source_id = :source_id, "
                "review_status = :status, publication_id = :pid, updated_at = now() WHERE id = :id"
            ), {**params, "source_id": await provenance_id(), "id": jid})
            await run.audit(item.item_key, "judgment", jid, "updated", reason, content, prev)
            judgment_source = source_id
    run.judgment_by_item[item.item_key] = jid
    run.judgment_owner.setdefault(jid, item.item_key)

    for plan in citations:
        cstatus, creason = (status, reason) if plan.canonical else ("quarantined", v.REASON_CITATION_NOT_CANONICAL)
        columns = _citation_columns(plan)
        chash = entity_sha256("citation", {
            "citation_text": plan.text, "judgment_id": str(jid), **columns, "confidence": trust.confidence,
            "provenance": identity, "review_status": cstatus,
        })
        row = existing_citations.get(plan.text)
        cparams = {**columns, "text": plan.text, "jid": jid, "confidence": trust.confidence,
                   "status": cstatus, "pid": run.publication_id}
        if row is None:
            cid = await run.scalar(
                "INSERT INTO public.citation (judgment_id, citation_text, reporter, year, volume_or_court, page, "
                "confidence, source_id, review_status, publication_id) VALUES (:jid, :text, :reporter, :year, "
                ":volume_or_court, :page, :confidence, :source_id, :status, :pid) RETURNING id",
                **cparams, source_id=judgment_source,
            )
            await run.audit(item.item_key, "citation", cid, cstatus, creason, chash, None)
            continue
        cid = row[1]
        prev, prev_reason = await run.latest_hash("citation", cid)
        if prev == chash:
            await run.audit(item.item_key, "citation", cid, "unchanged", prev_reason, chash, prev)
            continue
        await run.conn.execute(text(
            "UPDATE public.citation SET judgment_id = :jid, reporter = :reporter, year = :year, "
            "volume_or_court = :volume_or_court, page = :page, confidence = :confidence, source_id = :source_id, "
            "review_status = :status, publication_id = :pid, updated_at = now() WHERE id = :id"
        ), {**cparams, "source_id": judgment_source, "id": cid})
        await run.audit(item.item_key, "citation", cid, "updated", creason, chash, prev)


# ---- treatments (B-7) -------------------------------------------------------------------------
async def _resolve_ref(run: _Run, ref: Any) -> Optional[uuid.UUID]:
    """A judgment item of this batch (unless it was rejected), or the judgment behind an exact
    canonical citation key."""
    item_key = getattr(ref, "item_key", None)
    if item_key is not None:
        return run.judgment_by_item.get(item_key)
    citation = getattr(ref, "citation", None)
    if not isinstance(citation, str) or not is_canonical(citation):
        return None
    return await run.scalar(
        "SELECT judgment_id FROM public.citation WHERE citation_text = :c AND judgment_id IS NOT NULL", c=citation)


async def _publish_treatment(run: _Run, item: TreatmentItem) -> None:
    if not _provenance_complete(item.provenance):
        raise _ItemRejected(v.REASON_PROVENANCE_INCOMPLETE)
    treating = await _resolve_ref(run, item.treating)
    treated = await _resolve_ref(run, item.treated)
    if treating is None or treated is None:
        raise _ItemRejected(v.REASON_UNRESOLVABLE_JUDGMENT)
    kind = v.canonical_treatment(item.treatment)
    if kind is None:
        raise _ItemRejected(v.REASON_INVALID_TREATMENT_KIND)
    bench = v.canonical_bench(item.treating_bench_type)
    if bench is None and not v.bench_is_missing(item.treating_bench_type):
        raise _ItemRejected(v.REASON_INVALID_BENCH)

    decision = publication_decision(item.trust.level, item.trust.confidence)
    held = []
    if not decision.promote:
        held.append(decision.reason)
    if bench is None:
        held.append(v.REASON_MISSING_BENCH)
    if not item.confidence >= v.TREATMENT_MIN_CONFIDENCE:  # NaN-safe form (re-audit D4)
        held.append(v.REASON_TREATMENT_UNCERTAIN)
    # Only promoted judgments can carry a promoted treatment (re-audit D3); one that touches a
    # quarantined judgment is held, so an unreviewed adverse treatment stays pending (ruling 3).
    statuses = dict((await run.conn.execute(text(
        "SELECT id, review_status FROM public.judgment WHERE id = ANY(:ids)"
    ), {"ids": [treating, treated]})).all())
    if statuses.get(treating) != "promoted" or statuses.get(treated) != "promoted":
        held.append(v.REASON_JUDGMENT_NOT_PROMOTED)
    reason = v.first_quarantine_reason(held)
    status = "promoted" if reason is None else "quarantined"

    existing = (await run.conn.execute(text(
        "SELECT id, review_status, source_id FROM public.treatment WHERE treating_judgment_id = :a "
        "AND treated_judgment_id = :b AND treatment = :k AND coalesce(passage_anchor, '') = :anchor"
    ), {"a": treating, "b": treated, "k": kind, "anchor": item.passage_anchor or ""})).first()
    if existing is not None and existing[1] == "promoted" and status != "promoted":
        raise _ItemRejected(v.REASON_PROMOTED_ROW_PROTECTED, existing[0])

    content = entity_sha256("treatment", {
        "treating_judgment_id": str(treating), "treated_judgment_id": str(treated), "treatment": kind,
        "passage_anchor": item.passage_anchor, "treating_bench_type": bench, "confidence": item.confidence,
        "provenance": _provenance_identity(item.provenance), "review_status": status,
    })
    params = {"a": treating, "b": treated, "k": kind, "anchor": item.passage_anchor, "bench": bench,
              "confidence": item.confidence, "status": status, "pid": run.publication_id}
    if existing is None:
        tid = await run.scalar(
            "INSERT INTO public.treatment (treating_judgment_id, treated_judgment_id, treatment, passage_anchor, "
            "treating_bench_type, confidence, source_id, review_status, publication_id) VALUES (:a, :b, :k, "
            ":anchor, :bench, :confidence, :source_id, :status, :pid) RETURNING id",
            **params, source_id=await run.insert_provenance(item.provenance),
        )
        await run.audit(item.item_key, "treatment", tid, status, reason, content, None)
        return
    tid = existing[0]
    prev, prev_reason = await run.latest_hash("treatment", tid)
    if prev == content:
        await run.audit(item.item_key, "treatment", tid, "unchanged", prev_reason, content, prev)
        return
    await run.conn.execute(text(
        "UPDATE public.treatment SET passage_anchor = :anchor, treating_bench_type = :bench, confidence = :confidence, "
        "source_id = :source_id, review_status = :status, publication_id = :pid, updated_at = now() WHERE id = :id"
    ), {**params, "source_id": await run.insert_provenance(item.provenance), "id": tid})
    await run.audit(item.item_key, "treatment", tid, "updated", reason, content, prev)


# ---- statute section histories (B-5) ----------------------------------------------------------
def _history_problem(item: StatuteSectionHistoryItem) -> Optional[str]:
    """The first B-5 rule a history breaks, in the plan's order, or None."""
    versions = sorted(item.versions, key=lambda ver: ver.version_no)
    if len({ver.version_no for ver in versions}) != len(versions):
        return v.REASON_INVALID_HISTORY
    if any(ver.effective_from is None for ver in versions):
        return v.REASON_HISTORY_MISSING_EFFECTIVE_FROM
    for index, ver in enumerate(versions):
        if ver.effective_to is not None and ver.effective_to <= ver.effective_from:
            return v.REASON_HISTORY_OUT_OF_ORDER
        if ver.effective_to is None and index != len(versions) - 1:
            return v.REASON_HISTORY_OUT_OF_ORDER
        if index and ver.effective_from <= versions[index - 1].effective_from:
            return v.REASON_HISTORY_OUT_OF_ORDER
    for earlier, later in zip(versions, versions[1:]):
        if earlier.effective_to is None or earlier.effective_to > later.effective_from:
            return v.REASON_HISTORY_OVERLAP
    if item.history == "current_text_only":
        only = versions[0]
        if len(versions) != 1 or only.effective_to is not None or only.version_confidence not in (
                None, v.CURRENT_TEXT_ONLY_CONFIDENCE):
            return v.REASON_INVALID_HISTORY
    return None


async def _upsert(run: _Run, item_key: str, entity_type: str, existing: Optional[Any], content: str, reason: Optional[str],
                  insert_sql: str, update_sql: str, params: Mapping[str, Any], provenance_id) -> uuid.UUID:
    """Insert, update or leave one row by its content hash; write its audit row. ``existing`` is
    (id, review_status) or None."""
    status = params["status"]
    if existing is None:
        entity_id = await run.scalar(insert_sql, **params, source_id=await provenance_id())
        await run.audit(item_key, entity_type, entity_id, status, reason, content, None)
        return entity_id
    entity_id = existing[0]
    prev, prev_reason = await run.latest_hash(entity_type, entity_id)
    if prev == content and existing[1] == status:
        await run.audit(item_key, entity_type, entity_id, "unchanged", prev_reason, content, prev)
        return entity_id
    await run.conn.execute(text(update_sql), {**params, "source_id": await provenance_id(), "id": entity_id})
    await run.audit(item_key, entity_type, entity_id, "updated", reason, content, prev)
    return entity_id


async def _publish_history(run: _Run, item: StatuteSectionHistoryItem) -> None:
    if not _provenance_complete(item.provenance):
        raise _ItemRejected(v.REASON_PROVENANCE_INCOMPLETE)
    jurisdiction = v.canonical_jurisdiction(item.statute.jurisdiction)
    if jurisdiction is None:
        raise _ItemRejected(v.REASON_INVALID_JURISDICTION)
    statute_status = v.canonical_statute_status(item.statute.status)
    if statute_status is None:
        raise _ItemRejected(v.REASON_INVALID_STATUTE_STATUS)
    problem = _history_problem(item)
    if problem is not None:
        raise _ItemRejected(problem)

    decision = publication_decision(item.trust.level, item.trust.confidence)
    reason = None if decision.promote else decision.reason
    status = "promoted" if reason is None else "quarantined"
    identity = _provenance_identity(item.provenance)
    trust_confidence = item.trust.confidence
    name = item.statute.name.strip()
    section_number = item.section.section_number.strip()

    statute = (await run.conn.execute(text(
        "SELECT id, review_status FROM public.statute WHERE name = :name AND jurisdiction = :j"
    ), {"name": name, "j": jurisdiction})).first()
    section = None
    existing_versions: Dict[int, Any] = {}
    if statute is not None:
        section = (await run.conn.execute(text(
            "SELECT id, review_status FROM public.statute_section WHERE statute_id = :s AND section_number = :n"
        ), {"s": statute[0], "n": section_number})).first()
    if section is not None:
        existing_versions = {row[2]: row for row in await run.rows(
            "SELECT id, review_status, version_no FROM public.statute_section_version WHERE section_id = :s",
            s=section[0])}
    versions = sorted(item.versions, key=lambda ver: ver.version_no)
    if status != "promoted":
        named = [statute, section, *(existing_versions.get(ver.version_no) for ver in versions)]
        protected = next((row for row in named if row is not None and row[1] == "promoted"), None)
        if protected is not None:
            raise _ItemRejected(v.REASON_PROMOTED_ROW_PROTECTED, protected[0])

    source_id: Optional[uuid.UUID] = None

    async def provenance_id() -> uuid.UUID:
        nonlocal source_id
        if source_id is None:
            source_id = await run.insert_provenance(item.provenance)
        return source_id

    statute_fields = {"name": name, "short_name": item.statute.short_name, "year_enacted": item.statute.year_enacted,
                      "jurisdiction": jurisdiction, "status_value": statute_status, "confidence": trust_confidence}
    statute_hash = entity_sha256("statute", {**statute_fields, "provenance": identity, "review_status": status})
    statute_id = await _upsert(
        run, item.item_key, "statute", statute, statute_hash, reason,
        "INSERT INTO public.statute (name, short_name, year_enacted, jurisdiction, status, confidence, source_id, "
        "review_status, publication_id) VALUES (:name, :short_name, :year_enacted, :jurisdiction, :status_value, "
        ":confidence, :source_id, :status, :pid) RETURNING id",
        "UPDATE public.statute SET short_name = :short_name, year_enacted = :year_enacted, status = :status_value, "
        "confidence = :confidence, source_id = :source_id, review_status = :status, publication_id = :pid, "
        "updated_at = now() WHERE id = :id",
        {**statute_fields, "status": status, "pid": run.publication_id}, provenance_id,
    )

    section_fields = {"statute_id": statute_id, "section_number": section_number, "chapter": item.section.chapter,
                      "current_title": item.section.current_title, "confidence": trust_confidence}
    section_hash = entity_sha256("statute_section", {
        **section_fields, "statute_id": str(statute_id), "provenance": identity, "review_status": status})
    section_id = await _upsert(
        run, item.item_key, "statute_section", section, section_hash, reason,
        "INSERT INTO public.statute_section (statute_id, section_number, chapter, current_title, confidence, "
        "source_id, review_status, publication_id) VALUES (:statute_id, :section_number, :chapter, :current_title, "
        ":confidence, :source_id, :status, :pid) RETURNING id",
        "UPDATE public.statute_section SET chapter = :chapter, current_title = :current_title, "
        "confidence = :confidence, source_id = :source_id, review_status = :status, publication_id = :pid, "
        "updated_at = now() WHERE id = :id",
        {**section_fields, "status": status, "pid": run.publication_id}, provenance_id,
    )

    planned = []
    for ver in versions:
        confidence = (v.CURRENT_TEXT_ONLY_CONFIDENCE if item.history == "current_text_only" or ver.version_confidence is None
                      else ver.version_confidence)
        fields = {"section_id": section_id, "version_no": ver.version_no, "effective_from": ver.effective_from,
                  "effective_to": ver.effective_to, "title": ver.title, "text": ver.text,
                  "version_confidence": confidence, "confidence": trust_confidence}
        content = entity_sha256("statute_section_version", {
            **fields, "section_id": str(section_id), "effective_from": _iso(ver.effective_from),
            "effective_to": _iso(ver.effective_to), "provenance": identity, "review_status": status})
        existing = existing_versions.get(ver.version_no)
        prev = (await run.latest_hash("statute_section_version", existing[0]))[0] if existing is not None else None
        planned.append((fields, content, existing, prev))

    # D23: demote this section's promoted versions that this item changes, so a shifted boundary never
    # trips over its own old range; promoted versions the item does not name stay, and an overlap with
    # them is refused by the guard (SKP06 -> history_overlap).
    changing = {existing[0] for _f, content, existing, prev in planned
                if existing is not None and existing[1] == "promoted" and prev != content}
    if changing:
        await run.conn.execute(text(
            "UPDATE public.statute_section_version SET review_status = 'quarantined', publication_id = :pid "
            "WHERE id = ANY(:ids)"
        ), {"pid": run.publication_id, "ids": list(changing)})

    for fields, content, existing, _prev in planned:
        current = None if existing is None else (existing[0], "quarantined" if existing[0] in changing else existing[1])
        await _upsert(
            run, item.item_key, "statute_section_version", current, content, reason,
            "INSERT INTO public.statute_section_version (section_id, version_no, effective_from, effective_to, title, "
            "text, version_confidence, confidence, source_id, review_status, publication_id) VALUES (:section_id, "
            ":version_no, :effective_from, :effective_to, :title, :text, :version_confidence, :confidence, "
            ":source_id, :status, :pid) RETURNING id",
            "UPDATE public.statute_section_version SET effective_from = :effective_from, effective_to = :effective_to, "
            "title = :title, text = :text, version_confidence = :version_confidence, confidence = :confidence, "
            "source_id = :source_id, review_status = :status, publication_id = :pid, updated_at = now() WHERE id = :id",
            {**fields, "status": status, "pid": run.publication_id}, provenance_id,
        )


# ---- the publication --------------------------------------------------------------------------
async def _final_statuses(conn: AsyncConnection, outcomes: Sequence[ItemOutcome]) -> Tuple[ItemOutcome, ...]:
    ids: Dict[str, List[uuid.UUID]] = {}
    for o in outcomes:
        if o.entity_id is not None:
            ids.setdefault(o.entity_type, []).append(o.entity_id)
    status: Dict[Tuple[str, uuid.UUID], str] = {}
    for entity_type, entity_ids in ids.items():
        table = _ENTITY_TABLES[entity_type]
        for row in (await conn.execute(text(
            f"SELECT id, review_status FROM public.{table} WHERE id = ANY(:ids)"  # noqa: S608 - fixed table names
        ), {"ids": entity_ids})).all():
            status[(entity_type, row[0])] = row[1]
    return tuple(
        ItemOutcome(o.item_key, o.entity_type, o.entity_id, o.decision, o.reason, o.content_sha256, o.prev_sha256,
                    status.get((o.entity_type, o.entity_id)) if o.entity_id is not None else None)
        for o in outcomes
    )


async def _already(conn: AsyncConnection, batch: PublicationBatch, input_sha: str, publication_id: uuid.UUID) -> PublicationResult:
    pub = (await conn.execute(text(
        "SELECT seq, item_count, promoted_count, quarantined_count, updated_count, unchanged_count, rejected_count "
        "FROM public.corpus_publication WHERE id = :id"
    ), {"id": publication_id})).one()
    items = (await conn.execute(text(
        "SELECT item_key, entity_type, entity_id, decision, reason, content_sha256, prev_sha256 "
        "FROM public.corpus_publication_item WHERE publication_id = :id ORDER BY id"
    ), {"id": publication_id})).all()
    outcomes = await _final_statuses(conn, [ItemOutcome(*row, None) for row in items])
    return PublicationResult(publication_id, batch.batch_key, input_sha, True, int(pub[0]),
                             dict(zip(COUNT_KEYS, (int(n) for n in pub[1:]))), outcomes)


async def publish_batch(conn: AsyncConnection, batch: PublicationBatch, actor_id: str) -> PublicationResult:
    """Publish ``batch`` on ``conn`` inside the caller's transaction. Raises PublicationError, or a
    database error for a real fault; in both cases the caller must roll back."""
    if not conn.in_transaction():
        raise PublicationError("transaction_required")
    if (await conn.execute(text(
        "SELECT coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user), false)"
    ))).scalar():
        raise PublicationError("superuser_session")  # D2: the guard does not check a superuser
    if not (await conn.execute(text("SELECT pg_catalog.pg_has_role(session_user, 'corpus_writer', 'MEMBER')"))).scalar():
        raise PublicationError("not_corpus_writer")
    previous_role = (await conn.execute(text("SELECT pg_catalog.current_setting('role')"))).scalar()
    try:
        await conn.execute(text("SET LOCAL ROLE corpus_writer"))
    except DBAPIError:
        raise PublicationError("not_corpus_writer") from None

    input_sha = batch_sha256(batch)
    try:
        begun = (await conn.execute(text(
            "SELECT publication_id, already FROM public.corpus_publication_begin(:key, :sha, :kind, :actor)"
        ), {"key": batch.batch_key, "sha": input_sha, "kind": batch.source_kind, "actor": actor_id})).one()
    except DBAPIError as exc:
        code, _token = _pg_error(exc)
        if code == "SKP01":
            raise PublicationError("batch_key_reused") from None
        if code in _STATE_ERRORS:
            raise PublicationError("publication_state") from None
        raise
    publication_id, already = begun[0], bool(begun[1])
    if already:
        result = await _already(conn, batch, input_sha, publication_id)
        await conn.execute(text("SELECT pg_catalog.set_config('role', :role, true)"), {"role": previous_role})
        return result

    run = _Run(conn, publication_id)
    ordered = (
        [i for i in batch.items if isinstance(i, JudgmentItem)]
        + [i for i in batch.items if isinstance(i, StatuteSectionHistoryItem)]
        + [i for i in batch.items if isinstance(i, TreatmentItem)]
    )
    for item in ordered:
        if isinstance(item, JudgmentItem):
            await run.item(item.item_key, "judgment", lambda item=item: _publish_judgment(run, item))
        elif isinstance(item, StatuteSectionHistoryItem):
            await run.item(item.item_key, "statute_section", lambda item=item: _publish_history(run, item))
        else:
            await run.item(item.item_key, "treatment", lambda item=item: _publish_treatment(run, item))

    # FA-D5-003 R1 (spec R21): the research term index of what this publication wrote, in its own transaction. A text
    # the fold cannot reproduce exactly stays pending; the application folds that judgment itself.
    if run.judgment_by_item and await research_index_present(conn):
        await index_research_terms(conn, judgment_ids=run.judgment_by_item.values())

    tally = Counter(o.decision for o in run.outcomes)
    counts = {"items": len({o.item_key for o in run.outcomes}), **{k: tally.get(k, 0) for k in COUNT_KEYS[1:]}}
    try:
        seq = (await conn.execute(text(
            "SELECT public.corpus_publication_finish(:pid, CAST(:counts AS jsonb))"
        ), {"pid": publication_id, "counts": canonical_json(counts).decode("utf-8")})).scalar()
    except DBAPIError as exc:
        code, _token = _pg_error(exc)
        if code in _STATE_ERRORS:
            raise PublicationError("publication_state") from None
        raise
    outcomes = await _final_statuses(conn, run.outcomes)
    await conn.execute(text("SELECT pg_catalog.set_config('role', :role, true)"), {"role": previous_role})
    logger.info(
        "publication.finished seq=%s kind=%s items=%d promoted=%d quarantined=%d updated=%d unchanged=%d rejected=%d",
        seq, batch.source_kind, *(counts[k] for k in COUNT_KEYS),
    )
    return PublicationResult(publication_id, batch.batch_key, input_sha, False, int(seq), counts, outcomes)
