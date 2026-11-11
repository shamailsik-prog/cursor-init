"""DATA-003-REHARVEST. Re-key stored sections whose hyphen suffix was dropped.

PR233 through PR238 fixed PakistanCode section keying. Before PR237 a heading
``12-A.`` was stored as section ``12``. ``12-B`` was stored as ``12``. A wrapped
``12-I`` line could be stored as ``12`` and, keyed alone, the current keyer
publishes it as ``12I``. Beside its host section the same line is not a section.

This module plans that repair from an export of stored rows. It does not open a
database connection. The default is a dry run. ``--apply`` rewrites keys only,
inside a transaction, after ``--expect-count`` and the exact id list match the
plan. It writes a backup JSONL and a rollback script. It does not delete rows.
Any collision refuses the apply and rolls the transaction back.

The stored section text is the source. The harvester does not keep a separate
pinned copy of an act page. When a row carries ``raw_text`` or ``pinned_source``
and that value equals ``section_text``, the plan records the source as pinned.
When the two differ, the row is not re-keyed.

The export query below is read-only. It returns every section of an act that
has at least one heading or body opening with a digit, a hyphen, and a letter
suffix, where the stored key does not already carry that suffix. The whole act
is required: keying the wrapped line on its own publishes ``12I``.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Optional, Sequence

from scraper.parsers.pakistancode_keys import (
    MAX_STAGED_DIVS,
    act_keys_from_metadata,
    is_amendment_footnote,
    is_schedule_publication_key,
    key_div_texts,
    lookup_section_key,
    normalise_div_text,
    omission_placeholder_status,
    parse_section_number,
    space_hyphen_suffix_key,
)

FINDING = "DATA-003-REHARVEST"
TABLE_MASTER = "statutes_master"
TABLE_STAGING = "statutes_staging"
KEY_COLUMN = {
    TABLE_MASTER: "section_number",
    TABLE_STAGING: "extracted_section_number",
}
TEXT_COLUMN = {
    TABLE_MASTER: "section_text",
    TABLE_STAGING: "extracted_section_text",
}
TEMP_PREFIX = "data003-rekey-"
_BARE_KEY = re.compile(r"^\d+[A-Z]{0,4}$")
_SAFE_ID = re.compile(r"^[0-9a-fA-F-]{8,80}$")
_SAFE_KEY = re.compile(r"^[0-9A-Za-z:~._-]{1,100}$")
_HYPHEN_START = re.compile(r"^\s*\d+[\u2013\u2014-]")
_WRITE_SQL = re.compile(
    r"\b(insert|update|delete|drop|alter|truncate|grant|revoke|create)\b",
    re.IGNORECASE,
)


class ReharvestRefusal(RuntimeError):
    """The apply did not run. The caller's rows are unchanged."""


@dataclass(frozen=True)
class RowDiff:
    """One stored section after the current keyer has been run on its act."""

    id: str
    table: str
    act: str
    old_key: str
    new_key: Optional[str]
    action: str
    text_md5: str
    text_md5_unchanged: bool
    source: str
    reason: str

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "table": self.table,
            "act": self.act,
            "old_key": self.old_key,
            "new_key": self.new_key,
            "action": self.action,
            "text_md5": self.text_md5,
            "text_md5_unchanged": self.text_md5_unchanged,
            "source": self.source,
            "reason": self.reason,
        }


@dataclass
class ActPlan:
    act: str
    table: str
    before_count: int
    apply_allowed: bool
    rows: list = field(default_factory=list)
    refusal: Optional[str] = None
    act_keys: Optional[tuple] = None
    prior_act_keys: Optional[tuple] = None

    def as_dict(self) -> dict:
        return {
            "act": self.act,
            "table": self.table,
            "before_count": self.before_count,
            "apply_allowed": self.apply_allowed,
            "refusal": self.refusal,
            "act_keys": None if self.act_keys is None else list(self.act_keys),
            "rows": [row.as_dict() for row in self.rows],
        }


@dataclass(frozen=True)
class RekeyAction:
    id: str
    table: str
    act: str
    old_key: str
    new_key: str
    text_md5: str
    section_text: str
    act_keys: Optional[tuple] = None
    prior_act_keys: Optional[tuple] = None


@dataclass(frozen=True)
class InventoryUpdate:
    """A sibling whose key stays put while its ``act_keys`` list is rewritten."""

    id: str
    table: str
    key: str
    text_md5: str
    act_keys: tuple
    prior_act_keys: tuple


def text_md5(text: str) -> str:
    """Checksum of the stored section text. The apply does not change that text."""
    return hashlib.md5((text or "").encode("utf-8"), usedforsecurity=False).hexdigest()


def suffix_key_of(text: str) -> Optional[str]:
    """Glued suffix when ``text`` opens with ``N-X``, else None.

    ``12-A.`` and ``12-A Title`` are ``12A``. ``12-AA`` is ``12AA``. ``12-Fees``
    and a glued ``12A.`` are not this shape. ``12-I Pakistan`` is ``12I`` here;
    the act keyer decides whether that line is a section.
    """
    normalised = normalise_div_text(text or "")
    if not normalised or _HYPHEN_START.match(normalised) is None:
        return None
    spaced = space_hyphen_suffix_key(normalised)
    if spaced:
        return spaced
    parsed = parse_section_number(normalised)
    if parsed and re.fullmatch(r"\d+[A-Za-z]{1,4}", parsed):
        return parsed
    return None


def lacks_suffix(stored_key: str, suffix: str) -> bool:
    """True when the stored key is not already the glued suffix.

    ``12A`` and ``12A-<token>`` already carry it. A glued ``12a`` is the key
    LOOKUP-003 kept, so it is not treated as missing ``12A``. ``12`` and
    ``12-<token>`` lack it.
    """
    stored = (stored_key or "").strip()
    if not stored or not suffix:
        return False
    if stored == suffix or stored.startswith(suffix + "-") or stored.startswith(suffix + "~"):
        return False
    if stored.lower() == suffix.lower() and re.fullmatch(r"\d+[A-Za-z]{1,4}", stored):
        return False
    return True


def is_candidate(row: Mapping) -> bool:
    """True when the heading or the body opens with ``N-X`` and the key lacks it."""
    suffix = suffix_key_of(str(row.get("section_text") or ""))
    if suffix is None:
        suffix = suffix_key_of(str(row.get("section_title") or ""))
    if suffix is None:
        return False
    return lacks_suffix(str(row.get("section_number") or ""), suffix)


