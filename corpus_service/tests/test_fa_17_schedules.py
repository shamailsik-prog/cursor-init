"""FA-17: schedule items are published under a parent-scoped key.

The key shape matches FA-F21-017 / FA-F21-019: ``schedule:L:N`` when the item
number is unique inside that schedule, ``schedule:L:N-<sha8>`` when it is not,
and ``~n`` for an identical copy. A body section key is never that key.
``unscoped`` still has no proven parent and stays out of the inventory.
"""

from __future__ import annotations

import asyncio
import uuid

from scraper.parsers.pakistancode_keys import (
    MAX_STAGED_DIVS,
    PUBLISHABLE_SECTION_KINDS,
    PublishedSection,
    act_inventory_is_complete,
    apply_harvest,
    content_token,
    fallback_act_keys,
    key_div_texts,
    keys_to_retire,
    lookup_real_section,
    normalise_div_text,
    schedule_container_label,
    section_kind_is_ambiguous,
)

BODY = "1. Short title of the body, which a schedule item numbered 1 must not replace."
FIRST = "THE FIRST SCHEDULE"
SECOND = "THE SECOND SCHEDULE"
ALPHA = "1. Alpha conveyance duty in the first schedule stays its own row."
BETA = "1. Beta conveyance duty in the first schedule is not merged into alpha."
SAME = "3. Same form text in the first schedule is kept twice here."
MORTGAGE = "1. Mortgage duty in the second schedule repeats item 1 under another parent."
FORM = "4. A form printed once in each schedule must not collapse into one row."
LATER_BODY = "2. Extent of the body, absent from a later mixed harvest, may be retired."


def _item_key(label, number, text, repeated, copy=1):
    stored = normalise_div_text(text)
    base = f"schedule:{label}:{number}"
    if repeated:
        base = f"{base}-{content_token(stored)}"
    if copy > 1:
        base = f"{base}~{copy}"
    return base


def _page():
    return [BODY, FIRST, ALPHA, BETA, SAME, SAME, FORM, SECOND, MORTGAGE, FORM]


def _expected_keys():
    return [
        "1",
        "schedule-heading:1",
        _item_key("1", "1", ALPHA, True),
        _item_key("1", "1", BETA, True),
        _item_key("1", "3", SAME, True, 1),
        _item_key("1", "3", SAME, True, 2),
        _item_key("1", "4", FORM, False),
        "schedule-heading:2",
        _item_key("2", "1", MORTGAGE, False),
        _item_key("2", "4", FORM, False),
    ]


def test_schedule_identity_scopes_repeats_and_does_not_collide_with_body_keys():
    """Two schedules, a repeated item number, an identical copy, and a shared form."""
    keyed = key_div_texts(_page())
    keys = [item.key for item in keyed.sections]
    assert keys == _expected_keys()
    assert len(keys) == len(set(keys)) == len(_page())
    assert [item.text for item in keyed.sections] == [normalise_div_text(text) for text in _page()]
    body_keys = {item.key for item in keyed.sections if item.kind == "section"}
    schedule_keys = {item.key for item in keyed.sections if item.kind == "schedule-item"}
    assert body_keys == {"1"}
    assert body_keys.isdisjoint(schedule_keys)
    assert all(key.startswith("schedule:") for key in schedule_keys)
    assert _item_key("1", "4", FORM, False) != _item_key("2", "4", FORM, False)
    assert not _item_key("2", "4", FORM, False).endswith("~2")
    store = {}
    apply_harvest(store, keyed.sections)
    found = lookup_real_section(store, "1")
    assert found is not None and found.kind == "section" and found.text == normalise_div_text(BODY)
    assert "conveyance" not in found.text.lower()
    assert lookup_real_section(store, "schedule:second:1") is None


def test_schedule_item_is_publishable_and_the_page_is_a_complete_inventory():
    keyed = key_div_texts(_page())
    assert section_kind_is_ambiguous("schedule-item") is False
    assert "schedule-item" in PUBLISHABLE_SECTION_KINDS
    assert act_inventory_is_complete(keyed) is True
    assert [item.key for item in keyed.sections] == _expected_keys()

    from bs4 import BeautifulSoup

    html = (
        "<div class='schedule'><h2>THE FIRST SCHEDULE</h2>"
        "<div class='section'>1. Nested conveyance duty is under the heading itself.</div>"
        "</div>"
    )
    node = BeautifulSoup(html, "html.parser").find("div", class_="section")
    assert schedule_container_label(node) == "1"
    contained = key_div_texts([node.get_text(" ", strip=True)], [schedule_container_label(node)])
    assert contained.sections[0].kind == "schedule-item"
    assert contained.sections[0].key == "schedule:1:1"
    assert contained.sections[0].lookup_number is None
    assert act_inventory_is_complete(contained) is True


