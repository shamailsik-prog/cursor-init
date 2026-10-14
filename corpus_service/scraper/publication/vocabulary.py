"""The closed vocabularies of the Annex A publication (audit F19).

Defined once here; a database test checks them against the DDL CHECKs
(postgres/ddl/001_corpus_contract.sql and 003_corpus_publication.sql).

* Bench (001 judgment.bench_type, 003 treatment.treating_bench_type): single | division | full |
  larger. Aliases are matched on squashed input (lowercase; whitespace, dots and hyphens removed).
  Blank is *missing* (quarantined missing_bench, ruling 9); anything else unknown is *invalid*
  (rejected invalid_bench). "Full Court" and "single judge" are not aliases: ambiguous input fails
  closed (D21).
* Treatment kinds (001 treatment.treatment): input is trimmed and lowercased, nothing else.
* Jurisdictions (Annex A A.4): eight values, matched case-insensitively after trimming, with no
  aliases. ``PK`` is ambiguous and is refused (ruling 6, D20).
* Court canonicals mirror services/d4-2/citations.ts:58-73: Karachi is Sindh; Balochistan and
  Quetta are Quetta.

Every function returns None for anything outside its set; nothing is guessed.
"""

from __future__ import annotations

import re
from types import MappingProxyType
from typing import Final, Iterable, Mapping, Optional, Tuple

from scraper import trust

BENCH_TYPES: Final[Tuple[str, ...]] = ("single", "division", "full", "larger")
BENCH_ALIASES: Final[Mapping[str, str]] = MappingProxyType(
    {
        "single": "single", "singlebench": "single", "sb": "single",
        "division": "division", "divisionbench": "division", "db": "division",
        "full": "full", "fullbench": "full", "fb": "full",
        "larger": "larger", "largerbench": "larger", "lb": "larger",
    }
)

TREATMENT_KINDS: Final[Tuple[str, ...]] = (
    "followed", "applied", "distinguished", "doubted", "overruled", "per_incuriam", "referred",
)
TREATMENT_MIN_CONFIDENCE: Final = 0.7  # Annex B B-7

JURISDICTIONS: Final[Tuple[str, ...]] = ("Federal", "Sindh", "Punjab", "KP", "Balochistan", "ICT", "GB", "AJK")
STATUTE_STATUSES: Final[Tuple[str, ...]] = ("in_force", "repealed", "lapsed")
DEFAULT_STATUTE_STATUS: Final = "in_force"
EXTRACTION_METHODS: Final[Tuple[str, ...]] = ("html", "pdf", "ocr", "manual", "api", "export")  # 001 CHECK
CURRENT_TEXT_ONLY_CONFIDENCE: Final = 0.5  # Annex B B-5

COURT_CANONICALS: Final[Tuple[str, ...]] = (
    "SC", "FSC", "Lahore", "Sindh", "Peshawar", "Quetta", "Islamabad", "AJ&K", "GB",
    "Civil", "Criminal", "Tax", "Revenue",
)
_COURT_KEYS: Final = {
    "SC": ("sc", "supremecourt", "supremecourtofpakistan"),
    "FSC": ("fsc", "federalshariatcourt"),
    "Lahore": ("lahore", "lahorehighcourt", "lah", "lhc"),
    "Sindh": ("sindh", "sindhhighcourt", "karachi", "kar", "shc"),
    "Peshawar": ("peshawar", "peshawarhighcourt", "pesh", "phc"),
    "Quetta": ("balochistan", "balochistanhighcourt", "quetta", "bal", "bhc"),
    "Islamabad": ("islamabad", "islamabadhighcourt", "isl", "ihc"),
    "AJ&K": ("aj&k", "ajk", "azadjammuandkashmir", "azadjammu&kashmir", "azadj&k"),
    "GB": ("gb", "gilgitbaltistan"),
    "Civil": ("civil",),
    "Criminal": ("criminal", "crl"),
    "Tax": ("tax",),
    "Revenue": ("revenue",),
}
COURT_ALIASES: Final[Mapping[str, str]] = MappingProxyType(
    {key: canonical for canonical, keys in _COURT_KEYS.items() for key in keys}
)

