"""The versioned publication batch format ``corpus-publication-batch/1`` (audit F19).

A batch is one JSON document: curated authority (``source_kind = "curated"``, published with
``python -m scraper.publication.cli publish``) or one promoted staging record
(``source_kind = "staging"``, built by from_staging). The normative JSON Schema is in the F19 plan
(docs/superpowers/plans/2026-10-14-f19-publication-etl.md, Task 3); these pydantic v2 models
implement it.

Validation boundary (plan D16): anything *structural* raises BatchError before any write - shape,
types, unknown keys, a duplicate item_key, more than MAX_BATCH_ITEMS items, a bad batch_key, a
judgment reference to an item that is not a judgment item of this batch, NUL characters (Postgres
text cannot hold them), a file over MAX_BATCH_BYTES. Everything *semantic* (vocabularies,
provenance completeness, canonical citations, trust, history rules) is decided per item by
annex_a.publish_batch.

A BatchError message names the field path and the error type, never the offending value.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date
from pathlib import Path
from typing import Annotated, Any, Final, List, Literal, Mapping, Optional, Union

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

BATCH_FORMAT: Final = "corpus-publication-batch/1"
MAX_BATCH_ITEMS: Final = 500
MAX_BATCH_BYTES: Final = 32 * 1024 * 1024
BATCH_KEY_RE: Final = r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$"
ITEM_KEY_RE: Final = r"^[A-Za-z0-9._:-]{1,100}$"


class BatchError(ValueError):
    """A structural problem with a batch. The message names a field path, never a value."""


_MODEL = ConfigDict(extra="forbid", frozen=True, strict=True, allow_inf_nan=False)

BatchKey = Annotated[str, StringConstraints(pattern=BATCH_KEY_RE)]
ItemKey = Annotated[str, StringConstraints(pattern=ITEM_KEY_RE)]
Confidence = Annotated[float, Field(ge=0, le=1)]


class Trust(BaseModel):
    model_config = _MODEL
    level: Optional[str]
    confidence: Optional[Confidence]


class Provenance(BaseModel):
    model_config = _MODEL
    source_name: Optional[str] = None
    source_url: Optional[str] = None
    raw_storage_key: Optional[str] = None
    fetched_at: Optional[AwareDatetime] = None
    content_hash: Optional[str] = None
    extraction_method: Optional[str] = None
    extractor_version: Optional[str] = None


class PartsInput(BaseModel):
    model_config = _MODEL
    reporter: str
    year: Annotated[str, StringConstraints(pattern=r"^(19|20)[0-9]{2}$")]
    page: Annotated[str, StringConstraints(pattern=r"^[0-9]{1,6}$")]
    court: Optional[str] = None
    series: Optional[Annotated[str, StringConstraints(max_length=30)]] = None
    note: Optional[Annotated[str, StringConstraints(max_length=30)]] = None


class CitationText(BaseModel):
    model_config = _MODEL
    text: Annotated[str, StringConstraints(min_length=1, max_length=200)]


class CitationFromParts(BaseModel):
    model_config = _MODEL
    parts: PartsInput


CitationInput = Union[CitationText, CitationFromParts]


class RefByItem(BaseModel):
    model_config = _MODEL
    item_key: str


class RefByCitation(BaseModel):
    model_config = _MODEL
    citation: Annotated[str, StringConstraints(max_length=200)]


JudgmentRef = Union[RefByItem, RefByCitation]


class _ItemBase(BaseModel):
    model_config = _MODEL
    item_key: ItemKey
    trust: Trust
    provenance: Provenance


class JudgmentItem(_ItemBase):
    kind: Literal["judgment"]
    citations: Annotated[List[CitationInput], Field(max_length=10)]
    case_title: Optional[str] = None
    bench_type: Optional[str] = None
    bench_size: Optional[Annotated[int, Field(ge=1, le=99)]] = None
    decision_date: Optional[date] = None
    full_text: Optional[str] = None
    headnotes: Optional[str] = None
    summary: Optional[str] = None


class TreatmentItem(_ItemBase):
    kind: Literal["treatment"]
    treating: JudgmentRef
    treated: JudgmentRef
    treatment: Annotated[str, StringConstraints(max_length=50)]
    passage_anchor: Optional[Annotated[str, StringConstraints(max_length=200)]] = None
    treating_bench_type: Optional[str] = None
    confidence: Confidence


class StatuteSpec(BaseModel):
    model_config = _MODEL
    name: Annotated[str, StringConstraints(min_length=1, max_length=500)]
    short_name: Optional[str] = None
    year_enacted: Optional[int] = None
    jurisdiction: str
    status: Optional[str] = None


class SectionSpec(BaseModel):
    model_config = _MODEL
    section_number: Annotated[str, StringConstraints(min_length=1, max_length=50)]
    chapter: Optional[str] = None
    current_title: Optional[str] = None


class VersionSpec(BaseModel):
    model_config = _MODEL
    version_no: Annotated[int, Field(ge=1)]
    effective_from: Optional[date]
    effective_to: Optional[date]
    title: Optional[str] = None
    text: str
    version_confidence: Optional[Confidence] = None


class StatuteSectionHistoryItem(_ItemBase):
    kind: Literal["statute_section_history"]
    statute: StatuteSpec
    section: SectionSpec
    history: Literal["amendment_history", "current_text_only"]
    versions: Annotated[List[VersionSpec], Field(min_length=1, max_length=200)]


Item = Annotated[Union[JudgmentItem, TreatmentItem, StatuteSectionHistoryItem], Field(discriminator="kind")]


class PublicationBatch(BaseModel):
    model_config = _MODEL
    format: Literal["corpus-publication-batch/1"]
    batch_key: BatchKey
    source_kind: Literal["curated", "staging"]
    items: Annotated[List[Item], Field(min_length=1, max_length=MAX_BATCH_ITEMS)]

    @model_validator(mode="after")
    def _structural_rules(self) -> "PublicationBatch":
        seen = set()
        judgments = set()
        for index, item in enumerate(self.items):
            if item.item_key in seen:
                raise ValueError(f"items.{index}.item_key: duplicate item_key")
            seen.add(item.item_key)
            if isinstance(item, JudgmentItem):
                judgments.add(item.item_key)
        for index, item in enumerate(self.items):
            if isinstance(item, TreatmentItem):
                for side in ("treating", "treated"):
                    ref = getattr(item, side)
                    if isinstance(ref, RefByItem) and ref.item_key not in judgments:
                        raise ValueError(f"items.{index}.{side}.item_key: not a judgment item of this batch")
        return self


def _describe(exc: ValidationError) -> str:
    """Field paths and error types only: no input values, no messages that quote them."""
    parts = []
    for error in exc.errors(include_url=False, include_input=False, include_context=False)[:5]:
        loc = ".".join(str(p) for p in error.get("loc", ())) or "<root>"
        kind = error.get("type", "invalid")
        if kind == "value_error":
            # Our own structural rules: the message is a path and a fixed phrase, never a value.
            msg = str(error.get("msg", "")).removeprefix("Value error, ")
            parts.append(msg)
        else:
            parts.append(f"{loc}: {kind}")
    return "; ".join(parts)


def _find_nul(value: Any, path: str = "") -> Optional[str]:
    if isinstance(value, str):
        return path or "<root>" if "\x00" in value else None
    if isinstance(value, Mapping):
        for key, inner in value.items():
            found = _find_nul(inner, f"{path}.{key}" if path else str(key))
            if found:
                return found
    if isinstance(value, (list, tuple)):
        for index, inner in enumerate(value):
            found = _find_nul(inner, f"{path}.{index}" if path else str(index))
            if found:
                return found
    return None


def parse_batch_json(raw: bytes) -> PublicationBatch:
    """Validate a batch document. Raises BatchError on any structural problem."""
    if len(raw) > MAX_BATCH_BYTES:
        raise BatchError(f"batch: larger than {MAX_BATCH_BYTES} bytes")
    try:
        batch = PublicationBatch.model_validate_json(raw)
    except ValidationError as exc:
        raise BatchError(f"invalid batch: {_describe(exc)}") from None
    nul = _find_nul(batch.model_dump(mode="json"))
    if nul:
        raise BatchError(f"invalid batch: {nul}: NUL character")
    return batch


def load_batch(path: Path) -> PublicationBatch:
    """Read and validate a batch file; the size cap is checked before the file is read."""
    size = Path(path).stat().st_size
    if size > MAX_BATCH_BYTES:
        raise BatchError(f"batch: larger than {MAX_BATCH_BYTES} bytes")
    return parse_batch_json(Path(path).read_bytes())


def canonical_json(value: object) -> bytes:
    """Sorted keys, no insignificant whitespace, UTF-8, NaN refused."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def batch_sha256(batch: PublicationBatch) -> str:
    """The content hash of a batch: independent of key order, whitespace and omitted nulls."""
    return hashlib.sha256(canonical_json(batch.model_dump(mode="json"))).hexdigest()


def entity_sha256(entity_type: str, fields: Mapping[str, object]) -> str:
    """The content hash of one Annex A entity as published (plan D10)."""
    return hashlib.sha256(canonical_json({"entity": entity_type, "v": 1, **fields})).hexdigest()
