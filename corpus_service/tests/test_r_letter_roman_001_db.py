"""R-LETTER-ROMAN-001 on a disposable Postgres database. No live DSN is read.

A lettered act publishes I, L, V and X as slugs. A roman act attaches a stored
schedule:i:* row to the new schedule:1 text and does not insert a second row.
A stored schedule:l:* row does not receive the First Schedule. A mixed act is
quarantined. Identical text under I and 1 stays two rows.
"""

from __future__ import annotations

from test_r_label_001_schedule_labels_db import (
    BODY,
    _gate_and_publish,
    _harvest,
    _install_pages,
    _master,
    _page,
    _seed,
)

from scraper.parsers.pakistancode_keys import normalise_div_text

SAME = "1. Identical item text that must not collapse I and 1 onto one copy key."
OTHER = "1. A different schedule item long enough to stay on its own row."
OLD_L = "1. Letter L as stored, which must not receive the First Schedule text."
OLD_FIRST = "1. First schedule text as stored before the later harvest."
NEW_FIRST = "1. First schedule text after a later harvest that must not land on L."
OLD_I = "1. Roman I as stored under the letter key before this harvest."
NEW_I = "1. Roman I after the act was harvested with schedule II beside it."


def test_lettered_schedules_publish_as_slugs_and_do_not_share_a_copy_key(corpus_db, monkeypatch):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    slug = "rletletter"
    blocks = [BODY]
    for heading, text in (
        ("Schedule A", OTHER),
        ("Schedule D", OTHER),
        ("Schedule I", SAME),
        ("Schedule L", OTHER),
        ("Schedule V", OTHER),
        ("Schedule X", OTHER),
        ("Schedule 1", SAME),
    ):
        blocks.extend((heading, text))
    _install_pages(monkeypatch, _page(slug, blocks))
    _harvest()
    outcomes = _gate_and_publish(slug)
    assert all(item[2] == "promoted" and item[3] == "embedded" for item in outcomes)
    master = {row[0]: row for row in _master(slug)}
    assert master["schedule:a:1"][1] == normalise_div_text(OTHER)
    assert master["schedule:i:1"][1] == normalise_div_text(SAME) and master["schedule:i:1"][2] is False
    assert master["schedule:l:1"][1] == normalise_div_text(OTHER) and master["schedule:l:1"][2] is False
    assert master["schedule:v:1"][2] is False and master["schedule:x:1"][2] is False
    assert master["schedule:1:1"][1] == normalise_div_text(SAME) and master["schedule:1:1"][2] is False
    assert master["schedule:d:1"][2] is False
    for key in master:
        assert "~" not in key
    assert "schedule:5:1" not in master and "schedule:10:1" not in master and "schedule:50:1" not in master


def test_pure_roman_harvest_attaches_a_stored_i_row(corpus_db, monkeypatch):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    slug = "rletroman1"
    _seed(slug, [
        ("1", BODY),
        ("schedule-heading:i", "SCHEDULE I"),
        ("schedule:i:1", OLD_I),
    ])
    _install_pages(monkeypatch, _page(slug, [BODY, "SCHEDULE I", NEW_I, "SCHEDULE II", OTHER, "SCHEDULE XII", OTHER]))
    _harvest()
    outcomes = _gate_and_publish(slug)
    assert all(item[3] == "embedded" for item in outcomes)
    master = {row[0]: row for row in _master(slug)}
    assert "schedule:1:1" not in master
    assert "schedule-heading:1" not in master
    assert master["schedule:i:1"][1] == normalise_div_text(NEW_I) and master["schedule:i:1"][2] is False
    assert master["schedule-heading:i"][1] == "SCHEDULE I" and master["schedule-heading:i"][2] is False
    assert master["schedule:2:1"][1] == normalise_div_text(OTHER) and master["schedule:2:1"][2] is False
    assert master["schedule:12:1"][1] == normalise_div_text(OTHER) and master["schedule:12:1"][2] is False
    assert master["1"][2] is False


def test_mixed_act_is_quarantined_and_retires_nothing(corpus_db, monkeypatch):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    slug = "rletmixed1"
    _seed(slug, [("1", BODY), ("schedule:l:1", OLD_L)])
    _install_pages(monkeypatch, _page(slug, [BODY, "Schedule A", OTHER, "SCHEDULE II", OTHER]))
    _harvest()
    outcomes = _gate_and_publish(slug)
    by_key = {item[0]: item for item in outcomes}
    assert by_key["1"][2] == "promoted" and by_key["1"][3] == "embedded"
    refused = [item for item in outcomes if item[0] != "1"]
    assert refused
    assert all(item[2] == "quarantined" and item[3] is None for item in refused)
    assert all(item[4] == "schedule_letter_roman_ambiguous" for item in refused)
    assert all(not str(item[0]).startswith("schedule:") for item in refused)
    master = {row[0]: row for row in _master(slug)}
    assert master["1"][1] == normalise_div_text(BODY) and master["1"][2] is False
    assert master["schedule:l:1"][1] == normalise_div_text(OLD_L) and master["schedule:l:1"][2] is False
    assert normalise_div_text(OTHER) not in {row[1] for row in master.values()}


def test_stored_schedule_l_does_not_receive_the_first_schedule(corpus_db, monkeypatch):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    slug = "rletstorel"
    _seed(slug, [
        ("1", BODY),
        ("schedule:1:1", OLD_FIRST),
        ("schedule:l:1", OLD_L),
    ])
    _install_pages(monkeypatch, _page(slug, [BODY, "Schedule 1", NEW_FIRST]))
    _harvest()
    outcomes = _gate_and_publish(slug)
    assert all(item[3] == "embedded" for item in outcomes)
    master = {row[0]: row for row in _master(slug)}
    assert master["schedule:1:1"][1] == normalise_div_text(NEW_FIRST)
    assert master["schedule:l:1"][1] == normalise_div_text(OLD_L)
    assert master["schedule:l:1"][1] != master["schedule:1:1"][1]
    assert master["schedule:l:1"][0] == "schedule:l:1"
    assert master["schedule:l:1"][2] is True
