"""PakistanCode section identity (FA-F21-017).

Historical aliases FA-F21-006..016 were moved onto this finding from the PR #90 rounds.
They describe defects in keying attempts that did not land. At 0f911bfb the harvester
stored ``section_number`` as the first 20 characters of the div text. This module is
the locked rule for ``div.section`` identity. It does not fetch, and it does not write
a database.

Locked rule
-----------
Walk ``div.section`` texts in document order.

1. A div whose whole text is a schedule heading (``THE FIRST SCHEDULE``, ``SCHEDULE``,
   ``SCHEDULE II``, ``2ND SCHEDULE``, and the same shape) is a heading. Headings are
   recognised before the short-div test, so an 18-character heading is kept.
2. Length does not drop a real section (R-LENGTH-GATE). ``len`` is Unicode characters.

   * A numbered provision (``1. Short title.``, ``2. Repeal.``, ``1.``, a heading-only
     item) is kept even when it is 20 characters or fewer. Identity is rule 5. It is
     not merged into a neighbour. An ``unscoped`` short item is quarantined, not skipped.
   * A short numbered amendment footnote is noise (R-LENGTH-RESID-002,
     R-LENGTH-RESID-005). The ``by`` formula (``Subs. by``, ``Ins. by``, ``Added by``,
     ``Omitted by``, ``Rep. by``, ``Am. by``, and the unabbreviated verbs) is noise.
     So is a bare abbreviation whose whole body is ``Ins.``, ``Subs.``, ``Am.``,
     ``Amd.`` or ``Amdt.``, and an abbreviation followed by ``of`` (``Rep. of X.``,
     ``Ins. of``). ``2. Repeal.``, ``1. Omitted.`` and ``2. Rep.`` stay provisions
     for identity: the full word, and ``Rep.`` with nothing after it, are section
     text, not noise. ``1. Omitted.`` and ``2. Rep.`` are non-live placeholders
     (R-LENGTH-RESID-001). ``2. Repeal.`` is a section heading and stays live.
     A citation footnote of any length is the same noise (R-LENGTH-RESID-004).
     When the whole body after the number is only an omission, repeal
     or deletion placeholder, the key is unchanged and ``provision_status`` is
     ``omitted``, ``repealed`` or ``deleted``. Publish sets ``is_repealed``. The
     public statute list and ``lookup_real_section`` do not serve that row as
     current law. The row, the key, the number and the raw text stay. A longer
     section that only mentions those words stays live.
   * RESID-001-POLICY-001. ``1. Omitted.`` and a bare ``2. Rep.`` are non-live
     on purpose. They keep the section key and the number. They are not noise,
     and they are not served as current law. ``2. Repeal.`` stays live.
   * RESID-005-POLICY. A page that contains only these short footnotes stages no
     rows. The notes are noise, so the page is not quarantined and ``act_keys`` is
     omitted. An omitted set retires nothing.
   * RESID-004-POLICY. A citation footnote of any length is unstaged noise, the
     same as a short note. The whole body after the number, and nothing else, is
     ``Subs.`` / ``Ins.`` / ``Added`` / ``Omitted by`` / ``Rep. by`` /
     ``Renumbered`` / ``Re-numbered`` / ``Amended by`` / ``See``, then one or
     more Act, Ord., P.O. or Regulation citations joined by a comma or
     ``and``. ``and`` or a comma may also start another verb, so ``Subs.`` /
     ``Ins.`` / ``Omitted`` / ``Added`` / ``Rep.`` / ``Amended`` can mix on
     one line:
     ``Subs. by Act II of 2000, s. 2 and Ins. by Act III of 2001, s. 3``
     is one note, and so is
     ``Subs. by Act II of 2000, s. 2, Ins. by Act III of 2001, s. 3 and Omitted by Ord. IV of 2002, s. 5``.
     ``Renumbered as sub-section (1)`` and ``as clause (x)`` are the
     same lead. After the section reference the note may add ``for "..."``,
     ``for the words "..."``, or ``w.e.f.`` a date, including ``(w.e.f. ...)``.
     That date clause may sit on a unit that is not last:
     ``Subs. by Act II of 2000, s. 2, w.e.f. 1-7-2001 and Ins. by Act III of 2001, s. 3``
     is one note, as is
     ``Subs. by Act II of 2000, s. 2 (w.e.f. 1-7-2001)``.
     A title word such as
     ``Civil`` is not an instrument number. ``Substitution of section 5 and
     insertion of section 5A`` stays live.
     It takes no key (``N``, ``N-<sha8>``, ``schedule:L:N`` or ``~n``), it does
     not use the 50-div cap, and a page of only those notes is not quarantined
     and omits ``act_keys``. When a note and a real section share a number, the
     real section keeps that key whether the note is first or last.
     ``Substitution``, ``Insertion of`` and ``Amendment of section X.-``
     followed by operative text stay live. A RESID-001 placeholder that is not
     this citation note keeps its key. A placeholder that is this note keeps
     its key only when no real section has the number.
     ``Omitted by Act II of 2000, see s. 2`` is that placeholder: alone it
     keeps the key and is not current law, and beside a real section it is
     dropped so the real section keeps the bare key. Two non-live placeholders
     for one number, and no live section, are not two sections
     (RESID-004-SEE-002). A ``see s.`` omission and a Finance ``Omitted by``
     note share bare ``N``. The lexicographically earliest normalised text is
     the one that is kept, with status ``omitted``, ``repealed`` or
     ``deleted``. The other is dropped. Lookup does not serve that row as
     current law. A repeated non-footnote ``3. [Omitted.]`` is not this case
     and stays content-addressed. A citation placeholder
     still counts as a body div for schedule scope; dropping it on a collision
     does not close a scope it already opened.
   * A div whose letters are only ``omitted``, ``repealed``, ``repeal`` or ``rep``
     (``[Omitted]``, ``Rep.``, brackets or a trailing stop), and which is not itself a
     numbered provision, is not given a number. It is staged as ``short-ambiguous``
     and quarantined as ``ambiguous_section_identity``. The page omits ``act_keys``.
   * Any other div of 20 characters or fewer is noise: blank divs, page chrome, stray
     markers, a repeated letter, a failed heading such as ``Schedule ll``. Noise is
     skipped, not staged, and it does not consume the 50-div cap.
   * A div of 21 characters is content, as before.
3. At most 50 kept divs are staged, in document order. Further kept divs are dropped by
   the cap.
4. Schedule scope (FA-F21-018). The live PakistanCode document was not fetched: the
   site certificate chain did not verify, and this repository has no saved page. A flat
   sibling heading is therefore not treated as a container.

   * A heading that follows a body section opens schedule scope for later flat siblings.
     Scope stays open. It is not closed because a later div looks like a body section.
   * A heading that appears before any body section does not open scope. Later numbered
     flat siblings are ``unscoped``, not body ``N`` and not ``schedule:L:N``.
   * A div whose ancestor (not a previous ``div.section`` sibling, and not a wrapper
     whose other children are only section divs) is itself a schedule heading is a
     schedule item under that label, including when no body section precedes it.

   Preamble and Explanation label that div only. A numberless div that merely starts
   with a structural word (``Table of rates``, ``The form of``) does not open schedule
   scope and does not rename later sections.
5. Keys, all deterministic, none positional, none a uuid:

   * unique body section number ``N`` → ``N`` (stable when the text is amended).
     A letter inserted by amendment is part of that number (R-LENGTH-RESID-003).
     ``12A`` and ``12-A`` are ``12A``. ``12AA`` and ``12-AA`` are ``12AA``.
     An en dash or em dash is the same mark as the hyphen. ``12-15`` and
     ``1-7-2001`` keep the bare number the hyphen already delimited. They are
     not letter suffixes. ``Act No. XII-A`` is not a section number.
     A space then a capital is not by itself a heading (RESID-003-CAP-001).
     ``12-A Title`` and ``12-A Inserted rates.`` are headings when a short
     title ends in a period or a dash, or when the number sits with its
     neighbours: the previous body section, if there is one, has the same
     base, and the next body section, if there is one, is that base or the
     next integer. A space-form heading already accepted is itself a body
     neighbour, so ``12-B`` after ``12-A`` and before 13 stays ``12B``, and a
     refused wrap joins that heading rather than an earlier section. An
     amendment footnote is not a neighbour. The search stops at a schedule
     heading: a schedule item is not the next body section, and a space-form
     inside that schedule is left for schedule identity. ``12-A`` after 12
     and before 13 is ``12A``. A wrapped body line ``12-I Pakistan`` or
     ``12-I The Federal Government`` inside section 11 stays in section 11.
     A refused line with no body section before it is not published as that
     suffix. ``12-A.`` and ``12-I.`` keep the punctuated form.
   * repeated body number ``N`` → ``N-<sha8>`` of the stored text
   * schedule item ``N`` under label ``L`` → ``schedule:L:N`` (or with ``-<sha8>`` when
     that schedule repeats ``N``)
   * schedule heading → ``schedule-heading:L``
   * numbered div under an unopened flat heading → ``unscoped:N-<sha8>``
   * bare omission marker → ``ambiguous-<sha8>`` (quarantined, never a guessed ``N``)
   * preamble / explanation / other numberless div → ``<kind>-<sha8>``
   * a second kept div that would otherwise reuse a key → ``<key>~2``, ``~3``, …

   ``<sha8>`` is the first 8 hex characters of SHA-256 of the stored text (capped at
   20_000 characters). Sibling insert, reorder, or deletion of a *different* text does
   not change these keys. Amending a unique numbered section keeps ``N`` and records
   another version. Amending a content-addressed div changes that div's key only.

6. Lookup by a real section number is equality on the unique body key ``N``. A schedule
   item is not that key. An ``unscoped`` div is not that key. A retired key is not returned.
   The suffix letter is folded to capitals at lookup (LOOKUP-003-001), so ``12a``,
   ``12A``, ``12-a`` and ``12-A`` name one row. A glued ``12a.`` is still stored as
   ``12a``. Lookup does not rewrite a row. Two live rows that differ only by that
   case are a tie and are not served.
7. FA-17 publishes a schedule item under the key in rule 5. The parent is the label
   already on that item: an ancestor whose own text is a schedule heading, or a flat
   heading that follows a body section. ``schedule:L:N`` is never a body key ``N`` or
   ``N-<sha8>``. A repeated item number inside one schedule uses ``-<sha8>``. An
   identical second copy uses ``~2``, ``~3``, …. Separate items stay separate rows.
   An ``unscoped`` div has no proven parent and is not published. A page that kept one
   omits ``act_keys``. ``schedule-heading`` remains the div text and may be published.
   This is not a claim about the live document order: no captured page is in this
   repository, and the live certificate chain was not re-checked for this finding.
8. An empty live key set never retires existing rows. The key being published is never
   retired by its own harvest set. A live set made only of schedule keys
   (``schedule:`` and ``schedule-heading:``) does not retire any other key. A page
   that kept a schedule heading or schedule item and also dropped divs at the 50-div
   cap omits ``act_keys``, so the dropped tail is not retired.
9. Schedule label ``L`` is canonical when the heading is unambiguous (R-LABEL-001),
   and a single letter ``I``/``V``/``X``/``L`` is not (R-LETTER-ROMAN-001). Ordinal
   words through twentieth, a multi-character roman numeral, an arabic numeral, and
   ``Schedule No. 1`` are one arabic string. ``THE FIRST SCHEDULE`` and ``Schedule 1``
   are ``1``. ``SCHEDULE II`` is ``2``. OCR repair of ``l``/``I``/``1`` and ``O``/``0``
   runs only on a heading token that already contains a digit (``l0`` is ``10``).
   A lone ``C``, ``D`` or ``M`` is a letter, not 100, 500 or 1000. ``Schedule A`` and
   ``Tariff Schedule`` are stable slugs (``a``, ``tariff``) and are not numbers.
   ``Schedule ll``, ``Schedule 0``, ``Schedule lO`` and a heading that names two
   different numbers are not headings.

   A lone ``I``, ``V``, ``X`` or ``L`` is ambiguous. It becomes a roman value
   (1, 5, 10, 50) only when the same page's sibling headings prove a roman
   sequence: a multi-character roman is present and no unambiguous letter is.
   It stays a letter slug when an unambiguous letter is present and no
   multi-character roman is. Mixed evidence, or no evidence either way, does not
   pick a label. Those headings and the items under them are
   ``schedule-unresolved``. They are quarantined as
   ``schedule_letter_roman_ambiguous`` and the page omits ``act_keys``. A lone
   ``L`` is never the First Schedule.

   Compatibility is lookup aliasing, not a live rekey. A stored ``schedule:first:*``
   row is the same row as ``schedule:1:*``. Publish attaches to that row and leaves
   its ``section_number`` as stored. It does not insert a second row and does not
   retire the old key. A stored ``schedule:i:*``, ``schedule:v:*``, ``schedule:x:*``
   or ``schedule:l:*`` row is not that numeric row unless this harvest's sibling
   proof is roman, and even then ``L`` is 50, not 1. Two stored rows that already
   share one canonical identity are not merged and are not retired; that publish
   is refused. No migration rewrites a database. Equality on the raw stored key
   does not follow an alias.

The paragraph splitter is outside this div walk (FA-F21-019). It uses the same
three-way test at its ``< 15`` and ``< 20`` gates: a short numbered provision is kept,
a short numbered amendment footnote is rejected with the other noise, a citation
footnote of any length is rejected the same way (R-LENGTH-RESID-004), a bare omission
marker is its own ``short-ambiguous`` item and is not swallowed into the previous
section, and other noise under those gates is still rejected. A numbered placeholder
keeps its number and receives the same ``provision_status`` as a div, unless that
placeholder is a citation footnote sharing its number with a real section, in which
case the real section keeps the number. A repeated
paragraph number is kept as ``N-<sha8>`` of each stored text, not dropped. That
harvest stamps ``act_keys`` when it parsed those sections. It omits the set for an
``unscoped`` div, a ``short-ambiguous`` div, a page of only schedule headings, and an
unparsed single chunk. A ``schedule-item`` does not reach that path: kept schedule
items suppress the splitter and are staged on the div path, which includes them in
``act_keys`` when the inventory is complete.
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

# Noise at or below this length is not staged and does not consume the cap.
# A numbered provision or a bare omission marker is not noise (R-LENGTH-GATE).
# A div of 21 characters is content. FA-F21-010 / FA-F21-011.
SHORT_DIV_MAX_EXCLUSIVE = 20
MAX_STAGED_DIVS = 50
TEXT_CAP = 20000
LEGACY_PREFIX_CHARS = 20
SHA_CHARS = 8
PAKISTANCODE_SOURCE = "PakistanCode"
MAX_SECTION_KEY_CHARS = 100

_ORDINAL_WORDS = {
    "first": "1",
    "second": "2",
    "third": "3",
    "fourth": "4",
    "fifth": "5",
    "sixth": "6",
    "seventh": "7",
    "eighth": "8",
    "ninth": "9",
    "tenth": "10",
    "eleventh": "11",
    "twelfth": "12",
    "thirteenth": "13",
    "fourteenth": "14",
    "fifteenth": "15",
    "sixteenth": "16",
    "seventeenth": "17",
    "eighteenth": "18",
    "nineteenth": "19",
    "twentieth": "20",
}
# Strict roman of at least two characters. A lone I, V, X or L is ambiguous.
_ROMAN_RE = re.compile(
    r"^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$",
    re.IGNORECASE,
)
_ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
_BARE_SCHEDULE = re.compile(r"^(?:the\s+)?schedule$", re.IGNORECASE)
_LEAD_SCHEDULE = re.compile(r"^(?:the\s+)?(?P<tok>\S+)\s+schedule$", re.IGNORECASE)
_TRAIL_NO_SCHEDULE = re.compile(r"^(?:the\s+)?schedule\s+no\.?\s*(?P<tok>\S+)$", re.IGNORECASE)
_TRAIL_SCHEDULE = re.compile(r"^(?:the\s+)?schedule\s+(?P<tok>\S+)$", re.IGNORECASE)
_NAMED_SCHEDULE = re.compile(
    r"^(?:the\s+)?(?P<name>[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})\s+schedule$",
    re.IGNORECASE,
)
_SCHEDULE_COPY = re.compile(r"~\d+$")
# Item numbers keep a glued or hyphen-canonical letter suffix (``12A``, ``12AA``).
_SCHEDULE_ITEM_BODY = re.compile(
    r"^(?P<label>.+):(?P<item>\d+[A-Za-z]{0,4}(?:-[0-9a-f]{8})?)$"
)
# R-LENGTH-RESID-003. The stored key is the glued form ``12A`` already used for
# ``12A.``. A hyphen, en dash or em dash plus the same kind of suffix is that
# key: one letter (``12-A``, ``12-a``) or the same capital two to four times
# (``12-AA``). Hyphen letters are upper-cased, so ``12-a`` is ``12A``. A glued
# ``12a.`` stays ``12a``: that token was already stored in its own case.
# A heading word (``12-Fees``, ``12-Tax``) and an amendment lead (``12-Ins.``)
# stay behind the hyphen, which remains the delimiter. A digit after the hyphen
# is still a range or a date (``12-15``, ``1-7-2001``). A space-terminated
# suffix matches here when a capital follows (``12-A Title``) or the text ends.
# ``12-I shall`` and ``12-A of the`` are prose, not headings. A capital is not
# enough to publish the number (RESID-003-CAP-001): ``space_hyphen_heading_ok``
# keeps a wrapped ``12-I Pakistan`` inside the section that already holds it.
# One glued letter matches the old token. Repeated capitals are listed before
# that single letter so ``12AA`` is not read as ``12A`` when the trailing
# punctuation may be empty. ``(?-i:...)`` stays capitals under IGNORECASE.
# No nested quantifier.
_SECTION_PUNCT = r"[\.\)\:\u2013\u2014\-]"
# The same capital two to four times (``AA``, not ``AB`` or ``ST``). No
# capturing group: callers put this token in group 1 and read group 2 as the rest.
_REPEATED_CAPITAL = "(?-i:" + "|".join(f"{letter}{{2,4}}" for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ") + ")"
_GLUED_SUFFIX = "(?:" + _REPEATED_CAPITAL + r"|[A-Za-z])"
# Dash plus one letter, or the same capital repeated. Not an English word.
HYPHEN_LETTER_SUFFIX = r"[\u2013\u2014-]" + _GLUED_SUFFIX
# Punctuation, a capitalised title, or the end of the text. Not a lowercase word.
_SUFFIX_BOUNDARY = r"(?=[\.\)\:\u2013\u2014\-\]]|\s+(?-i:[A-Z])|\s*$)"
# Space or end only. The punctuated form is the other branch of the splitter.
HYPHEN_SUFFIX_SPACE_OR_END = r"(?=\s+(?-i:[A-Z])|\s*$)"
# After a hyphen this is prose (``I shall``, ``A of``), so the hyphen is not a
# section delimiter and the letter is not a suffix. Bounded; no nested repeat.
PROSE_HYPHEN_CONTINUATION = r"(?-i:(?:[A-Z]{2,4}|[A-Za-z])\s+[a-z])"
SECTION_NUMBER_TOKEN = (
    r"\d+(?:" + HYPHEN_LETTER_SUFFIX + _SUFFIX_BOUNDARY + r"|" + _GLUED_SUFFIX + r")?"
)
_NUMBER_RE = re.compile(
    r"^(?:(?:section|sec\.|s\.|article|art\.)\s+)?"
    r"(?P<digits>\d+)"
    r"(?:"
    r"(?P<glued>[A-Za-z])(?P<punct_glued>" + _SECTION_PUNCT + r")"
    r"|(?P<glued_many>(?-i:(?P<rep>[A-Z])(?P=rep){1,3}))(?P<punct_many>" + _SECTION_PUNCT + r")"
    r"|(?P<dash>[\u2013\u2014\-])(?:"
    r"(?P<letters_many>" + _REPEATED_CAPITAL + r")"
    r"|(?P<letters>[A-Za-z])"
    r")"
    r"(?:(?P<punct_letters>" + _SECTION_PUNCT + r")"
    r"|(?=\s+(?-i:[A-Z]))"
    r"|(?=\s*$))"
    r"|(?P<punct_bare>" + _SECTION_PUNCT + r")(?!" + PROSE_HYPHEN_CONTINUATION + r")"
    r")"
    r"\s*",
    re.IGNORECASE,
)
_CANONICAL_HYPHEN_SUFFIX = re.compile(
    r"^(\d+)[\u2013\u2014-](" + _REPEATED_CAPITAL + r"|[A-Za-z])$"
)
# Marginal amendment notes of at most 20 characters (R-LENGTH-RESID-002 / 005).
# ``2. Repeal.``, ``1. Omitted.`` and ``2. Rep.`` do not match: those are provisions
# for identity (R-LENGTH-RESID-001). ``1. Omitted.`` and ``2. Rep.`` are non-live
# placeholders; ``2. Repeal.`` stays live. The ``by`` formula is R-LENGTH-RESID-002.
# A bare abbreviation (``Ins.``, ``Subs.``, ``Am.``, ``Amd.``, ``Amdt.``) and an
# abbreviation followed by ``of`` (``Rep. of X.``) are R-LENGTH-RESID-005. Bare
# ``Rep.`` is not in that list. A citation footnote of any length is
# ``_LONG_FOOTNOTE_LEAD`` (R-LENGTH-RESID-004), not this short pattern.
_AMENDMENT_NOTE_RE = re.compile(
    r"^(?:subs(?:tituted)?|ins(?:erted)?|added|omitted|rep(?:ealed)?|am(?:ended)?)\.?\s+by\b",
    re.IGNORECASE,
)
_BARE_AMENDMENT_ABBREV_RE = re.compile(
    r"^[\[\(]*\s*(?:ins|subs|amdt|amd|am)\.?\s*[\]\)]*$",
    re.IGNORECASE,
)
_AMENDMENT_OF_RE = re.compile(
    r"^[\[\(]*\s*(?:ins|subs|rep|amdt|amd|am)\.?\s*[\]\)]*\s+of\b",
    re.IGNORECASE,
)
_STRUCTURAL_KIND = re.compile(r"^(preamble|explanation)\b", re.IGNORECASE)
_WS = re.compile(r"\s+")
# Single letters that are both a roman numeral and a schedule letter. C, D and M
# are letters only: a one-character roman is not read from them.
_AMBIGUOUS_SINGLE = frozenset({"i", "v", "x", "l"})
_ROMAN_SINGLE_VALUE = {"i": "1", "v": "5", "x": "10", "l": "50"}
# Whole-div omission markers. The letters, and nothing else, decide. A numbered
# provision is classified first, so ``2. Repeal.`` is section 2 and not a marker.
_OMISSION_WORDS = frozenset({"omitted", "repealed", "repeal", "rep"})
_LETTERS = re.compile(r"[^A-Za-z]+")
# R-LENGTH-RESID-001. The whole body after the number is a placeholder, or it is live.
# ``is_repealed`` on the master row is the existing live-law flag. These values say which
# placeholder it was. A bare unnumbered marker is not decided here.
NON_LIVE_PROVISION_STATUSES = frozenset({"omitted", "repealed", "deleted"})
_OPERATIVE_CLAUSE = re.compile(
    r"\b(?:hereby|shall|deemed|provided|whereas|notwithstanding)\b",
    re.IGNORECASE,
)
# Three or more asterisks, spaces allowed, optional brackets and a trailing stop.
_STAR_PLACEHOLDER_RE = re.compile(
    r"^(?:[\[\(]\s*)?(?:\*(?:\s+|(?=\*))){2,}\*(?:\s*[\]\)\.])*\s*$"
)
_STATUS_PLACEHOLDER_RE = re.compile(
    r"""
    ^
    (?:[\[\(]\s*)?
    (?:(?:\d{1,3}|[*†‡])\s*)?
    (?:[\[\(]\s*)?
    (?P<word>omitted|omit|repealed|deleted|rep\.)
    \.?
    (?:
        \s+(?P<rel>by|of)\b
        (?P<tail>.*)?
    )?
    \s*
    (?:[\]\)]\s*){0,3}
    \.?
    \s*
    $
    """,
    re.IGNORECASE | re.VERBOSE | re.DOTALL,
)
# A letter the number pattern left in the body (``12. A. [Omitted.]``). A
# hyphenated suffix is already in the key (R-LENGTH-RESID-003), so this does
# not see ``12-A``.
_LETTER_SUFFIX_RE = re.compile(
    r"^[A-Za-z][\.\)\:\-\u2013\u2014]\s*(?P<rest>\S.*)$"
)
_CITATION_ABBREV = frozenset({
    "ord", "s", "ss", "sec", "sch", "sched", "no", "nos", "art", "arts",
    "cl", "cls", "pt", "para", "paras", "vol", "ch", "chap", "sub", "subs",
    "ins", "am", "amd", "p", "pp",
})


def normalise_div_text(text: str) -> str:
    """The div text the key is computed from: collapsed whitespace, then the storage cap."""
    collapsed = _WS.sub(" ", text or "").strip()
    return collapsed[:TEXT_CAP]


def content_token(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:SHA_CHARS]


def _roman_to_int(token: str) -> Optional[int]:
    if not token or len(token) < 2 or not _ROMAN_RE.fullmatch(token):
        return None
    total = 0
    prev = 0
    for char in reversed(token.upper()):
        value = _ROMAN_VALUES[char]
        if value < prev:
            total -= value
        else:
            total += value
            prev = value
    if total < 1:
        return None
    return total


def canonical_ordinal(token: str) -> Optional[str]:
    """Arabic schedule number for one unambiguous heading token, or None.

    OCR repair runs only here, and only when the token is already a heading token
    that contains a digit. A lone ``I``, ``V``, ``X`` or ``L`` is not a number:
    the act's sibling headings decide that. A longer valid roman numeral is not
    rewritten character by character, so ``ii`` is 2 and not 11.
    """
    word = (token or "").strip().lower()
    if not word:
        return None
    spelled = _ORDINAL_WORDS.get(word)
    if spelled is not None:
        return spelled
    suffix = re.fullmatch(r"([0-9]+)(?:st|nd|rd|th)", word)
    if suffix is not None:
        digits = suffix.group(1)
        if len(digits) > 1 and digits.startswith("0"):
            return None
        number = int(digits)
        if number < 1:
            return None
        return str(number)
    if re.fullmatch(r"[0-9]+", word):
        if len(word) > 1 and word.startswith("0"):
            return None
        number = int(word)
        if number < 1:
            return None
        return str(number)
    if re.fullmatch(r"[0-9lio]+", word) and re.search(r"[0-9]", word):
        repaired = word.replace("l", "1").replace("i", "1").replace("o", "0")
        if re.fullmatch(r"[1-9][0-9]*", repaired):
            return repaired
        return None
    if len(word) < 2:
        return None
    roman = _roman_to_int(word)
    if roman is None:
        return None
    return str(roman)


def _schedule_slug(name: str) -> Optional[str]:
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
    if not slug or slug == "schedule" or re.fullmatch(r"[0-9]+", slug):
        return None
    if canonical_ordinal(slug) is not None:
        return None
    if len(slug) > 60:
        return None
    return slug


def canonical_schedule_label(label: Optional[str], *, mode: Optional[str] = None) -> Optional[str]:
    """The label stored in a new key. Numbered surface forms collapse; names do not.

    ``mode="roman"`` is the only way a stored single letter ``i``/``v``/``x``/``l``
    becomes a roman value, and ``l`` becomes ``50``. Any other mode leaves the letter.
    """
    if label is None:
        return None
    text = str(label).strip()
    if not text:
        return None
    number = canonical_ordinal(text)
    if number is not None:
        return number
    word = text.lower()
    if word in _AMBIGUOUS_SINGLE:
        if mode == "roman":
            return _ROMAN_SINGLE_VALUE[word]
        return word
    if word == "schedule":
        return "schedule"
    slug = _schedule_slug(text)
    if slug is not None:
        return slug
    return word


@dataclass(frozen=True)
class _HeadingToken:
    """One schedule heading token before act-level resolution."""

    kind: str
    value: str
    raw: str


def classify_heading_token(token: str) -> Optional[_HeadingToken]:
    """Class of one heading token. A single ``I``/``V``/``X``/``L`` stays ambiguous."""
    word = (token or "").strip().lower()
    if not word:
        return None
    spelled = _ORDINAL_WORDS.get(word)
    if spelled is not None:
        return _HeadingToken("number", spelled, word)
    number = canonical_ordinal(word)
    if number is not None and len(word) >= 2 and _roman_to_int(word) is not None:
        return _HeadingToken("roman_multi", number, word)
    if number is not None:
        return _HeadingToken("number", number, word)
    if len(word) == 1 and word in _AMBIGUOUS_SINGLE:
        return _HeadingToken("ambiguous", word, word)
    if len(word) == 1 and word.isalpha():
        return _HeadingToken("letter", word, word)
    return None


def parse_schedule_heading(text: str) -> Optional[_HeadingToken]:
    """The heading token when ``text`` is only a schedule heading, else None.

    An ambiguous single letter is still a heading. It is not yet a label.
    """
    cleaned = _WS.sub(" ", text or "").strip().rstrip(".").strip()
    if not cleaned:
        return None
    if _BARE_SCHEDULE.fullmatch(cleaned):
        return _HeadingToken("bare", "schedule", "schedule")
    lead = _LEAD_SCHEDULE.fullmatch(cleaned)
    if lead is not None:
        token = classify_heading_token(lead.group("tok"))
        if token is not None:
            return token
    trail_no = _TRAIL_NO_SCHEDULE.fullmatch(cleaned)
    if trail_no is not None:
        token = classify_heading_token(trail_no.group("tok"))
        if token is not None and token.kind in ("number", "roman_multi", "ambiguous"):
            return token
        return None
    trail = _TRAIL_SCHEDULE.fullmatch(cleaned)
    if trail is not None:
        token = classify_heading_token(trail.group("tok"))
        if token is not None:
            return token
        return None
    named = _NAMED_SCHEDULE.fullmatch(cleaned)
    if named is not None:
        name = named.group("name")
        tokens = name.split()
        if any(classify_heading_token(token) is not None for token in tokens):
            return None
        if any(re.fullmatch(r"[lio]+", token, re.IGNORECASE) for token in tokens):
            return None
        slug = _schedule_slug(name)
        if slug is None:
            return None
        return _HeadingToken("name", slug, slug)
    return None


def schedule_evidence_mode(tokens: Sequence[_HeadingToken]) -> str:
    """How sibling headings resolve an ambiguous single letter.

    ``roman``: a multi-character roman is present and no unambiguous letter is.
    ``letter``: an unambiguous letter is present and no multi-character roman is.
    ``mixed``: both of those are present. ``insufficient``: an ambiguous letter
    has neither. ``plain``: nothing ambiguous needs a decision.
    """
    roman = any(token.kind == "roman_multi" for token in tokens)
    letter = any(token.kind == "letter" for token in tokens)
    ambiguous = any(token.kind == "ambiguous" for token in tokens)
    if roman and letter:
        return "mixed"
    if roman:
        return "roman"
    if letter:
        return "letter"
    if ambiguous:
        return "insufficient"
    return "plain"


def schedule_label(text: str) -> Optional[str]:
    """The schedule label when ``text`` is an unambiguous heading, else None.

    The whole div must be the heading. A lone ``I``, ``V``, ``X`` or ``L`` is not
    given a number or a letter slug here: that needs the sibling headings.
    """
    parsed = parse_schedule_heading(text)
    if parsed is None or parsed.kind == "ambiguous":
        return None
    return parsed.value


def schedule_key_identity(key: str, *, mode: Optional[str] = None) -> str:
    """Canonical identity of a schedule key. Other keys are returned unchanged.

    ``schedule:first:1`` and ``schedule:1:1`` share an identity. ``schedule:ii:1``
    shares ``schedule:2:1``. A stored ``schedule:i:*``, ``schedule:v:*``,
    ``schedule:x:*`` or ``schedule:l:*`` stays on that letter unless ``mode`` is
    ``roman``, and ``schedule:l:*`` then shares ``schedule:50:*``, not the First
    Schedule. The item suffix, including ``-<sha8>`` and ``~n``, stays. Applying
    this twice is a no-op.
    """
    if not isinstance(key, str) or not key.startswith(("schedule:", "schedule-heading:")):
        return key
    copy = ""
    body = key
    copied = _SCHEDULE_COPY.search(body)
    if copied is not None:
        copy = copied.group(0)
        body = body[:copied.start()]
    fold = mode if mode == "roman" else None
    if body.startswith("schedule-heading:"):
        label = body[len("schedule-heading:"):]
        if not label or ":" in label:
            return key
        canonical = canonical_schedule_label(label, mode=fold)
        if not canonical:
            return key
        return f"schedule-heading:{canonical}{copy}"
    matched = _SCHEDULE_ITEM_BODY.fullmatch(body[len("schedule:"):])
    if matched is None:
        return key
    canonical = canonical_schedule_label(matched.group("label"), mode=fold)
    if not canonical:
        return key
    return f"schedule:{canonical}:{matched.group('item')}{copy}"


def _is_section_div(node) -> bool:
    if getattr(node, "name", None) != "div" or not hasattr(node, "get"):
        return False
    classes = node.get("class")
    if not classes:
        return False
    if isinstance(classes, str):
        classes = [classes]
    return any(re.search(r"section", str(item), re.IGNORECASE) for item in classes)


def _node_contains(child, node) -> bool:
    if child is node:
        return True
    descendants = getattr(child, "descendants", None)
    return descendants is not None and node in descendants


def schedule_container_label(node) -> Optional[str]:
    """Schedule label when an ancestor, apart from other section divs, is a heading.

    A previous ``div.section`` sibling is not this signal. A wrapper whose other children
    are only section divs is not a container either, so a flat list stays flat. The public
    site was not used to invent that shape: its certificate chain did not verify.
    """
    parents = getattr(node, "parents", None)
    if parents is None:
        return None
    for ancestor in parents:
        name = getattr(ancestor, "name", None)
        if name in (None, "[document]", "html", "body"):
            break
        parts = []
        holds_node = False
        for child in list(getattr(ancestor, "children", ())):
            if _node_contains(child, node):
                holds_node = True
                continue
            if _is_section_div(child):
                continue
            if hasattr(child, "get_text"):
                text = child.get_text(" ", strip=True)
            else:
                text = str(child).strip()
            if text:
                parts.append(text)
        if not holds_node:
            continue
        parsed = parse_schedule_heading(" ".join(parts))
        if parsed is not None and parsed.kind != "ambiguous":
            return parsed.value
    return None


def schedule_container_token(node) -> Optional[str]:
    """Raw heading token of an ancestor, before sibling headings resolve it.

    ``SCHEDULE I`` stays ``i`` and ``SCHEDULE II`` stays ``ii``, so a later pass
    can still tell a letter from a roman numeral. The resolved label is
    ``schedule_container_label``.
    """
    parents = getattr(node, "parents", None)
    if parents is None:
        return None
    for ancestor in parents:
        name = getattr(ancestor, "name", None)
        if name in (None, "[document]", "html", "body"):
            break
        parts = []
        holds_node = False
        for child in list(getattr(ancestor, "children", ())):
            if _node_contains(child, node):
                holds_node = True
                continue
            if _is_section_div(child):
                continue
            if hasattr(child, "get_text"):
                text = child.get_text(" ", strip=True)
            else:
                text = str(child).strip()
            if text:
                parts.append(text)
        if not holds_node:
            continue
        parsed = parse_schedule_heading(" ".join(parts))
        if parsed is not None:
            return parsed.raw
    return None


def canonical_section_number(token: str) -> str:
    """Glued key for a hyphenated letter suffix. Any other token is unchanged.

    ``12-A``, ``12-a`` and ``12–A`` are ``12A``, the key ``12A.`` already produced.
    ``12-AA`` is ``12AA``. ``12``, ``12A``, ``12a``, ``12-15`` and ``12-Fees`` are
    unchanged. Glued ``12a`` keeps its case because that key was already stored.
    """
    matched = _CANONICAL_HYPHEN_SUFFIX.fullmatch(token or "")
    if matched is None:
        return token
    return matched.group(1) + matched.group(2).upper()


def parse_section_number(text: str) -> Optional[str]:
    """The section or item number at the start of ``text``, without the punctuation.

    ``12A.`` and ``12-A.`` and ``12-a.`` are ``12A``. ``12AA.`` and ``12-AA.`` are
    ``12AA``. ``Article 12AA.`` is ``12AA``. A glued ``12a.`` stays ``12a``.
    A hyphen before a digit is the delimiter it already was. ``12-I shall`` and
    ``12-A of`` are not section numbers. A space then a capital is still a
    number here. ``space_hyphen_heading_ok`` decides whether that number is a
    heading once the neighbouring sections are known (RESID-003-CAP-001).
    """
    matched = _NUMBER_RE.match(text or "")
    if matched is None:
        return None
    letters = (
        matched.group("glued")
        or matched.group("glued_many")
        or matched.group("letters_many")
        or matched.group("letters")
    )
    if letters and matched.group("dash"):
        letters = letters.upper()
    if letters:
        return matched.group("digits") + letters
    return matched.group("digits")


# RESID-003-CAP-001. The number pattern still sees ``12-A Title``. Publishing
# that number needs a short title or a neighbour that agrees. No nested
# quantifier: one anchored alternative, then a forward word scan.
_SPACE_HYPHEN_START = re.compile(
    r"^\s*(?P<digits>\d+)[\u2013\u2014-](?P<letters>"
    + _REPEATED_CAPITAL
    + r"|[A-Za-z])(?=\s+(?-i:[A-Z]))",
    re.IGNORECASE,
)
_TITLE_WORD_CAP = 8


def space_hyphen_suffix_key(text: str) -> Optional[str]:
    """Glued key when ``text`` opens with a space-form hyphen suffix, else None.

    ``12-A Title`` and ``12-A Inserted rates.`` are ``12A``. ``12-A. Title`` is
    punctuated and returns None. ``12-I shall`` is prose and returns None.
    """
    matched = _SPACE_HYPHEN_START.match(text or "")
    if matched is None:
        return None
    return matched.group("digits") + matched.group("letters").upper()


def _numeric_base(number: Optional[str]) -> Optional[int]:
    matched = re.match(r"(\d+)", number or "")
    if matched is None:
        return None
    return int(matched.group(1))


def _space_hyphen_title(text: str) -> bool:
    """True when a short title after the suffix ends in a period or a dash.

    ``12-A Title.`` and ``12-A Inserted rates.`` and ``12-A Rates—`` match.
    The splitter stores an em dash as a hyphen, so ``Rates-`` is that title.
    ``12-I Pakistan continues ...`` does not: the stop is not inside the
    first eight words. The scan is one forward pass.
    """
    matched = _SPACE_HYPHEN_START.match(text or "")
    if matched is None:
        return False
    rest = text[matched.end():]
    words = 0
    index = 0
    limit = len(rest)
    while index < limit and words < _TITLE_WORD_CAP:
        while index < limit and rest[index].isspace():
            index += 1
        if index >= limit:
            return False
        start = index
        while index < limit and not rest[index].isspace():
            index += 1
        token = rest[start:index]
        words += 1
        if (
            token.endswith(".")
            or token.endswith("-")
            or token.endswith(".-")
            or "\u2014" in token
            or "\u2013" in token
        ):
            return True
    return False


def space_hyphen_heading_ok(
    text: str, previous: Optional[str], following: Optional[str],
) -> bool:
    """True when a space-form hyphen suffix may be its own section.

    A short title ended by a period or a dash is a heading. Otherwise the
    suffix is a heading only when it sits with its base. No previous body
    section, or that section's base is this base. No following body section,
    or that section's base is this base or the next integer. ``12-A`` after
    12 and before 13 is a heading. ``12-I Pakistan`` inside section 11 is not.
    """
    key = space_hyphen_suffix_key(text)
    if key is None:
        return False
    if _space_hyphen_title(text):
        return True
    base = _numeric_base(key)
    prev = _numeric_base(previous)
    nxt = _numeric_base(following)
    if base is None:
        return False
    if prev is not None and prev != base:
        return False
    if nxt is not None and nxt != base and nxt != (base + 1):
        return False
    return True


def is_short_amendment_footnote(text: str) -> bool:
    """True for a numbered marginal note of at most 20 characters.

    Three shapes are notes, and nothing else. ``1. Subs. by Act`` (and ``Ins.``,
    ``Added``, ``Omitted``, ``Rep.``, ``Am.``, and the unabbreviated verbs, each
    followed by ``by``). A body that is only the abbreviation ``Ins.``, ``Subs.``,
    ``Am.``, ``Amd.`` or ``Amdt.``. An abbreviation followed by ``of``, as in
    ``7. Rep. of X.``. They are noise, so they cannot take ``N`` or ``schedule:L:N``.

    ``2. Repeal.``, ``1. Omitted.`` and ``2. Rep.`` are provisions. A longer
    citation note is ``is_amendment_footnote`` (R-LENGTH-RESID-004).
    R-LENGTH-RESID-001 marks a staged placeholder non-live without changing
    this short-note test.
    """
    normalised = normalise_div_text(text)
    if not normalised or len(normalised) > SHORT_DIV_MAX_EXCLUSIVE:
        return False
    if parse_section_number(normalised) is None:
        return False
    body = _NUMBER_RE.sub("", normalised, count=1).strip()
    return (
        _AMENDMENT_NOTE_RE.match(body) is not None
        or _BARE_AMENDMENT_ABBREV_RE.match(body) is not None
        or _AMENDMENT_OF_RE.match(body) is not None
    )


# R-LENGTH-RESID-004. The whole body after the number is the note. A longer
# alternative is listed before the abbreviation it starts with, so ``substituted``
# is not read as ``subs``. ``(?!\w)`` is the end of the lead: a period is not a
# word character, so ``\b`` would miss ``Subs.``.
_LONG_FOOTNOTE_LEAD = re.compile(
    r"(?i:substituted|subs\.?|inserted|ins\.?|added|omitted\s+by|repealed\s+by|"
    r"rep\.\s+by|re-?numbered|amended\s+by|amdt\.\s+by|amd\.\s+by|am\.\s+by|"
    r"see(?:\s+also)?)(?!\w)"
)
# One ``as`` target, then whitespace. No repeated group: ``sub-section`` and
# ``clause`` are fixed words, and the parenthesis holds at most six characters.
_AS_SECTION_REF = re.compile(
    r"(?i:as)\s+"
    r"(?:sub-section|subsection|clause|sections|section|secs|sec|ss|s)\.?\s*"
    r"(?:\(\s*[0-9A-Za-z]{1,6}\s*\)|\d+[A-Za-z]?)\s+"
)
_SECTION_WORD = r"(?:sections|section|secs|sec|ss|s)"
_FIRST_SECTION_REF = re.compile(
    rf"\s*(?:,\s*)?(?:for\s+)?{_SECTION_WORD}\.?\s*\d+[A-Za-z]?",
    re.IGNORECASE,
)
_NEXT_SECTION_REF = re.compile(
    rf"\s*(?:,\s*|\s+and\s+|\s*&\s+)(?:{_SECTION_WORD}\.?\s*)?\d+[A-Za-z]?",
    re.IGNORECASE,
)
_CITE_JOIN = re.compile(r"(?:,\s*and\s+|,\s+|\s+and\s+)", re.IGNORECASE)
# A new verb after ``and`` or a comma. Pakistan Code separates units both ways
# (``s. 2 and Ins. by`` and ``s. 2, Ins. by``). ``, and`` stays one separator,
# listed before the bare comma. Fixed alternatives, not a repeated group. A
# comma that is not followed by a verb is left where it stands.
_VERB_CHAIN = re.compile(r"(?:,\s+and\s+|\s+and\s+|,\s+)", re.IGNORECASE)
# ``see s. 2`` after that comma. One section word, then a number. No repeat.
_SEE_XREF = re.compile(
    rf"\s*{_SECTION_WORD}\.?\s*\d+[A-Za-z]?",
    re.IGNORECASE,
)
_FOR_QUOTE = re.compile(
    r"""\s*,?\s*for\s+(?:the\s+(?:words|word|figures|figure)\s+)?"""
    r"""["\u201c][^"\u201d]{1,200}["\u201d]""",
    re.IGNORECASE,
)
_QUOTE_REPLACEMENT = re.compile(
    r"""\s+the\s+(?:words|word|figures|figure)\s+["\u201c][^"\u201d]{1,200}["\u201d]""",
    re.IGNORECASE,
)
# The words only. A comma, spaces and one opening parenthesis before them are
# read in ``_consume_wef``, so this pattern has no nested quantifier.
_WEF_WORD = re.compile(r"(?:w\.e\.f\.|with\s+effect\s+from)\s+", re.IGNORECASE)
_DATE_GLUE = frozenset({"the", "day", "of"})
_MONTHS = frozenset({
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december", "jan", "feb", "mar", "apr",
    "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
})
# A title word starts with a capital. ``of``, ``and`` and ``the`` may sit between
# title words. ``court under the Finance Act`` does not match: ``court`` is not
# a title word. The instrument keyword is case-insensitive so ``ACT`` matches.
_NAMED_INSTRUMENT = (
    r"(?:(?i:the)\s+)?"
    r"[A-Z][A-Za-z'.-]*"
    r"(?:\s+(?:[A-Z][A-Za-z'.-]*|(?i:of|and|the)|\([A-Z][A-Za-z'.-]{1,40}\)))*"
    r"\s+(?i:Act|Ordinance|Regulation)(?!\w),?\s+\d{4}"
    r"(?:\s*\(\s*(?:[IVXLCDMivxlcdm]+|\d+)\s+(?i:of)\s+\d{4}\s*\))?"
)
_NUMBERED_ACT = (
    r"(?i:Act)(?!\w)\s+(?:(?i:No)\.\s+)?(?:[IVXLCDMivxlcdm]+|\d+)\s+(?i:of)\s+\d{4}"
)
_NUMBERED_ORD = (
    r"(?:(?i:Ordinance)(?!\w)\s+|(?i:Ord)\.\s+)"
    r"(?:(?i:No)\.\s+)?(?:[IVXLCDMivxlcdm]+|\d+)\s+(?i:of)\s+\d{4}"
)
_NUMBERED_PO = (
    r"(?i:P)\.\s*(?i:O)\.\s*(?:(?i:No)\.\s+)?"
    r"(?:[IVXLCDMivxlcdm]+|\d+)\s+(?i:of)\s+\d{4}"
)
_NUMBERED_REG = (
    r"(?i:Regulation)(?!\w)\s+(?:(?i:No)\.\s+)?"
    r"(?:[IVXLCDMivxlcdm]+|\d+)\s+(?i:of)\s+\d{4}"
)
_CITATION = re.compile(
    rf"(?:{_NAMED_INSTRUMENT}|{_NUMBERED_ACT}|{_NUMBERED_ORD}|{_NUMBERED_PO}|{_NUMBERED_REG})"
)
# Instrument numbers only. A title word such as ``Civil`` is not one of these.
_INSTRUMENT_NUMBER = re.compile(
    r"(?i:Act|Ordinance|Regulation)(?!\w)\s+(?:(?i:No)\.\s+)?"
    r"([IVXLCDMivxlcdm]+|\d+)\s+(?i:of)\s+\d{4}"
    r"|(?i:Ord)\.\s+(?:(?i:No)\.\s+)?([IVXLCDMivxlcdm]+|\d+)\s+(?i:of)\s+\d{4}"
    r"|(?i:P)\.\s*(?i:O)\.\s*(?:(?i:No)\.\s+)?"
    r"([IVXLCDMivxlcdm]+|\d+)\s+(?i:of)\s+\d{4}"
    r"|\(\s*([IVXLCDMivxlcdm]+|\d+)\s+(?i:of)\s+\d{4}\s*\)"
)


def _roman_ok(token: str) -> bool:
    """True for an arabic instrument number or a real roman numeral, including ``V``."""
    text = (token or "").strip()
    if re.fullmatch(r"[1-9]\d*", text):
        return True
    letters = text.upper()
    if not letters or not re.fullmatch(r"[IVXLCDM]+", letters):
        return False
    if len(letters) == 1:
        return letters in _ROMAN_VALUES
    return _roman_to_int(letters) is not None


def _instrument_numbers(cite: str) -> list:
    """Roman or arabic tokens that stand in an instrument-number slot.

    ``Act V of 1976`` and ``(XII of 1991)`` contribute a token. ``Civil`` in
    ``the Civil Courts Act, 1962`` does not: it is a title word, not ``Act
    CIVIL of``.
    """
    found = []
    for match in _INSTRUMENT_NUMBER.finditer(cite or ""):
        found.extend(group for group in match.groups() if group)
    return found


def _citation_ok(cite: str) -> bool:
    """True when ``cite`` is one instrument and each instrument number is real.

    ``Act CIVIL of 2001`` matches the shape and fails here: ``CIVIL`` is not a
    roman numeral. ``Act V`` and ``Act II`` pass. A four-digit year is not an
    instrument number, and neither is a title word.
    """
    if _CITATION.fullmatch(cite or "") is None:
        return False
    return all(_roman_ok(token) for token in _instrument_numbers(cite))


def _date_token(token: str) -> bool:
    low = token.lower().rstrip(".")
    if low in _DATE_GLUE or low in _MONTHS:
        return True
    if re.fullmatch(r"\d{1,2}(?:st|nd|rd|th)?", low):
        return True
    if re.fullmatch(r"\d{4}", low):
        return True
    return re.fullmatch(r"\d{1,2}[./-]\d{1,2}[./-]\d{2,4}", low) is not None


def _consume_section_refs(text: str, pos: int) -> int:
    """Advance past ``s. 2``, ``s. 2 and s. 3`` or ``ss. 2 & 3``. No nested repeat."""
    first = _FIRST_SECTION_REF.match(text, pos)
    if first is None:
        return pos
    pos = first.end()
    while True:
        nxt = _NEXT_SECTION_REF.match(text, pos)
        if nxt is None:
            return pos
        pos = nxt.end()


def _consume_citations(text: str) -> Optional[int]:
    """End offset after one or more citations joined by a comma or ``and``.

    Returns None when the text does not open with a citation. A join that is
    not followed by another citation is left for the trailing-clause scan.
    """
    pos = 0
    count = 0
    while pos < len(text):
        if count:
            join = _CITE_JOIN.match(text, pos)
            if join is None:
                break
            cite = _CITATION.match(text, join.end())
            if cite is None or not _citation_ok(text[join.end():cite.end()]):
                break
            pos = cite.end()
        else:
            cite = _CITATION.match(text, pos)
            if cite is None or not _citation_ok(text[pos:cite.end()]):
                return None
            pos = cite.end()
        count += 1
        pos = _consume_section_refs(text, pos)
    if count < 1:
        return None
    return pos


def _consume_wef(text: str, pos: int) -> Optional[int]:
    """End offset after ``w.e.f.`` or ``with effect from`` and one date.

    The clause may follow any verb unit, not only the last. A comma, spaces
    and one opening parenthesis may precede the words, and a closing
    parenthesis finishes ``(w.e.f. ...)``. At most eight date tokens. The gap
    before a token is kept only when that token is a date, so ``and`` or a
    comma after the date stays for the next unit. A lead with no numeric
    token does not advance.
    """
    cursor = pos
    length = len(text)
    while cursor < length and text[cursor].isspace():
        cursor += 1
    if cursor < length and text[cursor] == ",":
        cursor += 1
        while cursor < length and text[cursor].isspace():
            cursor += 1
    opened = False
    if cursor < length and text[cursor] == "(":
        opened = True
        cursor += 1
        while cursor < length and text[cursor].isspace():
            cursor += 1
    lead = _WEF_WORD.match(text, cursor)
    if lead is None:
        return None
    cursor = lead.end()
    numbers = 0
    tokens = 0
    while tokens < 8 and cursor < length:
        gap_end = cursor
        if tokens:
            while gap_end < length and (text[gap_end].isspace() or text[gap_end] == ","):
                gap_end += 1
            if gap_end == cursor:
                break
        word_end = gap_end
        while word_end < length and (text[word_end].isalnum() or text[word_end] in "./-"):
            word_end += 1
        if word_end == gap_end or not _date_token(text[gap_end:word_end]):
            break
        if any(ch.isdigit() for ch in text[gap_end:word_end]):
            numbers += 1
        cursor = word_end
        tokens += 1
    if numbers < 1 or cursor <= pos:
        return None
    if opened:
        close = cursor
        while close < length and text[close].isspace():
            close += 1
        if close >= length or text[close] != ")":
            return None
        cursor = close + 1
    if cursor <= pos:
        return None
    return cursor


def _consume_trailing_clauses(text: str, pos: int) -> int:
    """Advance past ``for "..."`` and ``w.e.f.`` clauses, including ``(w.e.f. ...)``.

    Each step grows. A date clause that is not last leaves the following
    separator for the next verb unit.
    """
    while pos < len(text):
        quoted = _FOR_QUOTE.match(text, pos)
        if quoted is not None:
            pos = quoted.end()
            replacement = _QUOTE_REPLACEMENT.match(text, pos)
            if replacement is not None:
                pos = replacement.end()
            continue
        wef = _consume_wef(text, pos)
        if wef is None:
            return pos
        pos = wef
    return pos


def _unwrap_note(body: str) -> str:
    """Drop one trailing stop and up to two layers of wrapping brackets."""
    text = (body or "").strip()
    if text.endswith("."):
        text = text[:-1].rstrip()
    for _ in range(2):
        if len(text) >= 2 and text[0] in "[(" and text[-1] in "])":
            text = text[1:-1].strip()
            if text.endswith("."):
                text = text[:-1].rstrip()
        else:
            break
    return text


def _consume_verb_unit(text: str, pos: int) -> Optional[int]:
    """One ``<verb> by <instrument>[, s. N][ for ...]`` unit, from ``pos``.

    The verb is matched once. Citations, section references and trailing
    clauses are the same forward scan as a single note. Returns None when
    the verb is missing or the instrument does not follow.
    """
    lead = _LONG_FOOTNOTE_LEAD.match(text, pos)
    if lead is None:
        return None
    cursor = lead.end()
    while cursor < len(text) and text[cursor].isspace():
        cursor += 1
    as_ref = _AS_SECTION_REF.match(text, cursor)
    if as_ref is not None:
        cursor = as_ref.end()
        while cursor < len(text) and text[cursor].isspace():
            cursor += 1
    lead_text = lead.group(0).lower().rstrip(".")
    if not lead_text.endswith("by") and not lead_text.startswith("see"):
        by = re.match(r"(?i:by)\s+", text[cursor:])
        if by is None:
            return None
        cursor += by.end()
    elif lead_text.startswith("see"):
        by = re.match(r"(?i:by)\s+", text[cursor:])
        if by is not None:
            cursor += by.end()
    while cursor < len(text) and text[cursor].isspace():
        cursor += 1
    tail = text[cursor:]
    end = _consume_citations(tail)
    if end is None:
        return None
    end = _consume_trailing_clauses(tail, end)
    return cursor + end


def _whole_body_is_citation_footnote(body: str) -> bool:
    """True when ``body`` is only an amendment footnote, from the first word to the end.

    The lead is ``Subs.`` / ``Ins.`` / ``Added`` / ``Omitted by`` / ``Rep. by`` /
    ``Renumbered`` / ``Re-numbered`` / ``Amended by`` / ``See``, optionally
    ``as sub-section (1)`` or ``as clause (x)``. Then one or more Act,
    Ordinance, P.O. or Regulation citations, an optional section reference,
    and optional ``for "..."`` or ``w.e.f.`` clauses, including ``(w.e.f. ...)``.
    ``and`` or a comma may repeat that whole unit with a different verb. A
    ``w.e.f.`` clause may sit on a unit that is not last. Anything left over,
    including an operative sentence, does not match. ``Substitution``,
    ``Insertion`` and ``Amendment of`` do not match the lead.
    """
    text = _unwrap_note(body)
    pos = _consume_verb_unit(text, 0)
    if pos is None:
        return False
    while True:
        join = _VERB_CHAIN.match(text, pos)
        if join is None:
            break
        nxt = _consume_verb_unit(text, join.end())
        if nxt is None:
            break
        pos = nxt
    return text[pos:].strip() == ""


def _citation_footnote_bodies(text: str) -> list:
    """Bodies to test: the text after the number, and the text after one letter suffix.

    ``12-A.`` is keyed as ``12A`` (R-LENGTH-RESID-003), so the letter is not
    left in that body. A letter the number pattern did leave (``12. A. Subs.``)
    is still tried. A footnote is not staged.
    """
    normalised = normalise_div_text(text)
    if parse_section_number(normalised) is None:
        return []
    body = _NUMBER_RE.sub("", normalised, count=1).strip()
    bodies = [body]
    suffix = _LETTER_SUFFIX_RE.match(body)
    if suffix is not None:
        bodies.append(suffix.group("rest").strip())
    return bodies


def is_long_amendment_footnote(text: str) -> bool:
    """True when the whole numbered body is a citation footnote of any length.

    This does not decide staging. A RESID-001 placeholder that uses the same
    words (``Omitted by the Finance Act, 1990...``) is recognised here and is
    still staged when it is the only text for that number.
    """
    return any(_whole_body_is_citation_footnote(body) for body in _citation_footnote_bodies(text))


def _see_crossref_placeholder(text: str) -> bool:
    """True for ``Omitted`` or ``Repealed by <instrument>, see s. N``.

    ``see s. N`` names no instrument, so the long-note grammar does not take
    the line. It is still an amendment footnote for collision. Alone, the
    line stays a non-live placeholder on the bare key.
    """
    if omission_placeholder_status(text) not in {"omitted", "repealed"}:
        return False
    for match in _VERB_CHAIN.finditer(text):
        if match.group(0).strip() != ",":
            continue
        lead = _LONG_FOOTNOTE_LEAD.match(text, match.end())
        if lead is None or not lead.group(0).lower().startswith("see"):
            continue
        if _consume_verb_unit(text, match.end()) is not None:
            continue
        if _SEE_XREF.match(text, lead.end()) is not None:
            return True
    return False


def is_amendment_footnote(text: str) -> bool:
    """True for a short marginal note or a citation footnote of any length.

    Short notes are R-LENGTH-RESID-002 and R-LENGTH-RESID-005, including a bare
    ``Ins.`` and ``Rep. of X.`` that name no instrument. Citation notes are
    R-LENGTH-RESID-004. ``Omitted by <instrument>, see s. N`` and the repealed
    form are included so a real section with that number keeps the bare key.
    A real amending section (``Substitution``, ``Insertion of``,
    ``Amendment of section X.-``) is none of these.
    """
    normalised = normalise_div_text(text)
    return (
        is_short_amendment_footnote(normalised)
        or is_long_amendment_footnote(normalised)
        or _see_crossref_placeholder(normalised)
    )


def is_unstaged_amendment_footnote(text: str) -> bool:
    """True when the note is noise and must not be staged.

    A short note is always noise, including one that also reads as a placeholder.
    A citation footnote is noise unless the whole body is a RESID-001 omission,
    repeal or deletion placeholder. That placeholder keeps its key when it is
    the only text for the number. ``footnote_collides_with_real`` drops it when
    a real section shares the number.
    """
    normalised = normalise_div_text(text)
    if is_short_amendment_footnote(normalised):
        return True
    if not is_long_amendment_footnote(normalised):
        return False
    return omission_placeholder_status(normalised) is None


def _status_for_word(word: str) -> str:
    token = word.lower().rstrip(".")
    if token in {"omitted", "omit"}:
        return "omitted"
    if token in {"repealed", "rep"}:
        return "repealed"
    return "deleted"


def _citation_tail_ok(tail: str) -> bool:
    """True when text after ``by`` or ``of`` is a citation, not a second sentence.

    ``Ord. X`` and ``s. 3`` are citations. ``mistake. The proviso`` is a sentence.
    """
    text = (tail or "").strip()
    if not text:
        return True
    if _OPERATIVE_CLAUSE.search(text):
        return False
    if ";" in text or "?" in text:
        return False
    if re.search(r"\d\.\s+[A-Z]", text):
        return False
    # ``Rep. by Act II and Amended by Act III`` and ``Omitted by Act II, Ins. by
    # Act III`` are mixed notes, not one placeholder. ``and`` plus a verb lead
    # is enough. A bare comma starts another unit only when that unit names an
    # instrument: ``, see s. 2`` is a section cross-reference and stays one
    # omission or repeal.
    for match in _VERB_CHAIN.finditer(text):
        if _LONG_FOOTNOTE_LEAD.match(text, match.end()) is None:
            continue
        if match.group(0).strip() == "," and _consume_verb_unit(text, match.end()) is None:
            continue
        return False
    for match in re.finditer(r"([A-Za-z]+)\.\s+", text):
        word = match.group(1).lower()
        if word in _CITATION_ABBREV:
            continue
        # ``w.e.f.`` is one date lead. The closing ``f.`` is not a stray
        # abbreviation, and a lone ``f.`` is still refused.
        if word == "f" and text[max(0, match.start() - 4):match.start()].lower() == "w.e.":
            continue
        return False
    return True


def _placeholder_body(body: str) -> Optional[str]:
    """``omitted``, ``repealed`` or ``deleted`` when ``body`` is only a placeholder."""
    text = (body or "").strip()
    if not text or _OPERATIVE_CLAUSE.search(text):
        return None
    if text.count("*") >= 3 and _STAR_PLACEHOLDER_RE.fullmatch(text) and not _LETTERS.sub("", text):
        return "omitted"
    matched = _STATUS_PLACEHOLDER_RE.fullmatch(text)
    if matched is None:
        return None
    relation = (matched.group("rel") or "").lower()
    word = matched.group("word")
    if relation == "of" and not word.lower().startswith("rep"):
        return None
    if not _citation_tail_ok(matched.group("tail") or ""):
        return None
    return _status_for_word(word)


def omission_placeholder_status(text: str) -> Optional[str]:
    """Non-live status when the whole body after the number is a placeholder.

    Returns ``omitted``, ``repealed`` or ``deleted``. Returns None when there is
    no section number, when the body is operative, and when a repeal or omission
    word only occurs inside a longer provision. This does not choose the key.
    ``2. Repeal.`` is a heading and returns None. ``12-A. [Omitted.]`` is
    section ``12A`` (R-LENGTH-RESID-003). The placeholder is the body after
    that number.
    """
    normalised = normalise_div_text(text)
    if parse_section_number(normalised) is None:
        return None
    body = _NUMBER_RE.sub("", normalised, count=1).strip()
    status = _placeholder_body(body)
    if status:
        return status
    suffix = _LETTER_SUFFIX_RE.match(body)
    if suffix is None:
        return None
    return _placeholder_body(suffix.group("rest").strip())


def short_div_disposition(text: str) -> str:
    """How one div or paragraph is treated when a length gate used to drop it.

    ``provision`` — the text parses as a numbered section or schedule item. Length
    does not drop it, and it is not merged into a neighbour.
    ``ambiguous`` — the letters are only an omission or repeal marker, and there is
    no section number to publish. Fail closed: quarantine, do not invent ``N``.
    ``noise`` — 20 characters or fewer and neither of the above, or an unstaged
    amendment footnote of any length (R-LENGTH-RESID-002, R-LENGTH-RESID-004).
    Skip it.
    ``content`` — longer than the noise gate and not an unstaged footnote. The
    caller uses the ordinary rules.
    """
    normalised = normalise_div_text(text)
    if is_unstaged_amendment_footnote(normalised):
        return "noise"
    if parse_section_number(normalised) is not None:
        return "provision"
    if len(normalised) > SHORT_DIV_MAX_EXCLUSIVE:
        return "content"
    letters = _LETTERS.sub("", normalised).lower()
    if letters in _OMISSION_WORDS:
        return "ambiguous"
    return "noise"


def _structural_kind(text: str) -> Optional[str]:
    matched = _STRUCTURAL_KIND.match(text or "")
    if matched is None:
        return None
    return matched.group(1).lower()


@dataclass(frozen=True)
class KeyedDiv:
    """One kept div and the key it is staged and published under."""

    key: str
    text: str
    title: Optional[str]
    kind: str
    lookup_number: Optional[str]
    schedule_label: Optional[str]
    # R-LENGTH-RESID-001. None is live law. A value is kept with the key and the text.
    provision_status: Optional[str] = None


@dataclass(frozen=True)
class DivKeyingResult:
    sections: tuple
    skipped_short: int
    dropped_by_cap: int
    schedule_label_mode: Optional[str] = None


@dataclass
class _Classified:
    text: str
    kind: str
    number: Optional[str]
    label: Optional[str]


def _title_for(text: str, number: Optional[str]) -> Optional[str]:
    body = _NUMBER_RE.sub("", text, count=1) if number else text
    body = body.strip()
    if not body:
        return None
    sentence = re.split(r"(?<=\.)\s", body, maxsplit=1)[0]
    return sentence[:500]


def _token_from_container(raw: Optional[str]) -> Optional[_HeadingToken]:
    text = _WS.sub(" ", raw or "").strip()
    if not text:
        return None
    if "schedule" in text.lower():
        return parse_schedule_heading(text)
    return classify_heading_token(text)


def _collect_heading_tokens(
    texts: Sequence[str], containers: Optional[Sequence[Optional[str]]],
) -> list:
    tokens = []
    for raw in texts:
        parsed = parse_schedule_heading(normalise_div_text(raw))
        if parsed is not None:
            tokens.append(parsed)
    if containers is not None:
        for raw in containers:
            parsed = _token_from_container(raw)
            if parsed is not None:
                tokens.append(parsed)
    return tokens


def _resolve_heading(parsed: Optional[_HeadingToken], mode: str) -> Optional[tuple]:
    """``("label", value)`` or ``("unresolved", raw)``. None when there is no heading."""
    if parsed is None:
        return None
    if mode == "mixed" or (parsed.kind == "ambiguous" and mode not in ("roman", "letter")):
        return ("unresolved", parsed.raw)
    if parsed.kind == "ambiguous":
        if mode == "roman":
            return ("label", _ROMAN_SINGLE_VALUE[parsed.value])
        return ("label", parsed.value)
    return ("label", parsed.value)


def _footnote_collision_id(item: _Classified):
    """The identity a citation footnote must not share with a real provision."""
    if item.number is None:
        return None
    if item.kind == "section":
        return ("section", item.number)
    if item.kind == "schedule-item":
        return ("schedule-item", item.label, item.number)
    if item.kind == "unscoped":
        return ("unscoped", item.number)
    if item.kind == "schedule-unresolved":
        return ("schedule-unresolved", item.label, item.number)
    return None


def _without_colliding_footnotes(kept: list, skipped: int) -> tuple:
    """Drop a citation footnote that shares its number with a real provision.

    The real provision keeps ``N`` or ``schedule:L:N``. Order does not matter:
    the real set is collected before anything is dropped. A placeholder that is
    the only text for that number stays, including ``Omitted by <instrument>,
    see s. N``. That cross-reference is an amendment footnote here, so a real
    section with the same number keeps the bare key. An unstaged note never
    reaches ``kept``.
    """
    real = set()
    for item in kept:
        ident = _footnote_collision_id(item)
        if ident is not None and not is_amendment_footnote(item.text):
            real.add(ident)
    filtered = []
    for item in kept:
        ident = _footnote_collision_id(item)
        if ident is not None and ident in real and is_amendment_footnote(item.text):
            skipped += 1
            continue
        filtered.append(item)
    return filtered, skipped


class _FoldEntry:
    """One div or splitter row, plus whether body-heading fold must ignore it."""

    __slots__ = ("text", "blocked")

    def __init__(self, text: str, blocked: bool = False) -> None:
        self.text = text
        self.blocked = blocked


def _schedule_boundary(text: str) -> str:
    """``whole`` when the text is only a schedule heading, ``embedded`` when a line is.

    A flat schedule heading is its own div. The paragraph splitter leaves that
    heading on a later line of the previous chunk. Either one ends body scope.
    """
    if parse_schedule_heading(normalise_div_text(text)) is not None:
        return "whole"
    for line in (text or "").splitlines():
        if parse_schedule_heading(normalise_div_text(line)) is not None:
            return "embedded"
    return ""


def space_heading_fold_plan(texts, blocked=None) -> dict:
    """Host index for each space-form line that is not a heading, or None.

    None means the line has no body section to join, so its suffix must not be
    published. ``blocked`` marks rows fold must ignore, such as a container item
    or a bare omission marker. A missing index is kept. Schedule scope matches
    ``_classify``:
    after a body section has been seen, a schedule heading closes the body.
    Later numbered rows are schedule items and are not body neighbours, and a
    space-form inside that scope is not folded into an item or a body section.
    An amendment footnote is not a neighbour. A space-form heading that this
    plan accepts is a neighbour, so a following wrap joins that heading and a
    following suffix is judged from it.
    """
    flags = tuple(blocked or ())
    entries = [
        _FoldEntry(text, blocked=index < len(flags) and bool(flags[index]))
        for index, text in enumerate(texts)
    ]
    count = len(entries)
    normalised = [normalise_div_text(entry.text) for entry in entries]
    boundary = [
        "" if entry.blocked else _schedule_boundary(entry.text) for entry in entries
    ]
    in_schedule = [False] * count
    scope = False
    body_seen = False
    for index, entry in enumerate(entries):
        in_schedule[index] = scope
        if entry.blocked or scope:
            continue
        if boundary[index] == "whole":
            if body_seen:
                scope = True
            continue
        numbered = (
            parse_section_number(normalised[index]) is not None
            and not is_amendment_footnote(normalised[index])
        )
        if numbered:
            body_seen = True
        if boundary[index] == "embedded" and (body_seen or numbered):
            scope = True

    def plain_anchor(index: int) -> bool:
        if entries[index].blocked or in_schedule[index] or boundary[index] == "whole":
            return False
        if space_hyphen_suffix_key(normalised[index]) is not None:
            return False
        if is_amendment_footnote(normalised[index]):
            return False
        return parse_section_number(normalised[index]) is not None

    def title_heading(index: int) -> bool:
        if entries[index].blocked or in_schedule[index] or boundary[index] == "whole":
            return False
        if space_hyphen_suffix_key(normalised[index]) is None:
            return False
        return _space_hyphen_title(normalised[index])

    confirmed = []
    confirmed_set = set()
    for index in range(count):
        if plain_anchor(index) or title_heading(index):
            confirmed.append(index)
            confirmed_set.add(index)

    def previous_host(index: int):
        for host in reversed(confirmed):
            if host < index:
                return host
        return None

    def following_number(index: int):
        if boundary[index] == "embedded":
            return None
        for cursor in range(index + 1, count):
            if boundary[cursor] == "whole" or in_schedule[cursor]:
                return None
            if cursor in confirmed_set and (plain_anchor(cursor) or title_heading(cursor)):
                return parse_section_number(normalised[cursor])
        return None

    plan = {}
    for index in range(count):
        if entries[index].blocked or in_schedule[index]:
            continue
        if space_hyphen_suffix_key(normalised[index]) is None or index in confirmed_set:
            continue
        host = previous_host(index)
        previous = parse_section_number(normalised[host]) if host is not None else None
        if space_hyphen_heading_ok(normalised[index], previous, following_number(index)):
            confirmed.append(index)
            confirmed.sort()
            confirmed_set.add(index)
            continue
        plan[index] = host
    return plan


def _absorb_false_space_headings(texts, containers):
    """Join a wrapped space-form line to the body section it continues.

    ``12-I Pakistan`` and ``12-I The Federal Government`` inside section 11
    are not sections. Their text stays on section 11. A real ``12-A`` that
    ``space_hyphen_heading_ok`` accepts stays its own div, and a later wrap
    joins that div rather than an earlier section. A schedule heading ends
    the body search, so a schedule item is not the next section and a
    space-form inside the schedule is not pulled into an item. An amendment
    footnote is not a host. A line with no previous section is marked for
    suppression and is not published as ``12I``.
    """
    raw = tuple(texts)
    boxes = tuple(containers) if containers is not None else None
    plan = space_heading_fold_plan(
        raw,
        blocked=[boxes is not None and bool(boxes[index]) for index in range(len(raw))],
    )
    if not plan:
        return raw, boxes, set()
    normalised = [normalise_div_text(text) for text in raw]
    pieces = {index: [normalised[index]] for index in range(len(normalised))}
    drop = set()
    suppress_at = set()
    for index, host in plan.items():
        if host is None:
            suppress_at.add(index)
            continue
        pieces[host].append(normalised[index])
        drop.add(index)
    new_texts = []
    new_boxes = [] if boxes is not None else None
    suppress = set()
    for index in range(len(normalised)):
        if index in drop:
            continue
        if index in suppress_at:
            suppress.add(len(new_texts))
        new_texts.append(" ".join(pieces[index]))
        if new_boxes is not None:
            new_boxes.append(boxes[index])
    return new_texts, new_boxes, suppress


def _collapse_nonlive_footnote_placeholders(kept: list, skipped: int) -> tuple:
    """One bare key when every body row for a number is a non-live footnote.

    A ``see s.`` omission and a Finance ``Omitted by`` note are both non-live.
    Keeping both publishes ``6-<sha>`` twice (RESID-004-SEE-002). The
    lexicographically earliest normalised text keeps bare ``N`` and its
    placeholder status. The others are dropped. Nothing is served as current
    law. A live section is already preferred by ``_without_colliding_footnotes``.
    A repeated ``3. [Omitted.]`` is not a footnote and is left content-addressed.
    """
    groups: dict = {}
    for index, item in enumerate(kept):
        if item.kind != "section" or not item.number:
            continue
        if omission_placeholder_status(item.text) not in NON_LIVE_PROVISION_STATUSES:
            continue
        if not is_amendment_footnote(item.text):
            continue
        groups.setdefault(item.number, []).append(index)
    drop = set()
    for number, indexes in groups.items():
        if len(indexes) < 2:
            continue
        if any(
            item.kind == "section" and item.number == number and not is_amendment_footnote(item.text)
            for item in kept
        ):
            continue
        winner = min(indexes, key=lambda item_index: normalise_div_text(kept[item_index].text))
        for item_index in indexes:
            if item_index == winner:
                continue
            drop.add(item_index)
            skipped += 1
    if not drop:
        return kept, skipped
    return [item for index, item in enumerate(kept) if index not in drop], skipped


def _classify(
    texts: Sequence[str],
    containers: Optional[Sequence[Optional[str]]] = None,
    suppress: Optional[Iterable[int]] = None,
) -> tuple:
    """Kept divs in order, plus how many noise divs were skipped, plus the mode.

    The skip count is short noise and unstaged amendment footnotes. Neither uses
    the 50-div cap.
    """
    mode = schedule_evidence_mode(_collect_heading_tokens(texts, containers))
    kept: list[_Classified] = []
    skipped = 0
    suppressed = set(suppress or ())
    scope: Optional[tuple] = None
    body_seen = False
    heading_before_body = False
    for index, raw in enumerate(texts):
        text = normalise_div_text(raw)
        container = _token_from_container(containers[index]) if containers is not None else None
        parsed = parse_schedule_heading(text)
        if parsed is not None:
            outcome = _resolve_heading(parsed, mode)
            if outcome[0] == "unresolved":
                kept.append(_Classified(
                    text=text, kind="schedule-unresolved", number=None, label=outcome[1],
                ))
                scope = outcome if body_seen else None
            else:
                kept.append(_Classified(
                    text=text, kind="schedule-heading", number=None, label=outcome[1],
                ))
                scope = outcome if body_seen else None
            if not body_seen:
                heading_before_body = True
            continue
        if is_unstaged_amendment_footnote(text):
            skipped += 1
            continue
        if index in suppressed:
            # A refused space-form with no section to join is not ``12I``.
            if len(text) <= SHORT_DIV_MAX_EXCLUSIVE and _structural_kind(text) is None:
                letters = _LETTERS.sub("", text).lower()
                if letters in _OMISSION_WORDS:
                    kept.append(_Classified(text=text, kind="short-ambiguous", number=None, label=None))
                else:
                    skipped += 1
                continue
            kind = _structural_kind(text) or "div"
            kept.append(_Classified(text=text, kind=kind, number=None, label=None))
            continue
        if len(text) <= SHORT_DIV_MAX_EXCLUSIVE and _structural_kind(text) is None:
            disposition = short_div_disposition(text)
            if disposition == "ambiguous":
                kept.append(_Classified(text=text, kind="short-ambiguous", number=None, label=None))
                continue
            if disposition != "provision":
                skipped += 1
                continue
        number = parse_section_number(text)
        chosen = _resolve_heading(container, mode) if container is not None else scope
        if number is not None and chosen is not None and chosen[0] == "unresolved":
            kept.append(_Classified(
                text=text, kind="schedule-unresolved", number=number, label=chosen[1],
            ))
            continue
        if number is not None and chosen is not None and chosen[0] == "label":
            kept.append(_Classified(
                text=text, kind="schedule-item", number=number, label=chosen[1],
            ))
            continue
        if number is not None and heading_before_body:
            kept.append(_Classified(text=text, kind="unscoped", number=number, label=None))
            continue
        if number is not None:
            body_seen = True
            kept.append(_Classified(text=text, kind="section", number=number, label=None))
            continue
        kind = _structural_kind(text) or "div"
        kept.append(_Classified(text=text, kind=kind, number=None, label=None))
    kept, skipped = _without_colliding_footnotes(kept, skipped)
    kept, skipped = _collapse_nonlive_footnote_placeholders(kept, skipped)
    return kept, skipped, mode


def _base_key(item: _Classified, body_counts: Mapping[str, int], schedule_counts: Mapping[tuple, int]) -> str:
    if item.kind == "section" and item.number is not None:
        if body_counts[item.number] == 1:
            return item.number
        return f"{item.number}-{content_token(item.text)}"
    if item.kind == "schedule-item" and item.number is not None and item.label is not None:
        base = f"schedule:{item.label}:{item.number}"
        if schedule_counts[(item.label, item.number)] == 1:
            return base
        return f"{base}-{content_token(item.text)}"
    if item.kind == "schedule-heading" and item.label is not None:
        return f"schedule-heading:{item.label}"
    if item.kind == "schedule-unresolved":
        if item.number is not None and item.label:
            return f"unresolved-schedule:{item.label}:{item.number}"
        if item.label:
            return f"unresolved-schedule-heading:{item.label}"
        return f"unresolved-schedule-{content_token(item.text)}"
    if item.kind == "short-ambiguous":
        return f"ambiguous-{content_token(item.text)}"
    if item.kind == "unscoped" and item.number is not None:
        return f"unscoped:{item.number}-{content_token(item.text)}"
    if item.kind == "preamble":
        return f"preamble-{content_token(item.text)}"
    if item.kind == "explanation":
        return f"explanation-{content_token(item.text)}"
    return f"div-{content_token(item.text)}"


_FALLBACK_SUPPRESSED_KINDS = frozenset({
    "section", "schedule-item", "preamble", "explanation", "div", "unscoped",
    "schedule-unresolved", "short-ambiguous",
})
# ``unscoped`` is a numbered div with no proven parent: a flat heading before any body
# section, and no ancestor heading. It stays withheld (FA-17). A schedule item already
# carries that parent label and is published under ``schedule:L:N``.
# ``schedule-unresolved`` is a heading whose single letter I/V/X/L has no roman or
# letter proof, or a schedule on a page whose evidence is mixed (R-LETTER-ROMAN-001).
PUBLISHABLE_SECTION_KINDS = frozenset({
    "section", "preamble", "explanation", "div", "schedule-heading", "schedule-item",
})
AMBIGUOUS_SECTION_KINDS = frozenset({"unscoped", "schedule-unresolved", "short-ambiguous"})
REASON_AMBIGUOUS_SECTION = "ambiguous_section_identity"
REASON_SCHEDULE_LETTER_ROMAN = "schedule_letter_roman_ambiguous"
_SCHEDULE_KEY_PREFIXES = ("schedule:", "schedule-heading:")


def is_schedule_publication_key(key: str) -> bool:
    """True for a schedule heading or schedule item, never for a body section key.

    Body keys are ``N``, ``N-<sha8>``, and ``~n`` copies of those, plus preamble,
    explanation, div, and unscoped keys. Schedule keys use ``schedule:L:N`` and
    ``schedule-heading:L`` with the same ``-<sha8>`` and ``~n`` suffixes. The
    prefixes do not overlap a body key.
    """
    return isinstance(key, str) and key.startswith(_SCHEDULE_KEY_PREFIXES)


def ambiguous_section_reason(kind: Optional[str]) -> Optional[str]:
    """Quarantine reason for a kind that must not be published, else None.

    ``unscoped`` and ``short-ambiguous`` keep ``ambiguous_section_identity``. An
    unresolved schedule letter uses ``schedule_letter_roman_ambiguous`` so the two
    holds stay distinct.
    """
    if kind in ("unscoped", "short-ambiguous"):
        return REASON_AMBIGUOUS_SECTION
    if kind == "schedule-unresolved":
        return REASON_SCHEDULE_LETTER_ROMAN
    return None


def section_kind_is_ambiguous(kind: Optional[str]) -> bool:
    """True when the div must not be published and the page must not retire keys."""
    return ambiguous_section_reason(kind) is not None


def act_inventory_is_complete(result: DivKeyingResult) -> bool:
    """True when every kept div may be published and the key set may retire absences.

    One ambiguous div means the page is not a proven inventory of the act.
    A schedule heading or schedule item on a page that also dropped divs at the
    50-div cap is not an inventory either: the dropped tail must not be retired
    because earlier schedule rows occupied slots.
    """
    if not result.sections or any(item.kind not in PUBLISHABLE_SECTION_KINDS for item in result.sections):
        return False
    if result.dropped_by_cap and any(
        item.kind in ("schedule-item", "schedule-heading") for item in result.sections
    ):
        return False
    return True


def suppresses_plain_text_fallback(result: DivKeyingResult) -> bool:
    """True when kept divs already carry the page's sections.

    A page of only schedule headings does not suppress the paragraph fallback here:
    a heading div beside real paragraphs must still be split. The harvester itself
    skips the splitter when the page text is those headings (and the act title) and
    nothing else, so a heading-only page is not turned into a section. A page with
    no kept div does not suppress the fallback either.
    """
    return any(item.kind in _FALLBACK_SUPPRESSED_KINDS for item in result.sections)


def page_has_text_besides_schedule_headings(
    full_text: str, headings: Sequence[str], act_name: str = "",
) -> bool:
    """True when ``full_text`` is not just the schedule headings and the act title.

    Each heading is removed once, and the act title is removed once. A paragraph that
    only mentions a heading still leaves its own words, so the splitter still runs.
    A page whose text is the heading (and the ``h1`` the harvester already stored as
    the act name) does not.
    """
    residual = normalise_div_text(full_text)
    act = normalise_div_text(act_name)
    if act:
        residual = normalise_div_text(residual.replace(act, " ", 1))
    counts: dict = {}
    for heading in headings:
        token = normalise_div_text(heading)
        if token:
            counts[token] = counts.get(token, 0) + 1
    for token in sorted(counts, key=len, reverse=True):
        for _ in range(counts[token]):
            updated = residual.replace(token, " ", 1)
            if updated == residual:
                break
            residual = normalise_div_text(updated)
    return residual != ""


def fallback_act_keys(divs: Optional[DivKeyingResult], staged: Sequence[tuple]) -> Optional[list]:
    """``act_keys`` for the paragraph-splitter path, or None when the set must be omitted.

    A page that kept an ``unscoped`` div does not carry ``act_keys`` and cannot retire
    other rows. A harvest of only schedule headings also omits the set. A heading is
    not an inventory of the act. Any other non-empty staged list, including fallback
    paragraph keys, is the set, in document order. Schedule items are staged on the
    div path, which includes them when ``act_inventory_is_complete`` is true.
    """
    if divs is not None and any(section_kind_is_ambiguous(item.kind) for item in divs.sections):
        return None
    if any(section_kind_is_ambiguous(kind) for _key, kind in staged):
        return None
    if not staged or all(kind == "schedule-heading" for _key, kind in staged):
        return None
    keys = [key for key, _kind in staged if isinstance(key, str) and key]
    if len(keys) != len(staged):
        return None
    return keys


def key_div_texts(texts: Sequence[str], containers: Optional[Sequence[Optional[str]]] = None) -> DivKeyingResult:
    """Stage identity for one PakistanCode act page. ``texts`` is document order.

    ``containers[i]`` is the schedule label of a real ancestor of that div, or None
    for a flat sibling. It must be the same length as ``texts``.
    """
    texts = tuple(texts)
    if containers is not None:
        containers = tuple(containers)
        if len(containers) != len(texts):
            raise ValueError("PakistanCode schedule containers must align with div texts")
    texts, containers, suppress = _absorb_false_space_headings(texts, containers)
    classified, skipped, mode = _classify(texts, containers, suppress)
    dropped = max(0, len(classified) - MAX_STAGED_DIVS)
    staged = classified[:MAX_STAGED_DIVS]
    body_counts: dict = {}
    schedule_counts: dict = {}
    for item in staged:
        if item.kind == "section" and item.number is not None:
            body_counts[item.number] = body_counts.get(item.number, 0) + 1
        elif item.kind == "schedule-item" and item.number is not None:
            pair = (item.label, item.number)
            schedule_counts[pair] = schedule_counts.get(pair, 0) + 1
    seen: dict = {}
    sections = []
    for item in staged:
        base = _base_key(item, body_counts, schedule_counts)
        seen[base] = seen.get(base, 0) + 1
        key = base if seen[base] == 1 else f"{base}~{seen[base]}"
        if len(key) > MAX_SECTION_KEY_CHARS:
            raise ValueError(f"PakistanCode section key exceeds {MAX_SECTION_KEY_CHARS} characters")
        lookup = item.number if item.kind == "section" and body_counts.get(item.number) == 1 else None
        sections.append(KeyedDiv(
            key=key,
            text=item.text,
            title=_title_for(item.text, item.number),
            kind=item.kind,
            lookup_number=lookup,
            schedule_label=item.label if item.kind in ("schedule-heading", "schedule-item") else None,
            provision_status=omission_placeholder_status(item.text) if item.number else None,
        ))
    return DivKeyingResult(
        sections=tuple(sections), skipped_short=skipped, dropped_by_cap=dropped,
        schedule_label_mode=mode,
    )


@dataclass
class PublishedSection:
    """One statutes_master identity while a harvest series is applied in memory."""

    key: str
    text: str
    kind: str
    lookup_number: Optional[str]
    versions: list
    retired: bool = False
    title: Optional[str] = None
    provision_status: Optional[str] = None


def _non_live(row: PublishedSection) -> bool:
    """True when the row is an omission, repeal or deletion placeholder."""
    return row.provision_status in NON_LIVE_PROVISION_STATUSES


@dataclass
class HarvestDelta:
    inserted: list = field(default_factory=list)
    amended: list = field(default_factory=list)
    unchanged: list = field(default_factory=list)
    retired: list = field(default_factory=list)


def _refuse_act_keys(reason: str) -> None:
    """Retire nothing. The caller sees the refusal; the store is left untouched."""
    message = f"act_keys refused ({reason}); retiring nothing"
    logger.error(message)
    raise ValueError(message)


def _materialise_act_keys(sections) -> list:
    """One concrete list of sections, or a refusal.

    Retirement runs only for a non-empty collection of sections whose keys are
    non-empty strings. ``None``, ``str``, ``bytes``, a mapping, an empty or
    exhausted iterator, and a collection with a non-string or empty element are
    refused. A generator is read once here and is not read again.
    """
    if sections is None:
        _refuse_act_keys("None")
    if isinstance(sections, (str, bytes, bytearray)):
        _refuse_act_keys(type(sections).__name__)
    if isinstance(sections, Mapping):
        _refuse_act_keys("mapping")
    if isinstance(sections, (list, tuple)):
        staged = list(sections)
    else:
        try:
            staged = list(sections)
        except TypeError:
            _refuse_act_keys(type(sections).__name__)
    if not staged:
        _refuse_act_keys("empty")
    for item in staged:
        key = item.key if isinstance(item, KeyedDiv) else None
        if not isinstance(key, str) or key == "":
            _refuse_act_keys("element is not a section with a non-empty str key")
    return staged


def apply_harvest(store: dict, sections: Sequence[KeyedDiv], *, label_mode: Optional[str] = None) -> HarvestDelta:
    """Publish ``sections`` onto ``store``.

    A new key is inserted once. The same key, or a schedule key with the same canonical
    identity, and the same text is unchanged. New text appends a version and keeps the
    stored key. The stored schedule key is not rewritten. A retired row with that
    identity is revived on the stored key, versions included. A live key whose identity is
    absent from this harvest is retired. The inventory is materialised once. Retirement
    runs only when that list is a non-empty collection of sections with non-empty str
    keys. Every other shape raises ``ValueError`` and retires nothing. Publish uses
    ``keys_to_retire``, which already returns nothing for a missing or empty set.
    A non-empty list still retires keys it does not contain.
    A harvest whose keys are all schedule keys
    does not retire a body section: adding a schedule is not an inventory that repeals
    the act. Two rows that already share one schedule identity are left as they
    are: this harvest does not pick one, insert a third, or retire them. No second row
    is created for an existing identity, and an unchanged text is not written again.
    ``label_mode="roman"`` is the sibling proof that lets a stored ``i``/``v``/``x``/``l``
    share the roman value. Without it those letters stay letters, and ``l`` never
    shares the First Schedule.
    """
    delta = HarvestDelta()
    staged = _materialise_act_keys(sections)
    fold = label_mode if label_mode == "roman" else None
    by_identity: dict = {}
    conflicts = set()
    for key, row in store.items():
        ident = schedule_key_identity(key, mode=fold)
        if ident in by_identity:
            conflicts.add(ident)
        else:
            by_identity[ident] = key
    seen_raw = set()
    seen_identities = set()
    blocked = any(section_kind_is_ambiguous(section.kind) for section in staged)
    for section in staged:
        if section_kind_is_ambiguous(section.kind):
            continue
        ident = schedule_key_identity(section.key, mode=fold)
        seen_raw.add(section.key)
        seen_identities.add(ident)
        if ident in conflicts:
            continue
        current_key = by_identity.get(ident)
        current = store.get(current_key) if current_key is not None else None
        if current is None:
            store[section.key] = PublishedSection(
                key=section.key,
                text=section.text,
                kind=section.kind,
                lookup_number=section.lookup_number,
                versions=[section.text],
                retired=False,
                title=section.title,
                provision_status=section.provision_status,
            )
            by_identity[ident] = section.key
            delta.inserted.append(section.key)
            continue
        current.retired = False
        current.kind = section.kind
        current.lookup_number = section.lookup_number
        current.title = section.title
        current.provision_status = section.provision_status
        if current.text != section.text:
            current.versions.append(section.text)
            current.text = section.text
            delta.amended.append(current.key)
        else:
            delta.unchanged.append(current.key)
    if blocked:
        return delta
    schedule_only = bool(seen_raw) and all(is_schedule_publication_key(key) for key in seen_raw)
    for key, row in store.items():
        if row.retired:
            continue
        ident = schedule_key_identity(key, mode=fold)
        if ident in seen_identities or ident in conflicts:
            continue
        if schedule_only and not is_schedule_publication_key(key):
            continue
        row.retired = True
        delta.retired.append(key)
    return delta


# LOOKUP-003-001. A bare body key, digits plus at most four suffix letters.
# ``12-Fees`` does not match. The fold is lookup only: keying still stores ``12a``.
_BARE_BODY_KEY = re.compile(r"^(\d+)([A-Za-z]{0,4})$")
_NO_BODY_ROW = object()


def lookup_section_key(number: str) -> str:
    """Body key compared at lookup. A suffix letter is upper-cased.

    ``12a``, ``12A``, ``12-a`` and ``12-A`` are ``12A``. ``12`` stays ``12``.
    ``12-Fees`` is unchanged. This does not rewrite a stored row. A glued
    ``12a.`` remains stored as ``12a`` (LOOKUP-003-001).
    """
    folded = canonical_section_number((number or "").strip())
    matched = _BARE_BODY_KEY.fullmatch(folded)
    if matched is None or not matched.group(2):
        return folded
    return matched.group(1) + matched.group(2).upper()


def _live_body_hits(store: Mapping[str, PublishedSection], number: str) -> list:
    """Live body rows whose key is ``number``, with the suffix letter folded."""
    folded = lookup_section_key(number)
    if not folded:
        return []
    if _BARE_BODY_KEY.fullmatch(folded):
        return [
            row for row in store.values()
            if not row.retired and not _non_live(row) and row.kind == "section"
            and isinstance(row.key, str) and _BARE_BODY_KEY.fullmatch(row.key)
            and lookup_section_key(row.key) == folded
        ]
    return [
        row for row in store.values()
        if not row.retired and not _non_live(row) and row.kind == "section" and row.key == folded
    ]


def _resolve_folded_body(store: Mapping[str, PublishedSection], number: str):
    """The one live body row, None when it must not be served, or a sentinel.

    The sentinel means no body row of this number is stored, so schedule
    identity may still be tried. A tie, a retired row, and a non-live
    placeholder return None.
    """
    hits = _live_body_hits(store, number)
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        return None
    folded = lookup_section_key(number)
    for stored in store:
        if isinstance(stored, str) and _BARE_BODY_KEY.fullmatch(stored) and lookup_section_key(stored) == folded:
            return None
    return _NO_BODY_ROW


def lookup_real_section(store: Mapping[str, PublishedSection], number: str) -> Optional[PublishedSection]:
    """The live body section whose key is the real number ``number``.

    A schedule item, a content-addressed div, a retired row, and a numbered
    omission or repeal placeholder are not returned. The placeholder stays in
    the store. Two live rows with the same key cannot occur; zero or many
    matches return None so a tie is never broken by publish order. ``12-A`` is
    the same body key as ``12A``. ``12a`` is the same lookup as ``12A``
    (LOOKUP-003-001). The stored key is not rewritten. Two live rows that
    differ only by the suffix case are a tie.
    """
    wanted = canonical_section_number((number or "").strip())
    if not wanted:
        return None
    hits = _live_body_hits(store, wanted)
    if len(hits) != 1:
        return None
    return hits[0]


def section_by_key(
    store: Mapping[str, PublishedSection], key: str, *, label_mode: Optional[str] = None,
) -> Optional[PublishedSection]:
    """The live row for ``key``.

    An exact key wins. ``12-A`` is the same body key as ``12A``. ``12a`` is the
    same body key at lookup as ``12A`` (LOOKUP-003-001). Otherwise one
    live schedule row with the same canonical identity is that row. Zero or
    several matches return None, so two stored spellings are not collapsed by
    lookup order. Two live body rows that differ only by the suffix case are
    a tie. A single letter ``i``/``v``/``x``/``l``
    matches a number only when ``label_mode`` is ``roman``, and ``l`` then matches 50.
    A numbered placeholder is not current law and is not returned. The row stays
    in the store.
    """
    if isinstance(key, str):
        canonical = canonical_section_number(key)
        if _BARE_BODY_KEY.fullmatch(canonical or ""):
            resolved = _resolve_folded_body(store, canonical)
            if resolved is not _NO_BODY_ROW:
                return resolved
    key = canonical_section_number(key) if isinstance(key, str) else key
    row = store.get(key)
    if row is not None:
        if row.retired or _non_live(row):
            return None
        return row
    fold = label_mode if label_mode == "roman" else None
    ident = schedule_key_identity(key, mode=fold)
    hits = [
        candidate for stored, candidate in store.items()
        if not candidate.retired and not _non_live(candidate)
        and schedule_key_identity(stored, mode=fold) == ident
    ]
    if len(hits) != 1:
        return None
    return hits[0]


def note_section_version(metadata: Optional[Mapping], prior_text: str, new_text: str) -> dict:
    """Metadata for a staging row that amends an existing section.

    The same text leaves the metadata unchanged. A different text records the prior
    text's SHA-256 and bumps ``section_version`` (the first stored amendment is 2).
    """
    meta = dict(metadata or {})
    if (prior_text or "") == (new_text or ""):
        return meta
    meta["prior_section_text_sha256"] = hashlib.sha256((prior_text or "").encode("utf-8")).hexdigest()
    current = meta.get("section_version")
    try:
        version = int(current) if current is not None else 1
    except (TypeError, ValueError):
        version = 1
    meta["section_version"] = version + 1
    return meta


def act_keys_from_metadata(metadata: Optional[Mapping]) -> Optional[frozenset]:
    """The harvest key set stamped on a PakistanCode staging row, or None when absent."""
    if not isinstance(metadata, Mapping):
        return None
    raw = metadata.get("act_keys")
    if not isinstance(raw, (list, tuple)) or not raw:
        return None
    if not all(isinstance(key, str) and key for key in raw):
        return None
    return frozenset(raw)


def harvest_token_from_metadata(metadata: Optional[Mapping]) -> Optional[datetime]:
    """The harvest clock stamped on a staging row, or None when it is missing or naive.

    A naive timestamp is refused so two clocks cannot be ordered by accident.
    ``updated_at`` is not this value: a late publish of older text also happens now.
    """
    if not isinstance(metadata, Mapping):
        return None
    raw = metadata.get("harvest_at")
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip())
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed


def harvest_is_stale(incoming: Optional[datetime], stored_max: Optional[datetime]) -> bool:
    """An incoming harvest must not overwrite a newer clock already stored for the act.

    A missing stored clock is not stale by this comparator. It is also not permission
    to change existing rows: ``pre_clock_act`` is that guard. A stored clock with no
    incoming clock fails closed. Equal clocks are the same harvest and may attach.
    """
    if stored_max is None:
        return False
    if incoming is None:
        return True
    return incoming < stored_max


def pre_clock_act(row_count: int, stored_max: Optional[datetime]) -> bool:
    """True when master rows for the act exist and every ``harvest_at`` is NULL.

    ``max(harvest_at)`` becoming non-NULL does not by itself end this state for
    the siblings. ``snapshot_is_incomplete`` is that wider check. No timestamp
    is invented for these rows.
    """
    return row_count > 0 and stored_max is None


def snapshot_is_incomplete(null_rows: int) -> bool:
    """True while any master row of the act still has no harvest clock.

    One matching stamp dates that row only. Sibling text, repeal, insertion,
    and retirement stay unchanged until every existing row has its own clock.
    A refused same-clock sibling write is not a finding that the write is
    historically stale: the NULL rows have no stored history to compare.
    """
    return null_rows > 0


def keys_to_retire(
    existing_keys: Iterable[str], live_keys: Optional[Iterable[str]], current_key: str,
    *, label_mode: Optional[str] = None,
) -> list:
    """Keys a successful non-empty harvest retires.

    An empty or missing live set retires nothing (a failed or empty page must not wipe
    an act). ``current_key`` is the row being published and is never retired by itself.
    A live set that contains only schedule keys does not retire a body section, a
    preamble, an explanation, or an unscoped key. Those rows stay. Schedule keys that
    the set omits can still be retired: the schedule inventory named them as absent.
    A stored schedule key whose canonical identity is in the live set is not retired
    and is not treated as a different row. ``current_key`` is added after that
    schedule-only check, so publishing a body row whose stamped set is only schedule
    keys does not repeal its siblings. ``label_mode="roman"`` is required before a
    stored ``i``/``v``/``x``/``l`` is treated as the roman value. ``l`` is then 50,
    not the First Schedule.
    """
    if live_keys is None:
        return []
    live = {key for key in live_keys if isinstance(key, str) and key}
    if not live:
        return []
    schedule_only = all(is_schedule_publication_key(key) for key in live)
    if current_key:
        live.add(current_key)
    fold = label_mode if label_mode == "roman" else None
    live_ids = {schedule_key_identity(key, mode=fold) for key in live}
    retired = []
    for key in existing_keys:
        if not isinstance(key, str) or not key or key in live:
            continue
        if schedule_key_identity(key, mode=fold) in live_ids:
            continue
        if schedule_only and not is_schedule_publication_key(key):
            continue
        retired.append(key)
    return sorted(retired)


# --- legacy prefix rekey (dry-run / in-memory apply; no database) ---------------------------------

ACTION_REKEY = "rekey"
ACTION_UNCHANGED = "unchanged"
ACTION_NEEDS_REHARVEST = "needs_reharvest"
ACTION_CONFLICT = "conflict"


@dataclass(frozen=True)
class RekeyAction:
    row_id: str
    short_name: str
    old_key: str
    new_key: Optional[str]
    action: str
    reason: str


def _is_legacy_prefix(section_number: str, section_text: str) -> bool:
    return (
        isinstance(section_number, str)
        and isinstance(section_text, str)
        and len(section_number) == LEGACY_PREFIX_CHARS
        and section_text[:LEGACY_PREFIX_CHARS] == section_number
        and len(section_text) > LEGACY_PREFIX_CHARS
    )


def _single_div_key(section_text: str) -> Optional[str]:
    """The key of this text alone, without sibling schedule scope."""
    result = key_div_texts([section_text])
    if len(result.sections) != 1:
        return None
    return result.sections[0].key


def plan_legacy_rekey(rows: Sequence[Mapping]) -> list:
    """Plan for rows whose ``section_number`` is the legacy 20-character text prefix.

    A content-addressed key (preamble, explanation, other numberless div, schedule
    heading) is rekeyed when no other row in the same short name wants that key.
    A bare section number is ``needs_reharvest``: one stored text cannot prove
    schedule scope, and this plan never turns a schedule item into section ``1``.
    Two rows that want the same new key are ``conflict`` and are not written.
    Rows that are not PakistanCode, or are not legacy prefixes, are ``unchanged``.
    The input rows are not modified.
    """
    targets: list = []
    for index, row in enumerate(rows):
        row_id = str(row.get("id", index))
        short_name = str(row.get("short_name") or "")
        old_key = row.get("section_number") if isinstance(row.get("section_number"), str) else ""
        source = row.get("source_site")
        text = row.get("section_text") if isinstance(row.get("section_text"), str) else ""
        if source != PAKISTANCODE_SOURCE or not _is_legacy_prefix(old_key, text):
            targets.append((row_id, short_name, old_key, None, ACTION_UNCHANGED, "not a PakistanCode text-prefix key"))
            continue
        new_key = _single_div_key(text)
        if new_key is None:
            targets.append((row_id, short_name, old_key, None, ACTION_NEEDS_REHARVEST, "text did not key as one div"))
            continue
        if new_key == old_key:
            targets.append((row_id, short_name, old_key, new_key, ACTION_UNCHANGED, "already the computed key"))
            continue
        if parse_section_number(normalise_div_text(text)) is not None and "-" not in new_key and "~" not in new_key:
            targets.append((
                row_id, short_name, old_key, new_key, ACTION_NEEDS_REHARVEST,
                "bare section number needs a re-harvest so schedule scope is known",
            ))
            continue
        targets.append((row_id, short_name, old_key, new_key, ACTION_REKEY, "content-addressed key replaces the text prefix"))

    claimed: dict = {}
    for item in targets:
        _row_id, short_name, _old, new_key, action, _reason = item
        if action == ACTION_REKEY and new_key is not None:
            claimed.setdefault((short_name, new_key), []).append(item[0])
    collisions = {pair for pair, ids in claimed.items() if len(ids) > 1}

    plan = []
    for row_id, short_name, old_key, new_key, action, reason in targets:
        if action == ACTION_REKEY and (short_name, new_key) in collisions:
            action = ACTION_CONFLICT
            reason = "another row of this short name computes the same key; left unchanged"
        plan.append(RekeyAction(
            row_id=row_id, short_name=short_name, old_key=old_key, new_key=new_key, action=action, reason=reason,
        ))
    return plan


def apply_legacy_rekey(rows: Sequence[Mapping], plan: Sequence[RekeyAction]) -> list:
    """A new row list with ``rekey`` actions applied. Input rows are not modified.

    ``unchanged``, ``needs_reharvest`` and ``conflict`` write nothing. Applying the
    plan of an already-applied list is a no-op.
    """
    by_id = {}
    for action in plan:
        if action.action == ACTION_REKEY and action.new_key:
            by_id.setdefault(action.row_id, action.new_key)
    updated = []
    for index, row in enumerate(rows):
        copy = dict(row)
        row_id = str(row.get("id", index))
        if row_id in by_id:
            copy["section_number"] = by_id[row_id]
        updated.append(copy)
    return updated
