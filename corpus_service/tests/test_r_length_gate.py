"""R-LENGTH-GATE: a short genuine section is not dropped for its length.

The keyer used to skip every non-heading div of 20 characters or fewer, and the
paragraph splitter used to drop a unique section under 20 characters and a chunk
under 15. Noise still skips. A bare omission marker is quarantined, not numbered.
No database and no network.
"""

from __future__ import annotations

from scraper.parsers.pakistancode_keys import (
    SHORT_DIV_MAX_EXCLUSIVE,
    act_inventory_is_complete,
    ambiguous_section_reason,
    apply_harvest,
    content_token,
    fallback_act_keys,
    is_short_amendment_footnote,
    key_div_texts,
    short_div_disposition,
    suppresses_plain_text_fallback,
)
from scraper.parsers.statute_parser import split_into_sections

BODY = "1. Short title of the body section is long enough to stay a body key."
LONG_2 = "2. Beta text of the second body section that is longer than twenty characters."


def _provision(number: int, length: int) -> str:
    prefix = f"{number}. "
    assert length > len(prefix)
    text = prefix + ("B" * (length - len(prefix)))
    assert len(text) == length
    return text


def _by_text(result):
    return {section.text: section for section in result.sections}


# ---------------------------------------------------------------------------------------------
# keyer: length boundaries
# ---------------------------------------------------------------------------------------------
def test_short_numbered_provisions_are_kept_at_the_length_boundaries():
    """14, 15, 16, 19 and 20 were skipped. 21 was already content. All six stay."""
    assert SHORT_DIV_MAX_EXCLUSIVE == 20
    texts = [_provision(n, length) for n, length in enumerate((14, 15, 16, 19, 20, 21), start=1)]
    result = key_div_texts(texts)
    assert result.skipped_short == 0 and result.dropped_by_cap == 0
    assert [section.key for section in result.sections] == ["1", "2", "3", "4", "5", "6"]
    assert [len(section.text) for section in result.sections] == [14, 15, 16, 19, 20, 21]
    assert [section.kind for section in result.sections] == ["section"] * 6
    assert act_inventory_is_complete(result) is True


def test_noise_at_the_same_boundaries_is_still_skipped_and_does_not_use_the_cap():
    noise = ["x" * length for length in (14, 15, 16, 19, 20)]
    noise.extend(["", "   ", "----", "***", "Page 12", "- 4 -", "12", "•", "Schedule ll", "Schedule 0"])
    filler = "q" * 21
    result = key_div_texts(noise + [filler, _provision(1, 21)])
    assert result.skipped_short == len(noise)
    assert filler in _by_text(result) and _by_text(result)[filler].kind == "div"
    assert _by_text(result)[_provision(1, 21)].key == "1"
    assert all(section.text not in noise for section in result.sections)
    longs = [
        f"{n}. Body text of section {n} is longer than twenty characters so it is kept."
        for n in range(1, 51)
    ]
    capped = key_div_texts(["z" * 20] * 50 + longs)
    assert capped.skipped_short == 50 and capped.dropped_by_cap == 0
    assert [section.key for section in capped.sections] == [str(n) for n in range(1, 51)]


def test_examples_are_kept_keyed_and_not_merged():
    texts = [
        "1. Short title.",
        "2. Repeal.",
        "3.",
        "4. Title",
        "[Omitted]",
        "Rep.",
        "[Repealed]",
        LONG_2.replace("2.", "8.", 1),
    ]
    assert [len(texts[i]) for i in range(4)] == [15, 10, 2, 8]
    result = key_div_texts(texts)
    by_text = _by_text(result)
    assert by_text["1. Short title."].key == "1" and by_text["1. Short title."].kind == "section"
    assert by_text["2. Repeal."].key == "2"
    assert by_text["3."].key == "3" and by_text["3."].title is None
    assert by_text["4. Title"].key == "4"
    assert by_text[LONG_2.replace("2.", "8.", 1)].key == "8"
    for marker in ("[Omitted]", "Rep.", "[Repealed]"):
        item = by_text[marker]
        assert item.kind == "short-ambiguous"
        assert item.key == f"ambiguous-{content_token(marker)}"
        assert item.lookup_number is None
        assert ambiguous_section_reason(item.kind) == "ambiguous_section_identity"
        assert marker not in by_text["1. Short title."].text
        assert marker not in by_text["8. Beta text of the second body section that is longer than twenty characters."].text
    assert result.skipped_short == 0
    assert act_inventory_is_complete(result) is False
    assert suppresses_plain_text_fallback(result) is True


