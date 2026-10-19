"""Audit F21: the normalisation step of the corpus lifecycle (``parsed`` -> ``normalised``).

Spec: docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md (R6).

Normalisation is validation, identity and dedup. It invents nothing: no citation, bench, court or
date is read out of a document's text (a judgment's first citation is usually a precedent it cites;
F19 D12), so what a harvester did not extract stays empty and the review gate decides.

* case (``scraper_staging``): the text must hold a letter or digit (else ``failed``, ``empty_text``);
  ``content_hash = sha256(raw_text)`` and ``source_url_hash = sha256(source_url)`` when absent.
* statute (``statutes_staging``): an act name, a section number of at most 100 characters (the
  ``statutes_master`` column), a short name of at most 100, and a section text with a letter or digit
  (else ``failed`` with that code); ``act_hash = sha256(act name, section number, text)``.
* dedup: a record whose source, URL hash and content hash (statutes: act hash) match another record
  that has already passed normalisation becomes ``duplicate`` (``duplicate_of:<id>``). A transaction
  advisory lock on that key serialises two workers normalising two copies of one document, so exactly
  one of them is kept.
* a harvester's pre-gate quarantine label (``quarantined`` with no review-queue row) is cleared and
  recorded in the move's details: the review gate decides quarantine.

Each function runs inside the consumer's per-record transaction (scraper.tasks.corpus_pipeline) on a
row claimed ``FOR UPDATE SKIP LOCKED``.
"""

from __future__ import annotations

import hashlib
import uuid
from typing import Optional

from sqlalchemy import and_, func, select, text

from scraper.models import QuarantineQueue, ScraperStaging, StatutesStaging
from scraper.tasks import lifecycle

# First key of pg_advisory_xact_lock(int, int) for "deciding whether this document is a duplicate".
DEDUP_LOCK_NAMESPACE = 0x0F2D
MAX_SECTION_NUMBER_CHARS = 100  # statutes_master.section_number
MAX_SHORT_NAME_CHARS = 100  # statutes_master.short_name
MAX_ACT_NAME_CHARS = 1000  # statutes_master.statute_name

FAILED_EMPTY_TEXT = "empty_text"
FAILED_ACT_NAME_MISSING = "act_name_missing"
FAILED_SECTION_NUMBER_MISSING = "section_number_missing"
FAILED_SECTION_NUMBER_TOO_LONG = "section_number_too_long"
FAILED_SHORT_NAME_TOO_LONG = "short_name_too_long"
FAILED_ACT_NAME_TOO_LONG = "act_name_too_long"

# A record in one of these states has passed normalisation, so it can be the original of a copy.
_PAST_NORMALISATION = (
    lifecycle.NORMALISED, lifecycle.QUARANTINED, lifecycle.APPROVED, lifecycle.PUBLISHED,
    lifecycle.EMBEDDED, lifecycle.REJECTED,
)


