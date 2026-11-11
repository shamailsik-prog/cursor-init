"""R-LENGTH-RESID-004: a long amendment footnote does not take a section key.

The short-note gate stops at 20 characters. A citation footnote of any length is
the same unstaged noise. A real section that shares the number keeps ``N``,
whether the note is first or last. ``Substitution``, ``Insertion of`` and
``Amendment of section X.-`` followed by operative text stay live. A RESID-001
placeholder that is not this note keeps its key. No database and no network.
"""

from __future__ import annotations

from scraper.parsers.pakistancode_keys import (
    act_inventory_is_complete,
    apply_harvest,
    content_token,
    fallback_act_keys,
    is_amendment_footnote,
    is_long_amendment_footnote,
    is_short_amendment_footnote,
    is_unstaged_amendment_footnote,
    key_div_texts,
    lookup_real_section,
    omission_placeholder_status,
    short_div_disposition,
    suppresses_plain_text_fallback,
)
from scraper.parsers.statute_parser import split_into_sections

SUBS = "1. Subs. by the Finance Act, 1991 (XII of 1991), s. 3."
INS = "3. Ins. by Ord. XXV of 1980, s. 2"
ADDED = "6. Added by Act II of 2001."
REAL_1 = (
    "1. Short title. This Act may be called the Footnote Fixture Act, 2099, "
    "and it extends to the whole of Pakistan."
)
REAL_3 = (
    "3. Definitions. In this Act, words and expressions have the meanings "
    "given in this section and in no other."
)
REAL_6 = (
    "6. Added duties of the registrar are to keep the roll and to certify "
    "a copy on payment of the prescribed fee."
)
SUBSTITUTION = (
    "3. Substitution of section 3.- For section 3 the following shall be "
    "substituted, namely: the tax shall be paid within thirty days of the assessment."
)
INSERTION = (
    "4. Insertion of new section 4A.- After section 4, the following new section "
    "shall be inserted, namely: a person may apply in writing to the registrar."
)
AMENDMENT = (
    "5. Amendment of section 5.- In section 5, for the word tax the word duty "
    "shall be substituted and the registrar shall record the change in the roll."
)
SEE_OPERATIVE = (
    "9. See the Companies Act, 2017, which defines a director for the purposes "
    "of this section and shall apply as if it were enacted in this Act."
)
ADDED_OPERATIVE = (
    "8. Added by way of explanation, the following words shall be read with "
    "section 4 of this Act and the court shall give effect to them."
)
SUBSTITUTED_THEN_OPERATIVE = (
    "7. Substituted by the Finance Act, 1991 (XII of 1991), s. 3, and the "
    "following shall be substituted, namely: the rate of tax is five percent of the value."
)
REPEAL = "2. Repeal. The Earlier Fixture Act, 1908, is hereby repealed."
MIXED_OPERATIVE = (
    "5. Substitution of section 5 and insertion of section 5A.- For section 5 "
    "the following shall be substituted, and after it the following shall be "
    "inserted, namely: the registrar shall keep the roll of instruments."
)
OMITTED_BY = "6. Omitted by the Finance Act, 1990 (X of 1990), s. 3."
REP_BY = "5. [Rep. by Ord. X of 1980]"
DELETED_BY = "10. Deleted by Act V of 1976."
BARE_LONG = "1. Substituted by Act"


def _pairs(texts):
    result = key_div_texts(texts)
    return [(section.key, section.text, section.provision_status) for section in result.sections]


