"""R-LENGTH-RESID-003: a hyphenated letter suffix is its own section number.

``12A.`` is already keyed ``12A``. ``12-A.``, ``12–A.`` and a bare ``12-A`` use
that same key. ``10-B`` is ``10B``. ``12-AA`` and ``12AA`` are ``12AA``. A real
section 12 beside a real section 12-A keeps both keys, in either order, and
both are retrievable. A hyphen before a digit stays the delimiter it was
(``12-15``, ``1-7-2001``). A hyphen before a heading word does too
(``12-Fees``, ``12-Tax``), and ``12-Ins. by Act ...`` stays the footnote it
was for section 12. ``Act No. XII-A`` is not a section. A citation footnote
for 12-A beside the real 12-A drops; the real section keeps bare ``12A``.
The same footnote does not take section 12. ``Section 12AA`` is ``12AA``,
including when no stop follows the suffix.

The omitted-note collision is mutation-sensitive: forcing the hyphen to be a
delimiter again keys the note as ``12``, and the note beside a real section 12
disappears. No database and no network.
"""

from __future__ import annotations

import time

from scraper.parsers.pakistancode_keys import (
    apply_harvest,
    canonical_section_number,
    is_amendment_footnote,
    is_long_amendment_footnote,
    is_unstaged_amendment_footnote,
    key_div_texts,
    lookup_real_section,
    omission_placeholder_status,
    parse_section_number,
    section_by_key,
)
from scraper.parsers.statute_parser import (
    _strategy_3_p_filtered_digit_start,
    split_into_sections,
)

REAL_12 = (
    "12. Rates. The rates in this section apply to every instrument "
    "presented for registration under this Act."
)
REAL_12A = (
    "12-A. Inserted rates. The inserted rates in this section apply to "
    "instruments presented after the amendment."
)
REAL_12A_GLUED = (
    "12A. Inserted rates. The inserted rates in this section apply to "
    "instruments presented after the amendment."
)
REAL_12A_EN = (
    "12\u2013A. Inserted rates. The inserted rates in this section apply to "
    "instruments presented after the amendment."
)
REAL_10 = (
    "10. Other. This other section applies to every instrument presented "
    "for registration under this Act."
)
REAL_10B = (
    "10-B. Beta rates. The beta rates in this section apply to instruments "
    "presented after the amendment."
)
NOTE_12A = "12-A. Ins. by Act II of 2001, s. 3."
OMIT_12A = "12-A. Omitted by the Finance Act, 1990 (X of 1990), s. 3."
REAL_12AA = (
    "12-AA. Double insertion. This section applies to every instrument "
    "presented for registration under this Act."
)
REAL_12AA_GLUED = (
    "12AA. Double insertion. This section applies to every instrument "
    "presented for registration under this Act."
)
REAL_12A_SPACE = (
    "12-A Inserted rates. The inserted rates in this section apply to "
    "instruments presented after the amendment."
)
FEES_12 = (
    "12-Fees. The fees specified in this section shall be paid on every "
    "instrument submitted for registration."
)
TAX_12 = (
    "12-Tax on property. The tax in this section applies to every instrument "
    "presented for registration under this Act."
)
NOTE_12_INS = "12-Ins. by Act II of 2001, s. 3."


def _keys(texts):
    result = key_div_texts(texts)
    return [(section.key, section.text, section.provision_status) for section in result.sections]


