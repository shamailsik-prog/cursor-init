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
   recognised before the short-div skip, so an 18-character heading is kept.
2. Any other div of 20 characters or fewer is skipped. It is not staged and it does not
   consume the 50-div cap. A div of 21 characters is kept. ``len`` is Unicode characters.
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

   * unique body section number ``N`` → ``N`` (stable when the text is amended)
   * repeated body number ``N`` → ``N-<sha8>`` of the stored text
   * schedule item ``N`` under label ``L`` → ``schedule:L:N`` (or with ``-<sha8>`` when
     that schedule repeats ``N``)
   * schedule heading → ``schedule-heading:L``
   * numbered div under an unopened flat heading → ``unscoped:N-<sha8>``
   * preamble / explanation / other numberless div → ``<kind>-<sha8>``
   * a second kept div that would otherwise reuse a key → ``<key>~2``, ``~3``, …

   ``<sha8>`` is the first 8 hex characters of SHA-256 of the stored text (capped at
   20_000 characters). Sibling insert, reorder, or deletion of a *different* text does
   not change these keys. Amending a unique numbered section keeps ``N`` and records
   another version. Amending a content-addressed div changes that div's key only.

6. Lookup by a real section number is equality on the unique body key ``N``. A schedule
   item is not that key. An ``unscoped`` div is not that key. A retired key is not returned.
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

The paragraph splitter is outside this div walk (FA-F21-019). A repeated paragraph
number is kept as ``N-<sha8>`` of each stored text, not dropped. That harvest stamps
``act_keys`` when it parsed those sections. It omits the set for an ``unscoped`` div,
a page of only schedule headings, and an unparsed single chunk. A ``schedule-item``
does not reach that path: kept schedule items suppress the splitter and are staged
on the div path, which includes them in ``act_keys`` when the inventory is complete.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Mapping, Optional, Sequence

# A div longer than this is content. Length == 20 is still short and is skipped
# unless rule 1 recognised a heading. FA-F21-010 / FA-F21-011.
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
_SCHEDULE_ITEM_BODY = re.compile(r"^(?P<label>.+):(?P<item>\d+[A-Za-z]?(?:-[0-9a-f]{8})?)$")
_NUMBER_RE = re.compile(
    r"^(?:(?:section|sec\.|s\.)\s+)?(?P<num>\d+[A-Za-z]?)[\.\)\:\-\u2013\u2014]\s*",
    re.IGNORECASE,
)
_STRUCTURAL_KIND = re.compile(r"^(preamble|explanation)\b", re.IGNORECASE)
_WS = re.compile(r"\s+")
# Single letters that are both a roman numeral and a schedule letter. C, D and M
# are letters only: a one-character roman is not read from them.
_AMBIGUOUS_SINGLE = frozenset({"i", "v", "x", "l"})
_ROMAN_SINGLE_VALUE = {"i": "1", "v": "5", "x": "10", "l": "50"}


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


def parse_section_number(text: str) -> Optional[str]:
    """The section or item number at the start of ``text``, without the punctuation."""
    matched = _NUMBER_RE.match(text or "")
    if matched is None:
        return None
    return matched.group("num")


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


def _classify(texts: Sequence[str], containers: Optional[Sequence[Optional[str]]] = None) -> tuple:
    """Kept divs in order, plus how many short non-headings were skipped, plus the mode."""
    mode = schedule_evidence_mode(_collect_heading_tokens(texts, containers))
    kept: list[_Classified] = []
    skipped = 0
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
        if len(text) <= SHORT_DIV_MAX_EXCLUSIVE and _structural_kind(text) is None:
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
    if item.kind == "unscoped" and item.number is not None:
        return f"unscoped:{item.number}-{content_token(item.text)}"
    if item.kind == "preamble":
        return f"preamble-{content_token(item.text)}"
    if item.kind == "explanation":
        return f"explanation-{content_token(item.text)}"
    return f"div-{content_token(item.text)}"