def test_citation_footnotes_of_any_length_are_recognised_and_unstaged():
    notes = (
        SUBS,
        INS,
        ADDED,
        "1. [Subs. by the Finance Act, 1991 (XII of 1991), s. 3.]",
        "1.  SUBS.  BY  THE  FINANCE  ACT,  1991  (XII  OF  1991),  S.  3.",
        "8. Amended by P.O. No. 8 of 1980, s. 2.",
        "8. Amended by P.O. 4 of 1975, s. 2.",
        "3. Renumbered by Act V of 1976.",
        "3. Re-numbered as s. 4 by Act V of 1976.",
        "9. See the Finance Act, 1991 (XII of 1991), s. 3.",
        "9. See also Act II of 2001, s. 3.",
        "2. Subs. by Ordinance No. IV of 1962, s. 5.",
        "4. Added by Regulation III of 1976.",
        "4. Subs. by the Cantonments Act, 1924, s. 2.",
        "1. Substituted by the Finance Act, 1991 (XII of 1991), s. 3.",
        "1. Subs. by the Finance Act, 1991, s. 3.",
        "9. See the Finance Act, 1991.",
        "1. Am. by the Finance Act, 1991 (XII of 1991), s. 3.",
        "12-A. Subs. by Act II of 2001, s. 4.",
        '1. Subs. by Ord. No. XXV of 2001, s. 2, for "words"',
        '1. Subs. by the Finance Act, 1991 (XII of 1991), s. 3, for the words "tax" the words "duty"',
        "1. Subs. by the Finance Act, 1991, s. 3, w.e.f. 1st July, 1991.",
        "2. Ins. by Act II of 2001, s. 4, w.e.f. the 15th day of June, 2001.",
        "1. Subs. by Act II of 2001, s. 2, with effect from 1st July, 2001.",
        "1. Subs. by the Finance Act, 1991, s. 3, and the Finance Act, 1992, s. 4.",
        "1. Subs. by Act II of 2001, s. 2 and Act III of 2002, s. 3.",
        "1. Subs. by the Finance Act, 1990, s. 2, the Finance Act, 1991, s. 3 and Ord. No. V of 1992, s. 4.",
        "3. Renumbered as sub-section (1) by Act V of 1976.",
        "4. Re-numbered as clause (x) by the Finance Act, 1991, s. 2.",
        "4. Renumbered as clause (a) by Act II of 2001.",
        "1. Subs. by the Civil Courts Act, 1962, s. 3.",
        "1. Subs. by the Finance (Supplementary) Act, 1991, s. 3.",
        "1. Subs. by Act II of 2000, s. 2 and Ins. by Act III of 2001, s. 3",
        "1. Added by Act II of 2000, s. 2 and Omitted by Act III of 2001, s. 3",
        "1. Rep. by Act II of 2000, s. 2 and Amended by Act III of 2001, s. 4",
        '1. Subs. by Act II of 2000, s. 2, for "tax" and Ins. by Act III of 2001, s. 3',
        "1. Subs. by Act II of 2000, s. 2, Ins. by Act III of 2001, s. 3 and Omitted by Ord. IV of 2002, s. 5",
        "1. Subs. by Act II of 2000, s. 2, Ins. by Act III of 2001, s. 3",
        "1. Subs. by Act II of 2000, s. 2 (w.e.f. 1-7-2001)",
        "1. Subs. by Act II of 2000, s. 2 (w.e.f. 1st July, 2001)",
        "1. Subs. by Act II of 2000, s. 2, w.e.f. 1-7-2001 and Ins. by Act III of 2001, s. 3",
        "1. Subs. by Act II of 2000, s. 2, w.e.f. 1st July, 2001 and Ins. by Act III of 2001, s. 3",
        "1. Subs. by Act II of 2000, s. 2 (w.e.f. 1-7-2001) and Ins. by Act III of 2001, s. 3",
        "1. Subs. by Act II of 2000, s. 2 (w.e.f. 1-7-2001), Ins. by Act III of 2001, s. 3",
        '1. Subs. by Act II of 2000, s. 2, for "tax", Ins. by Act III of 2001, s. 3',
        "1. Subs. by Act II of 2000, s. 2, w.e.f. 1-7-2001, Ins. by Act III of 2001, s. 3 (w.e.f. 2-8-2002)",
        "1. Subs. by the Finance Act, 1991, s. 3, Ins. by Act III of 2001, s. 4",
        "1. Subs. by Act II of 2000, s. 2, with effect from 1st July, 2001 and Ins. by Act III of 2001, s. 3",
        "6. Omitted by Act II of 2000, s. 2, Ins. by Act III of 2001, s. 3",
    )
    assert all(len(note) > 20 for note in notes)
    for note in notes:
        assert is_long_amendment_footnote(note) is True
        assert is_short_amendment_footnote(note) is False
        assert is_amendment_footnote(note) is True
        assert is_unstaged_amendment_footnote(note) is True
        assert omission_placeholder_status(note) is None
        assert short_div_disposition(note) == "noise"
        assert key_div_texts([note]).sections == ()
        assert split_into_sections(note, "Fixture Act") == []


def test_operative_amending_sections_stay_live():
    """The lead is the whole body. A real amending section is not a footnote."""
    live = (
        SUBSTITUTION, INSERTION, AMENDMENT, SEE_OPERATIVE, ADDED_OPERATIVE,
        SUBSTITUTED_THEN_OPERATIVE, REPEAL, MIXED_OPERATIVE,
    )
    for text in live:
        assert is_amendment_footnote(text) is False
        assert is_unstaged_amendment_footnote(text) is False
        assert omission_placeholder_status(text) is None
        assert short_div_disposition(text) == "provision"
        result = key_div_texts([text])
        assert len(result.sections) == 1
        assert result.sections[0].text == text
        assert result.sections[0].provision_status is None
        assert result.sections[0].key == text.split(".", 1)[0]
        parsed = split_into_sections(text, "Fixture Act")
        assert len(parsed) == 1
        assert parsed[0]["section_text"] == text
        assert "provision_status" not in parsed[0]
    assert is_amendment_footnote(BARE_LONG) is False
    assert short_div_disposition(BARE_LONG) == "provision"
    assert len(BARE_LONG) > 20
    assert is_amendment_footnote("1. Subs. by Act CIVIL of 2001, s. 3.") is False
    assert is_amendment_footnote(
        '1. Subs. by Ord. No. XXV of 2001, s. 2. The registrar shall keep the roll.'
    ) is False
    assert is_amendment_footnote(
        "3. Renumbered as sub-section (1) by order of the court and the registrar shall record it."
    ) is False
    assert is_short_amendment_footnote("1. Subs. by Act") is True
    assert is_amendment_footnote("2. Repeal.") is False
    assert is_amendment_footnote("6. Inserted.") is False


