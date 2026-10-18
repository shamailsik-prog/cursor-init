"""Audit F21: publish an approved record into the retrieval store and hand it to the embedding outbox.

Spec: docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md (R8, R9).

Search (F24's public routes, ``scraper.public_corpus``) and the embedder (``tasks/embeddings.py``, F27
R9) read ``case_law_master`` and ``statutes_master``; Annex A is the authority contract the draft gate
reads (F05). Until F24 follow-up 1 repoints reads at Annex A, a record the review gate approved is
invisible to search and never embedded unless it reaches these tables, which is the audit's F21
failure scenario. This module is the one place the lifecycle writes them (the F20 master-table scan
allowlists it), so the repoint can drop the projection here.

* ``publish_case``: under F23's per-citation advisory lock (namespace 0x0F23, key
  ``citation_lock_key``), so a reviewer's promote of one citation and this projection serialise. A
  ``case_law_master`` row with the citation is attached (nothing is rewritten); otherwise a row is
  inserted with the deterministic id ``uuid5(NAMESPACE_URL, "corpus-service:case_law_master:staging/<id>")``
  (F23 uses ``quarantine/<queue id>``), with F23's field mapping plus provenance.
* ``publish_statute``: under a per-section lock (namespace 0x0F21); an existing ``statutes_master`` row
  with the same ``(short_name, section_number)`` (the table's unique key) or, without a short name, the
  same source, act and section, is attached; otherwise a row with a deterministic id is inserted.
* ``enqueue_embedding``: F23's outbox statement (ruling 9), unchanged: one ``embedding_queue`` row per
  ``(table_name, record_id)``, ``status = 'pending'``, no F27 column set.

Every write runs in the caller's transaction (the publish consumer's per-record transaction).
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Final, Optional, Tuple

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from scraper.models import CaseLawMaster, EmbeddingQueue, StatutesMaster
from scraper.tasks.promotion import citation_lock_key

CASE_MASTER: Final = "case_law_master"
STATUTE_MASTER: Final = "statutes_master"
PUBLICATION_NAMESPACE: Final = uuid.NAMESPACE_URL
# F23's namespace for "publishing this citation into case_law_master" (scraper.routers.quarantine
# CITATION_LOCK_NAMESPACE; a rules test pins that the two agree).
F23_CITATION_LOCK_NAMESPACE: Final = 0x0F23
STATUTE_LOCK_NAMESPACE: Final = 0x0F21
CASE_YEAR_RANGE: Final = (1947, 2100)  # case_law_master's ck_case_law_year_sane


def case_publication_id(staging_id: uuid.UUID) -> uuid.UUID:
    return uuid.uuid5(PUBLICATION_NAMESPACE, f"corpus-service:{CASE_MASTER}:staging/{staging_id}")


def statute_key(source_name: str, act: str, short_name: Optional[str], section: str) -> str:
    """The natural key a statute section is published under: the table's unique key when the record
    has a short name, else its source, act and section."""
    parts = ["short", short_name, section] if short_name else ["site", source_name, act, section]
    return json.dumps(parts, ensure_ascii=True, separators=(",", ":"))


def statute_publication_id(key: str) -> uuid.UUID:
    return uuid.uuid5(PUBLICATION_NAMESPACE, f"corpus-service:{STATUTE_MASTER}:{key}")


async def enqueue_embedding(db: Any, table_name: str, record_id: uuid.UUID) -> uuid.UUID:
    """The outbox row for a published record (F23 ruling 9): exactly once by (table_name, record_id)."""
    inserted = (await db.execute(
        pg_insert(EmbeddingQueue)
        .values(id=uuid.uuid4(), record_id=record_id, table_name=table_name, status="pending")
        .on_conflict_do_nothing(constraint="uq_embedding_table_record")
        .returning(EmbeddingQueue.id)
    )).scalar()
    if inserted is not None:
        return inserted
    return (await db.execute(select(EmbeddingQueue.id).where(
        EmbeddingQueue.table_name == table_name, EmbeddingQueue.record_id == record_id))).scalar_one()


async def outbox_row(db: Any, table_name: str, record_id: uuid.UUID) -> Optional[uuid.UUID]:
    return (await db.execute(select(EmbeddingQueue.id).where(
        EmbeddingQueue.table_name == table_name, EmbeddingQueue.record_id == record_id))).scalar()


async def retrieval_row_exists(db: Any, table_name: str, record_id: Optional[uuid.UUID]) -> bool:
    if record_id is None:
        return False
    model = CaseLawMaster if table_name == CASE_MASTER else StatutesMaster
    return (await db.execute(select(model.id).where(model.id == record_id))).first() is not None


async def publish_case(db: Any, st: Any, source: Any) -> Tuple[uuid.UUID, bool]:
    """(the case_law_master id the record is published as, whether it was attached to an existing row)."""
    citation = (st.extracted_citation or "").strip() or None
    if citation is not None:
        await db.execute(text("SELECT pg_advisory_xact_lock(:namespace, hashtext(:citation))"),
                         {"namespace": F23_CITATION_LOCK_NAMESPACE, "citation": citation_lock_key(citation)})
        holder = (await db.execute(
            select(CaseLawMaster.id).where(CaseLawMaster.citation == citation).limit(1))).scalar()
        if holder is not None:
            return holder, True
    case_id = case_publication_id(st.id)
    if await retrieval_row_exists(db, CASE_MASTER, case_id):
        return case_id, True
    low, high = CASE_YEAR_RANGE
    year = st.extracted_year if isinstance(st.extracted_year, int) and low <= st.extracted_year <= high else None
    db.add(CaseLawMaster(
        id=case_id,
        citation=citation,
        case_title=st.extracted_title,
        court=st.extracted_court,
        year=year,
        reporter=st.extracted_reporter,
        source_site=source.source_name,  # the source whose trust was just re-read (F23 ruling 8, F24's predicate)
        source_url=st.source_url,
        source_file_path=st.raw_pdf_path,
        full_text=st.raw_text,
        confidence_score=st.confidence_score,
        is_promoted=True,
        promoted_at=func.now(),
    ))
    await db.flush()
    return case_id, False


async def publish_statute(db: Any, st: Any, source: Any) -> Tuple[uuid.UUID, bool, bool]:
    """(the statutes_master id, attached to an existing row, the attached row's text differs)."""
    act = (st.extracted_act_name or "").strip()
    section = (st.extracted_section_number or "").strip()
    short_name = (st.extracted_short_name or "").strip() or None
    body = st.extracted_section_text or st.raw_text
    key = statute_key(source.source_name, act, short_name, section)
    await db.execute(text("SELECT pg_advisory_xact_lock(:namespace, hashtext(:key))"),
                     {"namespace": STATUTE_LOCK_NAMESPACE, "key": key})
    if short_name is not None:
        match = (StatutesMaster.short_name == short_name, StatutesMaster.section_number == section)
    else:
        match = (StatutesMaster.short_name.is_(None), StatutesMaster.source_site == source.source_name,
                 StatutesMaster.statute_name == act, StatutesMaster.section_number == section)
    existing = (await db.execute(
        select(StatutesMaster.id, StatutesMaster.section_text).where(*match).order_by(StatutesMaster.created_at).limit(1)
    )).first()
    if existing is not None:
        return existing[0], True, existing[1] != body
    statute_id = statute_publication_id(key)
    db.add(StatutesMaster(
        id=statute_id,
        statute_name=act,
        short_name=short_name,
        section_number=section,
        section_title=st.extracted_section_title,
        section_text=body,
        source_site=source.source_name,
        source_url=st.source_url,
        confidence_score=st.confidence_score,
    ))
    await db.flush()
    return statute_id, False, False