def test_repeated_short_sections_keep_distinct_keys():
    same = "2. Repeal."
    pair = key_div_texts([same, same])
    assert [section.text for section in pair.sections] == [same, same]
    assert pair.sections[0].key == f"2-{content_token(same)}"
    assert pair.sections[1].key == f"2-{content_token(same)}~2"
    alpha = "1. Alpha short."
    beta = "1. Beta shorter"
    different = key_div_texts([alpha, beta])
    assert different.sections[0].key == f"1-{content_token(alpha)}"
    assert different.sections[1].key == f"1-{content_token(beta)}"
    assert different.sections[0].key != different.sections[1].key
    omitted = key_div_texts(["[Omitted]", "[Omitted]"])
    assert omitted.sections[0].key == f"ambiguous-{content_token('[Omitted]')}"
    assert omitted.sections[1].key == f"ambiguous-{content_token('[Omitted]')}~2"


def test_short_schedule_item_and_heading_only_item_are_not_body_keys():
    headed = key_div_texts([BODY, "Schedule 1", "1.", "2. Rep."])
    assert [section.kind for section in headed.sections] == [
        "section", "schedule-heading", "schedule-item", "schedule-item",
    ]
    assert headed.sections[0].key == "1"
    assert headed.sections[2].key == "schedule:1:1" and headed.sections[2].text == "1."
    assert headed.sections[3].key == "schedule:1:2" and headed.sections[3].text == "2. Rep."
    assert headed.skipped_short == 0
    assert act_inventory_is_complete(headed) is True


def test_short_item_before_any_body_is_unscoped_not_dropped():
    result = key_div_texts(["Schedule 1", "1. Short title."])
    assert result.skipped_short == 0
    assert result.sections[1].kind == "unscoped"
    assert result.sections[1].key == f"unscoped:1-{content_token('1. Short title.')}"
    assert ambiguous_section_reason("unscoped") == "ambiguous_section_identity"
    assert act_inventory_is_complete(result) is False


def test_broken_omission_marker_is_quarantined_and_not_numbered():
    result = key_div_texts([BODY, "Rep. 2"])
    assert short_div_disposition("Rep. 2") == "ambiguous"
    assert result.sections[1].kind == "short-ambiguous"
    assert result.sections[1].key.startswith("ambiguous-")
    assert result.sections[1].key != "2"
    assert act_inventory_is_complete(result) is False
    assert fallback_act_keys(result, [(section.key, section.kind) for section in result.sections]) is None


def test_a_placeholder_blocks_retirement_and_does_not_publish_a_number():
    store: dict = {}
    first = apply_harvest(store, key_div_texts([BODY, LONG_2]).sections)
    assert first.inserted == ["1", "2"]
    delta = apply_harvest(store, key_div_texts([BODY, "[Omitted]"]).sections)
    assert delta.retired == []
    assert store["2"].retired is False and store["1"].retired is False
    assert all(not key.startswith("ambiguous-") for key in store)
    assert "ambiguous_section_identity" == ambiguous_section_reason("short-ambiguous")


# A footnote longer than 20 characters still parses as a provision. That collision
# existed before R-LENGTH-GATE, because the old gate kept every div of 21 characters
# or more. R-LENGTH-RESID-002 does not extend past 20.
_LONG_FOOTNOTE = "1. Substituted by Act"


def test_short_amendment_footnote_does_not_take_section_1():
    """``1. Subs. by Act`` is noise. The real section 1 keeps key ``1`` and its text."""
    notes = (
        "1. Subs. by Act",
        "1. Ins. by Act",
        "1. Added by Act",
        "1. Omitted by X",
        "1. Rep. by Act",
        "1. Am. by Act",
        "1. Substituted by X",
        "1. Inserted by Act",
        "1. Repealed by Act",
        "1. Amended by Act",
        "1. Subs. by Act 1908",
        "1.  SUBS.  BY  ACT",
    )
    assert all(len(note) <= 20 for note in notes)
    assert len("1. Subs. by Act 1908") == 20
    assert short_div_disposition("2. Repeal.") == "provision"
    assert short_div_disposition("1. Short title.") == "provision"
    assert short_div_disposition("1. [Omitted]") == "provision"
    assert short_div_disposition("1. Omitted.") == "provision"
    assert is_short_amendment_footnote("2. Repeal.") is False
    for note in notes:
        assert is_short_amendment_footnote(note) is True
        assert short_div_disposition(note) == "noise"
        result = key_div_texts([BODY, note])
        assert [section.key for section in result.sections] == ["1"]
        assert result.sections[0].text == BODY
        assert note not in result.sections[0].text
        assert result.skipped_short == 1 and result.dropped_by_cap == 0
        assert act_inventory_is_complete(result) is True
    alone = key_div_texts(["1. Subs. by Act", LONG_2])
    assert [section.key for section in alone.sections] == ["2"]
    assert alone.sections[0].text == LONG_2
    assert is_short_amendment_footnote(_LONG_FOOTNOTE) is False
    assert len(_LONG_FOOTNOTE) > 20
    assert short_div_disposition(_LONG_FOOTNOTE) == "provision"