def test_the_for_words_note_is_unstaged_without_a_colliding_section():
    """The note itself is unstaged. A collision is not what makes that true.

    ``_without_colliding_footnotes`` also drops a recognised footnote, so a
    test that only keys the note beside a real section still passes when
    ``is_unstaged_amendment_footnote`` is false. This calls that predicate on
    the note alone, then checks the real section keeps ``1``.
    """
    note = '1. Subs. by Ord. No. XXV of 2001, s. 2, for "words"'
    assert is_long_amendment_footnote(note) is True
    assert is_unstaged_amendment_footnote(note) is True
    assert omission_placeholder_status(note) is None
    alone = key_div_texts([note])
    assert alone.sections == ()
    assert alone.skipped_short == 1
    assert _pairs([note, REAL_1]) == [("1", REAL_1, None)]
    assert _pairs([REAL_1, note]) == [("1", REAL_1, None)]
    assert len(key_div_texts([note, REAL_1]).sections) == 1


def test_a_mixed_verb_chain_does_not_take_a_second_key():
    """``Subs. ... and Ins. ...`` is one unstaged note. The real section keeps ``1``."""
    note = "1. Subs. by Act II of 2000, s. 2 and Ins. by Act III of 2001, s. 3"
    assert is_long_amendment_footnote(note) is True
    assert is_unstaged_amendment_footnote(note) is True
    alone = key_div_texts([note])
    assert alone.sections == ()
    assert alone.skipped_short == 1
    assert [section.key for section in key_div_texts([note, REAL_1]).sections] == ["1"]
    assert [section.key for section in key_div_texts([REAL_1, note]).sections] == ["1"]
    assert _pairs([note, REAL_1]) == [("1", REAL_1, None)]
    assert _pairs([REAL_1, note]) == [("1", REAL_1, None)]
    assert is_amendment_footnote(MIXED_OPERATIVE) is False
    assert is_unstaged_amendment_footnote(MIXED_OPERATIVE) is False
    kept = key_div_texts([MIXED_OPERATIVE])
    assert [section.key for section in kept.sections] == ["5"]
    assert kept.sections[0].text == MIXED_OPERATIVE
    assert kept.sections[0].provision_status is None


def test_a_long_ambiguous_tail_does_not_backtrack():
    """Comma tails and mixed-verb chains stay linear. No nested quantifier."""
    import time

    note = "1. Subs. by the Finance Act, 1991, " + (", s" * 4000)
    started = time.perf_counter()
    recognised = is_long_amendment_footnote(note)
    elapsed = time.perf_counter() - started
    assert recognised is False
    assert is_unstaged_amendment_footnote(note) is False
    assert elapsed < 1.0
    units = (
        " and Ins. by Act III of 2001, s. 3",
        " and Added by Act IV of 2002, s. 4",
        " and Omitted by Act V of 2003, s. 5",
        " and Rep. by Act VI of 2004, s. 6",
        " and Amended by Act VII of 2005, s. 7",
    )
    chain = "1. Subs. by Act II of 2000, s. 2"
    index = 0
    while len(chain) < 10000:
        chain += units[index % len(units)]
        index += 1
    assert len(chain) >= 10000
    started = time.perf_counter()
    assert is_long_amendment_footnote(chain) is True
    assert is_unstaged_amendment_footnote(chain) is True
    assert time.perf_counter() - started < 1.0


GRAM_011 = (
    "1. Subs. by Act II of 2000, s. 2, Ins. by Act III of 2001, s. 3 "
    "and Omitted by Ord. IV of 2002, s. 5"
)
GRAM_012 = "1. Subs. by Act II of 2000, s. 2 (w.e.f. 1-7-2001)"
GRAM_013 = (
    "1. Subs. by Act II of 2000, s. 2, w.e.f. 1-7-2001 and Ins. by Act III of 2001, s. 3"
)
FINANCE_AMENDMENT = (
    "4. Amendment of the Finance Act, 1991.- In the Finance Act, 1991, "
    "in section 3, for the word tax the word duty shall be substituted."
)
PROSE_TAIL = (
    "1. Subs. by Act II of 2000, s. 2, the registrar shall keep the roll "
    "of instruments filed under this Act."
)
URDU_TAIL = "1. Subs. by Act II of 2000, s. 2, یہ دفعہ نافذ العمل رہے گی۔"
NON_INSTRUMENT = "1. Subs. by Act CIVIL of 2001, s. 3."


