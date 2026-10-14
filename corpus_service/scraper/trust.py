"""The corpus trust vocabulary and the publication decision (audit F20).

One module owns both, so the database CHECK, the column default, the migration, the harvest
dispatcher and promotion cannot drift apart again.

FINAL_CORPUS_SERVICE_PROMPT_2.md :252-253 fixes the vocabulary as ``trusted | review | blocked``
with default ``review``; :894-898 fixes the rule: only a ``trusted`` source with confidence >= 0.5
is auto-promoted, ``review`` is always quarantined, ``blocked`` is never harvested.

Everything here fails closed. A value outside the vocabulary (None, '', a pre-F20 legacy value such
as ``semi_trusted``, or a different spelling such as ``TRUSTED``) is *unknown*: it is never
promoted and never harvested. Matching is exact; case and whitespace are not normalised, because
a value the schema would not have accepted must not be read as an approval.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final, Optional, Tuple

TRUSTED: Final = "trusted"
REVIEW: Final = "review"
BLOCKED: Final = "blocked"

TRUST_LEVELS: Final[Tuple[str, ...]] = (TRUSTED, REVIEW, BLOCKED)
DEFAULT_TRUST_LEVEL: Final = REVIEW
PROMOTION_MIN_CONFIDENCE: Final = 0.5

# Durable quarantine reasons (QuarantineQueue.reason / ScraperStaging.quarantine_reason).
REASON_REVIEW_SOURCE: Final = "review_source"
REASON_LOW_CONFIDENCE: Final = "low_confidence"
REASON_BLOCKED_SOURCE: Final = "blocked_source"
REASON_UNKNOWN_SOURCE: Final = "unknown_source"
REASON_CITATION_MISSING: Final = "citation_missing"  # decided by promotion, before trust (F22)
QUARANTINE_REASONS: Final[Tuple[str, ...]] = (
    REASON_REVIEW_SOURCE,
    REASON_LOW_CONFIDENCE,
    REASON_BLOCKED_SOURCE,
    REASON_UNKNOWN_SOURCE,
    REASON_CITATION_MISSING,
)
# A promotable record whose citation is already published is not quarantined: it is attached to the
# existing row and skipped (FINAL_2 DEDUPLICATION; see scraper/tasks/promotion.py).
# A record whose promotion raised is quarantined as "promotion_error:<ExceptionClass>".
REASON_PROMOTION_ERROR_PREFIX: Final = "promotion_error:"


def promotion_error_reason(exc: BaseException) -> str:
    """The durable reason for a record whose promotion raised: the exception class only, never its
    message (which can carry row data)."""
    return f"{REASON_PROMOTION_ERROR_PREFIX}{type(exc).__name__}"

# The pre-F20 schema allowed these (models.py CHECK on main before this fix). None of them is an
# explicit approval, so the upgrade maps each to review.
LEGACY_TRUST_LEVELS: Final[Tuple[str, ...]] = ("semi_trusted", "untrusted", "quarantined")


@dataclass(frozen=True)
class PublicationDecision:
    promote: bool
    reason: Optional[str]


def _known(trust_raw: object) -> Optional[str]:
    """The trust level if it is exactly one of TRUST_LEVELS, else None."""
    if isinstance(trust_raw, str) and trust_raw in TRUST_LEVELS:
        return trust_raw
    return None


def _usable_confidence(confidence: object) -> Optional[float]:
    """A finite number in [0, 1], or None. bool is not a confidence."""
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        return None
    value = float(confidence)
    if not math.isfinite(value) or value < 0.0 or value > 1.0:
        return None
    return value


def publication_decision(trust_raw: Optional[str], confidence: Optional[float]) -> PublicationDecision:
    """Whether a staged record from a source with ``trust_raw`` may be auto-promoted.

    trusted, confidence >= 0.5   -> promote
    trusted, lower or unusable   -> quarantine "low_confidence"
    review                       -> quarantine "review_source"
    blocked                      -> quarantine "blocked_source"
    anything else (None, '', legacy, different case/whitespace, a missing or deleted source)
                                 -> quarantine "unknown_source"
    """
    level = _known(trust_raw)
    if level is None:
        return PublicationDecision(False, REASON_UNKNOWN_SOURCE)
    if level == BLOCKED:
        return PublicationDecision(False, REASON_BLOCKED_SOURCE)
    if level == REVIEW:
        return PublicationDecision(False, REASON_REVIEW_SOURCE)
    value = _usable_confidence(confidence)
    if value is None or value < PROMOTION_MIN_CONFIDENCE:
        return PublicationDecision(False, REASON_LOW_CONFIDENCE)
    return PublicationDecision(True, None)


def may_harvest(trust_raw: Optional[str]) -> bool:
    """Only trusted and review sources are harvested; blocked and anything unknown are not."""
    return _known(trust_raw) in (TRUSTED, REVIEW)


def may_publish_directly(trust_raw: Optional[str]) -> bool:
    """Whether a harvester that writes a master table itself (no staging, so no promotion decision)
    may run for this source. Only trusted: a review source's output must always be quarantined
    (FINAL_2 :897), and such a harvester has no quarantine step."""
    return _known(trust_raw) == TRUSTED


def normalise_legacy_trust(value: Optional[str]) -> str:
    """Map a stored value onto TRUST_LEVELS for the upgrade: current values are kept, every other
    value (the legacy semi_trusted/untrusted/quarantined, None, '', any other spelling) becomes
    review, never trusted."""
    level = _known(value)
    return level if level is not None else DEFAULT_TRUST_LEVEL


def _sql_literal_list(values: Tuple[str, ...]) -> str:
    for value in values:  # the vocabulary is fixed above; refuse anything that would need quoting
        if not value.replace("_", "").isalnum():
            raise ValueError(f"unexpected trust level literal {value!r}")
    return ",".join(f"'{value}'" for value in values)


def trust_values_sql() -> str:
    """``'trusted','review','blocked'`` for an IN list."""
    return _sql_literal_list(TRUST_LEVELS)


def trust_check_sql() -> str:
    """The scraper_sources CHECK expression, built from TRUST_LEVELS."""
    return f"trust_level IN ({trust_values_sql()})"
