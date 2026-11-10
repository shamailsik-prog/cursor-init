"""R-LABEL-001: one canonical schedule label, and old schedule:L:* rows stay one row.

Ordinal words, roman numerals, arabic numerals and the OCR class l/I/1 name the same
schedule. A named schedule does not. An ambiguous heading is not a heading. A later
harvest that spells the same schedule differently does not retire the stored row and
does not insert a second one. Lookup of either key finds that row.
"""

from __future__ import annotations

from scraper.parsers.pakistancode_keys import (
    KeyedDiv,
    PublishedSection,
    apply_harvest,
    key_div_texts,
    keys_to_retire,
    lookup_real_section,
    normalise_div_text,
    schedule_key_identity,
    schedule_label,
    section_by_key,
)

BODY = "1. Short title of the body, which a renamed schedule must not repeal."
ITEM = "1. Stamp duty row long enough to be kept under every spelling of this schedule."
ITEM_NAMED = "1. Named schedule item long enough to remain under schedule A."
ITEM_NUMBERED = "1. Numbered schedule item long enough to remain under schedule 1."
OLD_TEXT = "1. Stamp duty as first harvested under the word label of this schedule."
NEW_TEXT = "1. Stamp duty after the same schedule was re-read as a roman numeral."

# One equivalence class. Each string is the whole div.
FIRST_FORMS = (
    "THE FIRST SCHEDULE",
    "FIRST SCHEDULE",
    "Schedule 1",
    "Schedule No. 1",
    "SCHEDULE NO. 1",
    "Schedule No 1",
    "Schedule No.1",
    "1st SCHEDULE",
    "1ST Schedule",
)

SECOND_FORMS = (
    "THE SECOND SCHEDULE",
    "SCHEDULE II",
    "Schedule 2",
    "2ND SCHEDULE",
    "Schedule No. 2",
)

TWENTIETH_FORMS = (
    "THE TWENTIETH SCHEDULE",
    "SCHEDULE XX",
    "Schedule 20",
    "20th Schedule",
    "SCHEDULE NO. 20",
)

ELEVENTH_FORMS = (
    "THE ELEVENTH SCHEDULE",
    "SCHEDULE XI",
    "Schedule 11",
    "11th SCHEDULE",
)

TENTH_OCR_FORMS = (
    "Schedule 10",
    "Schedule l0",
    "Schedule 1O",
)


def _stored(key, text, kind, lookup=None):
    body = normalise_div_text(text)
    return PublishedSection(key=key, text=body, kind=kind, lookup_number=lookup, versions=[body])


def _item_key_for(heading):
    keyed = key_div_texts([BODY, heading, ITEM])
    items = [section for section in keyed.sections if section.kind == "schedule-item"]
    assert len(items) == 1, heading
    assert items[0].text == normalise_div_text(ITEM)
    return items[0].key


def test_ordinal_roman_arabic_and_ocr_share_one_canonical_label():
    """first, I, l, 1 and Schedule No. 1 are the same schedule. So are the other classes."""
    assert {schedule_label(text) for text in FIRST_FORMS} == {"1"}
    assert {schedule_label(text) for text in SECOND_FORMS} == {"2"}
    assert {schedule_label(text) for text in TWENTIETH_FORMS} == {"20"}
    assert {schedule_label(text) for text in ELEVENTH_FORMS} == {"11"}
    assert {schedule_label(text) for text in TENTH_OCR_FORMS} == {"10"}
    assert {_item_key_for(text) for text in FIRST_FORMS} == {"schedule:1:1"}
    assert schedule_label("THE FIFTH SCHEDULE") == "5"
    assert schedule_label("SCHEDULE V") is None
    assert schedule_label("SCHEDULE I") is None
    assert schedule_label("Schedule l") is None
    assert schedule_label("SCHEDULE IV") == schedule_label("4TH SCHEDULE") == "4"
    assert schedule_label("THE SCHEDULE") == schedule_label("SCHEDULE") == "schedule"
    assert schedule_label("SCHEDULE") != "1"