def test_schedule_only_harvest_does_not_retire_body_keys():
    """Schedule keys may appear without repealing the body of the act."""
    containers = ["first", "first", "first", "first", "second"]
    texts = [ALPHA, BETA, SAME, SAME, MORTGAGE]
    keyed = key_div_texts(texts, containers)
    live = [item.key for item in keyed.sections]
    assert all(item.kind == "schedule-item" for item in keyed.sections)
    assert keys_to_retire(["1", "2", "schedule:second:9"], live, live[0]) == ["schedule:second:9"]
    assert keys_to_retire(["1", "2"], live, "2") == []
    assert keys_to_retire(["1", "2", "preamble-abcd1234"], ["schedule-heading:1"], "schedule-heading:1") == []

    store = {
        "1": PublishedSection("1", BODY, "section", "1", [BODY]),
        "2": PublishedSection("2", LATER_BODY, "section", "2", [LATER_BODY]),
        "schedule:second:9": PublishedSection("schedule:second:9", "old", "schedule-item", None, ["old"]),
    }
    delta = apply_harvest(store, keyed.sections)
    assert store["1"].retired is False and store["2"].retired is False
    assert "1" not in delta.retired and "2" not in delta.retired
    assert store["schedule:second:9"].retired is True
    assert len([row for row in store.values() if row.kind == "schedule-item" and not row.retired]) == len(texts)


def test_mixed_page_still_retires_an_absent_body_key():
    """A complete page that no longer contains a body section still retires that section."""
    keyed = key_div_texts([BODY, FIRST, ALPHA])
    live = [item.key for item in keyed.sections]
    assert "1" in live and "2" not in live
    assert keys_to_retire(["1", "2", "schedule:first:9"], live, "1") == ["2", "schedule:first:9"]


def test_unscoped_div_without_a_proven_parent_stays_withheld():
    item = "1. Flat item after a heading that precedes every body section."
    keyed = key_div_texts([FIRST, item])
    assert [section.kind for section in keyed.sections] == ["schedule-heading", "unscoped"]
    assert keyed.sections[1].key.startswith("unscoped:1-")
    assert not keyed.sections[1].key.startswith("schedule:")
    assert act_inventory_is_complete(keyed) is False
    assert section_kind_is_ambiguous("unscoped") is True
    assert section_kind_is_ambiguous("schedule-item") is False
    assert fallback_act_keys(keyed, [(section.key, section.kind) for section in keyed.sections]) is None


def test_heading_only_schedule_is_not_an_act_inventory():
    keyed = key_div_texts([FIRST])
    assert keyed.sections[0].key == "schedule-heading:1"
    assert keyed.sections[0].kind == "schedule-heading"
    assert fallback_act_keys(keyed, [(keyed.sections[0].key, "schedule-heading")]) is None
    assert keys_to_retire(["1", "2"], None, "schedule-heading:1") == []


def test_capped_schedule_page_is_not_an_inventory_and_an_uncapped_one_is():
    body = "{n}. Body text of section {n} is longer than twenty characters so it is kept."
    item = "1. Schedule duty row inside the cap is longer than twenty characters."
    within = [body.format(n=n) for n in range(1, MAX_STAGED_DIVS - 1)] + [FIRST, item]
    assert len(within) == MAX_STAGED_DIVS
    keyed = key_div_texts(within)
    assert keyed.dropped_by_cap == 0
    assert any(section.kind == "schedule-item" for section in keyed.sections)
    assert act_inventory_is_complete(keyed) is True
    capped = key_div_texts(within + [body.format(n=MAX_STAGED_DIVS)])
    assert capped.dropped_by_cap == 1
    assert any(section.kind == "schedule-item" for section in capped.sections)
    assert act_inventory_is_complete(capped) is False
    body_only = key_div_texts([body.format(n=n) for n in range(1, MAX_STAGED_DIVS + 2)])
    assert body_only.dropped_by_cap == 1
    assert act_inventory_is_complete(body_only) is True


def test_harvester_stamps_schedule_items_into_act_keys_in_document_order(monkeypatch):
    from scraper.net import fetch_policy
    from scraper.tasks import pakistancode

    texts = _page()
    page = "<html><h1>Schedule Fixture Act</h1>" + "".join(
        f"<div class='section'>{text}</div>" for text in texts
    ) + "</html>"

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
            if url.endswith("/schedact01"):
                return _Resp(page)
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

    calls = {"n": 0}
    real = pakistancode.split_into_sections

    def _wrapped(text, name=None):
        calls["n"] += 1
        return real(text, name)

    async def _asleep():
        return None

    monkeypatch.setattr(pakistancode, "split_into_sections", _wrapped)
    monkeypatch.setattr(fetch_policy, "fetcher_for", lambda *args, **kwargs: _Client())
    monkeypatch.setattr(pakistancode, "TARGET_SLUGS", ["schedact01"])
    monkeypatch.setattr(pakistancode.asyncio, "sleep", lambda *args, **kwargs: _asleep())
    db = _DB()
    asyncio.run(pakistancode.scrape_pakistancode(_Source(), db))
    assert calls["n"] == 0
    keys = [row.extracted_section_number for row in db.rows]
    assert keys == _expected_keys()
    assert [row.extracted_section_text for row in db.rows] == [normalise_div_text(text) for text in texts]
    assert all(row.parsing_metadata["act_keys"] == keys for row in db.rows)
    assert all(row.parsing_metadata["section_kind"] != "unscoped" for row in db.rows)
    schedule_rows = [row for row in db.rows if row.parsing_metadata["section_kind"] == "schedule-item"]
    assert len(schedule_rows) == 7
    assert all(row.parsing_metadata["lookup_number"] is None for row in schedule_rows)