def _assert_unstaged_note_yields(note, real, number):
    """The note is noise on its own, and the real section keeps bare ``number``.

    Both orders. A collision-only check is not enough: ``is_unstaged`` is
    called on the note with no neighbour, then the note is keyed alone.
    """
    assert is_long_amendment_footnote(note) is True
    assert is_amendment_footnote(note) is True
    assert is_unstaged_amendment_footnote(note) is True
    assert omission_placeholder_status(note) is None
    assert short_div_disposition(note) == "noise"
    alone = key_div_texts([note])
    assert alone.sections == ()
    assert alone.skipped_short == 1
    assert split_into_sections(note, "Fixture Act") == []
    assert _pairs([note, real]) == [(number, real, None)]
    assert _pairs([real, note]) == [(number, real, None)]
    for ordered in (f"{note}\n{real}", f"{real}\n{note}"):
        sections = split_into_sections(ordered, "Fixture Act")
        assert [section["section_number"] for section in sections] == [number]
        assert sections[0]["section_text"] == real
        assert note not in sections[0]["section_text"]


def test_gram_011_comma_joined_verb_stack_is_one_unstaged_note():
    """``s. 2, Ins. by`` is the same chain as ``s. 2 and Ins. by``."""
    _assert_unstaged_note_yields(GRAM_011, REAL_1, "1")


def test_gram_012_parenthetical_wef_is_one_unstaged_note():
    """``(w.e.f. 1-7-2001)`` is a date clause, not a second section."""
    _assert_unstaged_note_yields(GRAM_012, REAL_1, "1")


def test_gram_013_wef_mid_chain_is_one_unstaged_note():
    """A date on the first unit does not eat the separator before the next verb."""
    _assert_unstaged_note_yields(GRAM_013, REAL_1, "1")
    mid = (
        "1. Subs. by Act II of 2000, s. 2 (w.e.f. 1-7-2001), "
        "Ins. by Act III of 2001, s. 3"
    )
    _assert_unstaged_note_yields(mid, REAL_1, "1")


def test_comma_and_wef_notes_leave_live_text_on_its_bare_key():
    """These stay provisions. A comma or ``w.e.f.`` shape must not swallow them."""
    live = (
        MIXED_OPERATIVE,
        FINANCE_AMENDMENT,
        PROSE_TAIL,
        URDU_TAIL,
        NON_INSTRUMENT,
        "1. Subs. by Act II of 2000, s. 2 (w.e.f. 1-7-2001",
        "1. Subs. by Act II of 2000, s. 2. The registrar shall keep the roll.",
    )
    for text in live:
        assert is_amendment_footnote(text) is False
        assert is_unstaged_amendment_footnote(text) is False
        result = key_div_texts([text])
        assert len(result.sections) == 1
        assert result.sections[0].text == text
        assert result.sections[0].provision_status is None
        assert result.sections[0].key == text.split(".", 1)[0]
        assert "-" not in result.sections[0].key


def test_a_see_cross_reference_stays_an_omission_placeholder():
    """``, see s. 2`` names a section. It is not a second verb unit.

    The row keeps key ``6`` and status ``omitted``. Lookup does not serve it
    as current law.
    """
    note = "6. Omitted by Act II of 2000, see s. 2."
    assert is_long_amendment_footnote(note) is False
    assert is_unstaged_amendment_footnote(note) is False
    assert omission_placeholder_status(note) == "omitted"
    result = key_div_texts([note])
    assert len(result.sections) == 1
    assert result.sections[0].key == "6"
    assert result.sections[0].text == note
    assert result.sections[0].provision_status == "omitted"
    store: dict = {}
    apply_harvest(store, result.sections)
    assert lookup_real_section(store, "6") is None
    assert store["6"].text == note


