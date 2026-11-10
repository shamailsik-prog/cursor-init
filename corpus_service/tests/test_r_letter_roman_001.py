"""R-LETTER-ROMAN-001: a single letter I, V, X or L is not a roman numeral by itself.

A lettered act keeps those letters as slugs. A roman act, proved by a
multi-character roman and no letter schedules, maps them to 1, 5, 10 and 50.
Mixed or missing evidence quarantines the heading. A stored schedule:l:* row
is never the First Schedule. Identical text under I and under 1 does not share
a ~n key.
"""

from __future__ import annotations

from scraper.parsers.pakistancode_keys import (
    act_inventory_is_complete,
    ambiguous_section_reason,
    apply_harvest,
    key_div_texts,
    normalise_div_text,
    schedule_key_identity,
    schedule_label,
    section_by_key,
)

BODY = "1. Short title of the body, which a lettered schedule must not become."
ITEM = "1. Stamp duty row long enough to be kept under this schedule heading."
SAME = "1. Identical item text that must not collapse I and 1 onto one ~n key."
OLD_L = "1. Letter L as stored, which must not receive the First Schedule text."
NEW_FIRST = "1. First schedule text after a later harvest that must not land on L."
OLD_I = "1. Roman I as stored under the letter key before this harvest."


def _letters(start, end):
    return [chr(code) for code in range(ord(start), ord(end) + 1)]


def _page(headings, item=ITEM):
    texts = [BODY]
    for heading in headings:
        texts.append(heading)
        texts.append(item)
    return key_div_texts(texts)


def test_lettered_a_to_d_plus_i_stays_a_letter_and_distinct_from_schedule_1():
    keyed = _page(["Schedule A", "Schedule B", "Schedule C", "Schedule D", "Schedule I", "Schedule 1"])
    assert keyed.schedule_label_mode == "letter"
    labels = [section.schedule_label for section in keyed.sections if section.kind == "schedule-heading"]
    assert labels == ["a", "b", "c", "d", "i", "1"]
    item_keys = [section.key for section in keyed.sections if section.kind == "schedule-item"]
    assert item_keys == [
        "schedule:a:1", "schedule:b:1", "schedule:c:1", "schedule:d:1", "schedule:i:1", "schedule:1:1",
    ]
    assert schedule_label("Schedule I") is None
    assert "1" not in labels[:5]


def test_lettered_a_to_l_keeps_l_as_a_slug():
    headings = [f"Schedule {letter}" for letter in _letters("A", "L")]
    keyed = _page(headings)
    assert keyed.schedule_label_mode == "letter"
    labels = [section.schedule_label for section in keyed.sections if section.kind == "schedule-heading"]
    assert labels[-1] == "l"
    assert "1" not in labels
    assert "50" not in labels
    assert [section.key for section in keyed.sections if section.kind == "schedule-item"][-1] == "schedule:l:1"


def test_lettered_a_to_x_keeps_v_and_x_as_slugs():
    headings = [f"Schedule {letter}" for letter in _letters("A", "X")]
    keyed = _page(headings)
    assert keyed.schedule_label_mode == "letter"
    labels = {
        section.schedule_label: section
        for section in keyed.sections
        if section.kind == "schedule-heading"
    }
    assert set(labels) >= {"a", "i", "l", "v", "x"}
    assert "5" not in labels and "10" not in labels and "1" not in labels
    items = [section.key for section in keyed.sections if section.kind == "schedule-item"]
    assert "schedule:v:1" in items and "schedule:x:1" in items
    assert "schedule:5:1" not in items and "schedule:10:1" not in items


def test_pure_roman_i_to_xii_maps_singles_only_because_ii_is_present():
    roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"]
    keyed = _page([f"SCHEDULE {token}" for token in roman])
    assert keyed.schedule_label_mode == "roman"
    labels = [section.schedule_label for section in keyed.sections if section.kind == "schedule-heading"]
    assert labels == [str(number) for number in range(1, 13)]
    items = [section.key for section in keyed.sections if section.kind == "schedule-item"]
    assert items == [f"schedule:{number}:1" for number in range(1, 13)]
    assert act_inventory_is_complete(keyed) is True
    nested = key_div_texts([ITEM, ITEM], ["I", "II"])
    assert [section.key for section in nested.sections] == ["schedule:1:1", "schedule:2:1"]


def test_mixed_letter_and_roman_is_refused():
    keyed = _page(["Schedule A", "Schedule I", "SCHEDULE II"])
    assert keyed.schedule_label_mode == "mixed"
    assert act_inventory_is_complete(keyed) is False
    schedules = [section for section in keyed.sections if section.kind != "section"]
    assert schedules
    assert {section.kind for section in schedules} == {"schedule-unresolved"}
    assert all(ambiguous_section_reason(section.kind) == "schedule_letter_roman_ambiguous" for section in schedules)
    assert all(not section.key.startswith("schedule:") for section in schedules)
    assert all(not section.key.startswith("schedule-heading:") for section in schedules)
    assert keyed.sections[0].kind == "section" and keyed.sections[0].key == "1"


