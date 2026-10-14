"""Promote normalised staging records (audit F20, F22, F19).

Each record's source is resolved through its foreign key first, and the trust decision comes from
scraper.trust: only a trusted source with confidence >= 0.5 is promoted; review, blocked, low
confidence and an unknown, missing or deleted source are quarantined with a durable reason. A
record with no citation is quarantined as citation_missing (F22). Each record is decided in its own
savepoint and committed on its own, so one bad record cannot stop or roll back the rest.

A record the trust decision promotes is published into the Annex A corpus contract as one audited
publication (scraper.publication.annex_a.publish_batch, batch_key "staging/<id>", plan D7), in the
same transaction as the staging update. It is promoted only if Annex A promotes it: with no bench it
is published quarantined (missing_bench, ruling 9), a non-canonical citation is quarantined
(citation_not_canonical), incomplete provenance or an invalid bench is rejected, and a re-scrape can
never demote or rewrite a published authority (promoted_row_protected); each of those reasons is
recorded on the staging row and in quarantine_queue. Records quarantined for trust or a missing
citation never reach Annex A (D8). promoted_to_id is the Annex A judgment id.

case_law_master is no longer written here and nothing is queued for embedding (spec ruling 10;
Annex A embeddings are audit F27). Nothing schedules this routine yet (audit F21).
"""

import logging
from typing import Mapping, Optional, Tuple

from sqlalchemy import func, select

from scraper.database import SessionLocal
from scraper.models import QuarantineQueue, ScraperSource, ScraperStaging
from scraper.publication.annex_a import publish_batch
from scraper.publication.from_staging import STAGING_ACTOR_ID, staging_batch, staging_outcome
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


def _quarantine(
    db,
    st: ScraperStaging,
    src: Optional[ScraperSource],
    reason: str,
    resolved_by: Optional[str],
    extra_details: Optional[Mapping[str, object]] = None,
) -> None:
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
                **(extra_details or {}),
            },
        )
    )
    st.quarantined = True
    st.quarantine_reason = reason


async def _decide(db, st: ScraperStaging) -> str:
    """Apply the decision for one record; return "promoted" or "quarantined"."""
    src, resolved_by = await _resolve_source(db, st)
    citation = (st.extracted_citation or "").strip()
    if not citation:
        _quarantine(db, st, src, REASON_CITATION_MISSING, resolved_by)
        return "quarantined"
    decision = publication_decision(src.trust_level if src is not None else None, st.confidence_score)
    if not decision.promote:
        _quarantine(db, st, src, decision.reason, resolved_by)
        return "quarantined"
    # Audit F19: publish into Annex A in this record's transaction. A PublicationError or a database
    # error propagates to the per-record handler: the record is rolled back, counted failed, left pending.
    await db.flush()
    conn = await db.connection()
    result = await publish_batch(conn, staging_batch(st, src), STAGING_ACTOR_ID)
    outcome = staging_outcome(result)
    if not outcome.promoted:
        _quarantine(db, st, src, outcome.reason, resolved_by, extra_details=outcome.details)
        return "quarantined"
    st.promoted = True
    st.promoted_at = func.now()
    st.promoted_to_id = outcome.judgment_id
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
