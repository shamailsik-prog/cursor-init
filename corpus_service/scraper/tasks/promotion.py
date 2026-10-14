"""Promote normalised staging records (audit F20, F22, F19; PR #48 re-audit rounds 1 and 2).

For each record, in this order:
1. Resolve its source by the most specific identifier present (source_id FK, the harvester's stamped
   parsing_metadata source_id, then source_name, then the source_site label). A present identifier
   that no longer resolves makes the source unknown; it never falls through to a less specific one.
2. No citation -> quarantined citation_missing (F22).
3. The trust decision from scraper.trust: only a trusted source with confidence >= 0.5 may be
   promoted; review, blocked, low confidence and an unknown source are quarantined with that reason.
   Such records never reach the Annex A contract (F19 plan D8).
4. A promotable record is published into the Annex A corpus contract as one audited publication
   (scraper.publication.annex_a.publish_batch, batch_key "staging/<id>", plan D7), under a
   per-citation advisory lock keyed by the canonical citation, so two concurrent runs never publish
   the same citation at once and two spellings of one citation ("PLD 2099 Karachi 12",
   "PLD 2099 Sindh 12") serialise together. The publication decides what an already published
   citation means (PR #48 round 2, FINAL_2 DEDUPLICATION: "attach ... to the existing judgment row
   and skip the rest", in Annex A terms):
   - identical content (every entity `unchanged`) is attached and skipped: the staging row is closed
     (promoted, promoted_at, promoted_to_id = the existing Annex A judgment), nothing is rewritten,
     no review-queue row is written, and it is counted `attached`;
   - different trusted content is `updated` onto the same judgment and counted `promoted`;
   - a bench-less or otherwise quarantined re-scrape can never demote or rewrite it
     (promoted_row_protected, D9): the only re-stage that goes to review.
   The record is promoted only if Annex A promoted it; otherwise it is quarantined with the
   publication's reason (missing_bench, citation_not_canonical, provenance_incomplete,
   invalid_bench, promoted_row_protected, ...), recorded in quarantine_queue with details.annex_a.

Each record is re-read FOR UPDATE and decided in its own transaction, so one bad record cannot stop
or roll back the rest. A record whose promotion raises is rolled back, its publication with it. A
transient database error (connection lost; SQLSTATE class 08, 40, 53 or 57; 55P03) is not the
record's fault: the record is left pending for the next run. Any other error quarantines it as
promotion_error:<ExceptionClass>, so it is not retried forever; that includes every publication
guard refusal that escapes the item (SQLSTATE class SK, such as SKP12 or SKP13) and integrity
errors (class 23). Both count as failed.

case_law_master is no longer written here and nothing is queued for embedding (F19, spec ruling 10;
Annex A embeddings are audit F27); the duplicate check against case_law_master that PR #48 added is
replaced by the publication's own decision against Annex A. Nothing schedules this routine yet
(audit F21).
"""

import logging
from typing import Mapping, Optional, Tuple

from sqlalchemy import func, select, text

from scraper.database import SessionLocal
from scraper.models import QuarantineQueue, ScraperSource, ScraperStaging
from scraper.publication.annex_a import publish_batch
from scraper.publication.citations import canonical_key
from scraper.publication.from_staging import STAGING_ACTOR_ID, staging_batch, staging_outcome
from scraper.source_identity import META_SOURCE_ID, META_SOURCE_NAME, as_source_uuid, is_present
from scraper.trust import REASON_CITATION_MISSING, promotion_error_reason, publication_decision

logger = logging.getLogger(__name__)

# First key of pg_advisory_xact_lock(int, int) for "promoting this citation"; the second key is
# hashtext(<citation lock key>). A collision only serialises two promotions; it cannot let one through.
_CITATION_LOCK_NAMESPACE = 0x0F20

# Round-2 L2: database errors that say nothing about the record itself.
_TRANSIENT_SQLSTATE_CLASSES = ("08", "40", "53", "57")  # connection, transaction rollback, resources, operator intervention
_TRANSIENT_SQLSTATES = ("55P03",)  # lock_not_available


def _sqlstate(exc: BaseException) -> Optional[str]:
    """The SQLSTATE of a database error, looking through SQLAlchemy's wrapper and the driver
    exception it wraps."""
    seen = set()
    stack = [exc]
    while stack:
        candidate = stack.pop()
        if candidate is None or id(candidate) in seen:
            continue
        seen.add(id(candidate))
        for attr in ("sqlstate", "pgcode"):
            code = getattr(candidate, attr, None)
            if isinstance(code, str) and len(code) == 5:
                return code
        stack.extend([getattr(candidate, "orig", None), candidate.__cause__, candidate.__context__])
    return None


def is_transient_db_error(exc: BaseException) -> bool:
    """True when promotion failed for a reason outside the record: the connection was invalidated,
    or the SQLSTATE is in class 08, 40, 53 or 57, or is 55P03."""
    if getattr(exc, "connection_invalidated", False):
        return True
    code = _sqlstate(exc)
    return code is not None and (code[:2] in _TRANSIENT_SQLSTATE_CLASSES or code in _TRANSIENT_SQLSTATES)


def citation_lock_key(raw: Optional[str]) -> str:
    """The per-citation lock key (F19): the TypeScript canonical key when the citation has one, so
    every spelling of one authority takes the same lock; otherwise the trimmed text."""
    stripped = (raw or "").strip()
    return canonical_key(stripped) or stripped


async def _source_by_name(db, name: str) -> Optional[ScraperSource]:
    return (await db.execute(select(ScraperSource).where(ScraperSource.source_name == name))).scalars().first()


