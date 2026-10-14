"""Canonical citation keys, identical to the TypeScript gate's (audit F19).

The application's gate reads a citation with ``normaliseCitation`` (services/d4-2/citations.ts)
and looks the resulting canonical key up in the corpus. The corpus must therefore store exactly
that key. This module builds it:

* ``build_canonical(parts)`` mirrors ``strictHits`` / ``keyed()`` in citations.ts for structured
  parts (reporter, year, court, series, page, note);
* ``parse_parts(text)`` reads one citation from text. It is a strict, ASCII-only subset of what
  the TypeScript extractor accepts (plan D24): ``canonical_key(raw)`` is either None or exactly
  ``normaliseCitation(raw)``, never a different key. A gap costs recall (the row is quarantined as
  citation_not_canonical), never correctness.

Courts are recognised by a literal port of the TypeScript court patterns (citations.ts:58-73), not
by the squashed alias map in vocabulary.py, which is broader ("Lahore-High-Court") and would key a
bracketed sub-series differently from TypeScript.

The golden fixture tests/fixtures/corpus/citation-canonical-golden.json, generated from the real
``normaliseCitation``, pins this module to the TypeScript keys
(corpus_service/tests/test_publication_citations.py).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, FrozenSet, Optional, Tuple


@dataclass(frozen=True)
class CitationParts:
    reporter: str  # canonical spelling, e.g. "PLD", "SCMR", "PCrLJ"
    year: str  # "(19|20)\d\d"
    page: str  # digits, kept as text (TypeScript keeps leading zeros)
    court: Optional[str] = None  # alias or canonical (PLD; PLJ/NLR/KLR court-first)
    series: Optional[str] = None  # bracket before the page
    note: Optional[str] = None  # bracket after the page


class CitationError(ValueError):
    """A citation that cannot be keyed. ``reason`` is a stable token; the message never carries
    the input."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


REPORTER_FIRST: Final[Tuple[str, ...]] = ("PLD", "PLJ", "NLR", "KLR")
YEAR_FIRST: Final[Tuple[str, ...]] = (
    "SCMR", "SCR", "PCrLJ", "PTCL", "PTD", "GBLR", "CLC", "CLD", "YLR", "MLD", "PLC", "PLJ", "NLR", "KLR",
)
CONTINUOUS: Final[FrozenSet[str]] = frozenset({"SCMR", "SCR", "CLC", "YLR", "MLD", "PCrLJ", "PTD", "PTCL", "CLD", "GBLR"})
SECTIONED: Final[FrozenSet[str]] = frozenset({"PLJ", "NLR", "KLR"})
NOTES: Final[FrozenSet[str]] = frozenset({"SUPRA", "IBID", "SIC", "EMPHASISSUPPLIED", "EMPHASISADDED"})
REPORTERS: Final[Tuple[str, ...]] = ("PLD", *YEAR_FIRST)
_REPORTER_BY_LETTERS: Final = {r.upper(): r for r in REPORTERS}


def _flex(abbrev: str) -> str:
    """citations.ts flex(): letters joined by up to two dots/blanks, '&' with optional blanks."""
    return "[.\\s]{0,2}".join("\\s?&\\s?" if ch == "&" else re.escape(ch) for ch in abbrev) + "\\.?"


# citations.ts COURTS, alternative for alternative.
_TS_COURTS: Final = (
    ("SC", (r"Supreme\s+Court(?:\s+of\s+Pakistan)?", _flex("SC"))),
    ("FSC", (r"Federal\s+Shariat\s+Court", _flex("FSC"))),
    ("Lahore", (r"Lahore(?:\s+High\s+Court)?", r"Lah\.?", _flex("LHC"))),
    ("Sindh", (r"Sindh(?:\s+High\s+Court)?", "Karachi", r"Kar\.?", _flex("SHC"))),
    ("Peshawar", (r"Peshawar(?:\s+High\s+Court)?", r"Pesh\.?", _flex("PHC"))),
    ("Quetta", (r"Balochistan(?:\s+High\s+Court)?", "Quetta", r"Bal\.?", _flex("BHC"))),
    ("Islamabad", (r"Islamabad(?:\s+High\s+Court)?", r"Isl\.?", _flex("IHC"))),
    ("AJ&K", (r"Azad\s+Jammu\s+(?:and|&)\s+Kashmir", r"Azad\s+J\s?&\s?K", _flex("AJ&K"), _flex("AJK"))),
    ("GB", (r"Gilgit[-\s]Baltistan", _flex("GB"))),
    ("Civil", ("Civil",)),
    ("Criminal", ("Criminal", r"Crl\.?")),
    ("Tax", ("Tax",)),
    ("Revenue", ("Revenue",)),
)
_COURT_MATCHERS: Final = tuple(
    (canonical, tuple(re.compile(f"(?:{alt})", re.IGNORECASE | re.ASCII) for alt in alts))
    for canonical, alts in _TS_COURTS
)


