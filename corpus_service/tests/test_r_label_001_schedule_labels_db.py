"""R-LABEL-001 on a disposable Postgres database. No live or staging DSN is read.

A harvest that spells a schedule differently attaches to the stored schedule:L:* row.
It does not insert a second row and it does not repeal the first. A named schedule and a
numbered schedule stay separate. An ambiguous heading is not published as a schedule.
Migration 009 runs only against the database this fixture creates.
"""

from __future__ import annotations

from datetime import datetime, timezone

from test_f20_trust_policy_db import fetch, run

from scraper.parsers.pakistancode_keys import normalise_div_text

BODY = "1. Short title of the label fixture act, long enough to store as the body."
OLD_ITEM = "1. Stamp duty as first harvested under the word label of this schedule."
NEW_ITEM = "1. Stamp duty after the same schedule was re-read as a roman numeral."
OTHER_ITEM = "1. The other stored spelling of item 1, which must not be overwritten."
NAMED_ITEM = "1. Named schedule item long enough to remain under schedule A."
NUMBERED_ITEM = "1. Numbered schedule item long enough to remain under schedule 1."
AMBIGUOUS_ITEM = "1. Item after an ambiguous heading must stay a body section."
SEEDED_AT = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _install_pages(monkeypatch, pages):
    from scraper.net import fetch_policy
    from scraper.tasks import pakistancode

    class _Resp:
        def __init__(self, body, status=200):
            self.status_code = status
            self.text = body

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, *args, **kwargs):
            for slug, page in pages.items():
                if url.endswith("/" + slug):
                    return _Resp(page)
            if url.endswith("/federal"):
                return _Resp("<html></html>")
            return _Resp("missing", status=404)

    async def _asleep():
        return None

    monkeypatch.setattr(fetch_policy, "fetcher_for", lambda *args, **kwargs: _Client())
    monkeypatch.setattr(pakistancode, "TARGET_SLUGS", list(pages))
    monkeypatch.setattr(pakistancode.asyncio, "sleep", lambda *args, **kwargs: _asleep())


def _page(slug, blocks):
    divs = "".join(f"<div class='section'>{text}</div>" for text in blocks)
    return {slug: f"<html><h1>R Label Fixture Act</h1>{divs}</html>"}


def _harvest():
    from sqlalchemy import select

    from scraper.database import SessionLocal
    from scraper.models import ScraperSource
    from scraper.tasks import pakistancode

    async def _run():
        async with SessionLocal() as db:
            source = (await db.execute(
                select(ScraperSource).where(ScraperSource.source_name == "PakistanCode")
            )).scalar_one()
            await pakistancode.scrape_pakistancode(source, db)

    run(_run())


def _gate_and_publish(short_name):
    from sqlalchemy import select

    from scraper.database import SessionLocal
    from scraper.models import StatutesStaging
    from scraper.tasks.promotion import gate
    from scraper.tasks.publish import publish

    async def _run():
        async with SessionLocal() as db:
            async with db.begin():
                rows = (await db.execute(
                    select(StatutesStaging)
                    .where(StatutesStaging.extracted_short_name == short_name)
                    .order_by(StatutesStaging.created_at, StatutesStaging.extracted_section_number)
                )).scalars().all()
                outcomes = []
                for row in rows:
                    decision = await gate(db, row)
                    state = await publish(db, row) if decision == "promoted" else None
                    outcomes.append((
                        row.extracted_section_number,
                        (row.parsing_metadata or {}).get("section_kind"),
                        decision,
                        state,
                        row.state_reason,
                    ))
                return outcomes

    return run(_run())


def _master(short_name):
    return run(fetch(
        "SELECT section_number, section_text, is_repealed FROM statutes_master "
        "WHERE short_name = :name ORDER BY section_number",
        name=short_name,
    ))


def _seed(short_name, rows):
    from scraper.database import SessionLocal
    from scraper.models import StatutesMaster

    async def _run():
        async with SessionLocal() as db:
            async with db.begin():
                for key, text in rows:
                    db.add(StatutesMaster(
                        statute_name="R Label Fixture Act",
                        short_name=short_name,
                        section_number=key,
                        section_title="Fixture",
                        section_text=normalise_div_text(text),
                        source_site="PakistanCode",
                        source_url="https://pakistancode.gov.pk/english/statues/details/" + short_name,
                        confidence_score=0.85,
                        harvest_at=SEEDED_AT,
                        is_repealed=False,
                    ))

    run(_run())