def test_ambiguous_heading_is_not_recognised_and_ocr_repair_stays_in_the_heading():
    """ll, a leading zero, and two different numbers are not repaired into a schedule.

    A sentence that merely contains the words is not a heading either.
    """
    for text in (
        "Schedule ll",
        "Schedule 0",
        "Schedule O1",
        "Schedule lO",
        "Schedule IO",
        "Schedule 01",
        "Schedule 01st",
        "THE FIRST SCHEDULE NO. 2",
    ):
        assert schedule_label(text) is None, text
    prose = "1. The note mentions Schedule l and Schedule 1 but this div is the body section."
    assert schedule_label(prose) is None
    keyed = key_div_texts([prose])
    assert keyed.sections[0].kind == "section"
    assert keyed.sections[0].key == "1"
    skipped = key_div_texts(["Schedule ll", "Schedule 0", BODY])
    assert skipped.skipped_short == 2
    assert [section.kind for section in skipped.sections] == ["section"]
    assert skipped.sections[0].key == "1"


def test_named_schedule_is_a_stable_slug_and_does_not_merge_with_a_numbered_one():
    assert schedule_label("Schedule A") == schedule_label("SCHEDULE A") == "a"
    assert schedule_label("Tariff Schedule") == schedule_label("THE TARIFF SCHEDULE") == "tariff"
    assert schedule_label("Schedule O") == "o"
    assert schedule_label("Schedule C") == "c"
    for label in ("a", "tariff", "o", "c"):
        assert label != "1"
        assert label != "10"
    keyed = key_div_texts([BODY, "Schedule A", ITEM_NAMED, "Schedule 1", ITEM_NUMBERED])
    keys = [section.key for section in keyed.sections]
    assert keys == [
        "1",
        "schedule-heading:a",
        "schedule:a:1",
        "schedule-heading:1",
        "schedule:1:1",
    ]
    assert len(keys) == len(set(keys))
    assert "conveyance" not in keyed.sections[0].text.lower()
    retired = keys_to_retire(["schedule:a:1", "schedule:1:1"], ["schedule:1:1"], "schedule:1:1")
    assert retired == ["schedule:a:1"]


def test_rename_across_harvests_keeps_one_row_and_does_not_retire_the_body():
    """A row stored as schedule:first:1 is the later schedule:1:1 harvest. No second row."""
    store = {
        "1": _stored("1", BODY, "section", "1"),
        "schedule-heading:first": _stored("schedule-heading:first", "THE FIRST SCHEDULE", "schedule-heading"),
        "schedule:first:1": _stored("schedule:first:1", OLD_TEXT, "schedule-item"),
    }
    keyed = key_div_texts([BODY, "Schedule 1", NEW_TEXT])
    assert [section.key for section in keyed.sections] == ["1", "schedule-heading:1", "schedule:1:1"]
    apply_harvest(store, keyed.sections)
    live = {key: row for key, row in store.items() if not row.retired}
    assert set(live) == {"1", "schedule-heading:first", "schedule:first:1"}
    assert live["1"].text == normalise_div_text(BODY)
    assert live["1"].kind == "section"
    item = live["schedule:first:1"]
    assert item.text == normalise_div_text(NEW_TEXT)
    assert item.versions == [normalise_div_text(OLD_TEXT), normalise_div_text(NEW_TEXT)]
    assert item.kind == "schedule-item"
    assert live["schedule-heading:first"].text == "Schedule 1"
    assert section_by_key(store, "schedule:1:1") is item
    assert section_by_key(store, "schedule:first:1") is item
    assert section_by_key(store, "schedule:i:1") is None
    assert section_by_key(store, "schedule:l:1") is None
    assert lookup_real_section(store, "1") is live["1"]
    assert lookup_real_section(store, "schedule:1:1") is None
    again = apply_harvest(store, keyed.sections)
    assert again.inserted == []
    assert again.retired == []
    assert [key for key, row in store.items() if not row.retired] == ["1", "schedule-heading:first", "schedule:first:1"]