def ts_court(raw: object) -> Optional[str]:
    """citations.ts canonicalCourt() on ASCII input: the canonical court, or None."""
    if not isinstance(raw, str) or not raw.isascii():
        return None
    trimmed = raw.strip()
    for canonical, matchers in _COURT_MATCHERS:
        if any(m.fullmatch(trimmed) for m in matchers):
            return canonical
    return None


def _paren(raw: str) -> str:
    """citations.ts canonicalParen(): the court canonical, else the text without dots and blanks,
    upper-cased."""
    return ts_court(raw) or re.sub(r"[.\s]", "", raw, flags=re.ASCII).upper()


def _keyed(head: str, page: str, leading: Optional[str], trailing: Optional[str]) -> str:
    """citations.ts keyed(): "<head>(<sub-series>) <page>"; notes after the page are ignored."""
    tail = trailing if trailing and trailing not in NOTES else None
    if leading and tail and leading != tail:
        return f"{head}({leading}) {page} ({tail})"
    sub = leading if leading is not None else tail
    return f"{head}({sub}) {page}" if sub else f"{head} {page}"


_YEAR: Final = re.compile(r"(?:19|20)[0-9]{2}")
_PAGE: Final = re.compile(r"[0-9]{1,6}")
# A bracketed part: letters (at least one), dots, '&', '-', single inner spaces; no markup-like
# characters, digits or brackets. '&' may not start an entity-like run ("&amp", "&lt").
_BRACKET: Final = re.compile(r"(?=[^()]*[A-Za-z])[A-Za-z.&-]+(?: [A-Za-z.&-]+)*")
_ENTITY_LIKE: Final = re.compile(r"&[A-Za-z]{2,}")


def _bracket(value: Optional[str], field: str) -> Optional[str]:
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 30
        or not _BRACKET.fullmatch(value)
        or _ENTITY_LIKE.search(value)
    ):
        raise CitationError(f"invalid_{field}")
    return value


def build_canonical(parts: CitationParts) -> str:
    """The canonical key for structured parts. Raises CitationError (with a reason token)."""
    reporter, year, page = parts.reporter, parts.year, parts.page
    if not isinstance(reporter, str) or reporter not in REPORTERS:
        raise CitationError("unknown_reporter")
    if not isinstance(year, str) or not _YEAR.fullmatch(year):
        raise CitationError("invalid_year")
    if not isinstance(page, str) or not _PAGE.fullmatch(page):
        raise CitationError("invalid_page")
    series = _bracket(parts.series, "series")
    note = _bracket(parts.note, "note")
    court_raw = parts.court
    if court_raw is not None and (not isinstance(court_raw, str) or not court_raw.strip()):
        raise CitationError("invalid_court")
    if reporter == "PLD" or (reporter in SECTIONED and court_raw is not None):
        if court_raw is None:
            raise CitationError("court_required")
        court = ts_court(court_raw)
        if court is None:
            raise CitationError("unknown_court")
        return _keyed(
            f"{reporter} {year} {court}", page,
            _paren(series) if series else None, _paren(note) if note else None,
        )
    if court_raw is not None:
        raise CitationError("court_not_allowed")
    if reporter in CONTINUOUS:
        # A bracketed court is informational on a continuously paginated reporter; anything else
        # in brackets is a sub-series and stays in the key. A note after the page is dropped.
        leading = _paren(series) if series and ts_court(series) is None else None
        return _keyed(f"{year} {reporter}", page, leading, None)
    return _keyed(f"{year} {reporter}", page, _paren(series) if series else None, _paren(note) if note else None)