def test_a_see_crossref_yields_when_a_real_section_shares_the_number():
    """RESID-004-SEE-001. Beside a real section 6 the placeholder is dropped.

    ``is_amendment_footnote`` is what the collision path reads. Forcing it
    false on this note leaves two ``6-<sha>`` keys, and lookup of ``6``
    returns nothing. Forcing ``is_unstaged_amendment_footnote`` true drops
    the note when it is the only text, so bare key ``6`` is gone. Alone,
    the note keeps ``6`` and status ``omitted`` and is not current law.
    """
    notes = (
        "6. Omitted by Act II of 2000, see s. 2.",
        "5. Rep. by Ord. IV of 2002, see s. 5.",
    )
    reals = {
        "6": (
            "6. Savings of the omitted entries are recorded by the registrar "
            "when a court so directs and not otherwise."
        ),
        "5": (
            "5. Definitions. Words used in this Act have the meanings given in "
            "this section and in no other section."
        ),
    }
    statuses = {"6": "omitted", "5": "repealed"}
    for note in notes:
        number = note.split(".", 1)[0]
        real = reals[number]
        assert is_amendment_footnote(note) is True
        assert is_long_amendment_footnote(note) is False
        assert is_unstaged_amendment_footnote(note) is False
        assert omission_placeholder_status(note) == statuses[number]
        alone = key_div_texts([note])
        assert len(alone.sections) == 1
        assert alone.sections[0].key == number
        assert alone.sections[0].text == note
        assert alone.sections[0].provision_status == statuses[number]
        assert alone.skipped_short == 0
        store: dict = {}
        apply_harvest(store, alone.sections)
        assert lookup_real_section(store, number) is None
        assert store[number].provision_status == statuses[number]
        for ordered in ([note, real], [real, note]):
            result = key_div_texts(ordered)
            assert [section.key for section in result.sections] == [number]
            assert result.sections[0].text == real
            assert result.sections[0].provision_status is None
            assert result.skipped_short == 1
            assert note not in result.sections[0].text
            paired: dict = {}
            apply_harvest(paired, result.sections)
            found = lookup_real_section(paired, number)
            assert found is not None and found.text == real
        for ordered in (f"{note}\n{real}", f"{real}\n{note}"):
            sections = split_into_sections(ordered, "Fixture Act")
            assert [section["section_number"] for section in sections] == [number]
            assert sections[0]["section_text"] == real
            assert note not in sections[0]["section_text"]
        alone_split = split_into_sections(note, "Fixture Act")
        assert len(alone_split) == 1
        assert alone_split[0]["section_number"] == number
        assert alone_split[0]["section_text"] == note
        assert alone_split[0].get("provision_status") == statuses[number]


def test_a_wef_date_keeps_a_standalone_omission_or_repeal():
    """``(w.e.f. ...)`` is a date on the placeholder, not a reason to drop it.

    A lone ``f.`` is still not a citation abbreviation. A real section that
    shares the number keeps the bare key.
    """
    omitted = "6. Omitted by Act II of 2000, s. 2 (w.e.f. 1-7-2001)"
    repealed = "5. Rep. by Ord. IV of 2002, s. 5 (w.e.f. 1-7-2001)"
    spelled = "6. Omitted by Act II of 2000, s. 2, with effect from 1-7-2001"
    dated = "6. Omitted by Act II of 2000, s. 2, w.e.f. 1-7-2001"
    for note, number, status in (
        (omitted, "6", "omitted"),
        (repealed, "5", "repealed"),
        (spelled, "6", "omitted"),
        (dated, "6", "omitted"),
    ):
        assert is_long_amendment_footnote(note) is True
        assert omission_placeholder_status(note) == status
        assert is_unstaged_amendment_footnote(note) is False
        result = key_div_texts([note])
        assert len(result.sections) == 1
        assert result.sections[0].key == number
        assert result.sections[0].text == note
        assert result.sections[0].provision_status == status
        store: dict = {}
        apply_harvest(store, result.sections)
        assert lookup_real_section(store, number) is None
    bare_f = "6. Omitted by Act II of 2000, f. 3."
    assert omission_placeholder_status(bare_f) is None
    assert is_unstaged_amendment_footnote(bare_f) is False
    live = key_div_texts([bare_f])
    assert live.sections[0].key == "6"
    assert live.sections[0].provision_status is None
    real = (
        "6. Savings of the omitted entries are recorded by the registrar "
        "when a court so directs and not otherwise."
    )
    assert _pairs([omitted, real]) == [("6", real, None)]
    assert _pairs([real, omitted]) == [("6", real, None)]
    real_5 = (
        "5. Definitions. Words used in this Act have the meanings given in "
        "this section and in no other section."
    )
    assert _pairs([repealed, real_5]) == [("5", real_5, None)]
    assert _pairs([real_5, repealed]) == [("5", real_5, None)]


def test_forcing_unstaged_false_cannot_hide_behind_a_collision():
    """MUT-001. Forcing ``is_unstaged_amendment_footnote`` false stages the note.

    ``_without_colliding_footnotes`` also drops a recognised footnote, so a
    test that only keys the note beside a real section still passes when that
    predicate is false. These asserts call it on the note alone, then key the
    note with no real section.
    """
    for note in (GRAM_011, GRAM_012, GRAM_013):
        assert is_unstaged_amendment_footnote(note) is True
        alone = key_div_texts([note])
        assert alone.sections == ()
        assert alone.skipped_short == 1
        assert split_into_sections(note, "Fixture Act") == []
        assert _pairs([note, REAL_1]) == [("1", REAL_1, None)]


