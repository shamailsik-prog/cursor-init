"""FA-F21-019: the paragraph splitter must not drop a second section that reuses a number.

Before the fix, ``_deduplicate_sections`` kept the first copy of a section number and
discarded the rest. These tests call ``split_into_sections`` on the plain text the
PakistanCode harvester feeds it. No database and no network.
"""

from __future__ import annotations

from scraper.parsers.pakistancode_keys import TEXT_CAP, content_token
from scraper.parsers.statute_parser import split_into_sections
from scraper.parsers.text_cleaner import clean_html

ALPHA = "1. Alpha paragraph is longer than twenty characters for the parser."
BETA = "1. Beta paragraph is also longer than twenty characters and a duplicate number."
SAME = "1. Same paragraph text is longer than twenty characters exactly."


def _split(paragraphs):
    html = "<html><h1>Fixture Act</h1>" + "".join(f"<p>{text}</p>" for text in paragraphs) + "</html>"
    return split_into_sections(clean_html(html), "Fixture Act")


def _key_for(text):
    return f"1-{content_token(text[:TEXT_CAP])}"


def test_repeated_paragraph_numbers_keep_both_texts_and_are_stable():
    """The second paragraph used to vanish. Both texts stay, and the keys follow the text."""
    forward = _split([ALPHA, BETA])
    backward = _split([BETA, ALPHA])
    assert len(forward) == 2 and len(backward) == 2
    forward_text = {section["section_text"] for section in forward}
    assert ALPHA in forward_text and BETA in forward_text
    assert {section["section_number"] for section in forward} == {_key_for(ALPHA), _key_for(BETA)}
    assert {section["section_number"] for section in backward} == {_key_for(ALPHA), _key_for(BETA)}
    assert [section["section_number"] for section in forward] == [_key_for(ALPHA), _key_for(BETA)]
    assert [section["section_number"] for section in backward] == [_key_for(BETA), _key_for(ALPHA)]
    assert all(section["section_number"] != "1" for section in forward)


def test_identical_repeated_paragraphs_are_both_kept():
    sections = _split([SAME, SAME])
    assert len(sections) == 2
    assert sections[0]["section_text"] == SAME and sections[1]["section_text"] == SAME
    assert sections[0]["section_number"] == _key_for(SAME)
    assert sections[1]["section_number"] == f"{_key_for(SAME)}~2"


def test_distinct_paragraph_numbers_stay_bare():
    second = "2. Beta paragraph is longer than twenty characters for the parser."
    sections = _split([ALPHA, second])
    assert [section["section_number"] for section in sections] == ["1", "2"]
    assert sections[0]["section_text"] == ALPHA and sections[1]["section_text"] == second