def _repeated_letters_sql() -> str:
    parts = [f"{letter}{{2,4}}" for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"]
    return "|".join(parts)


def _candidate_predicate(text_column: str, title_column: str, key_column: str) -> str:
    """POSIX predicate. Read-only. A superset check is not required: the letters
    are the keyer's suffix, and a key that already ends in those letters is out.
    """
    one = r"[0-9]+[—–-]([A-Za-z])([^A-Za-z]|$)"
    many = r"[0-9]+[—–-](" + _repeated_letters_sql() + r")([^A-Za-z]|$)"
    text_hit = (
        f"(coalesce({text_column}, '') ~ '^[[:space:]]*{one}'"
        f" OR coalesce({text_column}, '') ~ '^[[:space:]]*{many}'"
        f" OR coalesce({title_column}, '') ~ '^[[:space:]]*{one}'"
        f" OR coalesce({title_column}, '') ~ '^[[:space:]]*{many}')"
    )
    lacks = (
        f"coalesce({key_column}, '') !~ '^[0-9]+[A-Za-z]{{1,4}}$'"
        f" AND coalesce({key_column}, '') !~ '^[0-9]+[A-Za-z]{{1,4}}[-~]'"
    )
    return f"{text_hit}\n  AND {lacks}"


def _act_expr(short_column: str, name_column: str) -> str:
    return (
        f"coalesce(nullif(btrim({short_column}), ''), {name_column})"
    )


def _stale_twelve_predicate(text_column: str, title_column: str, key_column: str) -> str:
    """A stored key ``12`` whose heading is ``12-A`` / ``12-B`` / ``12-I.``."""
    opening = r"12[—–-][A-Za-z]"
    return (
        "btrim(coalesce(" + key_column + ", '')) = '12'\n"
        "  AND (coalesce(" + text_column + ", '') ~ '^[[:space:]]*" + opening + "'"
        " OR coalesce(" + title_column + ", '') ~ '^[[:space:]]*" + opening + "')"
    )


def count_sql() -> str:
    """Per-act counts of stored rows the selector still matches.

    Run it before the apply and again after. A re-keyed ``12A`` drops out.
    A wrapped line that was not re-keyed stays in the count. The last two
    statements count the stale bare key ``12`` on its own.
    """
    master_act = _act_expr("short_name", "statute_name")
    master_where = _candidate_predicate("section_text", "section_title", "section_number")
    staging_act = _act_expr("extracted_short_name", "extracted_act_name")
    staging_where = _candidate_predicate(
        "extracted_section_text", "extracted_section_title", "extracted_section_number",
    )
    stale_master = _stale_twelve_predicate("section_text", "section_title", "section_number")
    stale_staging = _stale_twelve_predicate(
        "extracted_section_text", "extracted_section_title", "extracted_section_number",
    )
    return (
        "-- DATA-003-REHARVEST before/after counts. Read only.\n"
        "SELECT " + master_act + " AS act, count(*) AS affected\n"
        "FROM statutes_master\n"
        "WHERE " + master_where + "\n"
        "GROUP BY 1\n"
        "ORDER BY 1;\n"
        "\n"
        "SELECT " + staging_act + " AS act, count(*) AS affected\n"
        "FROM statutes_staging\n"
        "WHERE " + staging_where + "\n"
        "GROUP BY 1\n"
        "ORDER BY 1;\n"
        "\n"
        "-- Stale stored key 12. Read only. Not an apply.\n"
        "SELECT " + master_act + " AS act, count(*) AS stale_12\n"
        "FROM statutes_master\n"
        "WHERE " + stale_master + "\n"
        "GROUP BY 1\n"
        "ORDER BY 1;\n"
        "\n"
        "SELECT " + staging_act + " AS act, count(*) AS stale_12\n"
        "FROM statutes_staging\n"
        "WHERE " + stale_staging + "\n"
        "GROUP BY 1\n"
        "ORDER BY 1;\n"
    )


def _json_ordinal(meta: str, key: str) -> str:
    """An integer stored as text. A missing or non-numeric value is null, not an error."""
    raw = meta + "->>'" + key + "'"
    return "CASE WHEN " + raw + " ~ '^[0-9]+$' THEN (" + raw + ")::integer ELSE NULL END"


def _metadata_ordinal(meta: str, key_column: str) -> str:
    """``source_ordinal``, then ``page_offset``, then the 1-based ``act_keys`` position."""
    position = (
        "CASE WHEN jsonb_typeof(" + meta + "->'act_keys') = 'array' THEN "
        "array_position(ARRAY(SELECT jsonb_array_elements_text(" + meta + "->'act_keys')), "
        + key_column + ") ELSE NULL END"
    )
    return "COALESCE(" + _json_ordinal(meta, "source_ordinal") + ", " + _json_ordinal(meta, "page_offset") + ", " + position + ")"


def _staging_ordinal_expr(alias: str) -> str:
    """Page offset, or the harvest's own ``act_keys`` position. Not ``created_at``."""
    return _metadata_ordinal(alias + ".parsing_metadata", alias + ".extracted_section_number")


def _master_ordinal_expr() -> str:
    """The staging row's ordinal for this master text. Never ``id`` or ``created_at``.

    One distinct ordinal is kept. None, or two that disagree, is null, and the
    planner then refuses the act.
    """
    master_act = _act_expr("m.short_name", "m.statute_name")
    staging_act = _act_expr("s.extracted_short_name", "s.extracted_act_name")
    ordinal = _metadata_ordinal("s.parsing_metadata", "s.extracted_section_number")
    return (
        "(SELECT CASE WHEN count(DISTINCT sourced.ord) = 1 THEN min(sourced.ord) ELSE NULL END\n"
        "          FROM (\n"
        "            SELECT " + ordinal + " AS ord\n"
        "            FROM statutes_staging AS s\n"
        "            WHERE " + staging_act + " = " + master_act + "\n"
        "              AND s.extracted_section_text IS NOT DISTINCT FROM m.section_text\n"
        "              AND m.section_text IS NOT NULL\n"
        "          ) AS sourced\n"
        "          WHERE sourced.ord IS NOT NULL)"
    )


def select_act_sql() -> str:
    """Every stored section of an act that has a candidate row.

    Keying a wrapped ``12-I`` line without the rest of the act publishes ``12I``.
    Document order is a staging ordinal: ``source_ordinal``, ``page_offset``, or
    the position of the staging key in ``act_keys``. A master row takes that
    ordinal from the staging row with the same act and the same section text.
    ``id`` and ``created_at`` are not that order. A null or disagreeing ordinal
    is refused by the planner.
    """
    master_act = _act_expr("m.short_name", "m.statute_name")
    master_where = _candidate_predicate("section_text", "section_title", "section_number")
    staging_act = _act_expr("s.extracted_short_name", "s.extracted_act_name")
    staging_where = _candidate_predicate(
        "extracted_section_text", "extracted_section_title", "extracted_section_number",
    )
    return (
        "-- DATA-003-REHARVEST export. Read only. No writes.\n"
        "-- Master ordinal is the matching staging source_ordinal, page_offset, or act_keys position.\n"
        "WITH affected AS (\n"
        "  SELECT DISTINCT " + _act_expr("short_name", "statute_name") + " AS act\n"
        "  FROM statutes_master\n"
        "  WHERE " + master_where + "\n"
        ")\n"
        "SELECT m.id::text AS id,\n"
        "       'statutes_master' AS \"table\",\n"
        "       m.short_name,\n"
        "       m.statute_name,\n"
        "       m.section_number,\n"
        "       m.section_title,\n"
        "       m.section_text,\n"
        "       NULL::text AS raw_text,\n"
        "       NULL::jsonb AS parsing_metadata,\n"
        "       " + _master_ordinal_expr() + " AS ordinal\n"
        "FROM statutes_master AS m\n"
        "JOIN affected AS a ON a.act = " + master_act + "\n"
        "ORDER BY a.act, ordinal;\n"
        "\n"
        "WITH affected AS (\n"
        "  SELECT DISTINCT " + _act_expr("extracted_short_name", "extracted_act_name") + " AS act\n"
        "  FROM statutes_staging\n"
        "  WHERE " + staging_where + "\n"
        ")\n"
        "SELECT s.id::text AS id,\n"
        "       'statutes_staging' AS \"table\",\n"
        "       s.extracted_short_name AS short_name,\n"
        "       s.extracted_act_name AS statute_name,\n"
        "       s.extracted_section_number AS section_number,\n"
        "       s.extracted_section_title AS section_title,\n"
        "       s.extracted_section_text AS section_text,\n"
        "       s.raw_text,\n"
        "       s.parsing_metadata,\n"
        "       " + _staging_ordinal_expr("s") + " AS ordinal\n"
        "FROM statutes_staging AS s\n"
        "JOIN affected AS a ON a.act = " + staging_act + "\n"
        "ORDER BY a.act, ordinal;\n"
    )


def sql_is_read_only(sql: str) -> bool:
    """True when the statement bundle has no write keyword."""
    stripped = re.sub(r"--[^\n]*", "", sql)
    return _WRITE_SQL.search(stripped) is None


def _table_of(raw: Mapping) -> str:
    table = str(raw.get("table") or TABLE_MASTER)
    if table not in KEY_COLUMN:
        raise ReharvestRefusal(f"unknown table {table}")
    return table


def normalise_row(raw: Mapping) -> dict:
    """One export object. Master and staging column names both load."""
    table = _table_of(raw)
    if table == TABLE_STAGING:
        text = raw.get("section_text", raw.get("extracted_section_text"))
        key = raw.get("section_number", raw.get("extracted_section_number"))
        title = raw.get("section_title", raw.get("extracted_section_title"))
        short = raw.get("short_name", raw.get("extracted_short_name"))
        name = raw.get("statute_name", raw.get("extracted_act_name"))
    else:
        text = raw.get("section_text")
        key = raw.get("section_number")
        title = raw.get("section_title")
        short = raw.get("short_name")
        name = raw.get("statute_name")
    pinned = raw.get("pinned_source", raw.get("raw_text"))
    row_id = str(raw.get("id") or "").strip()
    if not row_id:
        raise ReharvestRefusal("a row has no id")
    metadata = raw.get("parsing_metadata")
    if metadata is None:
        metadata = None
    elif not isinstance(metadata, Mapping):
        raise ReharvestRefusal(f"parsing_metadata on {row_id} is not an object")
    else:
        metadata = copy.deepcopy(dict(metadata))
    return {
        "id": row_id,
        "table": table,
        "short_name": ("" if short is None else str(short)).strip(),
        "statute_name": ("" if name is None else str(name)).strip(),
        "section_number": "" if key is None else str(key),
        "section_title": "" if title is None else str(title),
        "section_text": "" if text is None else str(text),
        "raw_text": None if pinned is None else str(pinned),
        "ordinal": _read_ordinal(raw),
        "parsing_metadata": metadata,
    }


def _act_of(row: Mapping) -> str:
    return row["short_name"] or row["statute_name"] or ""


def _source(row: Mapping) -> tuple:
    stored = row["section_text"]
    pinned = row.get("raw_text")
    if pinned is None:
        return stored, "stored_text"
    if pinned == stored:
        return stored, "pinned_source"
    return stored, "pinned_source_differs"


def _read_ordinal(raw: Mapping):
    """The first source ordinal the export actually carries. ``created_at`` is not one."""
    for key in ("ordinal", "source_ordinal", "page_offset"):
        if key in raw:
            return raw.get(key)
    return None


def _ordinal_number(row: Mapping) -> Optional[int]:
    """A non-negative page or staging ordinal. Anything else is not document order."""
    value = row.get("ordinal")
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and re.fullmatch(r"[0-9]+", value.strip() or ""):
        number = int(value.strip())
    else:
        return None
    if number < 0:
        return None
    return number


def collision_identity(key: str) -> str:
    """The identity ``lookup_section_key`` uses for a bare body key.

    ``12a`` and ``12A`` are one key. A schedule key and a content-addressed key
    stay as stored. This is the lookup fold, not a second spelling.
    """
    if not key or is_schedule_publication_key(key):
        return key or ""
    folded = lookup_section_key(key)
    if _BARE_KEY.fullmatch(folded or ""):
        return folded
    return key


def _in_scope(row: Mapping, new_key: str) -> bool:
    if _BARE_KEY.fullmatch(new_key or "") is None:
        return False
    text = row["section_text"]
    if suffix_key_of(text) or suffix_key_of(row.get("section_title") or ""):
        return True
    if is_amendment_footnote(text) or omission_placeholder_status(text):
        return True
    return False


def _body_count(rows: Sequence[Mapping]) -> int:
    count = 0
    for row in rows:
        if parse_section_number(normalise_div_text(row["section_text"])):
            count += 1
    return count


def _align(rows: Sequence[dict], sections) -> list:
    """Pair each stored row with the keyer section whose text is that row.

    A wrapped line joined onto its host is a span longer than one row. A
    footnote the keyer drops stays unused. Spans run in document order.
    """
    norms = [normalise_div_text(row["section_text"]) for row in rows]
    assigned = [None] * len(rows)
    cursor = 0
    for section in sections:
        found = None
        for start in range(cursor, len(rows)):
            joined = ""
            for end in range(start, len(rows)):
                piece = norms[end]
                joined = piece if not joined else joined + " " + piece
                if joined == section.text:
                    found = (start, end, section)
                    break
                if not section.text.startswith(joined):
                    break
            if found is not None:
                break
        if found is None:
            return None
        start, end, section = found
        for index in range(start, end + 1):
            assigned[index] = (section, end - start + 1)
        cursor = end + 1
    return assigned


def _order_act(rows: Sequence[dict]) -> tuple:
    """Sort by source ordinal. Missing or repeated ordinals are not an order."""
    numbers = [_ordinal_number(row) for row in rows]
    if any(number is None for number in numbers):
        return None, "no trustworthy source ordinal"
    if len(set(numbers)) != len(numbers):
        return None, "source ordinals are not unique"
    ordered = [row for _number, row in sorted(zip(numbers, rows), key=lambda pair: pair[0])]
    return ordered, None


def plan_act(table: str, act: str, rows: Sequence[dict]) -> ActPlan:
    """Diff one act. Document order is the source ordinal, or the act is refused."""
    ordered, order_refusal = _order_act(rows)
    if ordered is None:
        plan = ActPlan(
            act=act, table=table,
            before_count=sum(1 for row in rows if is_candidate(row)),
            apply_allowed=False, refusal=order_refusal,
        )
        for row in rows:
            plan.rows.append(_diff(row, None, "unordered", order_refusal))
        return plan
    before = sum(1 for row in ordered if is_candidate(row))
    plan = ActPlan(act=act, table=table, before_count=before, apply_allowed=True)
    if len(ordered) > MAX_STAGED_DIVS:
        plan.apply_allowed = False
        plan.refusal = "act exceeds the keyer cap"
        for row in ordered:
            plan.rows.append(_diff(row, None, "cap_refused", "the act has more than the staged div cap"))
        return plan
    duplicate_ids = set()
    seen_keys: dict = defaultdict(list)
    for row in ordered:
        seen_keys[row["section_number"]].append(row["id"])
    for key, ids in seen_keys.items():
        if key and len(ids) > 1:
            duplicate_ids.update(ids)
    texts: dict = defaultdict(list)
    for row in ordered:
        texts[normalise_div_text(row["section_text"])].append(row["id"])
    duplicate_text = set()
    for ids in texts.values():
        if len(ids) > 1 and any(is_candidate(_row_by_id(ordered, row_id)) for row_id in ids):
            duplicate_text.update(ids)
    keyed = key_div_texts([row["section_text"] for row in ordered])
    if keyed.dropped_by_cap:
        plan.apply_allowed = False
        plan.refusal = "keyer dropped sections at the cap"
        for row in ordered:
            plan.rows.append(_diff(row, None, "cap_refused", "the keyer dropped a tail"))
        return plan
    assigned = _align(ordered, keyed.sections)
    if assigned is None:
        plan.apply_allowed = False
        plan.refusal = "stored texts did not align with the current keyer"
        for row in ordered:
            plan.rows.append(_diff(row, None, "unaligned", "no keyer span matched this act"))
        return plan
    body_rows = _body_count(ordered)
    for index, row in enumerate(ordered):
        source_name = _source(row)[1]
        if source_name == "pinned_source_differs":
            plan.apply_allowed = False
            plan.refusal = "pinned source text differs from the stored section"
            plan.rows.append(_diff(
                row, None, "pinned_source_differs",
                "the pinned text is not the stored text, so the row is not re-keyed",
            ))
            continue
        if row["id"] in duplicate_ids:
            plan.apply_allowed = False
            plan.refusal = "two stored rows share a key"
            plan.rows.append(_diff(row, None, "collision", "duplicate stored key"))
            continue
        if row["id"] in duplicate_text:
            plan.apply_allowed = False
            plan.refusal = "two stored rows have the same text"
            plan.rows.append(_diff(row, None, "collision", "duplicate stored text"))
            continue
        slot = assigned[index]
        if slot is None:
            plan.rows.append(_diff(
                row, None, "dropped_not_deleted",
                "the current keyer does not publish this row; it is not deleted",
            ))
            continue
        section, span = slot
        if span > 1:
            plan.rows.append(_diff(
                row, None, "absorbed",
                "the line joins a neighbour, so it is not given its own key",
            ))
            continue
        if is_schedule_publication_key(row["section_number"]):
            plan.rows.append(_diff(
                row, row["section_number"], "unchanged",
                "a schedule key keeps its scope and is not re-keyed to a body key",
            ))
            continue
        new_key = section.key
        if new_key == row["section_number"]:
            plan.rows.append(_diff(row, new_key, "unchanged", "the stored key already matches"))
            continue
        if space_hyphen_suffix_key(normalise_div_text(row["section_text"])) and body_rows < 2:
            # ``12-I Pakistan`` on its own is published as ``12I``. A punctuated
            # ``12-A.`` has no space-form key, so it is still re-keyed alone.
            plan.rows.append(_diff(
                row, None, "isolated_space_form",
                "a wrapped line is not re-keyed without the rest of its act",
            ))
            continue
        if is_candidate(row) and _BARE_KEY.fullmatch(new_key or "") is None:
            plan.apply_allowed = False
            plan.refusal = "current keying did not assign one bare key"
            plan.rows.append(_diff(
                row, new_key, "collision",
                "the keyer content-addressed this section instead of a bare key",
            ))
            continue
        if _in_scope(row, new_key):
            plan.rows.append(_diff(row, new_key, "rekey", "stored key lacks the suffix the current keyer assigns"))
            continue
        plan.rows.append(_diff(
            row, new_key, "out_of_scope",
            "the key differs and this repair does not rewrite it",
        ))
    _refuse_projected_collisions(plan)
    if plan.apply_allowed:
        _bind_act_keys(plan, ordered)
    return plan


def _row_by_id(rows: Sequence[dict], row_id: str) -> dict:
    for row in rows:
        if row["id"] == row_id:
            return row
    raise ReharvestRefusal(f"missing row {row_id}")


def _diff(row: Mapping, new_key: Optional[str], action: str, reason: str) -> RowDiff:
    source_name = _source(row)[1]
    return RowDiff(
        id=row["id"],
        table=row["table"],
        act=_act_of(row),
        old_key=row["section_number"],
        new_key=new_key,
        action=action,
        text_md5=text_md5(row["section_text"]),
        text_md5_unchanged=True,
        source=source_name,
        reason=reason,
    )


def _refuse_projected_collisions(plan: ActPlan) -> None:
    """A new key that lookup already folds onto another row is a collision."""
    moving = {row.id: row.new_key for row in plan.rows if row.action == "rekey"}
    if not moving:
        if any(row.action == "collision" for row in plan.rows):
            plan.apply_allowed = False
        return
    final: dict = defaultdict(list)
    for row in plan.rows:
        key = moving.get(row.id, row.old_key)
        if key:
            final[collision_identity(key)].append(row.id)
    blocked = set()
    for ids in final.values():
        if len(ids) > 1:
            blocked.update(ids)
    if not blocked:
        return
    plan.apply_allowed = False
    plan.refusal = "re-key would collide with a stored key"
    rewritten = []
    for row in plan.rows:
        if row.id in blocked and row.action == "rekey":
            rewritten.append(RowDiff(
                id=row.id, table=row.table, act=row.act, old_key=row.old_key,
                new_key=row.new_key, action="collision", text_md5=row.text_md5,
                text_md5_unchanged=True, source=row.source,
                reason="the new key is already held in this act",
            ))
        else:
            rewritten.append(row)
    plan.rows = rewritten


def _bind_act_keys(plan: ActPlan, rows: Sequence[dict]) -> None:
    """Rewrite ``act_keys`` to the post-image, or refuse when the lists diverge.

    Publication retires master keys absent from this inventory. Every sibling
    must carry the same list, and that list must be the stored keys after the
    re-key. A missing list on a master row is not an inventory.
    """
    inventories = []
    for row in rows:
        metadata = row.get("parsing_metadata")
        if not isinstance(metadata, Mapping) or "act_keys" not in metadata:
            inventories.append(None)
            continue
        parsed = act_keys_from_metadata(metadata)
        if parsed is None:
            plan.apply_allowed = False
            plan.refusal = "act_keys would diverge"
            return
        inventories.append(list(metadata["act_keys"]))
    present = [item for item in inventories if item is not None]
    if not present:
        return
    if len(present) != len(inventories) or any(item != present[0] for item in present):
        plan.apply_allowed = False
        plan.refusal = "act_keys would diverge"
        return
    prior = list(present[0])
    stored_keys = [row["section_number"] for row in rows]
    if frozenset(prior) != frozenset(stored_keys) or len(prior) != len(stored_keys):
        plan.apply_allowed = False
        plan.refusal = "act_keys would diverge"
        return
    updated = list(prior)
    by_id = {row.id: row for row in plan.rows}
    for row in rows:
        diff = by_id[row["id"]]
        if diff.action != "rekey" or not diff.new_key:
            continue
        if diff.old_key not in updated:
            plan.apply_allowed = False
            plan.refusal = "act_keys would diverge"
            return
        updated[updated.index(diff.old_key)] = diff.new_key
    post = []
    for row in rows:
        diff = by_id[row["id"]]
        if row["section_number"] not in prior:
            continue
        if diff.action == "rekey" and diff.new_key:
            post.append(diff.new_key)
        else:
            post.append(row["section_number"])
    if frozenset(updated) != frozenset(post) or len(updated) != len(post):
        plan.apply_allowed = False
        plan.refusal = "act_keys would diverge"
        return
    plan.prior_act_keys = tuple(prior)
    plan.act_keys = tuple(updated)


def plan_rows(raw_rows: Sequence[Mapping]) -> list:
    """Group an export by table and act. Each act is ordered by its source ordinal."""
    groups: dict = defaultdict(list)
    seen = set()
    for raw in raw_rows:
        row = normalise_row(raw)
        if row["id"] in seen:
            raise ReharvestRefusal(f"duplicate id {row['id']}")
        seen.add(row["id"])
        groups[(row["table"], _act_of(row))].append(row)
    plans = []
    for (table, act) in sorted(groups):
        plans.append(plan_act(table, act, groups[(table, act)]))
    return plans


def before_counts(plans: Sequence[ActPlan]) -> list:
    return [
        {"act": plan.act, "table": plan.table, "affected": plan.before_count}
        for plan in plans
    ]


def project_after(raw_rows: Sequence[Mapping], plans: Sequence[ActPlan]) -> list:
    """Per-act selector counts after the planned re-keys, text unchanged."""
    by_id = {}
    for plan in plans:
        for row in plan.rows:
            if row.action == "rekey" and row.new_key:
                by_id[row.id] = row.new_key
    grouped: dict = defaultdict(list)
    for raw in raw_rows:
        row = normalise_row(raw)
        if row["id"] in by_id:
            row = dict(row)
            row["section_number"] = by_id[row["id"]]
        grouped[(row["table"], _act_of(row))].append(row)
    counts = []
    seen = {(plan.table, plan.act) for plan in plans}
    for table, act in sorted(seen):
        affected = sum(1 for row in grouped[(table, act)] if is_candidate(row))
        counts.append({"act": act, "table": table, "affected": affected})
    return counts


def build_report(raw_rows: Sequence[Mapping], *, dry_run: bool, applied: bool = False,
                 refusal: Optional[str] = None) -> dict:
    plans = plan_rows(raw_rows)
    return {
        "finding": FINDING,
        "dry_run": dry_run,
        "applied": applied,
        "refusal": refusal,
        "before_counts": before_counts(plans),
        "after_counts": project_after(raw_rows, plans),
        "acts": [plan.as_dict() for plan in plans],
        "sql": {
            "count_before": count_sql(),
            "count_after": count_sql(),
            "select_acts": select_act_sql(),
        },
    }


def rekey_actions(plans: Sequence[ActPlan]) -> list:
    actions = []
    for plan in plans:
        if not plan.apply_allowed:
            continue
        for row in plan.rows:
            if row.action == "rekey" and row.new_key:
                actions.append(row)
    return actions


def _quote(value: str) -> str:
    if _SAFE_KEY.fullmatch(value) is None and _SAFE_ID.fullmatch(value) is None:
        raise ReharvestRefusal(f"refusing to interpolate an unsafe SQL value: {value!r}")
    return "'" + value.replace("'", "''") + "'"


def _check_ids(ids: Iterable[str]) -> list:
    cleaned = [str(item).strip() for item in ids]
    if any(not item for item in cleaned):
        raise ReharvestRefusal("an id is empty")
    if len(cleaned) != len(set(cleaned)):
        raise ReharvestRefusal("the id list contains a duplicate")
    for item in cleaned:
        if _SAFE_ID.fullmatch(item) is None:
            raise ReharvestRefusal(f"id is not a safe token: {item}")
    return cleaned


def _plan_signature(plans: Sequence[ActPlan]) -> list:
    return sorted(
        (row.id, row.action, row.old_key, row.new_key, row.text_md5, row.table)
        for plan in plans for row in plan.rows
    )


def guard_apply(export_rows: Sequence[Mapping], live_rows: Sequence[Mapping], *,
                expect_count: int, ids: Sequence[str]) -> tuple:
    """Refuse unless the live rows reproduce the export plan.

    The export is planned on its own. The live rows are planned again. A text
    or key that differs from the export is a divergence, including when both
    arguments happen to be the same list. A collision anywhere refuses the apply.
    """
    if expect_count is None:
        raise ReharvestRefusal("apply requires --expect-count")
    if int(expect_count) < 1:
        raise ReharvestRefusal("expect-count must be the number of re-key rows")
    id_list = _check_ids(ids)
    if len(id_list) != int(expect_count):
        raise ReharvestRefusal("expect-count does not equal the id list")
    plans = plan_rows(export_rows)
    if any(not plan.apply_allowed for plan in plans):
        reasons = [f"{plan.act}: {plan.refusal}" for plan in plans if not plan.apply_allowed]
        raise ReharvestRefusal("refusing apply because of a collision or an unsafe act: " + "; ".join(reasons))
    live_plans = plan_rows(live_rows)
    if any(not plan.apply_allowed for plan in live_plans) or _plan_signature(plans) != _plan_signature(live_plans):
        raise ReharvestRefusal("live plan diverges from the export plan")
    actions = [row for row in rekey_actions(plans)]
    if len(actions) != int(expect_count):
        raise ReharvestRefusal(
            f"expect-count {expect_count} does not equal the planned re-key count {len(actions)}"
        )
    planned_ids = {row.id for row in actions}
    if set(id_list) != planned_ids:
        raise ReharvestRefusal("the id list is not the planned re-key set")
    live_by_id = {normalise_row(raw)["id"]: normalise_row(raw) for raw in live_rows}
    inventory = {(plan.table, plan.act): plan for plan in plans if plan.act_keys is not None}
    concrete = []
    siblings = []
    for action in actions:
        stored = live_by_id.get(action.id)
        if stored is None:
            raise ReharvestRefusal(f"live row missing {action.id}")
        if text_md5(stored["section_text"]) != action.text_md5:
            raise ReharvestRefusal(f"text md5 changed for {action.id}")
        if stored["section_number"] != action.old_key:
            raise ReharvestRefusal(f"stored key changed for {action.id}")
        if not action.new_key or action.new_key == action.old_key:
            raise ReharvestRefusal(f"empty re-key for {action.id}")
        if action.new_key.startswith(TEMP_PREFIX) or action.old_key.startswith(TEMP_PREFIX):
            raise ReharvestRefusal("a stored key uses the temporary re-key prefix")
        plan = inventory.get((action.table, action.act))
        act_keys = None if plan is None else plan.act_keys
        prior_keys = None if plan is None else plan.prior_act_keys
        _quote(action.id)
        _quote(action.old_key)
        _quote(action.new_key)
        _quote(action.text_md5)
        concrete.append(RekeyAction(
            id=action.id,
            table=action.table,
            act=action.act,
            old_key=action.old_key,
            new_key=action.new_key,
            text_md5=action.text_md5,
            section_text=stored["section_text"],
            act_keys=act_keys,
            prior_act_keys=prior_keys,
        ))
    rekey_ids = {action.id for action in concrete}
    for plan in plans:
        if plan.act_keys is None:
            continue
        for row in plan.rows:
            if row.id in rekey_ids:
                continue
            stored = live_by_id.get(row.id)
            if stored is None or text_md5(stored["section_text"]) != row.text_md5:
                raise ReharvestRefusal(f"live row missing {row.id}")
            if stored["section_number"] != row.old_key:
                raise ReharvestRefusal(f"stored key changed for {row.id}")
            siblings.append(InventoryUpdate(
                id=row.id, table=row.table, key=row.old_key, text_md5=row.text_md5,
                act_keys=plan.act_keys, prior_act_keys=plan.prior_act_keys,
            ))
    return plans, concrete, siblings


def _json_array(keys: Sequence[str]) -> str:
    for key in keys:
        if _SAFE_KEY.fullmatch(key) is None:
            raise ReharvestRefusal(f"refusing to interpolate an unsafe SQL value: {key!r}")
    payload = json.dumps(list(keys), ensure_ascii=True)
    if "'" in payload:
        raise ReharvestRefusal("act_keys JSON is not a safe SQL literal")
    return payload


def render_rowcount_guard(update_sql: str) -> str:
    """Wrap one UPDATE so Postgres raises unless the row count is exactly 1.

    ``CASE WHEN ... ELSE 1/0`` is planned as a constant and raises even when the
    row matches. ``GET DIAGNOSTICS`` reads the count after the UPDATE runs.
    """
    body = update_sql.strip()
    if body.endswith(";"):
        body = body[:-1].rstrip()
    if ";" in body or "$" in body:
        raise ReharvestRefusal("a guarded update is one statement")
    if re.match(r"UPDATE\s+(statutes_master|statutes_staging)\s+SET\s+", body, re.IGNORECASE) is None:
        raise ReharvestRefusal("a guarded update must re-key statutes_master or statutes_staging")
    if re.search(r"\b(DELETE|INSERT|DROP|ALTER|TRUNCATE)\b", body, re.IGNORECASE):
        raise ReharvestRefusal("a guarded update contained a forbidden statement")
    return (
        "DO $data003$\n"
        "DECLARE\n"
        "  n integer;\n"
        "BEGIN\n"
        "  " + body + ";\n"
        "  GET DIAGNOSTICS n = ROW_COUNT;\n"
        "  IF n IS DISTINCT FROM 1 THEN\n"
        "    RAISE EXCEPTION 'DATA-003-REHARVEST expected 1 row, updated %', n;\n"
        "  END IF;\n"
        "END\n"
        "$data003$"
    )


def _one_row_update(table: str, new_key: str, row_id: str, expected_key: str, digest: str,
                    act_keys: Optional[Sequence[str]] = None) -> str:
    """One statement. It changes nothing unless the id, key, and text md5 match one row."""
    column = KEY_COLUMN[table]
    text_column = TEXT_COLUMN[table]
    assignment = column + " = " + _quote(new_key)
    if act_keys is not None:
        assignment += (
            ", parsing_metadata = jsonb_set(COALESCE(parsing_metadata, '{}'::jsonb), "
            "'{act_keys}', '" + _json_array(act_keys) + "'::jsonb, true)"
        )
    update = (
        "UPDATE " + table + " SET " + assignment
        + " WHERE id = " + _quote(row_id)
        + " AND " + column + " = " + _quote(expected_key)
        + " AND md5(convert_to(" + text_column + ", 'UTF8')) = " + _quote(digest)
    )
    return render_rowcount_guard(update)


def render_apply_sql(actions: Sequence[RekeyAction], siblings: Sequence[InventoryUpdate] = ()) -> str:
    """One transaction. Keys move aside, then to the new key. No deletes.

    Each statement binds the text md5 and errors unless it updates one row.
    ``act_keys`` is rewritten with the final key, on the re-keyed row and on
    every sibling that carried the same list.
    """
    lines = [
        "-- DATA-003-REHARVEST apply. Re-key only. Do not run until the dry-run report is accepted.",
        "BEGIN;",
    ]
    for action in actions:
        lines.append(_one_row_update(
            action.table, TEMP_PREFIX + action.id, action.id, action.old_key, action.text_md5,
        ) + ";")
    for action in actions:
        lines.append(_one_row_update(
            action.table, action.new_key, action.id, TEMP_PREFIX + action.id, action.text_md5,
            action.act_keys,
        ) + ";")
    for sibling in siblings:
        lines.append(_one_row_update(
            sibling.table, sibling.key, sibling.id, sibling.key, sibling.text_md5, sibling.act_keys,
        ) + ";")
    lines.append("COMMIT;")
    sql = "\n".join(lines) + "\n"
    _refuse_forbidden_sql(sql, "apply")
    return sql


def render_rollback_sql(actions: Sequence[RekeyAction], siblings: Sequence[InventoryUpdate] = ()) -> str:
    """Restore keys through the same temporary keys the apply used.

    A chain ``12`` to ``12A`` and ``12A`` to ``12B`` is parked on temporary keys
    before any old key is written back.
    """
    lines = [
        "-- DATA-003-REHARVEST rollback. Restores the section keys this apply wrote.",
        "BEGIN;",
    ]
    for action in actions:
        lines.append(_one_row_update(
            action.table, TEMP_PREFIX + action.id, action.id, action.new_key, action.text_md5,
        ) + ";")
    for action in actions:
        lines.append(_one_row_update(
            action.table, action.old_key, action.id, TEMP_PREFIX + action.id, action.text_md5,
            action.prior_act_keys,
        ) + ";")
    for sibling in siblings:
        lines.append(_one_row_update(
            sibling.table, sibling.key, sibling.id, sibling.key, sibling.text_md5, sibling.prior_act_keys,
        ) + ";")
    lines.append("COMMIT;")
    sql = "\n".join(lines) + "\n"
    _refuse_forbidden_sql(sql, "rollback")
    return sql


def _refuse_forbidden_sql(sql: str, label: str) -> None:
    """Comments may name the rule. The statements themselves must only re-key."""
    stripped = re.sub(r"--[^\n]*", "", sql)
    if re.search(r"\b(DELETE|INSERT|DROP|ALTER|TRUNCATE)\b", stripped, re.IGNORECASE):
        raise ReharvestRefusal(f"{label} SQL contained a forbidden statement")


def backup_jsonl(actions: Sequence[RekeyAction]) -> str:
    lines = []
    for action in actions:
        lines.append(json.dumps({
            "id": action.id,
            "table": action.table,
            "act": action.act,
            "section_number": action.old_key,
            "new_key": action.new_key,
            "section_text": action.section_text,
            "text_md5": action.text_md5,
        }, ensure_ascii=True, sort_keys=True))
    return "\n".join(lines) + ("\n" if lines else "")


class MemoryStore:
    """The apply transaction against an export. It is not a database connection.

    ``BEGIN`` copies the rows. ``COMMIT`` keeps the copy. ``ROLLBACK`` drops it.
    An update that hits a key another row of the same act still holds is a
    collision and raises. Deletes are refused.
    """

    def __init__(self, raw_rows: Sequence[Mapping]):
        self.rows = {normalise_row(raw)["id"]: normalise_row(raw) for raw in raw_rows}
        self._snapshot = None
        self.statements: list = []
        self.committed = False

    def begin(self) -> None:
        if self._snapshot is not None:
            raise ReharvestRefusal("a transaction is already open")
        self._snapshot = {row_id: dict(row) for row_id, row in self.rows.items()}
        self.committed = False

    def rollback(self) -> None:
        self._snapshot = None
        self.committed = False

    def commit(self) -> None:
        if self._snapshot is None:
            raise ReharvestRefusal("commit without begin")
        for row in self._snapshot.values():
            if str(row["section_number"]).startswith(TEMP_PREFIX):
                raise ReharvestRefusal("commit would leave a temporary key")
        self.rows = self._snapshot
        self._snapshot = None
        self.committed = True

    def _live(self) -> dict:
        if self._snapshot is None:
            raise ReharvestRefusal("update outside a transaction")
        return self._snapshot

    def update_key(self, table: str, row_id: str, expected: str, new_key: str, expected_md5: str,
                   act_keys: Optional[Sequence[str]] = None) -> None:
        if new_key is None or str(new_key).strip() == "":
            raise ReharvestRefusal("refusing an empty key")
        live = self._live()
        row = live.get(row_id)
        if row is None or row["table"] != table or row["section_number"] != expected:
            raise ReharvestRefusal("expected 1 row")
        if text_md5(row["section_text"]) != expected_md5:
            raise ReharvestRefusal("expected 1 row")
        act = _act_of(row)
        wanted = collision_identity(new_key)
        for other in live.values():
            if other["id"] == row_id:
                continue
            if other["table"] == table and _act_of(other) == act and collision_identity(other["section_number"]) == wanted:
                raise ReharvestRefusal(f"collision on {new_key} in {act}")
        other_text = row["section_text"]
        row["section_number"] = new_key
        if act_keys is not None:
            metadata = dict(row.get("parsing_metadata") or {})
            metadata["act_keys"] = list(act_keys)
            row["parsing_metadata"] = metadata
        if row["section_text"] != other_text:
            raise ReharvestRefusal("text changed during a re-key")

    def execute_script(self, sql: str) -> None:
        """Run the apply or rollback script. A failure rolls back."""
        statements = _statements(sql)
        if not statements or statements[0].upper() != "BEGIN" or statements[-1].upper() != "COMMIT":
            raise ReharvestRefusal("a re-key script must be one transaction")
        self.begin()
        try:
            for statement in statements[1:-1]:
                self.statements.append(statement)
                self._execute_update(statement)
            self.commit()
        except Exception:
            self.rollback()
            raise

    def _execute_update(self, statement: str) -> None:
        if re.search(r"\b(DELETE|INSERT|DROP|ALTER|TRUNCATE)\b", statement, re.IGNORECASE):
            raise ReharvestRefusal("refusing a statement that is not a re-key")
        if "GET DIAGNOSTICS" not in statement or "RAISE EXCEPTION" not in statement:
            raise ReharvestRefusal("re-key statement does not require exactly one row")
        matched = _REKEY_SQL.fullmatch(statement.strip())
        if matched is None:
            raise ReharvestRefusal("refusing an update that is not a section re-key")
        table = matched.group("table")
        column = matched.group("column")
        text_column = matched.group("text")
        if KEY_COLUMN[table] != column or TEXT_COLUMN[table] != text_column:
            raise ReharvestRefusal("update names the wrong key column")
        act_keys = None
        if matched.group("keys") is not None:
            act_keys = json.loads(matched.group("keys"))
            if not isinstance(act_keys, list):
                raise ReharvestRefusal("act_keys JSON is not a list")
        self.update_key(
            table, matched.group("id"), matched.group("expected"), matched.group("new"),
            matched.group("md5"), act_keys,
        )


def _statements(sql: str) -> list:
    """Split on semicolons that are outside dollar quotes and line comments."""
    parts = []
    buf = []
    i = 0
    n = len(sql)
    dollar = None
    while i < n:
        if dollar is None and sql.startswith("--", i):
            newline = sql.find("\n", i)
            if newline < 0:
                break
            i = newline + 1
            continue
        if sql[i] == "$":
            tag = re.match(r"\$[A-Za-z0-9_]*\$", sql[i:])
            if tag and (dollar is None or tag.group(0) == dollar):
                token = tag.group(0)
                buf.append(token)
                i += len(token)
                dollar = None if dollar == token else token
                continue
        if dollar is None and sql[i] == ";":
            part = "".join(buf).strip()
            if part:
                parts.append(part)
            buf = []
            i += 1
            continue
        buf.append(sql[i])
        i += 1
    tail = "".join(buf).strip()
    if tail:
        parts.append(tail)
    return parts


_REKEY_SQL = re.compile(
    r"^DO \$data003\$\s*DECLARE\s+n integer;\s*BEGIN\s+"
    r"UPDATE (?P<table>statutes_master|statutes_staging) SET "
    r"(?P<column>section_number|extracted_section_number) = '(?P<new>[^']*)'"
    r"(?:, parsing_metadata = jsonb_set\(COALESCE\(parsing_metadata, '\{\}'::jsonb\), "
    r"'\{act_keys\}', '(?P<keys>\[[^']*\])'::jsonb, true\))? "
    r"WHERE id = '(?P<id>[^']*)' AND (?P=column) = '(?P<expected>[^']*)' "
    r"AND md5\(convert_to\((?P<text>section_text|extracted_section_text), 'UTF8'\)\) = '(?P<md5>[0-9a-f]{32})';\s*"
    r"GET DIAGNOSTICS n = ROW_COUNT;\s*"
    r"IF n IS DISTINCT FROM 1 THEN\s*"
    r"RAISE EXCEPTION 'DATA-003-REHARVEST expected 1 row, updated %', n;\s*"
    r"END IF;\s*END\s*\$data003\$\Z",
    re.DOTALL,
)


def apply_transaction(store: MemoryStore, export_rows: Sequence[Mapping], *, expect_count: int,
                      ids: Sequence[str], live_rows: Optional[Sequence[Mapping]] = None) -> dict:
    """Re-key inside one transaction. Files are the caller's concern.

    The plan is taken from ``export_rows``. ``live_rows``, or the store when
    that argument is omitted, is planned again and must match. On refusal the
    store is rolled back and this function raises.
    """
    if live_rows is None:
        live_rows = [dict(row) for row in store.rows.values()]
    _plans, actions, siblings = guard_apply(
        export_rows, live_rows, expect_count=expect_count, ids=ids,
    )
    before = {action.id: (action.text_md5, action.section_text, action.old_key) for action in actions}
    script = render_apply_sql(actions, siblings)
    rollback_sql = render_rollback_sql(actions, siblings)
    backup = backup_jsonl(actions)
    store.execute_script(script)
    if not store.committed:
        raise ReharvestRefusal("transaction did not commit")
    for action in actions:
        stored = store.rows[action.id]
        if stored["section_number"] != action.new_key:
            raise ReharvestRefusal(f"committed key mismatch for {action.id}")
        if text_md5(stored["section_text"]) != before[action.id][0]:
            raise ReharvestRefusal(f"text md5 changed for {action.id}")
        if stored["section_text"] != before[action.id][1]:
            raise ReharvestRefusal(f"text changed for {action.id}")
    return {
        "apply_sql": script,
        "rollback_sql": rollback_sql,
        "backup_jsonl": backup,
        "ids": [action.id for action in actions],
    }
