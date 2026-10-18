"""Which scraper_sources row a staged record came from (audit F20, re-audit MEDIUM-1).

Harvesters stamp it when they write a staging row: ScraperStaging.source_id (the FK) plus
parsing_metadata["source_id"] and ["source_name"]. The FK is ON DELETE SET NULL, so after a source
is deleted only the stamped id still says which source the record belonged to.

Promotion resolves a record by the most specific identifier present (FK, then the stamped id, then
the stamped name, then the source_site label) and never falls through to a less specific one when
that identifier no longer resolves: a deleted or renamed source's records must not borrow the trust
of a family label such as source_site "SupremeCourt".
"""

from __future__ import annotations

import uuid
from typing import Any, Mapping, Optional

META_SOURCE_ID = "source_id"
META_SOURCE_NAME = "source_name"


def stamp_metadata(source: Any, metadata: Optional[Mapping[str, Any]] = None) -> dict:
    """A copy of ``metadata`` with the source's id and name stamped in (overriding any keys of the
    same name, so a harvester cannot attribute a record to another source)."""
    stamped = dict(metadata or {})
    stamped[META_SOURCE_ID] = str(source.id)
    stamped[META_SOURCE_NAME] = source.source_name
    return stamped


def is_present(value: Any) -> bool:
    """An identifier counts as present unless it is None or ''."""
    return value is not None and value != ""


def as_source_uuid(value: Any) -> Optional[uuid.UUID]:
    """The UUID in a stamped source id, or None when it is not a valid UUID string."""
    if isinstance(value, uuid.UUID):
        return value
    if not isinstance(value, str):
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None
