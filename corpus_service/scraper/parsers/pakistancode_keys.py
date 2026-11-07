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
7. An empty live key set never retires existing rows. The key being published is never
   retired by its own harvest set.
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

_ORDINAL = (
    r"first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|"
    r"\d+(?:st|nd|rd|th)|[ivxlcdm]{1,8}"
)
_SCHEDULE_HEADING = re.compile(
    rf"^(?:the\s+)?(?:(?P<lead>{_ORDINAL})\s+)?schedule(?:\s+(?P<trail>{_ORDINAL}))?$",
    re.IGNORECASE,
)
_NUMBER_RE = re.compile(
    r"^(?:(?:section|sec\.|s\.)\s+)?(?P<num>\d+[A-Za-z]?)[\.\)\:\-\u2013\u2014]\s*",
    re.IGNORECASE,
)
_STRUCTURAL_KIND = re.compile(r"^(preamble|explanation)\b", re.IGNORECASE)
_WS = re.compile(r"\s+")


def normalise_div_text(text: str) -> str:
    """The div text the key is computed from: collapsed whitespace, then the storage cap."""
    collapsed = _WS.sub(" ", text or "").strip()
    return collapsed[:TEXT_CAP]


def content_token(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:SHA_CHARS]


def schedule_label(text: str) -> Optional[str]:
    """The schedule label when ``text`` is only a schedule heading, else None.

    The whole div must be the heading. A longer div that starts with a structural
    word is not a heading and does not open schedule scope.
    """
    cleaned = _WS.sub(" ", text or "").strip().rstrip(".").strip()
    matched = _SCHEDULE_HEADING.fullmatch(cleaned)
    if matched is None:
        return None
    token = matched.group("lead") or matched.group("trail") or "schedule"
    return token.lower()


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
        label = schedule_label(" ".join(parts))
        if label:
            return label
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


def _classify(texts: Sequence[str], containers: Optional[Sequence[Optional[str]]] = None) -> tuple:
    """Kept divs in order, plus how many short non-headings were skipped."""
    kept: list[_Classified] = []
    skipped = 0
    schedule: Optional[str] = None
    body_seen = False
    heading_before_body = False
    for index, raw in enumerate(texts):
        text = normalise_div_text(raw)
        container = None
        if containers is not None:
            container = containers[index] or None
        label = schedule_label(text)
        if label is not None:
            if body_seen:
                schedule = label
            else:
                heading_before_body = True
                schedule = None
            kept.append(_Classified(text=text, kind="schedule-heading", number=None, label=label))
            continue
        if len(text) <= SHORT_DIV_MAX_EXCLUSIVE and _structural_kind(text) is None:
            skipped += 1
            continue
        number = parse_section_number(text)
        open_label = container or schedule
        if number is not None and open_label is not None:
            kept.append(_Classified(text=text, kind="schedule-item", number=number, label=open_label))
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
    return kept, skipped


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
    if item.kind == "unscoped" and item.number is not None:
        return f"unscoped:{item.number}-{content_token(item.text)}"
    if item.kind == "preamble":
        return f"preamble-{content_token(item.text)}"
    if item.kind == "explanation":
        return f"explanation-{content_token(item.text)}"
    return f"div-{content_token(item.text)}"


_FALLBACK_SUPPRESSED_KINDS = frozenset({"section", "schedule-item", "preamble", "explanation", "div", "unscoped"})


def suppresses_plain_text_fallback(result: DivKeyingResult) -> bool:
    """True when kept divs already carry the page's sections.

    A page of only schedule headings does not suppress the paragraph fallback.
    Headings are still staged by the caller. A page with no kept div does not
    suppress it either. That is the same no-div and all-short-div reach as the
    harvester had before FA-F21-017.
    """
    return any(item.kind in _FALLBACK_SUPPRESSED_KINDS for item in result.sections)


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
    classified, skipped = _classify(texts, containers)
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
    return DivKeyingResult(sections=tuple(sections), skipped_short=skipped, dropped_by_cap=dropped)


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


def apply_harvest(store: dict, sections: Sequence[KeyedDiv]) -> HarvestDelta:
    """Publish ``sections`` onto ``store``.

    A new key is inserted once. The same key with the same text is unchanged. The same
    key with new text appends a version and keeps the key (the numbered-section rule).
    A live key absent from this harvest is retired. No second row is created for an
    existing key, and an unchanged text is not written again.
    """
    delta = HarvestDelta()
    seen = set()
    for section in sections:
        seen.add(section.key)
        current = store.get(section.key)
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
            delta.inserted.append(section.key)
            continue
        current.retired = False
        current.kind = section.kind
        current.lookup_number = section.lookup_number
        current.title = section.title
        if current.text != section.text:
            current.versions.append(section.text)
            current.text = section.text
            delta.amended.append(section.key)
        else:
            delta.unchanged.append(section.key)
    for key, row in store.items():
        if key not in seen and not row.retired:
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


def section_by_key(store: Mapping[str, PublishedSection], key: str) -> Optional[PublishedSection]:
    row = store.get(key)
    if row is None or row.retired:
        return None
    return row


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
    """An incoming harvest must not overwrite a newer one already stored for the act.

    No stored clock means nothing has won yet. A stored clock with no incoming clock
    fails closed. Equal clocks are the same harvest and may attach.
    """
    if stored_max is None:
        return False
    if incoming is None:
        return True
    return incoming < stored_max


def keys_to_retire(existing_keys: Iterable[str], live_keys: Optional[Iterable[str]], current_key: str) -> list:
    """Keys a successful non-empty harvest retires.

    An empty or missing live set retires nothing (a failed or empty page must not wipe
    an act). ``current_key`` is the row being published and is never retired by itself.
    """
    if live_keys is None:
        return []
    live = {key for key in live_keys if isinstance(key, str) and key}
    if not live:
        return []
    if current_key:
        live.add(current_key)
    return sorted(key for key in existing_keys if isinstance(key, str) and key and key not in live)


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