async def _resolve_source(db, st: ScraperStaging) -> Tuple[Optional[ScraperSource], Optional[str]]:
    """The source record behind a staging row, and the identifier that decided it.

    Only the most specific identifier present is used:
    1. the source_id FK (survives a rename; NULL once the source is deleted);
    2. parsing_metadata["source_id"], stamped by the harvester (survives the delete);
    3. parsing_metadata["source_name"], stamped by the harvester;
    4. source_site, a label that court harvesters share across a family of sources.
    If that identifier does not resolve (deleted, renamed, malformed), the source is unknown: the
    record must not borrow the trust of a less specific label.
    """
    if st.source_id is not None:
        return await db.get(ScraperSource, st.source_id, populate_existing=True), "source_id"
    metadata = st.parsing_metadata
    if metadata is not None and not isinstance(metadata, dict):
        return None, "parsing_metadata"
    metadata = metadata or {}
    stamped_id = metadata.get(META_SOURCE_ID)
    if is_present(stamped_id):
        source_uuid = as_source_uuid(stamped_id)
        src = await db.get(ScraperSource, source_uuid, populate_existing=True) if source_uuid is not None else None
        return src, "parsing_metadata.source_id"
    stamped_name = metadata.get(META_SOURCE_NAME)
    if is_present(stamped_name):
        src = await _source_by_name(db, stamped_name) if isinstance(stamped_name, str) else None
        return src, "parsing_metadata.source_name"
    if is_present(st.source_site):
        return await _source_by_name(db, st.source_site), "source_site"
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
    """Apply the decision for one record; return "promoted", "attached" or "quarantined"."""
    src, resolved_by = await _resolve_source(db, st)
    citation = (st.extracted_citation or "").strip()
    if not citation:
        _quarantine(db, st, src, REASON_CITATION_MISSING, resolved_by)
        return "quarantined"
    decision = publication_decision(src.trust_level if src is not None else None, st.confidence_score)
    if not decision.promote:
        _quarantine(db, st, src, decision.reason, resolved_by)
        return "quarantined"
    # Trust first, then the publication (re-audit LOW-4), serialised per citation so two concurrent
    # runs cannot both decide the same citation unpublished. Since F19 the duplicate decision is the
    # audited publication's own, against Annex A (unchanged / updated / promoted_row_protected).
    await db.execute(
        text("SELECT pg_advisory_xact_lock(:namespace, hashtext(:citation))"),
        {"namespace": _CITATION_LOCK_NAMESPACE, "citation": citation_lock_key(citation)},
    )
    # A PublicationError or a database error propagates to the per-record handler: the record and
    # its publication are rolled back, then it is left pending (transient) or quarantined as
    # promotion_error:<ExceptionClass>.
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
    # Attach and skip: an unchanged re-stage of the published judgment wrote nothing in Annex A.
    return "attached" if outcome.attached else "promoted"


async def _quarantine_after_error(db, staging_id, exc: BaseException) -> None:
    """Make a failed record's outcome durable (re-audit LOW-3): after its own work is rolled back,
    quarantine it as promotion_error:<ExceptionClass> in a fresh transaction. If even that fails,
    log it (identifier and class only) and leave the record pending."""
    reason = promotion_error_reason(exc)
    try:
        async with db.begin_nested():
            st = await db.get(ScraperStaging, staging_id, populate_existing=True, with_for_update=True)
            if st is not None and not st.promoted and not st.quarantined:
                _quarantine(db, st, None, reason, None)
        await db.commit()
    except Exception as second:  # noqa: BLE001 - the batch must continue
        await db.rollback()
        logger.error("promotion.error_quarantine_failed staging_id=%s error=%s", staging_id, type(second).__name__)


async def promote_staging_records() -> dict:
    """Decide every normalised, undecided staging record. Returns counts of promoted, attached
    (a duplicate of an already-published citation), quarantined and failed records. A failed
    record is rolled back; it is then left pending if the error was transient, otherwise
    quarantined as promotion_error:<ExceptionClass>."""
    counts = {"promoted": 0, "attached": 0, "quarantined": 0, "failed": 0}
    async with SessionLocal() as db:
        ids = (
            await db.execute(
                select(ScraperStaging.id)
                .where(
                    ScraperStaging.normalised.is_(True),
                    ScraperStaging.promoted.is_(False),
                    ScraperStaging.quarantined.is_(False),
                )
                .order_by(ScraperStaging.id)  # one lock order for every concurrent run
            )
        ).scalars().all()
        for staging_id in ids:
            try:
                async with db.begin_nested():
                    st = await db.get(ScraperStaging, staging_id, populate_existing=True, with_for_update=True)
                    if st is None or not st.normalised or st.promoted or st.quarantined:
                        outcome = "skipped"  # decided elsewhere since the list was read
                    else:
                        outcome = await _decide(db, st)
                await db.commit()  # one record per transaction; also releases the row lock when skipped
            except Exception as exc:  # noqa: BLE001 - one record must not stop the batch
                await db.rollback()
                counts["failed"] += 1
                transient = is_transient_db_error(exc)
                # Identifier and exception class only: the message can carry row data.
                logger.warning(
                    "promotion.record_failed staging_id=%s error=%s transient=%s",
                    staging_id, type(exc).__name__, "true" if transient else "false",
                )
                if not transient:  # a transient error leaves the record pending for the next run
                    await _quarantine_after_error(db, staging_id, exc)
                continue
            if outcome in counts:
                counts[outcome] += 1
    logger.info(
        "promotion.finished promoted=%d attached=%d quarantined=%d failed=%d",
        counts["promoted"], counts["attached"], counts["quarantined"], counts["failed"],
    )
    return counts