# ---- the strict parser ------------------------------------------------------------------------
# Single spaces only (a run of blanks can change how the TypeScript flex patterns read a court),
# printable ASCII only, the whole string is exactly one citation.
_PRINTABLE: Final = re.compile(r"[\x21-\x7e]+(?: [\x21-\x7e]+)*")
_REPORTER_TOKEN: Final = re.compile(r"(?:[A-Za-z]\.?)+")
_SEGMENT: Final = r"[A-Za-z.&-]+(?: [A-Za-z.&-]+)*"
_TAIL: Final = r"(?: ?\((?P<series>[^()]+)\))? (?P<page>[0-9]+)(?: \((?P<note>[^()]+)\))?"
_RE_REPORTER_FIRST: Final = re.compile(
    rf"(?P<rep>[A-Za-z.]+) (?P<year>(?:19|20)[0-9]{{2}}) (?P<court>{_SEGMENT}?){_TAIL}", re.ASCII
)
_RE_YEAR_FIRST: Final = re.compile(
    rf"(?P<year>(?:19|20)[0-9]{{2}}) (?P<rep>[A-Za-z.]+)(?: (?P<court>{_SEGMENT}?))?{_TAIL}", re.ASCII
)

# Court spellings the TypeScript suspect detectors can flag even inside a well-formed citation
# (an abbreviation one edit away from a reporter token, e.g. "PHC" ~ "PLC"). The parser does not
# accept them; such a row is quarantined as citation_not_canonical instead of risking a key the
# gate would read differently.
_REPORTER_LIKE_LETTERS: Final = tuple(r.upper() for r in ("SCMR", "PLD", "PLJ", "CLC", "YLR", "MLD", "PCrLJ", "PTD", "PTCL", "CLD", "PLC", "NLR", "KLR", "SCR", "GBLR"))


def _one_edit(a: str, b: str) -> bool:
    if abs(len(a) - len(b)) > 1:
        return False
    i = j = edits = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1
            j += 1
            continue
        edits += 1
        if edits > 1:
            return False
        if len(a) > len(b):
            i += 1
        elif len(a) < len(b):
            j += 1
        else:
            i += 1
            j += 1
    return edits + (len(a) - i) + (len(b) - j) <= 1


_CLEAN_TOKEN: Final = re.compile(r"^[(\[\"']+|[)\]\"',;:.]+$")


def _reporter_like(token: str) -> bool:
    """citations.ts editDistanceSuspects' token test, without its position test (so it refuses
    more, never less): an abbreviation-like token (two capitals, or a non-letter inside) of three
    or more characters, with no digit, within one edit of a reporter token but not one."""
    bare = _CLEAN_TOKEN.sub("", token)
    if len(bare) < 3 or re.search(r"[0-9]", bare):
        return False
    if len(re.findall(r"[A-Z]", bare)) < 2 and bare.isalpha():
        return False
    upper = bare.upper()
    if upper in _REPORTER_LIKE_LETTERS:
        return False
    return any(_one_edit(upper, r) for r in _REPORTER_LIKE_LETTERS)


def _reporter(token: str, allowed: Tuple[str, ...]) -> Optional[str]:
    if not _REPORTER_TOKEN.fullmatch(token):
        return None
    canonical = _REPORTER_BY_LETTERS.get(token.replace(".", "").upper())
    return canonical if canonical in allowed else None


def parse_parts(text: object) -> Optional[CitationParts]:
    """The parts of ``text`` when it is exactly one citation in a shape the TypeScript extractor
    reads the same way; otherwise None."""
    if not isinstance(text, str) or not text.isascii():
        return None
    stripped = text.strip()
    if not stripped or not _PRINTABLE.fullmatch(stripped):
        return None
    if any(_reporter_like(token) for token in stripped.split(" ")):
        return None
    for pattern, allowed in ((_RE_REPORTER_FIRST, REPORTER_FIRST), (_RE_YEAR_FIRST, YEAR_FIRST)):
        m = pattern.fullmatch(stripped)
        if not m:
            continue
        reporter = _reporter(m.group("rep"), allowed)
        if reporter is None:
            continue
        court = m.group("court")
        if court is not None:
            if ts_court(court) is None:
                continue
            if pattern is _RE_YEAR_FIRST and reporter not in SECTIONED:
                continue
        elif reporter == "PLD":
            continue
        parts = CitationParts(
            reporter=reporter, year=m.group("year"), page=m.group("page"),
            court=court, series=m.group("series"), note=m.group("note"),
        )
        try:
            build_canonical(parts)
        except CitationError:
            continue
        return parts
    return None


def canonical_key(text: object) -> Optional[str]:
    """build_canonical(parse_parts(text)), or None on any failure."""
    parts = parse_parts(text)
    if parts is None:
        return None
    try:
        return build_canonical(parts)
    except CitationError:
        return None


def is_canonical(text: object) -> bool:
    return isinstance(text, str) and canonical_key(text) == text
