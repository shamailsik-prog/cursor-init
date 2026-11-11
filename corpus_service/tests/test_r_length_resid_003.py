"""R-LENGTH-RESID-003: a hyphenated letter suffix is its own section number.

``12A.`` is already keyed ``12A``. ``12-A.``, ``12–A.`` and a bare ``12-A`` use
that same key. ``10-B`` is ``10B``. ``12-AA`` and ``12AA`` are ``12AA``. A real
section 12 beside a real section 12-A keeps both keys, in either order, and
both are retrievable. A hyphen before a digit stays the delimiter it was
(``12-15``, ``1-7-2001``). A hyphen before a heading word does too
(``12-Fees``, ``12-Tax``), and ``12-Ins. by Act ...`` stays the footnote it
was for section 12. ``Act No. XII-A`` is not a section. A citation footnote
for 12-A beside the real 12-A drops; the real section keeps bare ``12A``.
The same footnote does not take section 12. ``Section 12AA`` is ``12AA``.
``Article 12AA. x`` is ``12AA`` in the keyer and ``Article 12AA`` in the
splitter. ``12-a.`` is ``12A``. A glued ``12a.`` stays ``12a``. ``12-I shall``
and ``12-A of the Act`` are not headings. ``12-I. Heading`` is ``12I``, and
``12-A Title`` is ``12A``.

The omitted-note collision is mutation-sensitive: forcing the hyphen to be a
delimiter again keys the note as ``12``, and the note beside a real section 12
disappears. No database and no network.
"""

from __future__ import annotations

import time