def test_stored_schedule_l_does_not_attach_to_the_first_schedule():
    assert schedule_key_identity("schedule:l:1") == "schedule:l:1"
    assert schedule_key_identity("schedule:first:1") == "schedule:1:1"
    assert schedule_key_identity("schedule:l:1") != schedule_key_identity("schedule:first:1")
    assert schedule_key_identity("schedule:l:1", mode="roman") == "schedule:50:1"
    assert schedule_key_identity("schedule:i:1") == "schedule:i:1"
    assert schedule_key_identity("schedule:v:1") == "schedule:v:1"
    assert schedule_key_identity("schedule:x:1") == "schedule:x:1"
    from scraper.parsers.pakistancode_keys import PublishedSection

    def stored(key, text, kind, lookup=None):
        body = normalise_div_text(text)
        return PublishedSection(key=key, text=body, kind=kind, lookup_number=lookup, versions=[body])

    store = {
        "1": stored("1", BODY, "section", "1"),
        "schedule:first:1": stored("schedule:first:1", OLD_I, "schedule-item"),
        "schedule:l:1": stored("schedule:l:1", OLD_L, "schedule-item"),
    }
    keyed = key_div_texts([BODY, "Schedule 1", NEW_FIRST])
    apply_harvest(store, keyed.sections, label_mode=keyed.schedule_label_mode)
    assert store["schedule:first:1"].text == normalise_div_text(NEW_FIRST)
    assert store["schedule:l:1"].text == normalise_div_text(OLD_L)
    assert store["schedule:l:1"].versions == [normalise_div_text(OLD_L)]
    assert store["schedule:l:1"].retired is True
    assert section_by_key(store, "schedule:1:1") is store["schedule:first:1"]
    assert section_by_key(store, "schedule:l:1") is None
    assert section_by_key(store, "schedule:1:1", label_mode="roman") is not store["schedule:l:1"]


def test_identical_text_under_i_and_1_does_not_share_a_copy_suffix():
    keyed = key_div_texts([
        BODY, "Schedule A", SAME, "Schedule I", SAME, "Schedule 1", SAME,
    ])
    assert keyed.schedule_label_mode == "letter"
    items = [section for section in keyed.sections if section.kind == "schedule-item"]
    assert [section.key for section in items] == ["schedule:a:1", "schedule:i:1", "schedule:1:1"]
    assert len({section.key for section in items}) == 3
    assert all("~" not in section.key for section in items)
    assert len({section.text for section in items}) == 1
    alone = key_div_texts([BODY, "Schedule I", SAME, "Schedule 1", SAME])
    assert alone.schedule_label_mode == "insufficient"
    assert act_inventory_is_complete(alone) is False
    unresolved = [section for section in alone.sections if section.kind == "schedule-unresolved"]
    numbered = [section for section in alone.sections if section.kind == "schedule-item"]
    assert [section.key for section in unresolved] == [
        "unresolved-schedule-heading:i", "unresolved-schedule:i:1",
    ]
    assert [section.key for section in numbered] == ["schedule:1:1"]
    assert [section.key for section in alone.sections if section.kind == "schedule-heading"] == ["schedule-heading:1"]
    assert all("~" not in section.key for section in alone.sections)


def test_roman_proof_attaches_a_stored_i_and_does_not_attach_l_to_first():
    from scraper.parsers.pakistancode_keys import PublishedSection

    def stored(key, text, kind):
        body = normalise_div_text(text)
        return PublishedSection(key=key, text=body, kind=kind, lookup_number=None, versions=[body])

    keyed = key_div_texts([BODY, "SCHEDULE I", NEW_FIRST, "SCHEDULE II", ITEM])
    assert keyed.schedule_label_mode == "roman"
    store = {
        "1": stored("1", BODY, "section"),
        "schedule:i:1": stored("schedule:i:1", OLD_I, "schedule-item"),
    }
    apply_harvest(store, keyed.sections, label_mode="roman")
    assert "schedule:1:1" not in store
    assert store["schedule:i:1"].text == normalise_div_text(NEW_FIRST)
    assert store["schedule:i:1"].retired is False
    assert "schedule:2:1" in store
    no_proof = {
        "schedule:i:1": stored("schedule:i:1", OLD_I, "schedule-item"),
        "schedule:l:1": stored("schedule:l:1", OLD_L, "schedule-item"),
    }
    apply_harvest(no_proof, keyed.sections)
    assert no_proof["schedule:i:1"].text == normalise_div_text(OLD_I)
    assert no_proof["schedule:l:1"].text == normalise_div_text(OLD_L)
    assert no_proof["schedule:1:1"].text == normalise_div_text(NEW_FIRST)