def test_hyphen_suffix_uses_the_glued_key_already_used_for_12A():
    assert parse_section_number("12A. Title") == "12A"
    assert parse_section_number("12a. Title") == "12a"
    assert parse_section_number("12-A. Title") == "12A"
    assert parse_section_number("12-A") == "12A"
    assert parse_section_number("Section 12-A. Title") == "12A"
    assert parse_section_number("s. 10-B. Title") == "10B"
    assert parse_section_number("12AA. Title") == "12AA"
    assert parse_section_number("12-AA. Title") == "12AA"
    assert parse_section_number("12\u2013A. Title") == "12A"
    assert parse_section_number("12\u2014AA. Title") == "12AA"
    assert canonical_section_number("12-A") == "12A"
    assert canonical_section_number("12\u2013AA") == "12AA"
    assert canonical_section_number("12A") == "12A"
    assert canonical_section_number("12-15") == "12-15"
    assert parse_section_number("2nd. Title") is None
    assert parse_section_number("1ST. Title") is None
    assert parse_section_number("Section 12AA. Rates.") == "12AA"
    assert parse_section_number("12-Fees. The fees.") == "12"
    assert parse_section_number("12-Tax on property.") == "12"
    assert parse_section_number(NOTE_12_INS) == "12"
    assert canonical_section_number("12-Fees") == "12-Fees"
    assert canonical_section_number("12-AA") == "12AA"
    alone = key_div_texts([REAL_12A])
    assert alone.sections[0].key == "12A"
    assert alone.sections[0].title == "Inserted rates."
    assert alone.sections[0].provision_status is None
    assert key_div_texts([REAL_12A_GLUED]).sections[0].key == "12A"
    assert key_div_texts([REAL_12A_EN]).sections[0].key == "12A"
    assert key_div_texts([REAL_12AA]).sections[0].key == "12AA"
    assert key_div_texts([REAL_12AA_GLUED]).sections[0].key == "12AA"
    pair_keys = [key for key, _text, _status in _keys([REAL_12AA, REAL_12AA_GLUED])]
    assert len(pair_keys) == 2 and pair_keys[0] != pair_keys[1]
    assert all(len(key) == len("12AA-") + 8 and key.startswith("12AA-") for key in pair_keys)


def test_real_12_and_12A_stay_separate_in_both_orders_and_are_retrievable():
    forward = _keys([REAL_12, REAL_12A])
    backward = _keys([REAL_12A, REAL_12])
    assert [item[0] for item in forward] == ["12", "12A"]
    assert [item[0] for item in backward] == ["12A", "12"]
    assert [item[1] for item in forward] == [REAL_12, REAL_12A]
    assert [item[1] for item in backward] == [REAL_12A, REAL_12]
    ten = _keys([REAL_10, REAL_10B])
    ten_back = _keys([REAL_10B, REAL_10])
    assert [item[0] for item in ten] == ["10", "10B"]
    assert [item[0] for item in ten_back] == ["10B", "10"]
    store: dict = {}
    staged = key_div_texts([REAL_12, REAL_12A, REAL_10, REAL_10B]).sections
    apply_harvest(store, staged)
    assert lookup_real_section(store, "12") is store["12"]
    assert lookup_real_section(store, "12A") is store["12A"]
    assert lookup_real_section(store, "12-A") is store["12A"]
    assert lookup_real_section(store, "12\u2013A") is store["12A"]
    assert section_by_key(store, "12-A") is store["12A"]
    assert lookup_real_section(store, "10") is store["10"]
    assert lookup_real_section(store, "10-B") is store["10B"]
    assert lookup_real_section(store, "12").text == REAL_12
    assert lookup_real_section(store, "12A").text == REAL_12A
    assert lookup_real_section(store, "12") is not lookup_real_section(store, "12A")


def test_insertion_footnote_drops_beside_real_12A_and_does_not_hide_section_12():
    """``Ins. by Act ..., s. 3`` for 12-A. The predicate is asserted on the note alone.

    A mutation that stops recognising the note stages it. A mutation that
    drops the hyphen keys the real section as ``12``.
    """
    assert is_long_amendment_footnote(NOTE_12A) is True
    assert is_unstaged_amendment_footnote(NOTE_12A) is True
    assert is_amendment_footnote(NOTE_12A) is True
    assert omission_placeholder_status(NOTE_12A) is None
    assert key_div_texts([NOTE_12A]).sections == ()
    assert _keys([NOTE_12A, REAL_12A]) == [("12A", REAL_12A, None)]
    assert _keys([REAL_12A, NOTE_12A]) == [("12A", REAL_12A, None)]
    assert _keys([NOTE_12A, REAL_12]) == [("12", REAL_12, None)]
    assert _keys([REAL_12, NOTE_12A]) == [("12", REAL_12, None)]
    both = _keys([REAL_12, NOTE_12A, REAL_12A])
    assert [item[0] for item in both] == ["12", "12A"]
    assert [item[1] for item in both] == [REAL_12, REAL_12A]