def test_comma_and_wef_chains_stay_linear():
    """Comma and ``and`` mixed chains, and near-misses, stay one forward pass."""
    import time

    units = (
        ", Ins. by Act III of 2001, s. 3",
        " and Added by Act IV of 2002, s. 4, w.e.f. 1-7-2002",
        ", Omitted by Ord. V of 2003, s. 5 (w.e.f. 1-7-2003)",
        " and Rep. by Act VI of 2004, s. 6",
        ", Amended by Act VII of 2005, s. 7, w.e.f. 1st July, 2005",
    )
    chain = "1. Subs. by Act II of 2000, s. 2, w.e.f. 1-7-2001"
    index = 0
    while len(chain) < 10000:
        chain += units[index % len(units)]
        index += 1
    assert len(chain) >= 10000
    assert "," in chain and " and " in chain
    started = time.perf_counter()
    assert is_long_amendment_footnote(chain) is True
    assert is_unstaged_amendment_footnote(chain) is True
    assert time.perf_counter() - started < 1.0

    near_miss = chain + ", the registrar shall keep the roll of every instrument filed under this Act."
    assert len(near_miss) >= 10000
    started = time.perf_counter()
    assert is_long_amendment_footnote(near_miss) is False
    assert is_unstaged_amendment_footnote(near_miss) is False
    assert time.perf_counter() - started < 1.0

    comma_tail = "1. Subs. by Act II of 2000, s. 2" + (", s" * 5000)
    assert len(comma_tail) >= 10000
    paren_tail = "1. Subs. by Act II of 2000, s. 2 (w.e.f. " + ("1-7-2001 " * 1200)
    assert len(paren_tail) >= 10000
    started = time.perf_counter()
    assert is_long_amendment_footnote(comma_tail) is False
    assert is_unstaged_amendment_footnote(comma_tail) is False
    assert is_long_amendment_footnote(paren_tail) is False
    assert is_unstaged_amendment_footnote(paren_tail) is False
    assert time.perf_counter() - started < 1.0


def test_a_real_section_keeps_its_key_whichever_side_the_footnote_is_on():
    forward = _pairs([REAL_1, SUBS, INS, REAL_3, REAL_6, ADDED])
    backward = _pairs([SUBS, REAL_1, REAL_3, INS, ADDED, REAL_6])
    expect = [("1", REAL_1, None), ("3", REAL_3, None), ("6", REAL_6, None)]
    assert forward == expect
    assert backward == expect
    result = key_div_texts([SUBS, REAL_1, INS, REAL_3, ADDED, REAL_6])
    assert result.skipped_short == 3 and result.dropped_by_cap == 0
    assert act_inventory_is_complete(result) is True
    assert fallback_act_keys(result, [(section.key, section.kind) for section in result.sections]) == ["1", "3", "6"]
    assert all(SUBS not in section.text and INS not in section.text and ADDED not in section.text for section in result.sections)
    store: dict = {}
    apply_harvest(store, key_div_texts([SUBS, REAL_1]).sections)
    assert lookup_real_section(store, "1").text == REAL_1
    apply_harvest(store, key_div_texts([REAL_1, SUBS]).sections)
    assert lookup_real_section(store, "1").text == REAL_1
    assert all(SUBS not in row.text for row in store.values())


def test_a_footnote_does_not_split_a_repeated_real_section_into_a_third_key():
    alpha = "1. Alpha text of the first real section is long enough to stay a section."
    beta = "1. Beta text of the second real section is long enough to stay a section."
    result = key_div_texts([SUBS, alpha, beta, SUBS])
    assert [section.text for section in result.sections] == [alpha, beta]
    assert result.sections[0].key == f"1-{content_token(alpha)}"
    assert result.sections[1].key == f"1-{content_token(beta)}"
    assert result.skipped_short == 2


def test_a_citation_placeholder_yields_when_a_real_section_shares_the_number():
    real = (
        "5. Definitions. Words used in this Act have the meanings given in "
        "this section and in no other section."
    )
    assert is_long_amendment_footnote(REP_BY) is True
    assert is_unstaged_amendment_footnote(REP_BY) is False
    assert omission_placeholder_status(REP_BY) == "repealed"
    assert _pairs([REP_BY, real]) == [( "5", real, None)]
    assert _pairs([real, REP_BY]) == [("5", real, None)]
    alone = key_div_texts([REP_BY])
    assert alone.sections[0].key == "5"
    assert alone.sections[0].text == REP_BY
    assert alone.sections[0].provision_status == "repealed"
    omitted_real = (
        "6. Savings of the omitted entries are recorded by the registrar "
        "when a court so directs and not otherwise."
    )
    assert _pairs([OMITTED_BY, omitted_real]) == [("6", omitted_real, None)]
    assert _pairs([omitted_real, OMITTED_BY]) == [("6", omitted_real, None)]
    kept = key_div_texts([OMITTED_BY])
    assert kept.sections[0].key == "6"
    assert kept.sections[0].provision_status == "omitted"
    deleted = key_div_texts([DELETED_BY])
    assert is_amendment_footnote(DELETED_BY) is False
    assert deleted.sections[0].key == "10"
    assert deleted.sections[0].provision_status == "deleted"