def test_rename_across_harvests_leaves_no_orphan_and_no_duplicate(corpus_db, monkeypatch):
    """schedule:first:1 stays the only item row when the next harvest says SCHEDULE I."""
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    slug = "rlabrename"
    _seed(slug, [
        ("1", BODY),
        ("schedule-heading:first", "THE FIRST SCHEDULE"),
        ("schedule:first:1", OLD_ITEM),
    ])
    _install_pages(monkeypatch, _page(slug, [BODY, "SCHEDULE I", NEW_ITEM]))
    _harvest()
    outcomes = _gate_and_publish(slug)
    assert [item[3] for item in outcomes] == ["embedded", "embedded", "embedded"]
    assert [item[4] for item in outcomes] == [None, None, None]
    master = _master(slug)
    by_key = {row[0]: row for row in master}
    assert set(by_key) == {"1", "schedule-heading:first", "schedule:first:1"}
    assert by_key["1"][1] == normalise_div_text(BODY) and by_key["1"][2] is False
    assert by_key["schedule:first:1"][1] == normalise_div_text(NEW_ITEM) and by_key["schedule:first:1"][2] is False
    assert by_key["schedule-heading:first"][1] == "SCHEDULE I" and by_key["schedule-heading:first"][2] is False
    assert all(not str(key).startswith("schedule:i:") for key in by_key)
    assert "schedule:1:1" not in by_key
    assert "schedule-heading:1" not in by_key
    assert len([row for row in master if row[2] is False]) == 3


def test_two_stored_spellings_are_not_merged_or_repealed(corpus_db, monkeypatch):
    """Fail closed when schedule:first:1 and schedule:i:1 both already exist."""
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    slug = "rlabconfli"
    _seed(slug, [
        ("1", BODY),
        ("schedule:first:1", OLD_ITEM),
        ("schedule:i:1", OTHER_ITEM),
    ])
    _install_pages(monkeypatch, _page(slug, [BODY, "Schedule 1", NEW_ITEM]))
    _harvest()
    outcomes = _gate_and_publish(slug)
    by_outcome = {item[0]: item for item in outcomes}
    assert by_outcome["schedule:1:1"][2] == "promoted"
    assert by_outcome["schedule:1:1"][3] == "dead_letter"
    assert by_outcome["schedule:1:1"][4] == "schedule_label_alias_conflict"
    master = {row[0]: row for row in _master(slug)}
    assert master["1"][1] == normalise_div_text(BODY) and master["1"][2] is False
    assert master["schedule:first:1"][1] == normalise_div_text(OLD_ITEM) and master["schedule:first:1"][2] is False
    assert master["schedule:i:1"][1] == normalise_div_text(OTHER_ITEM) and master["schedule:i:1"][2] is False
    assert "schedule:1:1" not in master
    assert normalise_div_text(NEW_ITEM) not in {row[1] for row in master.values()}


def test_named_schedule_and_numbered_schedule_both_publish(corpus_db, monkeypatch):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    slug = "rlabnamed1"
    _install_pages(monkeypatch, _page(slug, [
        BODY, "Schedule A", NAMED_ITEM, "Tariff Schedule", "Schedule 1", NUMBERED_ITEM,
    ]))
    _harvest()
    outcomes = _gate_and_publish(slug)
    assert [item[3] for item in outcomes] == ["embedded"] * len(outcomes)
    master = {row[0]: row for row in _master(slug)}
    assert master["1"][1] == normalise_div_text(BODY) and master["1"][2] is False
    assert master["schedule:a:1"][1] == normalise_div_text(NAMED_ITEM) and master["schedule:a:1"][2] is False
    assert master["schedule-heading:a"][1] == "Schedule A" and master["schedule-heading:a"][2] is False
    assert master["schedule-heading:tariff"][1] == "Tariff Schedule"
    assert master["schedule:1:1"][1] == normalise_div_text(NUMBERED_ITEM) and master["schedule:1:1"][2] is False
    assert master["schedule-heading:1"][1] == "Schedule 1"
    assert master["schedule:a:1"][0] != master["schedule:1:1"][0]
    assert len(master) == 6


def test_ambiguous_heading_is_not_published_as_a_schedule(corpus_db, monkeypatch):
    """Schedule ll is not roman two and not eleven. The following item stays a body section."""
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    slug = "rlabambig1"
    _install_pages(monkeypatch, _page(slug, [BODY, "Schedule ll", AMBIGUOUS_ITEM]))
    _harvest()
    staged = run(fetch(
        "SELECT extracted_section_number, parsing_metadata->>'section_kind' "
        "FROM statutes_staging WHERE extracted_short_name = :name ORDER BY extracted_section_number",
        name=slug,
    ))
    assert staged
    assert all(not str(key).startswith("schedule:") for key, _kind in staged)
    assert all(not str(key).startswith("schedule-heading:") for key, _kind in staged)
    assert all(kind != "unscoped" for _key, kind in staged)
    outcomes = _gate_and_publish(slug)
    assert all(item[2] == "promoted" and item[3] == "embedded" for item in outcomes)
    master = _master(slug)
    assert len(master) == 2
    assert all(not str(row[0]).startswith("schedule") for row in master)
    assert all(row[2] is False for row in master)
    # Both divs are numbered 1, so #229 keeps each under its own content key.
    assert {row[1] for row in master} == {normalise_div_text(BODY), normalise_div_text(AMBIGUOUS_ITEM)}
    assert all(row[0] != "1" and row[0].startswith("1-") for row in master)