def test_omitted_12A_collides_only_with_12A_not_with_section_12():
    """The note is staged alone. Beside real 12-A it drops. Beside real 12 it stays.

    Keying ``12-A`` as ``12`` drops this note in the last two assertions.
    """
    assert is_amendment_footnote(OMIT_12A) is True
    assert is_unstaged_amendment_footnote(OMIT_12A) is False
    assert omission_placeholder_status(OMIT_12A) == "omitted"
    alone = key_div_texts([OMIT_12A])
    assert alone.sections[0].key == "12A"
    assert alone.sections[0].provision_status == "omitted"
    assert alone.sections[0].text == OMIT_12A
    assert _keys([OMIT_12A, REAL_12A]) == [("12A", REAL_12A, None)]
    assert _keys([REAL_12A, OMIT_12A]) == [("12A", REAL_12A, None)]
    assert _keys([OMIT_12A, REAL_12]) == [
        ("12A", OMIT_12A, "omitted"),
        ("12", REAL_12, None),
    ]
    assert _keys([REAL_12, OMIT_12A]) == [
        ("12", REAL_12, None),
        ("12A", OMIT_12A, "omitted"),
    ]
    period_letter = key_div_texts(["12. A. [Omitted.]"])
    assert period_letter.sections[0].key == "12"
    assert period_letter.sections[0].provision_status == "omitted"


def test_heading_words_and_hyphenated_amendment_notes_stay_section_12():
    """``12-Fees`` and ``12-Ins.`` are not suffixes. Widening the suffix eats them.

    ``12-Fees`` would be keyed ``12Fees`` and the title word would disappear.
    ``12-Ins. by Act ...`` would be published as live section ``12Ins``.
    """
    fees = key_div_texts([FEES_12])
    assert fees.sections[0].key == "12"
    assert fees.sections[0].title == "Fees."
    assert fees.sections[0].text == FEES_12
    tax = key_div_texts([TAX_12])
    assert tax.sections[0].key == "12"
    assert tax.sections[0].title == "Tax on property."
    assert is_unstaged_amendment_footnote(NOTE_12_INS) is True
    assert is_amendment_footnote(NOTE_12_INS) is True
    assert is_long_amendment_footnote(NOTE_12_INS) is True
    assert key_div_texts([NOTE_12_INS]).sections == ()
    assert _keys([NOTE_12_INS, REAL_12]) == [("12", REAL_12, None)]
    assert _keys([REAL_12, NOTE_12_INS]) == [("12", REAL_12, None)]
    assert _keys([FEES_12, REAL_12A]) == [
        ("12", FEES_12, None),
        ("12A", REAL_12A, None),
    ]