def test_a_schedule_item_and_a_letter_suffix_footnote_do_not_take_the_real_key():
    item = "1. Stamp on an instrument in this schedule is long enough to stay the item."
    body = "2. Beta text of the second body section that is longer than twenty characters."
    for texts in (
        [body, "Schedule 1", SUBS, item],
        [body, "Schedule 1", item, SUBS],
    ):
        result = key_div_texts(texts)
        assert [section.kind for section in result.sections] == [
            "section", "schedule-heading", "schedule-item",
        ]
        assert result.sections[2].key == "schedule:1:1"
        assert result.sections[2].text == item
        assert result.skipped_short == 1
        assert act_inventory_is_complete(result) is True
    omitted = "1. Omitted by the Finance Act, 1990 (X of 1990), s. 3."
    collided = key_div_texts([body, "Schedule 1", omitted, item])
    assert collided.sections[-1].key == "schedule:1:1"
    assert collided.sections[-1].text == item
    assert omitted not in [section.text for section in collided.sections]
    alone = key_div_texts([body, "Schedule 1", omitted])
    assert alone.sections[-1].key == "schedule:1:1"
    assert alone.sections[-1].text == omitted
    assert alone.sections[-1].provision_status == "omitted"
    real = (
        "12. Rates. The rates in this section apply to every instrument "
        "presented for registration under this Act."
    )
    note = "12-A. Subs. by Act II of 2001, s. 4."
    assert _pairs([note, real]) == [("12", real, None)]
    assert _pairs([real, note]) == [("12", real, None)]
    assert key_div_texts([note]).sections == ()


def test_footnotes_do_not_use_the_cap_or_open_a_quarantine():
    notes = [f"{n}. Subs. by the Finance Act, 1991 (XII of 1991), s. 3." for n in range(1, 51)]
    reals = []
    for number in range(1, 52):
        prefix = f"{number}. "
        reals.append(prefix + ("B" * (40 - len(prefix))))
    interleaved = [piece for pair in zip(notes, reals) for piece in pair]
    capped = key_div_texts(interleaved + [reals[-1]])
    assert capped.skipped_short == 50
    assert capped.dropped_by_cap == 1
    assert [section.key for section in capped.sections] == [str(n) for n in range(1, 51)]
    assert [section.text for section in capped.sections] == reals[:50]
    page = key_div_texts([SUBS, INS, ADDED])
    assert page.sections == ()
    assert page.skipped_short == 3
    assert act_inventory_is_complete(page) is False
    assert suppresses_plain_text_fallback(page) is False
    assert fallback_act_keys(page, []) is None
    body = REAL_1
    mixed = key_div_texts([body, SUBS, "[Omitted]"])
    assert mixed.sections[0].key == "1" and mixed.sections[0].text == body
    assert mixed.sections[1].kind == "short-ambiguous"
    assert act_inventory_is_complete(mixed) is False


def test_the_splitter_serves_the_real_body_and_drops_the_footnote():
    forward = "\n".join([REAL_1, SUBS, REAL_3, INS, REAL_6, ADDED, INSERTION, AMENDMENT])
    backward = "\n".join([SUBS, REAL_1, INS, REAL_3, ADDED, REAL_6, AMENDMENT, INSERTION])
    for text in (forward, backward):
        sections = split_into_sections(text, "Fixture Act")
        by_number = {section["section_number"]: section for section in sections}
        assert by_number["1"]["section_text"] == REAL_1
        assert by_number["3"]["section_text"] == REAL_3
        assert by_number["6"]["section_text"] == REAL_6
        assert by_number["4"]["section_text"] == INSERTION
        assert by_number["5"]["section_text"] == AMENDMENT
        assert "provision_status" not in by_number["1"]
        assert all(SUBS not in section["section_text"] for section in sections)
        assert all(INS not in section["section_text"] for section in sections)
        assert all(ADDED not in section["section_text"] for section in sections)
    operative = split_into_sections("\n".join([SUBSTITUTION, INSERTION, AMENDMENT]), "Fixture Act")
    assert [section["section_number"] for section in operative] == ["3", "4", "5"]
    assert [section["section_text"] for section in operative] == [SUBSTITUTION, INSERTION, AMENDMENT]
    html = """
    <html><h1>Fixture Act</h1><body>
    <p class="section">1. Subs. by the Finance Act, 1991 (XII of 1991), s. 3.</p>
    <p class="section">1. Short title. This Act may be called the Footnote Fixture Act, 2099, and it extends to the whole of Pakistan.</p>
    <p class="section">3. Ins. by Ord. XXV of 1980, s. 2</p>
    <p class="section">3. Definitions. In this Act, words and expressions have the meanings given in this section and in no other.</p>
    </body></html>
    """
    html_sections = split_into_sections(html, "Fixture Act")
    by_number = {section["section_number"]: section for section in html_sections}
    assert by_number["1"]["section_text"] == REAL_1
    assert by_number["3"]["section_text"] == REAL_3
    assert all(SUBS not in section["section_text"] and INS not in section["section_text"] for section in html_sections)
    notes_page = """
    <html><h1>Notes Only Act 2099</h1>
    <div class="section">1. Subs. by the Finance Act, 1991 (XII of 1991), s. 3.</div>
    <div class="section">3. Ins. by Ord. XXV of 1980, s. 2</div>
    <div class="section">6. Added by Act II of 2001.</div>
    </html>
    """
    assert split_into_sections(notes_page, "Notes Only Act 2099") == []
    prose = (
        "This Act may be cited as the Example and it applies throughout "
        "Pakistan to every person who files an instrument."
    )
    fallback = split_into_sections(prose, "Example Act")
    assert len(fallback) == 1 and fallback[0]["section_number"] == "1"
    assert prose in fallback[0]["section_text"]
    with_note = prose + "\n" + SUBS
    kept = split_into_sections(with_note, "Example Act")
    assert len(kept) == 1 and kept[0]["section_number"] == "1"
    assert prose in kept[0]["section_text"]
    assert "Subs. by" not in kept[0]["section_text"]
    assert "Finance Act" not in kept[0]["section_text"]
    html_prose = (
        "<html><body><p>" + prose + "</p>"
        "<p class=\"section\">" + SUBS + "</p></body></html>"
    )
    html_kept = split_into_sections(html_prose, "Example Act")
    assert len(html_kept) == 1 and html_kept[0]["section_number"] == "1"
    assert prose in html_kept[0]["section_text"]
    assert "Subs. by" not in html_kept[0]["section_text"]
    assert split_into_sections("Page 12\n" + SUBS, "Example Act") == []
    titled = "\n".join(["Resid004 Notes Only Act 2099", SUBS, INS, ADDED])
    assert split_into_sections(titled, "Resid004 Notes Only Act 2099") == []


