"""Promote normalised staging records (audit F20, F22).

Each record's source is resolved through its foreign key first, and the trust decision comes from
scraper.trust: only a trusted source with confidence >= 0.5 is promoted; review, blocked, low
confidence and an unknown, missing or deleted source are quarantined with a durable reason. A
record with no citation is quarantined as citation_missing (F22). Each record is decided in its own
savepoint and committed on its own, so one bad record cannot stop or roll back the rest.

Promoted rows are still written to case_law_master and queued for embedding; moving publication to
the Annex A contract is audit F19. Nothing schedules this routine yet (audit F21).
"""

import logging
from typing import Optional, Tuple

from sqlalchemy import func, select

from scraper.database import SessionLocal
from scraper.models import CaseLawMaster, EmbeddingQueue, QuarantineQueue, ScraperSource, ScraperStaging
from scraper.trust import REASON_CITATION_MISSING, publication_decision

logger = logging.getLogger(__name__)


async def _resolve_source(db, st: ScraperStaging) -> Tuple[Optional[ScraperSource], Optional[str]]:
    """The source record behind a staging row, and how it was found.

    1. the source_id foreign key (survives a rename; NULL once the source is deleted);
    2. parsing_metadata["source_name"], the harvester's own source record name;
    3. source_site, a label that may be stale.
    The FK, when set, is authoritative: a row cannot borrow another source's trust by its label.
    """
    if st.source_id is not None:
        src = await db.get(ScraperSource, st.source_id, populate_existing=True)
        return src, ("source_id" if src is not None else None)
    metadata = st.parsing_metadata if isinstance(st.parsing_metadata, dict) else {}
    for how, name in (("parsing_metadata.source_name", metadata.get("source_name")), ("source_site", st.source_site)):
        if isinstance(name, str) and name:
            src = (await db.execute(select(ScraperSource).where(ScraperSource.source_name == name))).scalars().first()
            if src is not None:
                return src, how
    return None, None


def _quarantine(db, st: ScraperStaging, src: Optional[ScraperSource], reason: str, resolved_by: Optional[str]) -> None:
    db.add(
        QuarantineQueue(
            staging_id=st.id,
            source_id=src.id if src is not None else None,
            source_site=st.source_site,
            source_url=st.source_url,
            extracted_citation=st.extracted_citation,
            extracted_title=st.extracted_title,
            extracted_court=st.extracted_court,
            confidence_score=st.confidence_score,
            reason=reason,
            details={
                "trust_level": src.trust_level if src is not None else None,
                "source_resolved_by": resolved_by,
            },
        )
    )
    st.quarantined = True
    st.quarantine_reason = reason


async def _decide(db, st: ScraperStaging) -> str:
    """Apply the decision for one record; return "promoted", "quarantined" or "skipped"."""
    src, resolved_by = await _resolve_source(db, st)
    citation = (st.extracted_citation or "").strip()
    if not citation:
        _quarantine(db, st, src, REASON_CITATION_MISSING, resolved_by)
        return "quarantined"
    dup = await db.execute(select(CaseLawMaster.id).where(CaseLawMaster.citation == st.extracted_citation))
    if dup.first() is not None:
        return "skipped"  # already published; left pending as before
    decision = publication_decision(src.trust_level if src is not None else None, st.confidence_score)
    if not decision.promote:
        _quarantine(db, st, src, decision.reason, resolved_by)
        return "quarantined"
    master = CaseLawMaster(
        citation=st.extracted_citation,
        case_title=st.extracted_title,
        court=st.extracted_court,
        year=st.extracted_year,
        reporter=st.extracted_reporter,
        full_text=st.raw_text,
        source_site=st.source_site,
        source_url=st.source_url,
        confidence_score=st.confidence_score,
        is_promoted=True,
    )
    db.add(master)
    await db.flush()
    db.add(EmbeddingQueue(record_id=master.id, table_name="case_law_master"))
    st.promoted = True
    st.promoted_at = func.now()
    st.promoted_to_id = master.id
    return "promoted"


async def promote_staging_records() -> dict:
    """Decide every normalised, undecided staging record. Returns counts of promoted, quarantined
    and failed records (a failed record is rolled back and left pending)."""
    counts = {"promoted": 0, "quarantined": 0, "failed": 0}
    async with SessionLocal() as db:
        ids = (
            await db.execute(
                select(ScraperStaging.id).where(
                    ScraperStaging.normalised.is_(True),
                    ScraperStaging.promoted.is_(False),
                    ScraperStaging.quarantined.is_(False),
                )
            )
        ).scalars().all()
        for staging_id in ids:
            try:
                async with db.begin_nested():
                    st = await db.get(ScraperStaging, staging_id, populate_existing=True, with_for_update=True)
                    if st is None or not st.normalised or st.promoted or st.quarantined:
                        continue  # decided elsewhere since the list was read
                    outcome = await _decide(db, st)
                await db.commit()
            except Exception as exc:  # noqa: BLE001 - one record must not stop the batch
                await db.rollback()
                counts["failed"] += 1
                # Identifier and exception class only: the message can carry row data.
                logger.warning("promotion.record_failed staging_id=%s error=%s", staging_id, type(exc).__name__)
                continue
            if outcome in counts:
                counts[outcome] += 1
    logger.info(
        "promotion.finished promoted=%d quarantined=%d failed=%d",
        counts["promoted"], counts["quarantined"], counts["failed"],
    )
    return counts