def test_ranges_dates_roman_act_numbers_and_mid_body_refs_are_not_letter_suffixes():
    assert parse_section_number("12-15") == "12"
    assert parse_section_number("12-15. The years twelve to fifteen are a range.") == "12"
    assert parse_section_number("1-7-2001") == "1"
    assert parse_section_number("w.e.f. 1-7-2001") is None
    assert parse_section_number("Act No. XII-A.") is None
    assert parse_section_number("Act No. XII-A of 2001") is None
    ranged = (
        "12-15. The years twelve to fifteen are a range and not a letter "
        "suffix in this heading of the Act."
    )
    assert key_div_texts([ranged]).sections[0].key == "12"
    dated = (
        "1-7-2001 is the commencement date written as a figure, and this "
        "line is long enough to be its own div."
    )
    assert parse_section_number(dated) == "1"
    assert key_div_texts([dated]).sections[0].key == "1"
    body = (
        "4. Commencement. This Act comes into force w.e.f. 1-7-2001 and "
        "the years 12-15 are a range stated in this section, which also "
        "refers to section 12-A. The court then applies the rates."
    )
    assert key_div_texts([body]).sections[0].key == "4"
    act = key_div_texts([
        "Act No. XII-A of 2001 is cited in the margin of this longer note about the instrument.",
    ])
    assert act.sections[0].key != "12A"
    assert act.sections[0].key != "12"
    assert not act.sections[0].key.startswith("12")


def test_splitter_agrees_with_the_glued_key_and_does_not_split_mid_body_refs():
    forward = "\n".join([REAL_12, REAL_12A, REAL_10, REAL_10B])
    backward = "\n".join([REAL_10B, REAL_10, REAL_12A, REAL_12])
    en = "\n".join([REAL_12, REAL_12A_EN])
    for text, expected in (
        (forward, ["12", "12A", "10", "10B"]),
        (backward, ["10B", "10", "12A", "12"]),
        (en, ["12", "12A"]),
    ):
        sections = split_into_sections(text, "Fixture Act")
        assert [section["section_number"] for section in sections] == expected
    keyword = "\n".join([
        "Section 12. Rates. The rates in this section apply to every instrument under this Act.",
        "Section 12-A. Inserted rates. The inserted rates apply to every instrument under this Act.",
    ])
    keyword_sections = split_into_sections(keyword, "Fixture Act")
    assert [section["section_number"] for section in keyword_sections] == ["12", "12A"]
    html = (
        "<p>12. Rates. The rates in this section apply to every instrument "
        "presented for registration under this Act.</p>"
        "<p>12-A. Inserted rates. The inserted rates in this section apply "
        "to instruments presented after the amendment.</p>"
    )
    from bs4 import BeautifulSoup

    html_sections = _strategy_3_p_filtered_digit_start(BeautifulSoup(html, "html.parser"), "Fixture Act")
    assert [section["section_number"] for section in html_sections] == ["12", "12A"]
    html_back = (
        "<p>10-B. Beta rates. The beta rates in this section apply to "
        "instruments presented after the amendment.</p>"
        "<p>10. Other. This other section applies to every instrument "
        "presented for registration under this Act.</p>"
    )
    back_sections = _strategy_3_p_filtered_digit_start(
        BeautifulSoup(html_back, "html.parser"), "Fixture Act",
    )
    assert [section["section_number"] for section in back_sections] == ["10B", "10"]
    mixed = "\n".join([
        "4. Commencement. This Act comes into force w.e.f. 1-7-2001 and applies to the years 12-15.",
        "5. Savings. Orders already made under this Act continue in force throughout Pakistan.",
        "The proviso refers to section 12-A. The court then applies the rates in this Act.",
    ])
    mixed_numbers = [section["section_number"] for section in split_into_sections(mixed, "Fixture Act")]
    assert mixed_numbers == ["4", "5"]
    roman = "Act No. XII-A\nThis Act may be called the Example and it applies throughout Pakistan."
    roman_numbers = [section["section_number"] for section in split_into_sections(roman, "Example Act")]
    assert "12A" not in roman_numbers
    assert "12" not in roman_numbers
    spaced = "\n".join([REAL_12, REAL_12A_SPACE])
    spaced_back = "\n".join([REAL_12A_SPACE, REAL_12])
    assert [section["section_number"] for section in split_into_sections(spaced, "Fixture Act")] == ["12", "12A"]
    assert [section["section_number"] for section in split_into_sections(spaced_back, "Fixture Act")] == ["12A", "12"]
    alone = split_into_sections(REAL_12A_SPACE, "Fixture Act")
    assert [section["section_number"] for section in alone] == ["12A"]
    html_space = (
        "<p>12. Rates. The rates in this section apply to every instrument "
        "presented for registration under this Act.</p>"
        "<p>12-A Inserted rates. The inserted rates in this section apply "
        "to instruments presented after the amendment.</p>"
    )
    space_sections = _strategy_3_p_filtered_digit_start(
        BeautifulSoup(html_space, "html.parser"), "Fixture Act",
    )
    assert [section["section_number"] for section in space_sections] == ["12", "12A"]
    fees_split = "\n".join([
        FEES_12,
        "13. Other. This other section applies to every instrument presented for registration under this Act.",
    ])
    assert [section["section_number"] for section in split_into_sections(fees_split, "Fixture Act")] == ["12", "13"]
    ins_split = "\n".join([NOTE_12_INS, REAL_12])
    assert [section["section_number"] for section in split_into_sections(ins_split, "Fixture Act")] == ["12"]
    repeated = "\n".join([
        "Section 12A. Single letter. This section applies to every instrument under this Act.",
        "Section 12AA. Repeated letters. This section applies to every instrument under this Act.",
    ])
    repeated_hyphen = "\n".join([
        "Section 12A. Single letter. This section applies to every instrument under this Act.",
        "Section 12-AA. Repeated letters. This section applies to every instrument under this Act.",
    ])
    assert [section["section_number"] for section in split_into_sections(repeated, "Fixture Act")] == ["12A", "12AA"]
    assert [section["section_number"] for section in split_into_sections(repeated_hyphen, "Fixture Act")] == ["12A", "12AA"]
    keyword_space = "\n".join([
        "Section 12. Rates. The rates in this section apply to every instrument under this Act.",
        "Section 12-A Inserted rates. The inserted rates apply to every instrument under this Act.",
    ])
    keyword_fees = "\n".join([
        "Section 12-Fees. The fees specified in this section shall be paid on every instrument submitted for registration.",
        "Section 13. Other. This other section applies to every instrument presented for registration under this Act.",
    ])
    assert [section["section_number"] for section in split_into_sections(keyword_space, "Fixture Act")] == ["12", "12A"]
    assert [section["section_number"] for section in split_into_sections(keyword_fees, "Fixture Act")] == ["12", "13"]
    articles = "\n".join([
        "Article 12A. Single letter. This article applies to every instrument under this Act.",
        "Article 12AA. Repeated letters. This article applies to every instrument under this Act.",
    ])
    assert [section["section_number"] for section in split_into_sections(articles, "Fixture Act")] == [
        "Article 12A",
        "Article 12AA",
    ]