_FALLBACK_SUPPRESSED_KINDS = frozenset({
    "section", "schedule-item", "preamble", "explanation", "div", "unscoped", "schedule-unresolved",
})
# ``unscoped`` is a numbered div with no proven parent: a flat heading before any body
# section, and no ancestor heading. It stays withheld (FA-17). A schedule item already
# carries that parent label and is published under ``schedule:L:N``.
# ``schedule-unresolved`` is a heading whose single letter I/V/X/L has no roman or
# letter proof, or a schedule on a page whose evidence is mixed (R-LETTER-ROMAN-001).
PUBLISHABLE_SECTION_KINDS = frozenset({
    "section", "preamble", "explanation", "div", "schedule-heading", "schedule-item",
})
AMBIGUOUS_SECTION_KINDS = frozenset({"unscoped", "schedule-unresolved"})
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

    ``unscoped`` keeps ``ambiguous_section_identity``. An unresolved schedule letter
    uses ``schedule_letter_roman_ambiguous`` so the two holds stay distinct.
    """
    if kind == "unscoped":
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
    classified, skipped, mode = _classify(texts, containers)
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


@dataclass
class HarvestDelta:
    inserted: list = field(default_factory=list)
    amended: list = field(default_factory=list)
    unchanged: list = field(default_factory=list)
    retired: list = field(default_factory=list)


def apply_harvest(store: dict, sections: Sequence[KeyedDiv], *, label_mode: Optional[str] = None) -> HarvestDelta:
    """Publish ``sections`` onto ``store``.

    A new key is inserted once. The same key, or a schedule key with the same canonical
    identity, and the same text is unchanged. New text appends a version and keeps the
    stored key. The stored schedule key is not rewritten. A retired row with that
    identity is revived on the stored key, versions included. A live key whose identity is
    absent from this harvest is retired. A harvest whose keys are all schedule keys
    does not retire a body section: adding a schedule is not an inventory that repeals
    the act. Two rows that already share one schedule identity are left as they
    are: this harvest does not pick one, insert a third, or retire them. No second row
    is created for an existing identity, and an unchanged text is not written again.
    ``label_mode="roman"`` is the sibling proof that lets a stored ``i``/``v``/``x``/``l``
    share the roman value. Without it those letters stay letters, and ``l`` never
    shares the First Schedule.
    """
    delta = HarvestDelta()
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
    blocked = any(section_kind_is_ambiguous(section.kind) for section in sections)
    for section in sections:
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
            )
            by_identity[ident] = section.key
            delta.inserted.append(section.key)
            continue
        current.retired = False
        current.kind = section.kind
        current.lookup_number = section.lookup_number
        current.title = section.title
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


def lookup_real_section(store: Mapping[str, PublishedSection], number: str) -> Optional[PublishedSection]:
    """The live body section whose key is the real number ``number``.

    A schedule item, a content-addressed div, and a retired row are not returned.
    Two live rows with the same key cannot occur; zero or many matches return None
    so a tie is never broken by publish order.
    """
    wanted = (number or "").strip()
    if not wanted:
        return None
    hits = [
        row for row in store.values()
        if not row.retired and row.kind == "section" and row.key == wanted
    ]
    if len(hits) != 1:
        return None
    return hits[0]


def section_by_key(
    store: Mapping[str, PublishedSection], key: str, *, label_mode: Optional[str] = None,
) -> Optional[PublishedSection]:
    """The live row for ``key``.

    An exact key wins. Otherwise one live schedule row with the same canonical
    identity is that row. Zero or several matches return None, so two stored
    spellings are not collapsed by lookup order. A single letter ``i``/``v``/``x``/``l``
    matches a number only when ``label_mode`` is ``roman``, and ``l`` then matches 50.
    """
    row = store.get(key)
    if row is not None:
        if row.retired:
            return None
        return row
    fold = label_mode if label_mode == "roman" else None
    ident = schedule_key_identity(key, mode=fold)
    hits = [
        candidate for stored, candidate in store.items()
        if not candidate.retired and schedule_key_identity(stored, mode=fold) == ident
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
