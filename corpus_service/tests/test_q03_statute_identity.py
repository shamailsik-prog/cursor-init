"""Q03 statute identity, in memory.

The probe at fa2f43e7 (prefixes 39fb5ae8, 1f179665, 6d32f751) retired a repeated
number and inserted new keys. Those strings are not in this repo. This file uses
its own synthetic texts and ``content_token`` of those texts. After the fix, the
object at ``2`` moves to ``2-<sha8>`` and back to ``2``, and versions accumulate
on that object.
"""

from __future__ import annotations

from itertools import permutations

from scraper.parsers.pakistancode_keys import (
    PublishedSection,
    apply_harvest,
    content_token,
    key_div_texts,
    note_section_version,
    pair_renumbered_identities,
)

ONE = "1. Q03 synthetic section one stays in place for the identity probe and is long enough."
B = "2. Q03 synthetic member B. This stable body is the section that must keep its row."
C = "2. Q03 synthetic member C. This second body appears when section two is repeated."
C2 = "2. Q03 synthetic member C2. This replaces member C and must stay on member C's row."


def _token(text: str) -> str:
    return content_token(text)


def _sha(number: str, text: str) -> str:
    return f"{number}-{_token(text)}"


def test_pair_renumbered_identities_rules_and_permutations():
    bare = "2"
    same = "Q03 synthetic identical body for a unique text match."
    other = "Q03 synthetic other body that shares no text with the stored row."
    changed = "Q03 synthetic amended body for the single remaining member."
    prior = {bare: same, _sha("2", other): other}
    live = [(_sha("2", same), same), (_sha("2", changed), changed)]
    # (c) the identical text pairs both ways. (d) the one remaining member then pairs.
    assert pair_renumbered_identities(prior, live) == {
        _sha("2", same): bare,
        _sha("2", changed): _sha("2", other),
    }

    # (e) two changed members, a count mismatch, and a cross-base text match pair nothing.
    both = {
        _sha("2", same): same,
        _sha("2", other): other,
    }
    assert pair_renumbered_identities(both, [(_sha("2", changed), changed), (_sha("2", "x"), "x")]) == {}
    assert pair_renumbered_identities({bare: same}, [(_sha("2", other), other), (_sha("2", changed), changed)]) == {}
    assert pair_renumbered_identities({"2": same}, [("3", same)]) == {}

    # An identical text that is not unique in either direction does not pair.
    tied_prior = {_sha("2", "a"): same, _sha("2", "b"): same}
    assert pair_renumbered_identities(tied_prior, [(_sha("2", "c"), same)]) == {}
    assert pair_renumbered_identities({bare: same}, [(_sha("2", "a"), same), (_sha("2", "b"), same)]) == {}

    # (b) copies and the excluded key kinds are not bases.
    excluded = [
        "2~2",
        "unscoped:2-aaaaaaaa",
        "ambiguous-aaaaaaaa",
        "preamble-aaaaaaaa",
        "explanation-aaaaaaaa",
        "div-aaaaaaaa",
        "unresolved-schedule:1:2",
        "schedule-heading:1",
    ]
    for key in excluded:
        assert pair_renumbered_identities({key: same}, [(f"{key}-extra", same)]) == {}

    # (a) a schedule item and its content-addressed form share a base. Label aliases do too.
    schedule_text = "4. Q03 synthetic schedule item whose token form continues the stored item."
    stored_schedule = "schedule:first:4"
    live_schedule = f"schedule:1:4-{_token(schedule_text)}"
    assert pair_renumbered_identities(
        {stored_schedule: schedule_text}, [(live_schedule, schedule_text)],
    ) == {live_schedule: stored_schedule}
    letter = "schedule:i:4"
    numbered = f"schedule:1:4-{_token(schedule_text)}"
    assert pair_renumbered_identities({letter: schedule_text}, [(numbered, schedule_text)]) == {}
    assert pair_renumbered_identities(
        {letter: schedule_text}, [(numbered, schedule_text)], label_mode="roman",
    ) == {numbered: letter}

    # Order is not an input. Every ordering of a three-member base yields one map.
    members = {
        _sha("4", "A"): "A",
        _sha("4", "B"): "B",
        _sha("4", "C"): "C",
    }
    incoming = [
        (_sha("4", "A"), "A"),
        (_sha("4", "B"), "B"),
        (_sha("4", "D"), "D"),
    ]
    expected = {
        _sha("4", "A"): _sha("4", "A"),
        _sha("4", "B"): _sha("4", "B"),
        _sha("4", "D"): _sha("4", "C"),
    }
    seen = set()
    for prior_order in permutations(members):
        for live_order in permutations(incoming):
            got = pair_renumbered_identities(
                {key: members[key] for key in prior_order}, list(live_order),
            )
            seen.add(tuple(sorted(got.items())))
    assert seen == {tuple(sorted(expected.items()))}