from scraper.parsers.pakistancode_keys import (
    PublishedSection,
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
    assert parse_section_number("12-a. Title") == "12A"
    assert parse_section_number("12-a") == "12A"
    assert canonical_section_number("12-a") == "12A"
    assert canonical_section_number("12\u2013a") == "12A"
    assert parse_section_number("Article 12AA. x") == "12AA"
    assert parse_section_number("Art. 12AA. x") == "12AA"
    assert parse_section_number("12-I shall continue") is None
    assert parse_section_number("12-A of the Act") is None
    assert parse_section_number("12-I. Heading") == "12I"
    assert parse_section_number("12-A Title") == "12A"
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
    assert lookup_real_section(store, "12-a") is store["12A"]
    assert lookup_real_section(store, "12-A") is store["12A"]
    assert section_by_key(store, "12-a") is store["12A"]
    lowered = key_div_texts(["12-a. Inserted rates. The inserted rates in this section apply to instruments presented after the amendment."])
    assert lowered.sections[0].key == "12A"


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


def test_lowercase_continuation_is_not_a_hyphen_suffix_and_a_real_12I_is():
    """Space then a lowercase word is prose. A stop or a capital title is a heading.

    Accepting every space-terminated letter keys ``12-I shall`` as live ``12I``.
    """
    prose_i = "12-I shall continue"
    prose_a = "12-A of the Act"
    assert key_div_texts([prose_i]).sections == ()
    assert key_div_texts([prose_a]).sections == ()
    long_i = (
        "12-I shall continue the account of this instrument until the div "
        "is past the short-text gate and would otherwise be published."
    )
    long_a = (
        "12-A of the Act is the phrase in this sentence, and the div is "
        "long enough that a false suffix would be published as its own section."
    )
    assert [section.key for section in key_div_texts([long_i]).sections] != ["12I"]
    assert all(
        section.key != "12I" and not section.key.startswith("12I-")
        for section in key_div_texts([long_i]).sections
    )
    assert all(
        section.key != "12A" and not section.key.startswith("12A-")
        for section in key_div_texts([long_a]).sections
    )
    real = key_div_texts(["12-I. Heading"])
    assert real.sections[0].key == "12I"
    assert real.sections[0].provision_status is None
    titled = key_div_texts([
        "12-A Title. The title case heading applies to every instrument "
        "presented for registration under this Act.",
    ])
    assert titled.sections[0].key == "12A"
    assert titled.sections[0].title.startswith("Title")
    beside = _keys([long_i, "12-I. Heading"])
    assert [item for item in beside if item[0] == "12I"] == [("12I", "12-I. Heading", None)]
    alone_i = [
        section["section_number"] for section in split_into_sections(long_i, "Fixture Act")
    ]
    alone_a = [
        section["section_number"] for section in split_into_sections(long_a, "Fixture Act")
    ]
    assert "12I" not in alone_i
    assert "12A" not in alone_a
    with_real = [
        section["section_number"]
        for section in split_into_sections("\n".join([long_i, REAL_12, REAL_12A]), "Fixture Act")
    ]
    assert with_real == ["12", "12A"]
    with_of = [
        section["section_number"]
        for section in split_into_sections("\n".join([long_a, REAL_12, REAL_10]), "Fixture Act")
    ]
    assert with_of == ["12", "10"]


def test_article_12AA_x_is_keyed_and_split():
    """The exact probe ``Article 12AA. x``. The keyer stores ``12AA``.

    The splitter keeps the Article label it already uses for article headings.
    Dropping ``article`` from the keyer makes this short div noise.
    """
    exact = "Article 12AA. x"
    assert parse_section_number(exact) == "12AA"
    keyed = key_div_texts([exact])
    assert [section.key for section in keyed.sections] == ["12AA"]
    assert keyed.sections[0].provision_status is None
    sections = split_into_sections(exact, "Fixture Act")
    assert [section["section_number"] for section in sections] == ["Article 12AA"]


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
    prose = "12-I " + ("shall " * 2000)
    assert len(prose) >= 10000
    started = time.perf_counter()
    assert parse_section_number(failure) is None
    assert parse_section_number(storm) == "12"
    assert parse_section_number(hit) == "12A"
    assert parse_section_number(prose) is None
    assert key_div_texts([hit]).sections[0].key == "12A"
    assert time.perf_counter() - started < 1.0


S11 = (
    "11. Charge of tax. Tax shall be charged in accordance with this section "
    "for the tax year on the taxable income of every person who is resident."
)
PHANTOM_PAKISTAN = (
    "12-I Pakistan source income of a resident person is charged for the "
    "tax year under this section and the line is not a separate heading."
)
PHANTOM_FEDERAL = (
    "12-I The Federal Government may exempt a class of income from this "
    "charge by a notification published in the official Gazette for this section."
)
S13 = (
    "13. Other. This other section applies to every instrument presented "
    "for registration under this Act."
)
# No stop inside the first eight words, so the title signal does not carry it.
LONG_12A = (
    "12-A Inserted rates apply to every instrument presented for registration "
    "after the amendment and this sentence has no early stop so it is not a title"
)
TITLE_12A = (
    "12-A Title. The title case heading applies to every instrument "
    "presented for registration under this Act."
)
EM_12A = (
    "12-A Rates\u2014 The inserted rates in this section apply to every "
    "instrument presented for registration under this Act."
)
S4 = (
    "4. Commencement. This Act comes into force on the day it is published "
    "in the official Gazette and it extends to the whole of Pakistan."
)
S5 = (
    "5. Definitions. Words used in this Act have the meanings given in "
    "this section and in no other section of this Act."
)


def _numbers(text):
    return [section["section_number"] for section in split_into_sections(text, "Fixture Act")]


def test_capital_line_wrap_inside_section_11_is_not_a_phantom_12I():
    """RESID-003-CAP-001. A wrapped body line is not ``12-A Title``.

    Accepting every capital after the suffix keys both lines as live ``12I``.
    Refusing every space-form drops ``12-A Inserted rates.`` between 12 and 13.
    The long sentence has no title stop, so only the neighbour check keeps it
    as ``12A``. ``12-A Title.`` and the em-dash title sit between 4 and 5, so
    only the title signal keeps them.
    """
    wrapped = [S11, PHANTOM_PAKISTAN, PHANTOM_FEDERAL, REAL_12]
    keyed = key_div_texts(wrapped)
    assert [section.key for section in keyed.sections] == ["11", "12"]
    assert PHANTOM_PAKISTAN in keyed.sections[0].text
    assert PHANTOM_FEDERAL in keyed.sections[0].text
    assert keyed.sections[0].provision_status is None
    assert all(not section.key.startswith("12I") for section in keyed.sections)
    plain = "\n".join(wrapped)
    assert _numbers(plain) == ["11", "12"]
    body = split_into_sections(plain, "Fixture Act")[0]["section_text"]
    assert PHANTOM_PAKISTAN in body
    assert PHANTOM_FEDERAL in body
    between = [REAL_12, REAL_12A_SPACE, S13]
    assert [section.key for section in key_div_texts(between).sections] == ["12", "12A", "13"]
    assert _numbers("\n".join(between)) == ["12", "12A", "13"]
    long_between = [REAL_12, LONG_12A, S13]
    assert [section.key for section in key_div_texts(long_between).sections] == ["12", "12A", "13"]
    assert _numbers("\n".join(long_between)) == ["12", "12A", "13"]
    long_inside = [S11, LONG_12A, REAL_12]
    assert [section.key for section in key_div_texts(long_inside).sections] == ["11", "12"]
    assert LONG_12A in key_div_texts(long_inside).sections[0].text
    assert "12A" not in _numbers("\n".join(long_inside))
    titled = key_div_texts([S4, TITLE_12A, S5])
    assert [section.key for section in titled.sections] == ["4", "12A", "5"]
    assert _numbers("\n".join([S4, TITLE_12A, S5])) == ["4", "12A", "5"]
    em = key_div_texts([S4, EM_12A, S5])
    assert [section.key for section in em.sections] == ["4", "12A", "5"]
    assert _numbers("\n".join([S4, EM_12A, S5])) == ["4", "12A", "5"]
    from bs4 import BeautifulSoup

    html = "".join(f"<p>{line}</p>" for line in wrapped)
    html_sections = _strategy_3_p_filtered_digit_start(BeautifulSoup(html, "html.parser"), "Fixture Act")
    assert [section["section_number"] for section in html_sections] == ["11", "12"]
    assert PHANTOM_PAKISTAN in html_sections[0]["section_text"]
    assert PHANTOM_FEDERAL in html_sections[0]["section_text"]
    started = time.perf_counter()
    wide = "12-I Pakistan " + ("source " * 2000)
    assert len(wide) >= 10000
    wide_keys = [section.key for section in key_div_texts([S11, wide, REAL_12]).sections]
    assert wide_keys == ["11", "12"]
    assert time.perf_counter() - started < 1.0


def test_lookup_folds_suffix_case_and_does_not_rekey_glued_12a():
    """LOOKUP-003-001. ``12a`` and ``12A`` are one lookup. The stored key stays.

    Upper-casing at key time would make the glued row ``12A``. A case-sensitive
    compare makes ``lookup('12A')`` miss the ``12a`` row. Two live casings are
    a tie, so lookup does not pick one.
    """
    glued = (
        "12a. Inserted rates. The inserted rates in this section apply to "
        "instruments presented after the amendment."
    )
    keyed = key_div_texts([glued])
    assert keyed.sections[0].key == "12a"
    assert parse_section_number(glued) == "12a"
    store: dict = {}
    apply_harvest(store, keyed.sections)
    for query in ("12a", "12A", "12-a", "12-A", "12\u2013a", "12\u2014A"):
        assert lookup_real_section(store, query) is store["12a"]
        assert section_by_key(store, query) is store["12a"]
    upper: dict = {}
    apply_harvest(upper, key_div_texts([REAL_12A]).sections)
    assert upper["12A"].key == "12A"
    for query in ("12a", "12A", "12-a", "12-A"):
        assert lookup_real_section(upper, query) is upper["12A"]
        assert section_by_key(upper, query) is upper["12A"]
    both = {
        "12a": PublishedSection(
            key="12a", text=glued, kind="section", lookup_number="12a", versions=[glued],
        ),
        "12A": PublishedSection(
            key="12A", text=REAL_12A, kind="section", lookup_number="12A", versions=[REAL_12A],
        ),
    }
    assert lookup_real_section(both, "12A") is None
    assert lookup_real_section(both, "12a") is None
    assert section_by_key(both, "12-A") is None
    omitted = PublishedSection(
        key="12a", text=glued, kind="section", lookup_number="12a", versions=[glued],
        provision_status="omitted",
    )
    assert lookup_real_section({"12a": omitted}, "12A") is None
    assert section_by_key({"12a": omitted}, "12a") is None


LONG_12B = (
    "12-B Inserted rates apply to every instrument presented for registration "
    "after the amendment and this sentence has no early stop so it is not a title"
)
PHANTOM_13I = (
    "13-I Pakistan source income of a resident person continues in this "
    "provision and the wrapped line is not a heading of its own at all"
)
ITEM_1 = (
    "1. Description of the stamp duty in this schedule is long enough to remain an item."
)
ITEM_2 = (
    "2. Description of the instrument in this schedule is long enough to stay the item."
)
SUBS_NOTE = "1. Subs. by Act II of 2001, s. 3."
SHORT_TITLE = (
    "1. Short title. This Act may be called the Fixture Act and it extends "
    "to the whole of Pakistan."
)


def test_space_heading_fold_keeps_schedule_scope_and_accepted_hosts():
    """A schedule item is not a body neighbour, and a kept suffix heading is a host.

    Using item 1 as the next section rejects ``12-A`` and merges it into
    section 12. Skipping every space-form heading merges ``12-B`` into
    section 11 and merges ``13-I`` into section 12. A footnote host publishes
    live section 1. A leading refusal that keeps ``section_number`` 12I is a
    live section. Each of those is asserted the other way.
    """
    assert is_amendment_footnote(SUBS_NOTE) is True
    with_schedule = key_div_texts([REAL_12, LONG_12A, "FIRST SCHEDULE", ITEM_1])
    assert [section.key for section in with_schedule.sections] == [
        "12", "12A", "schedule-heading:1", "schedule:1:1",
    ]
    assert "Inserted rates apply" not in with_schedule.sections[0].text
    assert "Inserted rates apply" in with_schedule.sections[1].text
    absent = key_div_texts([REAL_12, LONG_12A])
    assert [section.key for section in absent.sections] == ["12", "12A"]
    inside = key_div_texts([S11, "Schedule 1", ITEM_2, LONG_12A])
    assert [section.key for section in inside.sections] == [
        "11", "schedule-heading:1", "schedule:1:2", "schedule:1:12A",
    ]
    assert "Inserted rates apply" not in inside.sections[2].text
    assert inside.sections[2].text == ITEM_2
    hosts = key_div_texts([REAL_12, REAL_12A_SPACE, PHANTOM_13I, S13])
    assert [section.key for section in hosts.sections] == ["12", "12A", "13"]
    assert PHANTOM_13I in hosts.sections[1].text
    assert PHANTOM_13I not in hosts.sections[0].text
    suffix = key_div_texts([S11, TITLE_12A, LONG_12B, S13])
    assert [section.key for section in suffix.sections] == ["11", "12A", "12B", "13"]
    assert "12-B Inserted rates" not in suffix.sections[0].text
    noted = key_div_texts([S11, SUBS_NOTE, PHANTOM_PAKISTAN, REAL_12])
    assert [section.key for section in noted.sections] == ["11", "12"]
    assert PHANTOM_PAKISTAN in noted.sections[0].text
    assert "Subs. by Act II" not in noted.sections[0].text
    orphan = key_div_texts([PHANTOM_PAKISTAN, SHORT_TITLE])
    assert [section.key for section in orphan.sections if section.kind == "section"] == ["1"]
    assert any(
        section.kind == "div" and "Pakistan source income" in section.text
        for section in orphan.sections
    )
    assert all(not section.key.startswith("12I") for section in orphan.sections)
    plain_hosts = "\n".join([REAL_12, REAL_12A_SPACE, PHANTOM_13I, S13])
    assert _numbers(plain_hosts) == ["12", "12A", "13"]
    host_rows = split_into_sections(plain_hosts, "Fixture Act")
    assert PHANTOM_13I not in host_rows[0]["section_text"]
    assert "Pakistan source income" in host_rows[1]["section_text"]
    plain_suffix = "\n".join([S11, TITLE_12A, LONG_12B, S13])
    assert _numbers(plain_suffix) == ["11", "12A", "12B", "13"]
    assert "12-B Inserted rates" not in split_into_sections(plain_suffix, "Fixture Act")[0]["section_text"]
    plain_schedule = "\n".join([REAL_12, LONG_12A, "FIRST SCHEDULE", ITEM_1])
    scheduled = split_into_sections(plain_schedule, "Fixture Act")
    assert [row["section_number"] for row in scheduled] == ["12", "12A", "1"]
    assert "Inserted rates apply" not in scheduled[0]["section_text"]
    assert "Inserted rates apply" in scheduled[1]["section_text"]
    plain_orphan = PHANTOM_PAKISTAN + "\n" + SHORT_TITLE
    opened = split_into_sections(plain_orphan, "Fixture Act")
    assert all(row["section_number"] != "12I" for row in opened)
    assert any(row["section_number"] == "1" for row in opened)
    assert any(
        row.get("section_kind") == "div" and "Pakistan source income" in row["section_text"]
        for row in opened
    )
    from bs4 import BeautifulSoup

    html = "".join(
        f"<p>{line}</p>" for line in (REAL_12, LONG_12A, "FIRST SCHEDULE", ITEM_1)
    )
    html_rows = _strategy_3_p_filtered_digit_start(BeautifulSoup(html, "html.parser"), "Fixture Act")
    assert [row["section_number"] for row in html_rows] == ["12", "12A", "1"]
    assert "Inserted rates apply" not in html_rows[0]["section_text"]
    assert all(row.get("section_kind") != "schedule-boundary" for row in html_rows)
