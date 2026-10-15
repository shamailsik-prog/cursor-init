"""Map one promoted staging record onto a publication batch (audit F19).

Promotion (scraper.tasks.promotion) publishes each staging record that the F20 trust decision
promotes as one publication (plan D7): ``batch_key = "staging/<staging id>"``, ``source_kind =
"staging"``, one judgment item. Provenance comes from the row itself (D17); the bench is the raw
``extracted_bench_type`` (aliases mapped at publication; none -> quarantined missing_bench, ruling 9);
the citation is re-parsed and re-keyed to the TypeScript canonical form, so the extractor's
"Karachi" / "Balochistan" spellings become "Sindh" / "Quetta" here (D26). Courts, judges, bench size
and decision date are not invented (D12).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Dict, Final, Mapping, Optional

from scraper.models import ScraperSource, ScraperStaging
from scraper.publication.annex_a import PublicationResult
from scraper.publication.batch import BATCH_FORMAT, Provenance, PublicationBatch, parse_batch_json
from scraper.publication.citations import parse_parts
from scraper.publication.vocabulary import EXTRACTION_METHODS

STAGING_ACTOR_ID: Final = "corpus_service:promote_staging_records"
STAGING_ITEM_KEY: Final = "judgment"
_MAX_CITATION_TEXT: Final = 200
_PROMOTED_DECISIONS: Final = ("promoted", "updated", "unchanged")


def staging_batch_key(staging_id: uuid.UUID) -> str:
    return f"staging/{staging_id}"


def _aware(value: object) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo is not None else None
    return None


def _provenance_fields(st: ScraperStaging, source: Optional[ScraperSource]) -> Dict[str, Any]:
    """D17: the source record's name; the row's URL and stored PDF; fetched_at from the harvester's
    metadata when it is a valid timezone-aware ISO-8601 time, else the row's created_at; the row's
    content_hash, else sha256(raw_text) (the model's own definition of content_hash); the extraction
    method from the metadata when it is in the Annex A set, else ocr / pdf / html from what the row
    holds, else none (provenance_incomplete). The method is never guessed from a URL."""
    metadata = st.parsing_metadata if isinstance(st.parsing_metadata, dict) else {}
    content_hash = st.content_hash or (hashlib.sha256(st.raw_text.encode("utf-8")).hexdigest() if st.raw_text else None)
    method = metadata.get("extraction_method")
    if method not in EXTRACTION_METHODS:
        if st.ocr_applied:
            method = "ocr"
        elif st.raw_pdf_path:
            method = "pdf"
        elif st.raw_html:
            method = "html"
        else:
            method = None
    extractor_version = metadata.get("extractor_version")
    return {
        "source_name": source.source_name if source is not None else None,
        "source_url": st.source_url,
        "raw_storage_key": st.raw_pdf_path,
        "fetched_at": _aware(metadata.get("fetched_at")) or _aware(st.created_at),
        "content_hash": content_hash,
        "extraction_method": method,
        "extractor_version": extractor_version if isinstance(extractor_version, str) else None,
    }


def staging_provenance(st: ScraperStaging, source: Optional[ScraperSource]) -> Provenance:
    fields = _provenance_fields(st, source)
    return Provenance.model_validate_json(json.dumps(fields, default=_json_default))


def _json_default(value: object) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(type(value).__name__)


def _citation(raw: Optional[str]) -> Dict[str, Any]:
    text = (raw or "").strip()
    parts = parse_parts(text)
    if parts is not None:
        return {"parts": asdict(parts)}
    return {"text": text[:_MAX_CITATION_TEXT]}


def staging_batch(st: ScraperStaging, source: Optional[ScraperSource]) -> PublicationBatch:
    """One judgment item for one staging record, validated as corpus-publication-batch/1."""
    doc = {
        "format": BATCH_FORMAT,
        "batch_key": staging_batch_key(st.id),
        "source_kind": "staging",
        "items": [{
            "kind": "judgment",
            "item_key": STAGING_ITEM_KEY,
            "trust": {"level": source.trust_level if source is not None else None, "confidence": st.confidence_score},
            "provenance": _provenance_fields(st, source),
            "citations": [_citation(st.extracted_citation)] if (st.extracted_citation or "").strip() else [],
            "case_title": st.extracted_title,
            "bench_type": st.extracted_bench_type,
            "bench_size": None,
            "decision_date": None,
            "full_text": st.raw_text,
        }],
    }
    return parse_batch_json(json.dumps(doc, default=_json_default).encode("utf-8"))


@dataclass(frozen=True)
class StagingOutcome:
    promoted: bool
    judgment_id: Optional[uuid.UUID]
    reason: Optional[str]
    details: Mapping[str, object] = field(default_factory=dict)  # {"annex_a": {...}}
    # Attach and skip (PR #48 round 2, FINAL_2 DEDUPLICATION): the judgment is already published and
    # every entity of the record was `unchanged`, so nothing was written; promoted is also true.
    attached: bool = False


def staging_outcome(result: PublicationResult) -> StagingOutcome:
    """Promoted when the judgment is promoted in Annex A by this publication (promoted, updated or
    unchanged); attached when, in addition, nothing was written (every entity unchanged); otherwise
    the item's durable reason."""
    primary = result.primary(STAGING_ITEM_KEY)
    promoted = primary.decision in _PROMOTED_DECISIONS and primary.review_status == "promoted"
    mine = [o for o in result.outcomes if o.item_key == STAGING_ITEM_KEY]
    attached = promoted and bool(mine) and all(o.decision == "unchanged" for o in mine)
    details = {"annex_a": {
        "publication_id": str(result.publication_id),
        "decision": primary.decision,
        "judgment_id": str(primary.entity_id) if primary.entity_id is not None else None,
    }}
    return StagingOutcome(promoted, primary.entity_id, None if promoted else primary.reason, details, attached)