def test_apply_harvest_keeps_one_object_across_the_probe_sequence():
    store: dict = {}
    first = apply_harvest(store, key_div_texts([ONE, B]).sections)
    assert first.inserted == ["1", "2"]
    row_b = store["2"]
    assert row_b.versions == [row_b.text]

    second_keyed = key_div_texts([ONE, B, C])
    by_text = {section.text: section.key for section in second_keyed.sections}
    key_b = by_text[row_b.text]
    key_c = next(section.key for section in second_keyed.sections if section.key not in {"1", key_b})
    second = apply_harvest(store, second_keyed.sections)
    assert store[key_b] is row_b and row_b.retired is False and row_b.key == key_b
    assert "2" not in store
    assert second.inserted == [key_c]
    assert key_b not in second.retired
    row_c = store[key_c]
    assert row_c.versions == [row_c.text]

    third_keyed = key_div_texts([ONE, B, C2])
    key_c2 = next(section.key for section in third_keyed.sections if section.key not in {"1", key_b})
    prior_c = row_c.text
    third = apply_harvest(store, third_keyed.sections)
    assert store[key_c2] is row_c and row_c.key == key_c2 and row_c.retired is False
    assert row_c.versions == [prior_c, row_c.text]
    assert row_c.text != prior_c
    assert store[key_b] is row_b and row_b.retired is False
    assert key_c not in store

    fourth = apply_harvest(store, key_div_texts([ONE, B]).sections)
    assert store["2"] is row_b and row_b.retired is False and row_b.key == "2"
    assert row_c.retired is True and row_c.key == key_c2
    assert key_b not in fourth.retired
    assert all(not row.retired for key, row in store.items() if key in {"1", "2"})


def test_note_section_version_uses_an_explicit_prior_and_keeps_the_old_default():
    amended = note_section_version({"keying": "q03"}, "before", "after", prior_version=2)
    assert amended["section_version"] == 3
    assert len(amended["prior_section_text_sha256"]) == 64
    assert amended["keying"] == "q03"
    historical = note_section_version({"keying": "q03"}, "before", "after")
    assert historical["section_version"] == 2
    assert note_section_version({"section_version": 4}, "same", "same", prior_version=9) == {"section_version": 4}


def test_apply_harvest_does_not_rename_a_stored_schedule_label_alias():
    """``schedule:first:1`` and ``schedule:1:1`` are one identity. The stored key stays."""
    from scraper.parsers.pakistancode_keys import KeyedDiv

    text = "1. Stamp duty on a Q03 synthetic instrument, long enough to be a schedule item."
    stored = PublishedSection(
        key="schedule:first:1", text=text, kind="schedule-item", lookup_number=None, versions=[text],
    )
    store = {"schedule:first:1": stored}
    alias = KeyedDiv(
        key="schedule:1:1", text=text, title=None, kind="schedule-item", lookup_number=None, schedule_label="1",
    )
    apply_harvest(store, [alias])
    assert list(store) == ["schedule:first:1"]
    assert store["schedule:first:1"] is stored
    assert stored.retired is False
    assert stored.text == text