def test_short_amendment_footnote_does_not_take_a_schedule_item_key():
    item = "1. Stamp on an instrument in this schedule is long enough to stay the item."
    note = "1. Subs. by Act"
    result = key_div_texts([LONG_2, "Schedule 1", note, item])
    by_kind = {section.kind: section for section in result.sections}
    assert [section.kind for section in result.sections] == [
        "section", "schedule-heading", "schedule-item",
    ]
    assert by_kind["section"].key == "2" and by_kind["section"].text == LONG_2
    assert by_kind["schedule-item"].key == "schedule:1:1"
    assert by_kind["schedule-item"].text == item
    assert note not in by_kind["schedule-item"].text
    assert result.skipped_short == 1
    assert act_inventory_is_complete(result) is True
    same_page = key_div_texts([BODY, note, "Schedule 1", item, "1. Ins. by Act"])
    assert same_page.sections[0].key == "1" and same_page.sections[0].text == BODY
    assert same_page.sections[2].key == "schedule:1:1" and same_page.sections[2].text == item
    assert same_page.skipped_short == 2
    assert all("Subs. by" not in section.text and "Ins. by" not in section.text for section in same_page.sections)


def test_noise_only_page_does_not_suppress_the_splitter():
    noise = key_div_texts(["x" * 14, "Page 3", "----"])
    assert noise.sections == () and noise.skipped_short == 3
    assert suppresses_plain_text_fallback(noise) is False


# ---------------------------------------------------------------------------------------------
# splitter: the same boundaries, and markers are not swallowed
# ---------------------------------------------------------------------------------------------
def test_splitter_keeps_short_sections_at_the_length_boundaries():
    chunks = [_provision(n, length) for n, length in enumerate((14, 15, 16, 19, 20, 21), start=1)]
    sections = split_into_sections("\n\n".join(chunks), "Fixture Act")
    assert [section["section_number"] for section in sections] == [str(n) for n in range(1, 7)]
    assert [len(section["section_text"]) for section in sections] == [14, 15, 16, 19, 20, 21]
    assert all(section.get("section_kind") != "short-ambiguous" for section in sections)


def test_splitter_keeps_examples_and_does_not_merge_a_marker_into_a_neighbour():
    text = "\n".join([
        "1. Short title.",
        "[Omitted]",
        "2. Repeal.",
        "Rep.",
        "3.",
    ])
    sections = split_into_sections(text, "Fixture Act")
    texts = [section["section_text"] for section in sections]
    assert "1. Short title." in texts and "2. Repeal." in texts and "3." in texts
    omitted = next(section for section in sections if section["section_text"] == "[Omitted]")
    repealed = next(section for section in sections if section["section_text"] == "Rep.")
    assert omitted["section_kind"] == "short-ambiguous"
    assert repealed["section_kind"] == "short-ambiguous"
    assert omitted["section_number"] == f"ambiguous-{content_token('[Omitted]')}"
    assert repealed["section_number"] == f"ambiguous-{content_token('Rep.')}"
    numbered = [section for section in sections if section.get("section_kind") != "short-ambiguous"]
    assert [section["section_number"] for section in numbered] == ["1", "2", "3"]
    assert all("[Omitted]" not in section["section_text"] for section in numbered)
    assert all(section["section_text"] != "Rep." for section in numbered)


def test_splitter_html_strategy_keeps_short_paragraphs_and_rejects_chrome():
    html = """
    <html><body>
    <p class="section">----</p>
    <p class="section">Page 12</p>
    <p class="section">1. Short title.</p>
    <p class="section">[Omitted]</p>
    <p class="section">2. Repeal.</p>
    <p class="section">Rep.</p>
    </body></html>
    """
    sections = split_into_sections(html, "Fixture Act")
    assert [section["section_text"] for section in sections] == [
        "1. Short title.", "[Omitted]", "2. Repeal.", "Rep.",
    ]
    assert sections[1]["section_kind"] == "short-ambiguous"
    assert sections[3]["section_kind"] == "short-ambiguous"
    assert "----" not in [section["section_text"] for section in sections]
    assert "Page 12" not in [section["section_text"] for section in sections]


def test_a_single_short_section_and_a_single_marker_are_not_replaced():
    one = split_into_sections("1. Short title.", "Fixture Act")
    assert len(one) == 1 and one[0]["section_number"] == "1" and one[0]["section_text"] == "1. Short title."
    marker = split_into_sections("[Omitted]", "Fixture Act")
    assert len(marker) == 1
    assert marker[0]["section_kind"] == "short-ambiguous"
    assert marker[0]["section_number"] == f"ambiguous-{content_token('[Omitted]')}"
    assert split_into_sections("----", "Fixture Act") == []
    assert split_into_sections("Page 12", "Fixture Act") == []