def test_policy_note_records_the_citation_footnote_rule():
    import scraper.parsers.pakistancode_keys as keys

    note = keys.__doc__ or ""
    assert "RESID-004-POLICY" in note
    assert "Subs." in note and "Ord." in note
    assert "Substitution" in note and "Insertion of" in note
    assert "Subs. by Act II of 2000, s. 2 and Ins. by Act III of 2001, s. 3" in note
    assert "Subs. by Act II of 2000, s. 2, Ins. by Act III of 2001, s. 3 and Omitted by Ord. IV of 2002, s. 5" in note
    assert "Subs. by Act II of 2000, s. 2 (w.e.f. 1-7-2001)" in note
    assert "Subs. by Act II of 2000, s. 2, w.e.f. 1-7-2001 and Ins. by Act III of 2001, s. 3" in note
    assert "insertion of section 5A" in note
    assert "Amendment of section X.-" in note
    assert "sub-section" in note and "w.e.f." in note
    assert "(w.e.f. ...)" in note
    assert "Omitted by Act II of 2000, see s. 2" in note
    assert "50-div cap" in note
    assert "RESID-004-SEE-002" in note


SEE_6 = "6. Omitted by Act II of 2000, see s. 2."
REAL_6_SAVINGS = (
    "6. Savings of the omitted entries are recorded by the registrar "
    "when a court so directs and not otherwise."
)


def test_two_non_live_section_6_placeholders_share_one_bare_key():
    """RESID-004-SEE-002. A see-omission and a Finance omission are one row.

    Leaving both staged publishes two ``6-<sha>`` keys. The kept text is the
    lexicographically earliest normalised text, in either order. Marking that
    row live makes lookup serve it. A real section 6 still keeps the bare key.
    ``3. [Omitted.]`` twice stays content-addressed: it is not a footnote.
    """
    finance = OMITTED_BY
    assert SEE_6 < finance
    for ordered in ([SEE_6, finance], [finance, SEE_6]):
        result = key_div_texts(ordered)
        assert [section.key for section in result.sections] == ["6"]
        assert result.sections[0].text == SEE_6
        assert result.sections[0].provision_status == "omitted"
        assert result.skipped_short == 1
        assert "-" not in result.sections[0].key
        store: dict = {}
        apply_harvest(store, result.sections)
        assert lookup_real_section(store, "6") is None
        assert store["6"].provision_status == "omitted"
        assert store["6"].text == SEE_6
        split = split_into_sections("\n".join(ordered), "Fixture Act")
        assert [section["section_number"] for section in split] == ["6"]
        assert split[0]["section_text"] == SEE_6
        assert split[0].get("provision_status") == "omitted"
    beside = key_div_texts([SEE_6, finance, REAL_6_SAVINGS])
    assert [section.key for section in beside.sections] == ["6"]
    assert beside.sections[0].text == REAL_6_SAVINGS
    assert beside.sections[0].provision_status is None
    paired: dict = {}
    apply_harvest(paired, beside.sections)
    found = lookup_real_section(paired, "6")
    assert found is not None and found.text == REAL_6_SAVINGS