def sha256_text(value: str) -> str:
    """Hex sha256 of the UTF-8 text (the same as Postgres encode(sha256(convert_to(v, 'UTF8')), 'hex'))."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def act_hash(act_name: str, section_number: str, section_text: str) -> str:
    """statutes_staging.act_hash: sha256 of act name, section number and text joined by U+001F."""
    return sha256_text("\x1f".join((act_name, section_number, section_text)))


def has_text(value: Optional[str]) -> bool:
    """A letter or a digit somewhere (whitespace, punctuation or control characters only is empty)."""
    return bool(value) and any(ch.isalnum() for ch in value)


def _present(value: Optional[str]) -> bool:
    return bool(value) and bool(value.strip())


def _same_source(model, row):
    if row.source_id is not None:
        return model.source_id == row.source_id
    return and_(model.source_id.is_(None), model.source_site.is_not_distinct_from(row.source_site))


async def _lock_key(db, model, row, content_key: str) -> None:
    source = str(row.source_id) if row.source_id is not None else f"site:{row.source_site}"
    key = "\x1f".join((model.__tablename__, source, row.source_url_hash or "", content_key))
    await db.execute(text("SELECT pg_advisory_xact_lock(:ns, hashtext(:key))"), {"ns": DEDUP_LOCK_NAMESPACE, "key": key})


async def _original(db, model, row, content_column, content_key: str) -> Optional[uuid.UUID]:
    """The record this one copies: same source, URL hash and content, already past normalisation."""
    return (await db.execute(
        select(model.id)
        .where(
            model.id != row.id,
            _same_source(model, row),
            model.source_url_hash.is_not_distinct_from(row.source_url_hash),
            content_column == content_key,
            model.lifecycle_state.in_(_PAST_NORMALISATION),
        )
        .order_by(model.created_at, model.id)
        .limit(1)
    )).scalar()


async def _clear_harvester_label(db, row, queue_column) -> Optional[str]:
    """A quarantine flag set by a harvester (no review-queue row) is not a gate decision: clear it."""
    if not row.quarantined:
        return None
    queued = (await db.execute(select(QuarantineQueue.id).where(queue_column == row.id).limit(1))).first()
    if queued is not None:
        return None
    label = row.quarantine_reason or ""
    row.quarantined = False
    row.quarantine_reason = None
    return label


async def _finish(db, row, model, content_column, content_key, queue_column, *, job_id) -> str:
    await _lock_key(db, model, row, content_key)
    original = await _original(db, model, row, content_column, content_key)
    if original is not None:
        lifecycle.move(db, row, lifecycle.DUPLICATE, actor=lifecycle.ACTOR_NORMALISE, job_id=job_id,
                       reason=f"duplicate_of:{original}")
        return lifecycle.DUPLICATE
    label = await _clear_harvester_label(db, row, queue_column)
    row.normalised = True
    row.normalised_at = func.now()
    lifecycle.move(db, row, lifecycle.NORMALISED, actor=lifecycle.ACTOR_NORMALISE, job_id=job_id,
                   details=lifecycle.summary_details(label_cleared=label))
    return lifecycle.NORMALISED


def _fail(db, row, code: str, job_id) -> str:
    lifecycle.move(db, row, lifecycle.FAILED, actor=lifecycle.ACTOR_NORMALISE, job_id=job_id, reason=code)
    return lifecycle.FAILED


async def normalise_case(db, row: ScraperStaging, *, job_id=None) -> str:
    if not has_text(row.raw_text):
        return _fail(db, row, FAILED_EMPTY_TEXT, job_id)
    row.content_hash = row.content_hash or sha256_text(row.raw_text)
    if row.source_url and not row.source_url_hash:
        row.source_url_hash = sha256_text(row.source_url)
    return await _finish(db, row, ScraperStaging, ScraperStaging.content_hash, row.content_hash,
                         QuarantineQueue.staging_id, job_id=job_id)


async def normalise_statute(db, row: StatutesStaging, *, job_id=None) -> str:
    act, section = (row.extracted_act_name or "").strip(), (row.extracted_section_number or "").strip()
    body = row.extracted_section_text or row.raw_text
    if not _present(act):
        return _fail(db, row, FAILED_ACT_NAME_MISSING, job_id)
    if len(act) > MAX_ACT_NAME_CHARS:
        return _fail(db, row, FAILED_ACT_NAME_TOO_LONG, job_id)
    if not _present(section):
        return _fail(db, row, FAILED_SECTION_NUMBER_MISSING, job_id)
    if len(section) > MAX_SECTION_NUMBER_CHARS:
        return _fail(db, row, FAILED_SECTION_NUMBER_TOO_LONG, job_id)
    if row.extracted_short_name and len(row.extracted_short_name.strip()) > MAX_SHORT_NAME_CHARS:
        return _fail(db, row, FAILED_SHORT_NAME_TOO_LONG, job_id)
    if not has_text(body):
        return _fail(db, row, FAILED_EMPTY_TEXT, job_id)
    row.act_hash = row.act_hash or act_hash(act, section, body)
    if row.source_url and not row.source_url_hash:
        row.source_url_hash = sha256_text(row.source_url)
    return await _finish(db, row, StatutesStaging, StatutesStaging.act_hash, row.act_hash,
                         QuarantineQueue.statutes_staging_id, job_id=job_id)


async def normalise(db, row, *, job_id=None) -> str:
    if lifecycle.table_of(row) == lifecycle.CASE_TABLE:
        return await normalise_case(db, row, job_id=job_id)
    return await normalise_statute(db, row, job_id=job_id)