# Durable publication reasons (quarantine_queue.reason and corpus_publication_item.reason).
REASON_PROVENANCE_INCOMPLETE: Final = "provenance_incomplete"
REASON_INVALID_BENCH: Final = "invalid_bench"
REASON_INVALID_TREATMENT_KIND: Final = "invalid_treatment_kind"
REASON_UNRESOLVABLE_JUDGMENT: Final = "unresolvable_judgment"
REASON_HISTORY_MISSING_EFFECTIVE_FROM: Final = "history_missing_effective_from"
REASON_HISTORY_OVERLAP: Final = "history_overlap"
REASON_HISTORY_OUT_OF_ORDER: Final = "history_out_of_order"
REASON_INVALID_HISTORY: Final = "invalid_history"
REASON_INVALID_JURISDICTION: Final = "invalid_jurisdiction"
REASON_INVALID_STATUTE_STATUS: Final = "invalid_statute_status"
REASON_CITATION_CONFLICT: Final = "citation_conflict"
REASON_CITATION_MISSING: Final = trust.REASON_CITATION_MISSING
REASON_PROMOTED_ROW_PROTECTED: Final = "promoted_row_protected"
REJECT_REASONS: Final[Tuple[str, ...]] = (
    REASON_PROVENANCE_INCOMPLETE, REASON_INVALID_BENCH, REASON_INVALID_TREATMENT_KIND,
    REASON_UNRESOLVABLE_JUDGMENT, REASON_HISTORY_MISSING_EFFECTIVE_FROM, REASON_HISTORY_OVERLAP,
    REASON_HISTORY_OUT_OF_ORDER, REASON_INVALID_HISTORY, REASON_INVALID_JURISDICTION,
    REASON_INVALID_STATUTE_STATUS, REASON_CITATION_CONFLICT, REASON_CITATION_MISSING,
    REASON_PROMOTED_ROW_PROTECTED,
)

REASON_MISSING_BENCH: Final = "missing_bench"
REASON_CITATION_NOT_CANONICAL: Final = "citation_not_canonical"
REASON_TREATMENT_UNCERTAIN: Final = "treatment_uncertain"
_TRUST_REASONS: Final[Tuple[str, ...]] = (
    trust.REASON_REVIEW_SOURCE, trust.REASON_LOW_CONFIDENCE, trust.REASON_BLOCKED_SOURCE, trust.REASON_UNKNOWN_SOURCE,
)
QUARANTINE_REASONS: Final[Tuple[str, ...]] = (
    REASON_MISSING_BENCH, REASON_CITATION_NOT_CANONICAL, REASON_TREATMENT_UNCERTAIN, *_TRUST_REASONS,
)
# When an item is quarantined for several reasons, the durable reason is the first of these: the
# trust decision, then the citation, then the bench, then the treatment confidence.
QUARANTINE_PRECEDENCE: Final[Tuple[str, ...]] = (
    *_TRUST_REASONS, REASON_CITATION_NOT_CANONICAL, REASON_MISSING_BENCH, REASON_TREATMENT_UNCERTAIN,
)

_SQUASH = re.compile(r"[\s.\-]+")


def squash(raw: str) -> str:
    """Lowercase, with whitespace, dots and hyphens removed."""
    return _SQUASH.sub("", raw).lower()


def bench_is_missing(raw: object) -> bool:
    """None, a non-string, or blank."""
    return not isinstance(raw, str) or not raw.strip()


def canonical_bench(raw: object) -> Optional[str]:
    if bench_is_missing(raw):
        return None
    return BENCH_ALIASES.get(squash(raw))  # type: ignore[arg-type]


def canonical_treatment(raw: object) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    value = raw.strip().lower()
    return value if value in TREATMENT_KINDS else None


_JURISDICTION_BY_FOLD: Final = {j.casefold(): j for j in JURISDICTIONS}


def canonical_jurisdiction(raw: object) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    return _JURISDICTION_BY_FOLD.get(raw.strip().casefold())


def canonical_statute_status(raw: object) -> Optional[str]:
    """None means the Annex A default, in_force. Anything outside the set is None (invalid)."""
    if raw is None:
        return DEFAULT_STATUTE_STATUS
    if not isinstance(raw, str):
        return None
    value = raw.strip().lower()
    return value if value in STATUTE_STATUSES else None


def canonical_court(raw: object) -> Optional[str]:
    if not isinstance(raw, str) or not raw.strip():
        return None
    return COURT_ALIASES.get(squash(raw))


def first_quarantine_reason(reasons: Iterable[str]) -> Optional[str]:
    """The reason that wins under QUARANTINE_PRECEDENCE, or None when there is none."""
    present = set(reasons)
    for reason in QUARANTINE_PRECEDENCE:
        if reason in present:
            return reason
    return None
