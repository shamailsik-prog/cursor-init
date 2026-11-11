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
    assert "insertion of section 5A" in note
    assert "Amendment of section X.-" in note
    assert "sub-section" in note and "w.e.f." in note
    assert "50-div cap" in note
