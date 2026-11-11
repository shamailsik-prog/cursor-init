"""R-LENGTH-RESID-001: a numbered omission or repeal placeholder is not live law.

The key and the raw text stay. ``2. Repeal.`` and a longer section that only
mentions repeal or omission stay live. Short ``by`` / ``of`` footnotes stay
noise. No database and no network.
"""

from __future__ import annotations

from scraper.parsers.pakistancode_keys import (
    act_inventory_is_complete,
    apply_harvest,
    content_token,
    fallback_act_keys,
    is_short_amendment_footnote,
    key_div_texts,
    lookup_real_section,
    omission_placeholder_status,
    section_by_key,
    short_div_disposition,
)
from scraper.parsers.statute_parser import split_into_sections

BODY = "1. Short title. This Act may be called the Placeholder Fixture Act, 2099, and it extends to Pakistan."
REPEAL = (
    "2. Repeal. The Earlier Fixture Act, 1908, is hereby repealed."
)
SAVINGS = (
    "8. Savings. Anything done under the repealed Act shall be deemed omitted "
    "from this Act only where a court so directs, and this section otherwise continues in force."
)
LONG_OMITTED = "6. Omitted by the Finance Act, 1990 (X of 1990), s. 3."
REP_BY = "5. [Rep. by Ord. X of 1980]"
DELETED = "9. [Deleted]"
DELETED_BY = "10. Deleted by Act V of 1976."


def test_detector_matches_the_placeholder_shapes_and_rejects_operative_text():
    assert omission_placeholder_status("3. [Omitted.]") == "omitted"
    assert omission_placeholder_status("3. [Omitted]") == "omitted"
    assert omission_placeholder_status("1. Omitted.") == "omitted"
    assert omission_placeholder_status("3. Omit.") == "omitted"
    assert omission_placeholder_status("3. (Omitted.)") == "omitted"
    assert omission_placeholder_status("3. 1[Omitted.]") == "omitted"
    assert omission_placeholder_status(LONG_OMITTED) == "omitted"
    assert omission_placeholder_status("6. Omitted by ...") == "omitted"
    assert omission_placeholder_status("4. * * *") == "omitted"
    assert omission_placeholder_status("4. ***") == "omitted"
    assert omission_placeholder_status("4. [* * *]") == "omitted"
    assert omission_placeholder_status("4. [***]") == "omitted"
    assert omission_placeholder_status("4. * * *.") == "omitted"
    assert omission_placeholder_status("4. * * * *") == "omitted"
    assert omission_placeholder_status("12-A. [Omitted.]") == "omitted"
    assert omission_placeholder_status(REP_BY) == "repealed"
    assert omission_placeholder_status("2. Rep.") == "repealed"
    assert omission_placeholder_status("7. [Repealed]") == "repealed"
    assert omission_placeholder_status("7. *[Repealed]") == "repealed"
    assert omission_placeholder_status("7. Rep. of the Act XX") == "repealed"
    assert omission_placeholder_status(DELETED) == "deleted"
    assert omission_placeholder_status(DELETED_BY) == "deleted"
    assert omission_placeholder_status("2. Repeal.") is None
    assert omission_placeholder_status(REPEAL) is None
    assert omission_placeholder_status(SAVINGS) is None
    assert omission_placeholder_status(BODY) is None
    assert omission_placeholder_status("[Omitted]") is None
    assert omission_placeholder_status("Rep.") is None
    assert omission_placeholder_status("4. **") is None
    assert omission_placeholder_status("7. Repeal of X.") is None
    assert omission_placeholder_status("6. Inserted.") is None
    assert omission_placeholder_status(
        "3. Omitted entries in the register are restored on application by the person affected "
        "and the registrar records the restoration in the same roll."
    ) is None


def test_numbered_placeholders_keep_their_keys_and_are_not_served_by_lookup():
    texts = [
        BODY,
        REPEAL,
        "3. [Omitted.]",
        "4. * * *",
        REP_BY,
        LONG_OMITTED,
        "7. [Repealed]",
        SAVINGS,
        DELETED,
        DELETED_BY,
    ]
    result = key_div_texts(texts)
    assert [section.key for section in result.sections] == [str(n) for n in range(1, 11)]
    assert [section.text for section in result.sections] == texts
    assert result.skipped_short == 0 and result.dropped_by_cap == 0
    assert act_inventory_is_complete(result) is True
    by_key = {section.key: section for section in result.sections}
    assert by_key["1"].provision_status is None
    assert by_key["2"].provision_status is None
    assert by_key["2"].text == REPEAL
    assert by_key["8"].provision_status is None
    assert by_key["3"].provision_status == "omitted"
    assert by_key["4"].provision_status == "omitted"
    assert by_key["5"].provision_status == "repealed"
    assert by_key["6"].provision_status == "omitted"
    assert by_key["7"].provision_status == "repealed"
    assert by_key["9"].provision_status == "deleted"
    assert by_key["10"].provision_status == "deleted"
    keys = fallback_act_keys(result, [(section.key, section.kind) for section in result.sections])
    assert keys == [str(n) for n in range(1, 11)]
    store: dict = {}
    delta = apply_harvest(store, result.sections)
    assert delta.inserted == [str(n) for n in range(1, 11)]
    assert delta.retired == []
    assert store["3"].text == "3. [Omitted.]" and store["3"].retired is False
    assert store["3"].provision_status == "omitted"
    assert lookup_real_section(store, "3") is None
    assert lookup_real_section(store, "4") is None
    assert lookup_real_section(store, "5") is None
    assert lookup_real_section(store, "7") is None
    assert lookup_real_section(store, "9") is None
    assert section_by_key(store, "3") is None
    assert lookup_real_section(store, "1") is store["1"]
    assert lookup_real_section(store, "2") is store["2"]
    assert lookup_real_section(store, "8") is store["8"]
    assert section_by_key(store, "2").text == REPEAL


