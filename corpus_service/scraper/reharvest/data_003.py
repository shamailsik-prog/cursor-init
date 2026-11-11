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

import hashlib
import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Optional, Sequence

from scraper.parsers.pakistancode_keys import (
    MAX_STAGED_DIVS,
    is_amendment_footnote,
    key_div_texts,
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

    def as_dict(self) -> dict:
        return {
            "act": self.act,
            "table": self.table,
            "before_count": self.before_count,
            "apply_allowed": self.apply_allowed,
            "refusal": self.refusal,
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


def count_sql() -> str:
    """Per-act counts of stored rows the selector still matches.

    Run it before the apply and again after. A re-keyed ``12A`` drops out.
    A wrapped line that was not re-keyed stays in the count.
    """
    master_act = _act_expr("short_name", "statute_name")
    master_where = _candidate_predicate("section_text", "section_title", "section_number")
    staging_act = _act_expr("extracted_short_name", "extracted_act_name")
    staging_where = _candidate_predicate(
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
    )


def select_act_sql() -> str:
    """Every stored section of an act that has a candidate row.

    Keying a wrapped ``12-I`` line without the rest of the act publishes ``12I``.
    The export is the whole act, in ``created_at`` then ``id`` order.
    """
    master_act = _act_expr("m.short_name", "m.statute_name")
    master_where = _candidate_predicate("section_text", "section_title", "section_number")
    staging_act = _act_expr("s.extracted_short_name", "s.extracted_act_name")
    staging_where = _candidate_predicate(
        "extracted_section_text", "extracted_section_title", "extracted_section_number",
    )
    return (
        "-- DATA-003-REHARVEST export. Read only. No writes.\n"
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
        "       m.created_at\n"
        "FROM statutes_master AS m\n"
        "JOIN affected AS a ON a.act = " + master_act + "\n"
        "ORDER BY a.act, m.created_at, m.id;\n"
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
        "       s.created_at\n"
        "FROM statutes_staging AS s\n"
        "JOIN affected AS a ON a.act = " + staging_act + "\n"
        "ORDER BY a.act, s.created_at, s.id;\n"
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
    return {
        "id": row_id,
        "table": table,
        "short_name": ("" if short is None else str(short)).strip(),
        "statute_name": ("" if name is None else str(name)).strip(),
        "section_number": "" if key is None else str(key),
        "section_title": "" if title is None else str(title),
        "section_text": "" if text is None else str(text),
        "raw_text": None if pinned is None else str(pinned),
        "ordinal": raw.get("ordinal"),
        "created_at": "" if raw.get("created_at") is None else str(raw.get("created_at")),
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


def _sort_key(row: Mapping):
    ordinal = row.get("ordinal")
    if ordinal is not None:
        return (0, int(ordinal), row["id"])
    return (1, row.get("created_at") or "", row["id"])


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


def plan_act(table: str, act: str, rows: Sequence[dict]) -> ActPlan:
    """Diff one act. Rows are already in document order."""
    ordered = list(rows)
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
    """A new bare key that another row keeps is a collision. The act is refused."""
    moving = {row.id: row.new_key for row in plan.rows if row.action == "rekey"}
    if not moving:
        if any(row.action == "collision" for row in plan.rows):
            plan.apply_allowed = False
        return
    final: dict = defaultdict(list)
    for row in plan.rows:
        key = moving.get(row.id, row.old_key)
        if key:
            final[key].append(row.id)
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


def plan_rows(raw_rows: Sequence[Mapping]) -> list:
    """Group an export by table and act, and plan each act in document order."""
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
        ordered = sorted(groups[(table, act)], key=_sort_key)
        plans.append(plan_act(table, act, ordered))
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


def guard_apply(raw_rows: Sequence[Mapping], *, expect_count: int, ids: Sequence[str]) -> tuple:
    """Refuse unless the id list is exactly the planned re-key set.

    A collision anywhere in the export refuses the apply, including a collision
    in an act the id list does not mention.
    """
    if expect_count is None:
        raise ReharvestRefusal("apply requires --expect-count")
    if int(expect_count) < 1:
        raise ReharvestRefusal("expect-count must be the number of re-key rows")
    id_list = _check_ids(ids)
    if len(id_list) != int(expect_count):
        raise ReharvestRefusal("expect-count does not equal the id list")
    plans = plan_rows(raw_rows)
    if any(not plan.apply_allowed for plan in plans):
        reasons = [f"{plan.act}: {plan.refusal}" for plan in plans if not plan.apply_allowed]
        raise ReharvestRefusal("refusing apply because of a collision or an unsafe act: " + "; ".join(reasons))
    actions = [row for row in rekey_actions(plans)]
    if len(actions) != int(expect_count):
        raise ReharvestRefusal(
            f"expect-count {expect_count} does not equal the planned re-key count {len(actions)}"
        )
    planned_ids = {row.id for row in actions}
    if set(id_list) != planned_ids:
        raise ReharvestRefusal("the id list is not the planned re-key set")
    by_id = {normalise_row(raw)["id"]: normalise_row(raw) for raw in raw_rows}
    concrete = []
    for action in actions:
        stored = by_id[action.id]
        if text_md5(stored["section_text"]) != action.text_md5:
            raise ReharvestRefusal(f"text md5 changed for {action.id}")
        if stored["section_number"] != action.old_key:
            raise ReharvestRefusal(f"stored key changed for {action.id}")
        if not action.new_key or action.new_key == action.old_key:
            raise ReharvestRefusal(f"empty re-key for {action.id}")
        if action.new_key.startswith(TEMP_PREFIX) or action.old_key.startswith(TEMP_PREFIX):
            raise ReharvestRefusal("a stored key uses the temporary re-key prefix")
        _quote(action.id)
        _quote(action.old_key)
        _quote(action.new_key)
        concrete.append(RekeyAction(
            id=action.id,
            table=action.table,
            act=action.act,
            old_key=action.old_key,
            new_key=action.new_key,
            text_md5=action.text_md5,
            section_text=stored["section_text"],
        ))
    return plans, concrete


def render_apply_sql(actions: Sequence[RekeyAction]) -> str:
    """One transaction. Keys move aside, then to the new key. No deletes."""
    lines = [
        "-- DATA-003-REHARVEST apply. Re-key only. Do not run until the dry-run report is accepted.",
        "BEGIN;",
    ]
    for action in actions:
        column = KEY_COLUMN[action.table]
        temp = TEMP_PREFIX + action.id
        lines.append(
            f"UPDATE {action.table} SET {column} = {_quote(temp)}"
            f" WHERE id = {_quote(action.id)} AND {column} = {_quote(action.old_key)};"
        )
    for action in actions:
        column = KEY_COLUMN[action.table]
        temp = TEMP_PREFIX + action.id
        lines.append(
            f"UPDATE {action.table} SET {column} = {_quote(action.new_key)}"
            f" WHERE id = {_quote(action.id)} AND {column} = {_quote(temp)};"
        )
    lines.append("COMMIT;")
    sql = "\n".join(lines) + "\n"
    _refuse_forbidden_sql(sql, "apply")
    return sql


def render_rollback_sql(actions: Sequence[RekeyAction]) -> str:
    """Restore the keys this apply wrote. Text is not mentioned because it was not changed."""
    lines = [
        "-- DATA-003-REHARVEST rollback. Restores the section keys this apply wrote.",
        "BEGIN;",
    ]
    for action in actions:
        column = KEY_COLUMN[action.table]
        lines.append(
            f"UPDATE {action.table} SET {column} = {_quote(action.old_key)}"
            f" WHERE id = {_quote(action.id)} AND {column} = {_quote(action.new_key)};"
        )
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

    def update_key(self, table: str, row_id: str, expected: str, new_key: str) -> None:
        if new_key is None or str(new_key).strip() == "":
            raise ReharvestRefusal("refusing an empty key")
        live = self._live()
        row = live.get(row_id)
        if row is None or row["table"] != table:
            raise ReharvestRefusal(f"row {row_id} is not in the transaction")
        if row["section_number"] != expected:
            raise ReharvestRefusal(f"row {row_id} key is {row['section_number']}, not {expected}")
        act = _act_of(row)
        for other in live.values():
            if other["id"] == row_id:
                continue
            if other["table"] == table and _act_of(other) == act and other["section_number"] == new_key:
                raise ReharvestRefusal(f"collision on {new_key} in {act}")
        other_text = row["section_text"]
        row["section_number"] = new_key
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
        matched = re.fullmatch(
            r"UPDATE\s+(statutes_master|statutes_staging)\s+SET\s+"
            r"(section_number|extracted_section_number)\s+=\s+'([^']*)'\s+"
            r"WHERE\s+id\s+=\s+'([^']*)'\s+AND\s+\2\s+=\s+'([^']*)'",
            statement.strip(),
            re.IGNORECASE | re.DOTALL,
        )
        if matched is None:
            raise ReharvestRefusal("refusing an update that is not a section re-key")
        table, column, new_key, row_id, expected = matched.groups()
        if KEY_COLUMN[table] != column:
            raise ReharvestRefusal("update names the wrong key column")
        self.update_key(table, row_id, expected, new_key)


def _statements(sql: str) -> list:
    body = []
    for line in sql.splitlines():
        if line.strip().startswith("--"):
            continue
        body.append(line)
    text = "\n".join(body)
    parts = [part.strip() for part in text.split(";")]
    return [part for part in parts if part]


def apply_transaction(store: MemoryStore, raw_rows: Sequence[Mapping], *, expect_count: int,
                      ids: Sequence[str]) -> dict:
    """Re-key inside one transaction. Files are the caller's concern.

    On refusal the store is rolled back and this function raises. Text md5 is
    checked before any update and again after commit.
    """
    _plans, actions = guard_apply(raw_rows, expect_count=expect_count, ids=ids)
    before = {action.id: (action.text_md5, action.section_text, action.old_key) for action in actions}
    script = render_apply_sql(actions)
    rollback_sql = render_rollback_sql(actions)
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