def test_old_schedule_labels_are_not_retired_by_the_canonical_inventory():
    live = ["1", "schedule-heading:1", "schedule:1:1"]
    existing = [
        "1",
        "2",
        "schedule:first:1",
        "schedule:i:1",
        "schedule:l:1",
        "schedule-heading:first",
        "schedule:first:9",
        "schedule:first:1-deadbeef",
        "preamble-abcd1234",
    ]
    retired = keys_to_retire(existing, live, "1")
    assert "schedule:first:1" not in retired
    assert "schedule-heading:first" not in retired
    assert "1" not in retired
    assert "schedule:i:1" in retired
    assert "schedule:l:1" in retired
    assert retired == [
        "2", "preamble-abcd1234", "schedule:first:1-deadbeef", "schedule:first:9",
        "schedule:i:1", "schedule:l:1",
    ]
    covered = keys_to_retire(
        ["schedule:first:1-deadbeef~2"],
        ["schedule:1:1-deadbeef~2"],
        "schedule:1:1-deadbeef~2",
    )
    assert covered == []
    assert schedule_key_identity("schedule:first:1-deadbeef~2") == "schedule:1:1-deadbeef~2"
    assert schedule_key_identity("schedule:l:1") == "schedule:l:1"
    assert schedule_key_identity(schedule_key_identity("schedule:l:1")) == "schedule:l:1"
    assert schedule_key_identity("schedule:i:1") == "schedule:i:1"
    assert schedule_key_identity("schedule:l:1", mode="roman") == "schedule:50:1"
    assert schedule_key_identity("schedule:i:1", mode="roman") == "schedule:1:1"
    assert schedule_key_identity("schedule:a:1") == "schedule:a:1"
    assert schedule_key_identity("schedule-heading:tariff") == "schedule-heading:tariff"
    assert schedule_key_identity("1") == "1"
    schedule_only = keys_to_retire(
        ["1", "2", "schedule:first:1", "schedule:l:9"],
        ["schedule:1:1"],
        "schedule:1:1",
    )
    assert schedule_only == ["schedule:l:9"]


def test_two_alias_rows_are_not_merged_and_the_body_stays():
    """Fail closed: two stored spellings are not overwritten and not repealed."""
    store = {
        "1": _stored("1", BODY, "section", "1"),
        "schedule:first:1": _stored("schedule:first:1", OLD_TEXT, "schedule-item"),
        "schedule:1:1": _stored("schedule:1:1", NEW_TEXT, "schedule-item"),
    }
    incoming = KeyedDiv(
        key="schedule:1:1",
        text=normalise_div_text(ITEM),
        title="Fixture",
        kind="schedule-item",
        lookup_number=None,
        schedule_label="1",
    )
    apply_harvest(store, [incoming])
    assert store["schedule:first:1"].retired is False
    assert store["schedule:1:1"].retired is False
    assert store["schedule:first:1"].text == normalise_div_text(OLD_TEXT)
    assert store["schedule:1:1"].text == normalise_div_text(NEW_TEXT)
    assert store["1"].retired is False
    assert section_by_key(store, "schedule:1st:1") is None


def test_a_retired_alias_comes_back_on_the_same_row():
    """A repealed spelling is the same row. The next harvest does not insert another."""
    store = {
        "1": _stored("1", BODY, "section", "1"),
        "schedule:first:1": _stored("schedule:first:1", OLD_TEXT, "schedule-item"),
    }
    store["schedule:first:1"].retired = True
    keyed = key_div_texts([BODY, "Schedule 1", NEW_TEXT])
    apply_harvest(store, keyed.sections)
    assert "schedule:1:1" not in store
    row = store["schedule:first:1"]
    assert row.retired is False
    assert row.versions == [normalise_div_text(OLD_TEXT), normalise_div_text(NEW_TEXT)]
    assert row.text == normalise_div_text(NEW_TEXT)
    assert store["1"].retired is False
    assert store["1"].versions == [normalise_div_text(BODY)]


def test_container_label_uses_the_canonical_form():
    keyed = key_div_texts([ITEM], ["first"])
    assert keyed.sections[0].kind == "schedule-item"
    assert keyed.sections[0].key == "schedule:1:1"
    assert keyed.sections[0].schedule_label == "1"
    other = key_div_texts([ITEM_NAMED], ["A"])
    assert other.sections[0].key == "schedule:a:1"
    assert other.sections[0].schedule_label == "a"
