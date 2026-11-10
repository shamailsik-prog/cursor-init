"""FA-F21-017: PakistanCode section identity. Aliases FA-F21-006..016 are the historical
PR #90 notes this finding absorbed; the assertions below are against the current rule,
not against those unmerged rounds.

Nine acceptance cases from the 2026-11-07 execution queue. No database is opened.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from scraper.parsers.pakistancode_keys import (
    MAX_STAGED_DIVS,
    SHORT_DIV_MAX_EXCLUSIVE,
    HarvestDelta,
    PublishedSection,
    act_keys_from_metadata,
    apply_harvest,
    apply_legacy_rekey,
    act_inventory_is_complete,
    fallback_act_keys,
    page_has_text_besides_schedule_headings,
    snapshot_is_incomplete,
    harvest_is_stale,
    harvest_token_from_metadata,
    key_div_texts,
    pre_clock_act,
    keys_to_retire,
    lookup_real_section,
    schedule_container_label,
    suppresses_plain_text_fallback,
    note_section_version,
    plan_legacy_rekey,
    section_by_key,
)
from scripts.rekey_pakistancode_section_keys import main as rekey_main

HEADING = "THE FIRST SCHEDULE"
SECTION_1 = "1. Short title. This Act may be called the First Harvest Fixture Act for keying."
SECTION_2 = "2. Definitions. In this first-harvest fixture words have the meanings given here."
SECTION_3 = "3. Extent. This first-harvest fixture extends to the synthetic territory described here."
PREAMBLE = "Preamble. WHEREAS it is expedient to stage this numberless preamble and to keep its key."
EXPLANATION = "Explanation. This numberless explanation is staged and is not dropped when numbered divs exist."
SCHEDULE_ITEM = "1. Stamp on a conveyance. This schedule item is staged under its own key, not section 1."
TABLE_OF_RATES = "Table of rates payable on the instruments listed in this numberless div and not a heading."
THE_FORM = "The form of notice a party must serve is printed in this numberless div and opens no schedule."


def _keys(texts):
    return [section.key for section in key_div_texts(texts).sections]


def _store(texts):
    store: dict = {}
    apply_harvest(store, key_div_texts(texts).sections)
    return store


def _divs(texts):
    body = "".join(f"<div class='section'>{text}</div>" for text in texts)
    return f"<html><h1>Fixture Act</h1>{body}</html>"


# ---------------------------------------------------------------------------------------------
# 1. first harvest: every kept div staged, counts equal, numberless keys stable
# ---------------------------------------------------------------------------------------------
def test_acceptance_1_first_harvest_stages_every_kept_div_including_numberless():
    texts = [PREAMBLE, SECTION_1, SECTION_2, EXPLANATION, HEADING, SCHEDULE_ITEM]
    first = key_div_texts(texts)
    second = key_div_texts(texts)
    assert len(first.sections) == len(texts)
    assert first.skipped_short == 0 and first.dropped_by_cap == 0
    assert [section.kind for section in first.sections] == [
        "preamble", "section", "section", "explanation", "schedule-heading", "schedule-item",
    ]
    assert first.sections[1].key == "1" and first.sections[1].lookup_number == "1"
    assert first.sections[0].key.startswith("preamble-")
    assert first.sections[3].key.startswith("explanation-")
    assert first.sections[4].key == "schedule-heading:1"
    assert first.sections[5].key == "schedule:1:1"
    assert [section.key for section in first.sections] == [section.key for section in second.sections]
    short_preamble = key_div_texts(["Preamble"])
    assert short_preamble.skipped_short == 0 and len(short_preamble.sections) == 1
    assert short_preamble.sections[0].kind == "preamble"
    repeated = "Preamble. WHEREAS this exact preamble text is repeated so neither copy is dropped."
    both = key_div_texts([repeated, repeated])
    assert len(both.sections) == 2
    assert both.sections[0].key != both.sections[1].key
    assert both.sections[1].key.endswith("~2")


# ---------------------------------------------------------------------------------------------
# 2. insert a new div mid-act: other keys stay, the new text is published once
# ---------------------------------------------------------------------------------------------
def test_acceptance_2_insert_mid_act_does_not_rekey_siblings():
    base = [SECTION_1, SECTION_2, SECTION_3]
    assert _keys([SECTION_3, SECTION_1, SECTION_2]) == ["3", "1", "2"]
    store = _store(base)
    before = {key: (row.text, list(row.versions), row.retired) for key, row in store.items()}
    inserted = "9. Insertion. This new div sits between the first and the second and is published once."
    delta = apply_harvest(store, key_div_texts([SECTION_1, inserted, SECTION_2, SECTION_3]).sections)
    assert delta.inserted == ["9"]
    assert delta.retired == [] and delta.amended == []
    for key, (text, versions, retired) in before.items():
        assert store[key].text == text and store[key].versions == versions and store[key].retired is retired
    assert store["9"].versions == [store["9"].text]
    assert sum(1 for row in store.values() if row.text == before["1"][0]) == 1
    assert sum(1 for row in store.values() if row.text == before["2"][0]) == 1


# ---------------------------------------------------------------------------------------------
# 3. delete a div: only that key is retired
# ---------------------------------------------------------------------------------------------
def test_acceptance_3_delete_retires_only_that_key():
    base = [SECTION_1, SECTION_2, SECTION_3]
    store = _store(base)
    kept = {key: store[key].text for key in ("1", "3")}
    delta = apply_harvest(store, key_div_texts([SECTION_1, SECTION_3]).sections)
    assert delta.retired == ["2"]
    assert store["2"].retired is True
    assert store["1"].retired is False and store["1"].text == kept["1"]
    assert store["3"].retired is False and store["3"].text == kept["3"]
    assert store["1"].versions == [kept["1"]] and store["3"].versions == [kept["3"]]
    assert keys_to_retire(["1", "2", "1. Short title. This"], ["1", "3"], "1") == ["1. Short title. This", "2"]
    assert keys_to_retire(["1", "2"], [], "1") == []
    assert keys_to_retire(["1", "2"], None, "1") == []
    assert keys_to_retire(["3"], ["1"], "3") == []


# ---------------------------------------------------------------------------------------------
# 4. amend a numbered section: same key, new version, no second row
# ---------------------------------------------------------------------------------------------
def test_acceptance_4_amend_numbered_section_keeps_key_and_records_a_version():
    base = [SECTION_1, SECTION_2, SECTION_3]
    store = _store(base)
    original = store["2"].text
    amended = "2. Definitions. The amended text of this numbered section replaces the prior version in full."
    delta = apply_harvest(store, key_div_texts([SECTION_1, amended, SECTION_3]).sections)
    assert isinstance(delta, HarvestDelta)
    assert delta.amended == ["2"] and delta.inserted == [] and delta.retired == []
    assert store["2"].key == "2" and store["2"].retired is False
    assert store["2"].versions == [original, store["2"].text]
    assert store["2"].text != original
    assert len([row for row in store.values() if not row.retired and row.key == "2"]) == 1
    assert len(store) == 3
    meta = note_section_version({"keying": "fa-f21-017"}, original, store["2"].text)
    assert meta["section_version"] == 2
    assert meta["prior_section_text_sha256"] == hashlib.sha256(original.encode("utf-8")).hexdigest()
    assert note_section_version(meta, store["2"].text, store["2"].text)["section_version"] == 2


# ---------------------------------------------------------------------------------------------
# 5. section 1 and schedule item 1 stay distinct across three reruns
# ---------------------------------------------------------------------------------------------
def test_acceptance_5_duplicate_number_is_distinct_and_stable_across_reruns():
    texts = [SECTION_1, HEADING, SCHEDULE_ITEM]
    runs = [_keys(texts) for _ in range(3)]
    assert runs[0] == runs[1] == runs[2]
    assert runs[0] == ["1", "schedule-heading:1", "schedule:1:1"]
    store: dict = {}
    deltas = [apply_harvest(store, key_div_texts(texts).sections) for _ in range(3)]
    assert deltas[0].inserted == ["1", "schedule-heading:1", "schedule:1:1"]
    assert deltas[1].inserted == [] and deltas[2].inserted == []
    assert deltas[2].retired == [] and deltas[2].amended == []
    assert all(len(row.versions) == 1 and row.retired is False for row in store.values())
    assert len(store) == 3
    body_pair = key_div_texts([
        "1. Alpha text of the first body section that shares its number with another.",
        "1. Beta text of the second body section that must not merge into the first.",
    ])
    assert len(body_pair.sections) == 2
    assert body_pair.sections[0].key != body_pair.sections[1].key
    assert body_pair.sections[0].key != "1" and body_pair.sections[1].key != "1"


# ---------------------------------------------------------------------------------------------
# 6. lookup by "1" returns the section, not the schedule item
# ---------------------------------------------------------------------------------------------
def test_acceptance_6_lookup_by_real_number_returns_the_section_not_the_schedule_item():
    store = _store([SECTION_1, HEADING, SCHEDULE_ITEM])
    found = lookup_real_section(store, "1")
    assert found is not None
    assert found.key == "1" and found.kind == "section"
    assert "Short title" in found.text and "conveyance" not in found.text.lower()
    schedule = section_by_key(store, "schedule:1:1")
    assert schedule is not None and schedule.kind == "schedule-item"
    assert "conveyance" in schedule.text.lower()
    assert lookup_real_section(store, "schedule:1:1") is None
    store["1"].retired = True
    assert lookup_real_section(store, "1") is None


# ---------------------------------------------------------------------------------------------
# 7. short heading kept; 20 skipped; 21 kept; skipped divs do not consume the cap
# ---------------------------------------------------------------------------------------------
def test_acceptance_7_heading_short_div_boundary_and_cap():
    assert SHORT_DIV_MAX_EXCLUSIVE == 20 and MAX_STAGED_DIVS == 50
    assert len(HEADING) == 18 and len(HEADING) <= 20
    heading = key_div_texts([HEADING])
    assert heading.skipped_short == 0 and heading.sections[0].kind == "schedule-heading"
    twenty = "x" * 20
    twenty_one = "y" * 21
    boundary = key_div_texts([twenty, twenty_one, HEADING])
    assert boundary.skipped_short == 1
    assert [section.text for section in boundary.sections] == [twenty_one, HEADING]
    assert twenty not in [section.text for section in boundary.sections]
    body = "{n}. Body text of section {n} is longer than twenty characters so it is kept."
    longs = [body.format(n=n) for n in range(1, 51)]
    after_shorts = key_div_texts(["z" * 20] * 50 + longs)
    assert after_shorts.skipped_short == 50 and after_shorts.dropped_by_cap == 0
    assert len(after_shorts.sections) == 50
    assert [section.key for section in after_shorts.sections] == [str(n) for n in range(1, 51)]
    over_cap = key_div_texts(longs + [body.format(n=51)])
    assert len(over_cap.sections) == 50 and over_cap.dropped_by_cap == 1
    assert over_cap.sections[-1].key == "50"
    mixed = key_div_texts([body.format(n=n) for n in range(1, 50)] + ["n" * 20] * 10 + [body.format(n=50)])
    assert mixed.skipped_short == 10 and len(mixed.sections) == 50 and mixed.sections[-1].key == "50"


# ---------------------------------------------------------------------------------------------
# 8. a structural word does not rename later sections
# ---------------------------------------------------------------------------------------------
def test_acceptance_8_structural_word_does_not_rename_later_sections():
    result = key_div_texts([
        "1. Short title. This Act may be called the Structural Word Fixture Act only.",
        TABLE_OF_RATES,
        THE_FORM,
        "2. Definitions. Words in this structural-word fixture keep their ordinary section keys.",
    ])
    assert [section.kind for section in result.sections] == ["section", "div", "div", "section"]
    assert result.sections[0].key == "1" and result.sections[3].key == "2"
    assert result.sections[1].key.startswith("div-") and result.sections[2].key.startswith("div-")
    assert result.sections[3].lookup_number == "2"
    assert not result.sections[3].key.startswith("schedule")
    assert all(section.schedule_label is None for section in result.sections)


# ---------------------------------------------------------------------------------------------
# 9. migration plan is idempotent, dry-run, and refuses a live database
# ---------------------------------------------------------------------------------------------
def _row(row_id, text, short_name="ppc1860", source="PakistanCode", section_number=None):
    return {
        "id": row_id,
        "short_name": short_name,
        "source_site": source,
        "section_number": text[:20] if section_number is None else section_number,
        "section_text": text,
    }


def test_acceptance_9_rekey_plan_is_idempotent_dry_run_and_refuses_a_live_database(tmp_path: Path):
    own_preamble = "Preamble. WHEREAS a different numberless preamble is rekeyed on its own content."
    preamble = _row("preamble", own_preamble)
    numbered = _row("numbered", SECTION_1)
    duplicate = _row("copy-a", PREAMBLE)
    other_copy = _row("copy-b", PREAMBLE)
    foreign = _row("foreign", PREAMBLE, source="NationalAssembly")
    original = [preamble, numbered, duplicate, other_copy, foreign]
    snapshot = json.dumps(original)
    plan = plan_legacy_rekey(original)
    assert json.dumps(original) == snapshot
    by_id = {action.row_id: action for action in plan}
    assert by_id["preamble"].action == "rekey" and by_id["preamble"].new_key.startswith("preamble-")
    assert by_id["numbered"].action == "needs_reharvest" and by_id["numbered"].new_key == "1"
    assert by_id["copy-a"].action == "conflict" and by_id["copy-b"].action == "conflict"
    assert by_id["foreign"].action == "unchanged"
    applied = apply_legacy_rekey(original, plan)
    assert original[0]["section_number"] == own_preamble[:20]
    assert applied[0]["section_number"] == by_id["preamble"].new_key
    assert applied[1]["section_number"] == SECTION_1[:20]
    assert applied[2]["section_number"] == PREAMBLE[:20] and applied[3]["section_number"] == PREAMBLE[:20]
    second = plan_legacy_rekey(applied)
    assert all(action.action != "rekey" for action in second)
    assert apply_legacy_rekey(applied, second) == applied

    source = tmp_path / "rows.json"
    source.write_text(json.dumps([preamble]), encoding="utf-8")
    before = source.read_bytes()
    plan_path = tmp_path / "plan.json"
    assert rekey_main(["--dry-run", "--input", str(source), "--output", str(plan_path)]) == 0
    assert source.read_bytes() == before
    written = json.loads(plan_path.read_text(encoding="utf-8"))
    assert written["dry_run"] is True and written["actions"][0]["action"] == "rekey"
    applied_path = tmp_path / "applied.json"
    assert rekey_main(["--apply", "--input", str(source), "--output", str(applied_path)]) == 0
    assert source.read_bytes() == before
    applied_body = json.loads(applied_path.read_text(encoding="utf-8"))
    assert applied_body["dry_run"] is False
    assert applied_body["rows"][0]["section_number"].startswith("preamble-")
    again_path = tmp_path / "again.json"
    rows_path = tmp_path / "rows-applied.json"
    rows_path.write_text(json.dumps(applied_body["rows"]), encoding="utf-8")
    assert rekey_main(["--dry-run", "--input", str(rows_path), "--output", str(again_path)]) == 0
    assert json.loads(again_path.read_text(encoding="utf-8"))["actions"][0]["action"] == "unchanged"
    with pytest.raises(SystemExit, match="live database"):
        rekey_main(["--dsn", "postgresql://example.invalid/legalos", "--input", str(source), "--output", str(plan_path)])


# ---------------------------------------------------------------------------------------------
# the harvester stages these keys; the F21 synthetic sentences stay real numbers
# ---------------------------------------------------------------------------------------------
def test_harvester_stages_locked_keys_and_f21_fixture_numbers_stay_real(monkeypatch):
    from scraper.net import fetch_policy
    from scraper.tasks import pakistancode

    texts = [PREAMBLE, SECTION_1, "q" * 20, HEADING, SCHEDULE_ITEM]
    pages = {
        "https://pakistancode.gov.pk/federal": "<html></html>",
        "https://pakistancode.gov.pk/english/statues/details/ppc1860": _divs(texts),
    }

    class _Resp:
        def __init__(self, body, status=200):
            self.status_code = status
            self.text = body

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, *args, **kwargs):
            if url in pages:
                return _Resp(pages[url])
            return _Resp("missing", status=404)

    class _Source:
        id = uuid.UUID("11111111-1111-1111-1111-111111111111")
        source_name = "PakistanCode"

    class _DB:
        def __init__(self):
            self.rows = []

        def add(self, row):
            self.rows.append(row)

        async def commit(self):
            return None

    monkeypatch.setattr(fetch_policy, "fetcher_for", lambda *args, **kwargs: _Client())
    monkeypatch.setattr(pakistancode, "TARGET_SLUGS", ["ppc1860"])
    monkeypatch.setattr(pakistancode.asyncio, "sleep", lambda *args, **kwargs: _asleep())

    async def _asleep():
        return None

    db = _DB()
    asyncio.run(pakistancode.scrape_pakistancode(_Source(), db))
    assert len(db.rows) == 4
    keys = [row.extracted_section_number for row in db.rows]
    assert keys[0].startswith("preamble-") and len(keys[0]) == len("preamble-") + 8
    assert keys[1:] == ["1", "schedule-heading:1", "schedule:1:1"]
    assert all(row.extracted_section_number != (row.extracted_section_text or "")[:20] for row in db.rows)
    assert db.rows[1].parsing_metadata["lookup_number"] == "1"
    assert db.rows[3].parsing_metadata["lookup_number"] is None
    assert db.rows[3].parsing_metadata["section_kind"] == "schedule-item"
    assert all(row.parsing_metadata["act_keys"] == keys for row in db.rows)
    assert act_keys_from_metadata(db.rows[0].parsing_metadata) == frozenset(keys)
    assert db.rows[0].parsing_metadata["source_name"] == "PakistanCode"
    assert len({row.parsing_metadata["harvest_at"] for row in db.rows}) == 1
    assert "+" in db.rows[0].parsing_metadata["harvest_at"] or db.rows[0].parsing_metadata["harvest_at"].endswith("Z")
    fixture = key_div_texts([
        "1. Short title. This Act may be called the F21 Test Penal Act 2099 (synthetic).",
        "2. Definitions. In the F21 Test Penal Act 2099 words are synthetic fixture text.",
    ])
    assert [section.key for section in fixture.sections] == ["1", "2"]


def test_fa_f21_018_flat_heading_before_body_does_not_become_a_schedule_item():
    """A flat heading with no preceding body section does not relabel later numbered divs.

    The live page shape is not in this repository. A previous sibling heading is not an
    ancestor container, so the later divs are unscoped: lookup of "1" returns nothing.
    """
    from bs4 import BeautifulSoup

    later = "2. Extent. This later numbered div is longer than twenty characters."
    flat = f"<div id='wrap'><div class='section'>{HEADING}</div><div class='section'>{SECTION_1}</div><div class='section'>{later}</div></div>"
    soup = BeautifulSoup(flat, "html.parser")
    nodes = soup.find_all("div", class_="section")
    assert [schedule_container_label(node) for node in nodes] == [None, None, None]
    keyed = key_div_texts([node.get_text(" ", strip=True) for node in nodes], [schedule_container_label(node) for node in nodes])
    keys = [item.key for item in keyed.sections]
    assert keys[0] == "schedule-heading:1"
    assert keys[1].startswith("unscoped:1-") and keys[2].startswith("unscoped:2-")
    assert not any(key.startswith("schedule:") for key in keys[1:])
    assert lookup_real_section({item.key: PublishedSection(item.key, item.text, item.kind, item.lookup_number, [item.text]) for item in keyed.sections}, "1") is None
    nested = "<div class='schedule'><h2>THE FIRST SCHEDULE</h2><div class='section'>1. Stamp on a conveyance is nested under the heading.</div></div>"
    node = BeautifulSoup(nested, "html.parser").find("div", class_="section")
    assert schedule_container_label(node) == "1"
    contained = key_div_texts([node.get_text(" ", strip=True)], [schedule_container_label(node)])
    assert [item.key for item in contained.sections] == ["schedule:1:1"]
    assert contained.sections[0].lookup_number is None


def test_fa_f21_018_scope_stays_open_after_a_body_section():
    """Once a body section has opened schedule scope, a later numbered div stays a schedule item.

    FA-17 publishes that item. The page is a complete inventory, so its keys include the
    body section and the schedule keys in document order. Lookup of "1" stays the body.
    No captured page substantiates closing or keeping the scope.
    """
    later = "3. A later numbered div follows the schedule and is longer than twenty characters."
    keyed = key_div_texts([SECTION_1, HEADING, SCHEDULE_ITEM, later])
    assert [item.key for item in keyed.sections] == ["1", "schedule-heading:1", "schedule:1:1", "schedule:1:3"]
    assert keyed.sections[0].lookup_number == "1"
    assert keyed.sections[3].kind == "schedule-item" and keyed.sections[3].lookup_number is None
    assert act_inventory_is_complete(keyed) is True
    assert lookup_real_section(
        {item.key: PublishedSection(item.key, item.text, item.kind, item.lookup_number, [item.text]) for item in keyed.sections},
        "1",
    ).text == SECTION_1


def test_fa_f21_019_fallback_runs_only_when_no_content_div_is_kept(monkeypatch):
    """Paragraph splitting is the no-kept-div path. Kept numbered divs never enter it.

    Two paragraph sections that share a number are both staged, under distinct
    ``N-<sha8>`` keys, and the page stamps ``act_keys``. A page whose text is only a
    schedule heading does not run the splitter and does not stamp ``act_keys``.
    Two ``div.section`` nodes that share a number still do not enter the splitter.
    """
    from scraper.net import fetch_policy
    from scraper.tasks import pakistancode

    calls = {"n": 0}
    real = pakistancode.split_into_sections

    def _wrapped(text, name=None):
        calls["n"] += 1
        return real(text, name)

    class _Resp:
        def __init__(self, body, status=200):
            self.status_code = status
            self.text = body

    class _Client:
        def __init__(self, page):
            self.page = page

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, *args, **kwargs):
            if url.endswith("/ppc1860"):
                return _Resp(self.page)
            if url.endswith("/federal"):
                return _Resp("<html></html>")
            return _Resp("missing", status=404)

    class _Source:
        id = uuid.UUID("11111111-1111-1111-1111-111111111111")
        source_name = "PakistanCode"

    class _DB:
        def __init__(self):
            self.rows = []

        def add(self, row):
            self.rows.append(row)

        async def commit(self):
            return None

    async def _asleep():
        return None

    monkeypatch.setattr(pakistancode, "split_into_sections", _wrapped)
    monkeypatch.setattr(pakistancode, "TARGET_SLUGS", ["ppc1860"])
    monkeypatch.setattr(pakistancode.asyncio, "sleep", lambda *args, **kwargs: _asleep())

    def _run(page):
        calls["n"] = 0
        db = _DB()
        monkeypatch.setattr(fetch_policy, "fetcher_for", lambda *args, **kwargs: _Client(page))
        asyncio.run(pakistancode.scrape_pakistancode(_Source(), db))
        return calls["n"], db.rows

    alpha = "1. Alpha section text is longer than twenty characters."
    beta = "1. Beta section text is longer than twenty characters."
    calls_n, rows = _run(f"<html><div class='section'>{alpha}</div><div class='section'>{beta}</div></html>")
    assert calls_n == 0
    assert len(rows) == 2
    assert rows[0].extracted_section_number != rows[1].extracted_section_number
    assert all(row.extracted_section_number != "1" for row in rows)
    assert "act_keys" in rows[0].parsing_metadata

    calls_n, rows = _run(
        "<html><p>1. Alpha paragraph is longer than twenty characters for the parser.</p>"
        "<p>1. Beta paragraph is also longer than twenty characters and a duplicate number.</p></html>"
    )
    assert calls_n == 1
    assert len(rows) == 2
    assert all(row.parsing_metadata["section_kind"] == "fallback" for row in rows)
    texts = " ".join(row.extracted_section_text for row in rows)
    assert "Alpha paragraph" in texts and "Beta paragraph" in texts
    assert rows[0].extracted_section_number != rows[1].extracted_section_number
    assert all(row.extracted_section_number != "1" for row in rows)
    assert all(row.extracted_section_number.startswith("1-") for row in rows)
    assert rows[0].parsing_metadata["act_keys"] == [row.extracted_section_number for row in rows]
    assert rows[1].parsing_metadata["act_keys"] == rows[0].parsing_metadata["act_keys"]

    calls_n, rows = _run(
        f"<html><h1>Fixture Act</h1><div class='section'>{HEADING}</div>"
        "<p>1. Alpha paragraph is longer than twenty characters for the parser.</p>"
        "<p>2. Beta paragraph is longer than twenty characters for the parser.</p></html>"
    )
    assert calls_n == 1
    keys = [row.extracted_section_number for row in rows]
    assert keys[0] == "schedule-heading:1"
    assert "1" in keys and "2" in keys
    assert all(row.parsing_metadata["act_keys"] == keys for row in rows)
    assert fallback_act_keys(key_div_texts([HEADING]), [(key, "schedule-heading" if key.startswith("schedule-heading") else "fallback") for key in keys]) == keys

    calls_n, rows = _run(
        f"<html><h1>The Stamp Act, 1899</h1><div class='section'>{HEADING}</div></html>"
    )
    assert calls_n == 0
    assert [row.extracted_section_number for row in rows] == ["schedule-heading:1"]
    assert rows[0].extracted_section_text == HEADING
    assert "act_keys" not in rows[0].parsing_metadata
    assert page_has_text_besides_schedule_headings(
        f"The Stamp Act, 1899 {HEADING}", [HEADING], "The Stamp Act, 1899",
    ) is False
    assert page_has_text_besides_schedule_headings(
        f"The Stamp Act, 1899 {HEADING} 1. Alpha paragraph is longer than twenty characters.",
        [HEADING], "The Stamp Act, 1899",
    ) is True

    calls_n, rows = _run("<html><div class='section'>" + ("q" * 20) + "</div></html>")
    assert calls_n == 1
    heading_only = key_div_texts([HEADING])
    assert suppresses_plain_text_fallback(heading_only) is False
    assert suppresses_plain_text_fallback(key_div_texts([SECTION_1])) is True
    assert fallback_act_keys(key_div_texts([HEADING, SECTION_1]), [("schedule-heading:1", "schedule-heading"), ("unscoped:1-aaaaaaaa", "unscoped")]) is None


def test_publish_statute_amends_the_same_row_and_retires_only_absent_keys():
    """A newer harvest amends in place and retires absent keys. The clock is harvest_at."""
    from types import SimpleNamespace

    from scraper.models import StatutesStaging
    from scraper.publication.retrieval import publish_statute

    class _Result:
        def __init__(self, rows=None, scalar=None):
            self._rows = list(rows or [])
            self._scalar = scalar

        def scalars(self):
            return self

        def first(self):
            return self._rows[0] if self._rows else None

        def all(self):
            return list(self._rows)

        def scalar(self):
            return self._scalar

        def one(self):
            return self._scalar

    class _DB:
        def __init__(self, current, deleted):
            self.current = current
            self.deleted = deleted
            self.calls = 0

        def add(self, row):
            raise AssertionError("an amended section must not insert a second master row")

        async def flush(self):
            return None

        async def execute(self, statement, params=None):
            self.calls += 1
            if self.calls in (1, 2):
                return _Result([])
            if self.calls == 3:
                return _Result(scalar=(2, self.current.harvest_at, 0))
            if self.calls == 4:
                return _Result([self.current])
            return _Result([self.current, self.deleted])

    older = datetime(2026, 11, 1, tzinfo=timezone.utc)
    newer = datetime(2026, 11, 2, tzinfo=timezone.utc)
    current = SimpleNamespace(
        id=uuid.uuid4(), section_number="2", section_text=SECTION_2, section_title="Definitions",
        is_repealed=True, harvest_at=older,
    )
    deleted = SimpleNamespace(
        id=uuid.uuid4(), section_number="9", section_text="old insertion", section_title=None,
        is_repealed=False, harvest_at=older,
    )
    amended = "2. Definitions. The amended text of this numbered section replaces the prior version in full."
    staging = StatutesStaging(
        extracted_act_name="Fixture Act",
        extracted_short_name="ppc1860",
        extracted_section_number="2",
        extracted_section_title="Definitions",
        extracted_section_text=amended,
        raw_text=amended,
        confidence_score=0.85,
        parsing_metadata={
            "act_keys": ["1", "2"], "keying": "fa-f21-017", "source_name": "PakistanCode",
            "harvest_at": newer.isoformat(),
        },
    )
    db = _DB(current, deleted)
    published = asyncio.run(publish_statute(db, staging, SimpleNamespace(source_name="PakistanCode")))
    assert (published.id, published.attached, published.changed, published.stale) == (current.id, True, True, False)
    assert current.section_text == amended and current.is_repealed is False and current.harvest_at == newer
    assert deleted.is_repealed is True and deleted.harvest_at == newer and deleted.section_number == "9"
    assert staging.parsing_metadata["section_version"] == 2
    assert staging.parsing_metadata["act_keys"] == ["1", "2"]
    assert db.calls == 5


def test_publish_statute_refuses_a_stale_harvest_without_clearing_repeal():
    """An older act_keys set must not un-repeal a key or retire what a newer harvest kept."""
    from types import SimpleNamespace

    from scraper.models import StatutesStaging
    from scraper.publication.retrieval import publish_statute

    class _Result:
        def __init__(self, scalar=None):
            self._scalar = scalar

        def scalar(self):
            return self._scalar

        def one(self):
            return self._scalar

    class _DB:
        def __init__(self):
            self.calls = 0

        def add(self, row):
            raise AssertionError("a stale harvest must not insert a master row")

        async def flush(self):
            raise AssertionError("a stale harvest must not flush")

        async def execute(self, statement, params=None):
            self.calls += 1
            if self.calls == 3:
                return _Result(scalar=(1, datetime(2026, 11, 2, tzinfo=timezone.utc), 0))
            return _Result()

    staging = StatutesStaging(
        extracted_act_name="Fixture Act",
        extracted_short_name="ppc1860",
        extracted_section_number="3",
        extracted_section_text="3. Stale text that must not be written back onto the retired key.",
        raw_text="3. Stale text that must not be written back onto the retired key.",
        confidence_score=0.85,
        parsing_metadata={"act_keys": ["1", "3"], "harvest_at": "2026-11-01T00:00:00+00:00"},
    )
    db = _DB()
    published = asyncio.run(publish_statute(db, staging, SimpleNamespace(source_name="PakistanCode")))
    assert published.stale is True and published.id is None and published.changed is False
    assert db.calls == 3
    assert "section_version" not in (staging.parsing_metadata or {})


def test_acceptance_helpers_do_not_invent_a_live_key_set():
    older = datetime(2026, 11, 1, tzinfo=timezone.utc)
    newer = datetime(2026, 11, 2, tzinfo=timezone.utc)
    assert harvest_token_from_metadata({"harvest_at": older.isoformat()}) == older
    assert harvest_token_from_metadata({"harvest_at": "2026-11-01T00:00:00"}) is None
    assert harvest_token_from_metadata({}) is None
    assert harvest_is_stale(older, newer) is True
    assert harvest_is_stale(newer, older) is False
    assert harvest_is_stale(newer, newer) is False
    assert harvest_is_stale(None, newer) is True
    assert harvest_is_stale(older, None) is False
    assert pre_clock_act(2, None) is True
    assert pre_clock_act(0, None) is False
    assert pre_clock_act(2, newer) is False
    assert snapshot_is_incomplete(1) is True
    assert snapshot_is_incomplete(0) is False
    assert act_inventory_is_complete(key_div_texts([SECTION_1, SECTION_2])) is True
    assert act_inventory_is_complete(key_div_texts([HEADING, SECTION_1])) is False
    assert act_inventory_is_complete(key_div_texts([SECTION_1, HEADING, SCHEDULE_ITEM])) is True
    assert act_keys_from_metadata(None) is None
    assert act_keys_from_metadata({"act_keys": []}) is None
    assert act_keys_from_metadata({"act_keys": ["1", ""]}) is None
    published = PublishedSection(key="1", text="t", kind="section", lookup_number="1", versions=["t"])
    assert lookup_real_section({"1": published}, " 1 ") is not None
    assert lookup_real_section({}, "1") is None
