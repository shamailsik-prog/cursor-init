"""DATA-003-REHARVEST. Stored hyphen suffixes are re-keyed from the current keyer.

Rows harvested before PR237 can still carry ``12`` for a ``12-A.`` heading.
The tool is a dry run unless ``--apply``, ``--expect-count`` and the exact ids
are all present. It does not open a database and it does not delete rows.

The fixture covers ``12-A``, ``12-B``, a ``12-I`` wrap, a ``see s.`` placeholder,
and the PR237 / PR238 shapes: en-dash, ``12-AA``, ``10-B``, a punctuated ``12-I.``,
a glued ``12a`` that stays, the insertion footnote, and the see-s pair.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path

import pytest

from scraper.parsers.pakistancode_keys import keys_to_retire
from scraper.reharvest.data_003 import (
    TEMP_PREFIX,
    MemoryStore,
    ReharvestRefusal,
    apply_transaction,
    build_report,
    count_sql,
    guard_apply,
    is_candidate,
    plan_rows,
    select_act_sql,
    sql_is_read_only,
    text_md5,
)
from scripts.reharvest_data_003 import main as reharvest_main

FIXTURE = Path(__file__).resolve().parents[0] / "fixtures" / "data_003_reharvest" / "rows.json"
REKEY_IDS = {
    "00000000-0000-4000-8000-000000000001",  # 12-A stored as 12
    "00000000-0000-4000-8000-000000000003",  # 12-A stored beside 12
    "00000000-0000-4000-8000-000000000004",  # 12-B
    "00000000-0000-4000-8000-000000000006",  # 10-B
    "00000000-0000-4000-8000-000000000007",  # 12-AA
    "00000000-0000-4000-8000-000000000008",  # 13–A
    "00000000-0000-4000-8000-000000000009",  # staging 12-B
    "00000000-0000-4000-8000-000000000013",  # 12-A see s.
    "00000000-0000-4000-8000-000000000014",  # see s. 6 kept
    "00000000-0000-4000-8000-000000000021",  # punctuated 12-I.
}
CLEAN_ACTS = {
    "bare-12a", "suffixes", "stage-12b", "wrap", "see-s", "footnote",
    "glued-12a", "fees", "real-12i",
}


def _rows(acts=None):
    loaded = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if acts is None:
        return loaded
    return [row for row in loaded if row["short_name"] in acts]


def _by_id(plans):
    found = {}
    for plan in plans:
        for row in plan.rows:
            found[row.id] = row
    return found


def test_fixture_covers_the_requested_shapes():
    rows = _rows()
    texts = "\n".join(row["section_text"] for row in rows)
    assert "12-A. Inserted rates." in texts
    assert "12-B. Beta rates." in texts
    assert "12-I Pakistan source income" in texts
    assert "see s. 2." in texts
    assert "13\u2013A. Inserted rates." in texts
    assert "12-AA. Double insertion." in texts
    assert "12-I. Heading" in texts
    assert "12a. Inserted rates." in texts


def test_selector_sql_is_read_only_and_counts_by_act():
    counts = count_sql()
    export = select_act_sql()
    assert sql_is_read_only(counts)
    assert sql_is_read_only(export)
    assert "GROUP BY 1" in counts
    assert "statutes_master" in counts and "statutes_staging" in counts
    assert "DELETE" not in counts.upper() and "UPDATE" not in counts.upper()
    assert " AS ordinal" in export
    assert "source_ordinal" in export and "page_offset" in export and "act_keys" in export
    assert "ORDER BY a.act, ordinal" in export
    assert "created_at" not in export
    for row in _rows():
        if row["short_name"] == "fees":
            assert is_candidate(row) is False
        if row["short_name"] == "glued-12a":
            assert is_candidate(row) is False
        if row["id"].endswith("1"):
            assert is_candidate(row) is True


def test_dry_run_reports_old_key_new_key_and_unchanged_md5():
    rows = _rows(CLEAN_ACTS)
    report = build_report(rows, dry_run=True)
    assert report["dry_run"] is True and report["applied"] is False
    counts = {item["act"]: item["affected"] for item in report["before_counts"]}
    assert counts["bare-12a"] == 1
    assert counts["suffixes"] == 5
    assert counts["wrap"] == 1
    assert counts["see-s"] == 1
    assert counts["real-12i"] == 1
    assert counts["glued-12a"] == 0
    assert counts["fees"] == 0
    after = {item["act"]: item["affected"] for item in report["after_counts"]}
    assert after["bare-12a"] == 0
    assert after["suffixes"] == 0
    assert after["wrap"] == 1
    assert after["see-s"] == 0
    diffs = _by_id(plan_rows(rows))
    bare = diffs["00000000-0000-4000-8000-000000000001"]
    assert bare.old_key == "12" and bare.new_key == "12A" and bare.action == "rekey"
    assert bare.text_md5_unchanged is True
    assert bare.text_md5 == text_md5(next(row["section_text"] for row in rows if row["id"] == bare.id))
    pair_b = diffs["00000000-0000-4000-8000-000000000004"]
    assert pair_b.old_key == "12-bbbbbbbb" and pair_b.new_key == "12B"
    en = diffs["00000000-0000-4000-8000-000000000008"]
    assert en.old_key == "13" and en.new_key == "13A"
    aa = diffs["00000000-0000-4000-8000-000000000007"]
    assert aa.new_key == "12AA"
    ten = diffs["00000000-0000-4000-8000-000000000006"]
    assert ten.new_key == "10B"
    staged = diffs["00000000-0000-4000-8000-000000000009"]
    assert staged.table == "statutes_staging" and staged.new_key == "12B"
    assert staged.source == "pinned_source"
    wrap = diffs["00000000-0000-4000-8000-000000000011"]
    assert wrap.action == "absorbed" and wrap.new_key is None
    assert wrap.text_md5_unchanged is True
    assert all(row.new_key != "12I" for row in diffs.values() if row.act == "wrap")
    see = diffs["00000000-0000-4000-8000-000000000013"]
    assert see.old_key == "12" and see.new_key == "12A" and see.action == "rekey"
    kept = diffs["00000000-0000-4000-8000-000000000014"]
    assert kept.old_key == "6-aaaaaaaa" and kept.new_key == "6" and kept.action == "rekey"
    dropped = diffs["00000000-0000-4000-8000-000000000015"]
    assert dropped.action == "dropped_not_deleted" and dropped.new_key is None
    note = diffs["00000000-0000-4000-8000-000000000017"]
    assert note.action == "dropped_not_deleted"
    real_12a = diffs["00000000-0000-4000-8000-000000000018"]
    assert real_12a.action == "unchanged" and real_12a.old_key == "12A"
    glued = diffs["00000000-0000-4000-8000-000000000019"]
    assert glued.action == "unchanged" and glued.old_key == "12a" and glued.new_key == "12a"
    fees = diffs["00000000-0000-4000-8000-000000000020"]
    assert fees.action == "unchanged" and fees.new_key == "12"
    real_i = diffs["00000000-0000-4000-8000-000000000021"]
    assert real_i.old_key == "12" and real_i.new_key == "12I" and real_i.action == "rekey"
    rekeys = {row.id for row in diffs.values() if row.action == "rekey"}
    assert rekeys == REKEY_IDS


def test_a_pinned_source_that_differs_is_not_rekeyed():
    plans = plan_rows(_rows({"pinned"}))
    row = plans[0].rows[0]
    assert row.source == "pinned_source_differs"
    assert row.action == "pinned_source_differs"
    assert row.new_key is None
    assert plans[0].apply_allowed is False
    store = MemoryStore(_rows({"bare-12a", "pinned"}))
    with pytest.raises(ReharvestRefusal, match="pinned source"):
        apply_transaction(
            store, _rows({"bare-12a", "pinned"}),
            expect_count=1, ids=["00000000-0000-4000-8000-000000000001"],
        )
    assert store.committed is False


def test_isolated_wrap_is_not_rekeyed_to_12I():
    plans = plan_rows(_rows({"isolated-wrap"}))
    row = plans[0].rows[0]
    assert row.action == "isolated_space_form"
    assert row.new_key is None
    assert row.old_key == "12"
    assert "12I" not in json.dumps(plans[0].as_dict())


def test_apply_rekeys_in_a_transaction_and_keeps_text():
    rows = _rows(CLEAN_ACTS)
    before = {row["id"]: (row["section_number"], row["section_text"], text_md5(row["section_text"])) for row in rows}
    store = MemoryStore(rows)
    result = apply_transaction(store, rows, expect_count=len(REKEY_IDS), ids=sorted(REKEY_IDS))
    assert store.committed is True
    assert len(store.rows) == len(rows)
    assert "BEGIN;" in result["apply_sql"] and "COMMIT;" in result["apply_sql"]
    assert "DELETE" not in result["apply_sql"].upper()
    assert "INSERT" not in result["apply_sql"].upper()
    assert "DELETE" not in result["rollback_sql"].upper()
    assert "extracted_section_number" in result["apply_sql"]
    assert "SET section_text" not in result["apply_sql"]
    assert "md5(convert_to(" in result["apply_sql"] and "1/0" in result["apply_sql"]
    assert result["apply_sql"].count(TEMP_PREFIX) >= len(REKEY_IDS) * 2
    assert result["rollback_sql"].count(TEMP_PREFIX) >= len(REKEY_IDS) * 2
    backup = [json.loads(line) for line in result["backup_jsonl"].splitlines()]
    assert {item["id"] for item in backup} == REKEY_IDS
    for row_id, (old_key, text, digest) in before.items():
        stored = store.rows[row_id]
        assert stored["section_text"] == text
        assert text_md5(stored["section_text"]) == digest
        if row_id in REKEY_IDS:
            assert stored["section_number"] != old_key
        else:
            assert stored["section_number"] == old_key
    assert store.rows["00000000-0000-4000-8000-000000000001"]["section_number"] == "12A"
    assert store.rows["00000000-0000-4000-8000-000000000004"]["section_number"] == "12B"
    assert store.rows["00000000-0000-4000-8000-000000000011"]["section_number"] == "12"
    assert store.rows["00000000-0000-4000-8000-000000000015"]["section_number"] == "6-bbbbbbbb"
    assert store.rows["00000000-0000-4000-8000-000000000017"]["section_number"] == "12-aaaaaaaa"
    assert store.rows["00000000-0000-4000-8000-000000000019"]["section_number"] == "12a"
    second = plan_rows(list(store.rows.values()))
    assert all(row.action != "rekey" for plan in second for row in plan.rows)
    rollback_store = MemoryStore(list(store.rows.values()))
    rollback_store.execute_script(result["rollback_sql"])
    assert rollback_store.committed is True
    for row_id, (old_key, text, digest) in before.items():
        restored = rollback_store.rows[row_id]
        assert restored["section_number"] == old_key
        assert restored["section_text"] == text
        assert text_md5(restored["section_text"]) == digest


def test_apply_refuses_a_collision_and_rolls_back():
    rows = _rows(CLEAN_ACTS | {"collision", "duplicate-text"})
    store = MemoryStore(rows)
    snapshot = json.dumps(list(store.rows.values()), sort_keys=True)
    with pytest.raises(ReharvestRefusal, match="collision|unsafe act"):
        apply_transaction(store, rows, expect_count=len(REKEY_IDS), ids=sorted(REKEY_IDS))
    assert store.committed is False
    assert json.dumps(list(store.rows.values()), sort_keys=True) == snapshot
    collision = plan_rows(_rows({"collision"}))
    assert collision[0].apply_allowed is False
    assert {row.action for row in collision[0].rows} == {"collision"}
    duplicate = plan_rows(_rows({"duplicate-text"}))
    assert duplicate[0].apply_allowed is False
    assert all(row.action == "collision" for row in duplicate[0].rows)


def test_apply_guards_reject_a_partial_id_list():
    rows = _rows(CLEAN_ACTS)
    store = MemoryStore(rows)
    with pytest.raises(ReharvestRefusal, match="planned re-key count"):
        apply_transaction(store, rows, expect_count=1, ids=["00000000-0000-4000-8000-000000000001"])
    assert store.committed is False
    wrong_ids = sorted(REKEY_IDS)
    wrong_ids[0] = "00000000-0000-4000-8000-000000000099"
    with pytest.raises(ReharvestRefusal, match="id list"):
        apply_transaction(store, rows, expect_count=len(REKEY_IDS), ids=wrong_ids)
    with pytest.raises(ReharvestRefusal, match="expect-count"):
        apply_transaction(store, rows, expect_count=len(REKEY_IDS) + 1, ids=sorted(REKEY_IDS))
    with pytest.raises(ReharvestRefusal, match="duplicate"):
        apply_transaction(
            store, rows, expect_count=2,
            ids=["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"],
        )


def test_cli_is_dry_run_by_default_and_apply_writes_the_artifacts(tmp_path: Path):
    source = tmp_path / "rows.json"
    source.write_text(json.dumps(_rows(CLEAN_ACTS)), encoding="utf-8")
    before = source.read_bytes()
    report_path = tmp_path / "report.json"
    assert reharvest_main(["--input", str(source), "--output", str(report_path)]) == 0
    assert source.read_bytes() == before
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["dry_run"] is True and report["applied"] is False
    assert report["finding"] == "DATA-003-REHARVEST"
    assert "count_before" in report["sql"] and "count_after" in report["sql"]
    assert sql_is_read_only(report["sql"]["count_before"])
    assert not (tmp_path / "backup.jsonl").exists()
    backup = tmp_path / "backup.jsonl"
    rollback = tmp_path / "rollback.sql"
    apply_sql = tmp_path / "apply.sql"
    rows_out = tmp_path / "rows-out.json"
    applied_report = tmp_path / "applied.json"
    ids = ",".join(sorted(REKEY_IDS))
    assert reharvest_main([
        "--apply", "--expect-count", str(len(REKEY_IDS)), "--ids", ids,
        "--input", str(source), "--output", str(applied_report),
        "--backup", str(backup), "--rollback", str(rollback),
        "--apply-sql", str(apply_sql), "--rows-out", str(rows_out),
    ]) == 0
    assert source.read_bytes() == before
    body = json.loads(applied_report.read_text(encoding="utf-8"))
    assert body["applied"] is True and body["dry_run"] is False
    assert "BEGIN;" in apply_sql.read_text(encoding="utf-8")
    assert backup.read_text(encoding="utf-8").count("\n") == len(REKEY_IDS)
    restored = json.loads(rows_out.read_text(encoding="utf-8"))
    assert len(restored) == len(_rows(CLEAN_ACTS))
    with pytest.raises(SystemExit, match="require --apply"):
        reharvest_main(["--expect-count", "1", "--input", str(source), "--output", str(report_path)])
    with pytest.raises(SystemExit, match="requires --expect-count"):
        reharvest_main([
            "--apply", "--input", str(source), "--output", str(applied_report),
            "--backup", str(backup), "--rollback", str(rollback), "--apply-sql", str(apply_sql),
        ])
    refused = tmp_path / "refused.json"
    mixed = tmp_path / "mixed.json"
    mixed.write_text(json.dumps(_rows(CLEAN_ACTS | {"collision"})), encoding="utf-8")
    assert reharvest_main([
        "--apply", "--expect-count", str(len(REKEY_IDS)), "--ids", ids,
        "--input", str(mixed), "--output", str(refused),
        "--backup", str(tmp_path / "no-backup.jsonl"),
        "--rollback", str(tmp_path / "no-rollback.sql"),
        "--apply-sql", str(tmp_path / "no-apply.sql"),
    ]) == 2
    assert not (tmp_path / "no-backup.jsonl").exists()
    assert json.loads(refused.read_text(encoding="utf-8"))["applied"] is False
    with pytest.raises(SystemExit, match="live database"):
        reharvest_main([
            "--dsn", "postgresql://example.invalid/legalos",
            "--input", str(source), "--output", str(report_path),
        ])


def test_a_quoted_key_is_not_interpolated():
    rows = [{
        "id": "00000000-0000-4000-8000-000000000099",
        "table": "statutes_master",
        "short_name": "quote",
        "statute_name": "quote",
        "section_number": "12'; DELETE FROM statutes_master; --",
        "section_text": (
            "12-A. Inserted rates. The inserted rates in this section apply to "
            "instruments presented after the amendment."
        ),
        "ordinal": 1,
    }]
    store = MemoryStore(rows)
    with pytest.raises(ReharvestRefusal, match="unsafe SQL"):
        apply_transaction(
            store, rows, expect_count=1, ids=["00000000-0000-4000-8000-000000000099"],
        )
    assert store.committed is False
    assert store.rows["00000000-0000-4000-8000-000000000099"]["section_number"].startswith("12'")


def _copy(row, **changes):
    copied = copy.deepcopy(row)
    copied.update(changes)
    return copied


def test_document_order_is_the_source_ordinal_in_either_input_order():
    wrap = _rows({"wrap"})
    forward = plan_rows(wrap)[0].as_dict()
    backward = plan_rows(list(reversed(wrap)))[0].as_dict()
    stamped = []
    for index, row in enumerate(reversed(wrap)):
        stamped.append(_copy(row, created_at=f"1999-01-0{index + 1}T00:00:00Z"))
    stamped_plan = plan_rows(stamped)[0].as_dict()
    assert forward == backward == stamped_plan
    assert all(row["new_key"] != "12I" for row in forward["rows"])
    assert {row["action"] for row in forward["rows"] if row["old_key"] == "12"} == {"absorbed"}
    missing = []
    for row in wrap:
        stripped = _copy(row)
        stripped.pop("ordinal")
        stripped["created_at"] = "1999-01-01T00:00:00Z"
        missing.append(stripped)
    refused = plan_rows(missing)[0]
    assert refused.apply_allowed is False
    assert refused.refusal == "no source ordinal"
    assert all(row.action == "unordered" and row.new_key is None for row in refused.rows)
    assert "12I" not in json.dumps(refused.as_dict())


def test_guard_apply_replans_a_separate_live_copy():
    rows = _rows({"bare-12a"})
    live = copy.deepcopy(rows)
    live[0]["section_text"] = live[0]["section_text"] + " Amended."
    store = MemoryStore(rows)
    with pytest.raises(ReharvestRefusal, match="live plan diverges"):
        guard_apply(rows, live, expect_count=1, ids=[rows[0]["id"]])
    with pytest.raises(ReharvestRefusal, match="live plan diverges"):
        apply_transaction(store, rows, expect_count=1, ids=[rows[0]["id"]], live_rows=live)
    assert store.committed is False
    assert store.rows[rows[0]["id"]]["section_number"] == "12"


def test_a_folded_12a_collides_with_a_rekey_to_12A():
    glued = _copy(
        next(row for row in _rows() if row["id"].endswith("000000000019")),
        short_name="fold", statute_name="fold", ordinal=1,
    )
    bare = _copy(
        next(row for row in _rows() if row["id"].endswith("000000000001")),
        id="00000000-0000-4000-8000-000000000041",
        short_name="fold", statute_name="fold", ordinal=2,
    )
    plan = plan_rows([glued, bare])[0]
    assert plan.apply_allowed is False
    folded = {row.old_key: row.action for row in plan.rows}
    assert folded["12a"] == "unchanged"
    assert folded["12"] == "collision"


def test_a_schedule_key_is_not_rekeyed_to_a_body_key():
    row = _copy(
        next(item for item in _rows() if item["id"].endswith("000000000001")),
        id="00000000-0000-4000-8000-000000000042",
        short_name="sched", statute_name="sched",
        section_number="schedule:1:12A", ordinal=1,
    )
    plan = plan_rows([row])[0]
    assert plan.apply_allowed is True
    assert plan.rows[0].action == "unchanged"
    assert plan.rows[0].old_key == plan.rows[0].new_key == "schedule:1:12A"
    store = MemoryStore([row])
    with pytest.raises(ReharvestRefusal, match="planned re-key count"):
        apply_transaction(store, [row], expect_count=1, ids=[row["id"]])
    assert store.rows[row["id"]]["section_number"] == "schedule:1:12A"


def test_act_keys_are_rewritten_so_publication_does_not_retire():
    text_12a = next(row["section_text"] for row in _rows() if row["id"].endswith("000000000001"))
    inventory = ["12", "13"]
    twelve = {
        "id": "00000000-0000-4000-8000-000000000043",
        "table": "statutes_staging",
        "short_name": "inventory",
        "statute_name": "inventory",
        "section_number": "12",
        "section_text": text_12a,
        "raw_text": text_12a,
        "ordinal": 1,
        "parsing_metadata": {"act_keys": list(inventory), "keying": "fa-f21-017"},
    }
    thirteen_text = (
        "13. Other. This other section applies to every instrument presented "
        "for registration under this Act."
    )
    thirteen = {
        "id": "00000000-0000-4000-8000-000000000044",
        "table": "statutes_staging",
        "short_name": "inventory",
        "statute_name": "inventory",
        "section_number": "13",
        "section_text": thirteen_text,
        "raw_text": thirteen_text,
        "ordinal": 2,
        "parsing_metadata": {"act_keys": list(inventory), "keying": "fa-f21-017"},
    }
    plan = plan_rows([twelve, thirteen])[0]
    assert plan.apply_allowed is True
    assert list(plan.act_keys) == ["12A", "13"]
    assert keys_to_retire(["12A", "13"], plan.act_keys, "12A") == []
    assert "12A" in keys_to_retire(["12A", "13"], inventory, "13")
    store = MemoryStore([twelve, thirteen])
    result = apply_transaction(
        store, [twelve, thirteen], expect_count=1, ids=[twelve["id"]],
    )
    assert store.rows[twelve["id"]]["section_number"] == "12A"
    assert store.rows[twelve["id"]]["parsing_metadata"]["act_keys"] == ["12A", "13"]
    assert store.rows[thirteen["id"]]["section_number"] == "13"
    assert store.rows[thirteen["id"]]["parsing_metadata"]["act_keys"] == ["12A", "13"]
    assert store.rows[thirteen["id"]]["parsing_metadata"]["keying"] == "fa-f21-017"
    rollback = MemoryStore(list(store.rows.values()))
    rollback.execute_script(result["rollback_sql"])
    assert rollback.rows[twelve["id"]]["section_number"] == "12"
    assert rollback.rows[twelve["id"]]["parsing_metadata"]["act_keys"] == ["12", "13"]
    assert rollback.rows[thirteen["id"]]["parsing_metadata"]["act_keys"] == ["12", "13"]
    divergent = [_copy(twelve), _copy(thirteen)]
    divergent[0]["parsing_metadata"] = {"act_keys": ["12"]}
    divergent[1]["parsing_metadata"] = {"act_keys": ["12"]}
    refused = plan_rows(divergent)[0]
    assert refused.apply_allowed is False
    assert refused.refusal == "act_keys would diverge"


def test_rollback_uses_temporary_keys_for_a_12_12A_12B_chain():
    text_12a = next(row["section_text"] for row in _rows() if row["id"].endswith("000000000001"))
    text_12b = next(row["section_text"] for row in _rows() if row["id"].endswith("000000000004"))
    first = {
        "id": "00000000-0000-4000-8000-000000000030",
        "table": "statutes_master",
        "short_name": "chain",
        "statute_name": "chain",
        "section_number": "12",
        "section_text": text_12a,
        "ordinal": 1,
    }
    second = {
        "id": "00000000-0000-4000-8000-000000000031",
        "table": "statutes_master",
        "short_name": "chain",
        "statute_name": "chain",
        "section_number": "12A",
        "section_text": text_12b,
        "ordinal": 2,
    }
    diffs = {row.id: row for row in plan_rows([first, second])[0].rows}
    assert diffs[first["id"]].action == "rekey" and diffs[first["id"]].new_key == "12A"
    assert diffs[second["id"]].action == "rekey" and diffs[second["id"]].new_key == "12B"
    store = MemoryStore([first, second])
    result = apply_transaction(
        store, [first, second], expect_count=2, ids=[first["id"], second["id"]],
    )
    assert store.rows[first["id"]]["section_number"] == "12A"
    assert store.rows[second["id"]]["section_number"] == "12B"
    statements = [line for line in result["rollback_sql"].splitlines() if line.startswith("WITH updated")]
    assert len(statements) == 4
    assert all(TEMP_PREFIX in line for line in statements[:2])
    assert "1/0" in statements[0]
    assert text_md5(text_12a) in statements[0]
    assert "= '12'" in statements[2] or "= '12A'" in statements[2]
    assert "= '12'" in statements[3] or "= '12A'" in statements[3]
    restored = MemoryStore(list(store.rows.values()))
    restored.execute_script(result["rollback_sql"])
    assert restored.committed is True
    assert restored.rows[first["id"]]["section_number"] == "12"
    assert restored.rows[second["id"]]["section_number"] == "12A"


def test_cli_refuses_an_output_that_aliases_the_input_or_another_output(tmp_path: Path):
    source = tmp_path / "rows.json"
    source.write_text("[]\n", encoding="utf-8")
    before = source.read_bytes()
    with pytest.raises(SystemExit, match="aliases"):
        reharvest_main(["--input", str(source), "--output", str(source)])
    assert source.read_bytes() == before
    hard = tmp_path / "hard.json"
    os.link(source, hard)
    with pytest.raises(SystemExit, match="aliases"):
        reharvest_main(["--input", str(source), "--output", str(hard)])
    assert source.read_bytes() == before
    mirror = tmp_path / "mirror.json"
    mirror.symlink_to(source)
    with pytest.raises(SystemExit, match="aliases"):
        reharvest_main(["--input", str(source), "--output", str(mirror)])
    assert source.read_bytes() == before
    report = tmp_path / "report.json"
    shared = tmp_path / "shared.out"
    with pytest.raises(SystemExit, match="aliases"):
        reharvest_main([
            "--apply", "--expect-count", "1",
            "--ids", "00000000-0000-4000-8000-000000000001",
            "--input", str(source), "--output", str(report),
            "--backup", str(shared), "--rollback", str(shared),
            "--apply-sql", str(tmp_path / "apply.sql"),
        ])
    assert source.read_bytes() == before
    assert not report.exists()