def test_splitter_drops_a_short_amendment_footnote_beside_the_real_section():
    text = "\n".join([
        "1. Short title.",
        "1. Subs. by Act",
        "2. Repeal.",
        "1. Ins. by Act",
        "1. Added by Act",
        "1. Omitted by X",
        "1. Rep. by Act",
    ])
    sections = split_into_sections(text, "Fixture Act")
    assert [section["section_number"] for section in sections] == ["1", "2"]
    assert sections[0]["section_text"] == "1. Short title."
    assert sections[1]["section_text"] == "2. Repeal."
    assert all(" by " not in section["section_text"] for section in sections)
    html = """
    <html><body>
    <p class="section">1. Short title.</p>
    <p class="section">1. Subs. by Act</p>
    </body></html>
    """
    html_sections = split_into_sections(html, "Fixture Act")
    assert len(html_sections) == 1
    assert html_sections[0]["section_number"] == "1"
    assert html_sections[0]["section_text"] == "1. Short title."
    assert split_into_sections("1. Subs. by Act", "Fixture Act") == []
    assert split_into_sections("<p class=\"section\">1. Subs. by Act 1908</p>", "Fixture Act") == []


def test_bare_abbreviation_footnotes_do_not_take_a_section_or_schedule_key():
    """``6. Ins.`` and ``7. Rep. of X.`` are notes. Full words and bare ``Rep.`` are not."""
    notes = (
        "6. Ins.",
        "6. Subs.",
        "6. Am.",
        "6. Amd.",
        "6. Amdt.",
        "6. [Ins.]",
        "6. INS.",
        "7. Rep. of X.",
        "1. Ins. of s. 2",
        "1. Subs. of s. 4",
        "1. Ins. of section 2",
    )
    assert all(len(note) <= 20 for note in notes)
    assert len("1. Ins. of section 2") == 20
    for note in notes:
        assert is_short_amendment_footnote(note) is True
        assert short_div_disposition(note) == "noise"
        result = key_div_texts([BODY, note])
        assert [section.key for section in result.sections] == ["1"]
        assert result.sections[0].text == BODY
        assert result.skipped_short == 1
        assert act_inventory_is_complete(result) is True
    near = (
        "2. Repeal.",
        "1. Omitted.",
        "2. Rep.",
        "1. [Omitted]",
        "1. Short title.",
        "6. Inserted.",
        "6. Substituted.",
        "6. Added.",
        "6. Amended.",
        "6. Inspection.",
        "6. Report.",
        "7. Repeal of X.",
        "7. Rep.of X.",
    )
    for note in near:
        assert len(note) <= 20
        assert is_short_amendment_footnote(note) is False
        assert short_div_disposition(note) == "provision"
    long_of = "7. Rep. of the Act XX"
    assert len(long_of) > 20
    assert is_short_amendment_footnote(long_of) is False
    assert short_div_disposition(long_of) == "provision"
    item = "1. Stamp on an instrument in this schedule is long enough to stay the item."
    scheduled = key_div_texts([LONG_2, "Schedule 1", "1. Ins.", item])
    assert [section.kind for section in scheduled.sections] == [
        "section", "schedule-heading", "schedule-item",
    ]
    assert scheduled.sections[2].key == "schedule:1:1"
    assert scheduled.sections[2].text == item
    assert scheduled.skipped_short == 1
    page = "\n".join(["1. Short title.", "6. Ins.", "7. Rep. of X.", "2. Repeal."])
    sections = split_into_sections(page, "Fixture Act")
    assert [section["section_number"] for section in sections] == ["1", "2"]
    assert sections[0]["section_text"] == "1. Short title."
    assert sections[1]["section_text"] == "2. Repeal."
    assert split_into_sections("6. Ins.", "Fixture Act") == []
    assert split_into_sections("7. Rep. of X.", "Fixture Act") == []


def test_footnote_only_page_stages_nothing_and_is_not_quarantined():
    """RESID-005-POLICY: notes are noise. The page has no rows and no quarantine."""
    page = key_div_texts(["6. Ins.", "7. Rep. of X.", "1. Subs. by Act"])
    assert page.sections == ()
    assert page.skipped_short == 3
    assert act_inventory_is_complete(page) is False
    assert suppresses_plain_text_fallback(page) is False
    assert fallback_act_keys(page, []) is None
    assert split_into_sections("6. Ins.\n7. Rep. of X.", "Fixture Act") == []