def test_a_schedule_item_12A_is_not_body_section_12():
    body = (
        "1. Short title. This Act may be called the Hyphen Fixture Act, 2099, "
        "and it extends to the whole of Pakistan."
    )
    item = "12-A. Stamp on an instrument in this schedule is long enough to stay the item itself."
    result = key_div_texts([body, REAL_12, "Schedule 1", item])
    kinds = [(section.kind, section.key) for section in result.sections]
    assert kinds == [
        ("section", "1"),
        ("section", "12"),
        ("schedule-heading", "schedule-heading:1"),
        ("schedule-item", "schedule:1:12A"),
    ]


def test_hyphen_suffix_match_stays_linear_past_ten_thousand_characters():
    """A long failure and a long hit. No nested quantifier on the number token."""
    failure = "12" + ("A" * 12000) + "!"
    storm = "12-" + ("-" * 15000)
    hit = "12-A. " + ("Rates " * 2000)
    assert len(failure) >= 10000
    assert len(storm) >= 10000
    assert len(hit) >= 10000
    started = time.perf_counter()
    assert parse_section_number(failure) is None
    assert parse_section_number(storm) == "12"
    assert parse_section_number(hit) == "12A"
    assert key_div_texts([hit]).sections[0].key == "12A"
    assert time.perf_counter() - started < 1.0