def test_a_later_operative_text_becomes_live_and_a_placeholder_does_not_retire_neighbours():
    store: dict = {}
    apply_harvest(store, key_div_texts([BODY, "3. [Omitted.]"]).sections)
    assert lookup_real_section(store, "3") is None
    assert store["3"].retired is False
    revived = "3. Definitions. In this Act, words and expressions have the meanings given in this section."
    apply_harvest(store, key_div_texts([BODY, revived]).sections)
    assert store["3"].text == revived
    assert store["3"].provision_status is None
    assert store["3"].retired is False
    assert lookup_real_section(store, "3") is store["3"]
    apply_harvest(store, key_div_texts([BODY, "3. [Repealed]"]).sections)
    assert store["1"].retired is False and store["3"].retired is False
    assert store["3"].provision_status == "repealed"
    assert lookup_real_section(store, "1") is store["1"]
    assert lookup_real_section(store, "3") is None


def test_identity_rules_for_footnotes_markers_and_repeal_headings_are_unchanged():
    assert short_div_disposition("2. Repeal.") == "provision"
    assert omission_placeholder_status("2. Repeal.") is None
    assert short_div_disposition("1. Omitted.") == "provision"
    assert short_div_disposition("2. Rep.") == "provision"
    assert is_short_amendment_footnote("1. Omitted by X") is True
    assert is_short_amendment_footnote("1. Rep. by Act") is True
    assert is_short_amendment_footnote("6. Ins.") is True
    assert is_short_amendment_footnote("7. Rep. of X.") is True
    notes = key_div_texts([BODY, "1. Subs. by Act", "1. Rep. by Act", "1. Omitted by X"])
    assert [section.key for section in notes.sections] == ["1"]
    assert notes.sections[0].text == BODY
    assert notes.skipped_short == 3
    bare = key_div_texts([BODY, "[Omitted]", "Rep.", "[Repealed]"])
    assert bare.sections[1].kind == "short-ambiguous"
    assert bare.sections[1].key == f"ambiguous-{content_token('[Omitted]')}"
    assert bare.sections[1].provision_status is None
    assert act_inventory_is_complete(bare) is False
    headed = key_div_texts([BODY, "Schedule 1", "1.", "2. Rep."])
    assert headed.sections[3].key == "schedule:1:2"
    assert headed.sections[3].text == "2. Rep."
    assert headed.sections[3].provision_status == "repealed"
    same = "3. [Omitted.]"
    pair = key_div_texts([same, same])
    assert pair.sections[0].key == f"3-{content_token(same)}"
    assert pair.sections[1].key == f"3-{content_token(same)}~2"
    assert pair.sections[0].provision_status == pair.sections[1].provision_status == "omitted"


def test_splitter_marks_placeholders_and_keeps_operative_sections():
    text = "\n".join([
        BODY,
        REPEAL,
        "3. [Omitted.]",
        "4. * * *",
        REP_BY,
        LONG_OMITTED,
        "7. [Repealed]",
        SAVINGS,
        "1. Subs. by Act",
        "[Omitted]",
    ])
    sections = split_into_sections(text, "Fixture Act")
    by_number = {section["section_number"]: section for section in sections}
    assert by_number["1"]["section_text"] == BODY
    assert "provision_status" not in by_number["1"]
    assert by_number["2"]["section_text"] == REPEAL
    assert "provision_status" not in by_number["2"]
    assert by_number["3"]["provision_status"] == "omitted"
    assert by_number["3"]["section_text"] == "3. [Omitted.]"
    assert by_number["4"]["provision_status"] == "omitted"
    assert by_number["5"]["provision_status"] == "repealed"
    assert by_number["6"]["provision_status"] == "omitted"
    assert by_number["7"]["provision_status"] == "repealed"
    assert by_number["8"]["section_text"] == SAVINGS
    assert "provision_status" not in by_number["8"]
    assert "1. Subs. by Act" not in [section["section_text"] for section in sections]
    omitted = next(section for section in sections if section["section_text"] == "[Omitted]")
    assert omitted["section_kind"] == "short-ambiguous"
    assert omitted["section_number"].startswith("ambiguous-")
    assert "provision_status" not in omitted
