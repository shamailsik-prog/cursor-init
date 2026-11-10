"""FA-17 on a disposable Postgres database. No live or staging DSN is read.

Schedule items are master rows under ``schedule:L:N``. A schedule-only harvest
does not repeal body sections. An unscoped div stays quarantined. A heading-only
schedule does not invent a section and does not retire one. Migration 009 runs
only against the database this fixture creates.
"""

from __future__ import annotations

import json
from collections import Counter

from test_f20_trust_policy_db import fetch, run

from scraper.parsers.pakistancode_keys import content_token, key_div_texts, normalise_div_text, schedule_container_label

BODY_1 = "1. Short title of the schedule fixture act, long enough to store."
BODY_2 = "2. Definitions in the schedule fixture act, stored before any schedule."
BODY_3 = "3. Extent of the schedule fixture act, which a schedule harvest must keep."
ALPHA = "1. Alpha conveyance duty in the first schedule stays its own row."
BETA = "1. Beta conveyance duty in the first schedule is not merged into alpha."
SAME = "3. Same form text in the first schedule is kept twice here."
MORTGAGE = "1. Mortgage duty in the second schedule repeats item 1 under another parent."
MORTGAGE_AMENDED = "1. Mortgage duty in the second schedule was amended and keeps schedule:second:1."
FLAT = "1. Flat item after a heading that precedes every body section."
HEADING = "THE FIRST SCHEDULE"
SEEDED = "1. Seeded body section that a heading-only schedule must not repeal."
T_SEED = "2026-11-01T00:00:00+00:00"
T_AMEND = "2026-12-01T00:00:00+00:00"


def _item_key(label, number, text, repeated, copy=1):
    stored = normalise_div_text(text)
    base = f"schedule:{label}:{number}"
    if repeated:
        base = f"{base}-{content_token(stored)}"
    if copy > 1:
        base = f"{base}~{copy}"
    return base


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
    from scraper.tasks import lifecycle
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
                        row.quarantine_reason,
                    ))
                return outcomes

    return run(_run())


def _master(short_name):
    return run(fetch(
        "SELECT section_number, section_text, is_repealed FROM statutes_master "
        "WHERE short_name = :name ORDER BY section_number",
        name=short_name,
    ))


def _seed_section(short_name, text):
    from types import SimpleNamespace

    from scraper.database import SessionLocal
    from scraper.models import StatutesStaging
    from scraper.publication.retrieval import publish_statute

    async def _run():
        async with SessionLocal() as db:
            async with db.begin():
                row = StatutesStaging(
                    source_site="PakistanCode",
                    source_url="https://pakistancode.gov.pk/english/statues/details/" + short_name,
                    extracted_act_name="FA-17 Fixture Act",
                    extracted_short_name=short_name,
                    extracted_section_number="1",
                    extracted_section_title="Fixture",
                    extracted_section_text=text,
                    raw_text=text,
                    confidence_score=0.85,
                    parsing_metadata={
                        "act_keys": ["1"],
                        "harvest_at": T_SEED,
                        "section_kind": "section",
                        "keying": "fa-f21-017",
                        "source_name": "PakistanCode",
                    },
                )
                db.add(row)
                published = await publish_statute(db, row, SimpleNamespace(source_name="PakistanCode"))
                await db.delete(row)
                return published

    return run(_run())


def _schedule_html():
    blocks = []
    for heading, items in (
        ("THE FIRST SCHEDULE", [ALPHA, BETA, SAME, SAME]),
        ("THE SECOND SCHEDULE", [MORTGAGE]),
    ):
        divs = "".join(f"<div class='section'>{item}</div>" for item in items)
        blocks.append(f"<div class='schedule'><h2>{heading}</h2>{divs}</div>")
    return "<html><h1>Schedule Fixture Act</h1>" + "".join(blocks) + "</html>"


def _expected_schedule_keys():
    return [
        _item_key("first", "1", ALPHA, True),
        _item_key("first", "1", BETA, True),
        _item_key("first", "3", SAME, True, 1),
        _item_key("first", "3", SAME, True, 2),
        _item_key("second", "1", MORTGAGE, False),
    ]


def test_fa_17_multi_schedule_items_publish_without_retiring_body(corpus_db, monkeypatch):
    """A later schedule harvest stores every item and leaves sections 1, 2 and 3 in force."""
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    slug = "schedact01"
    body = (
        "<html><h1>Schedule Fixture Act</h1>"
        f"<div class='section'>{BODY_1}</div>"
        f"<div class='section'>{BODY_2}</div>"
        f"<div class='section'>{BODY_3}</div>"
        "</html>"
    )
    _install_pages(monkeypatch, {slug: body})
    _harvest()
    schedule = _schedule_html()
    _install_pages(monkeypatch, {slug: schedule})
    _harvest()

    from bs4 import BeautifulSoup

    nodes = BeautifulSoup(schedule, "html.parser").find_all("div", class_="section")
    containers = [schedule_container_label(node) for node in nodes]
    assert containers == ["first", "first", "first", "first", "second"]
    expected = _expected_schedule_keys()
    assert [item.key for item in key_div_texts(
        [node.get_text(" ", strip=True) for node in nodes], containers,
    ).sections] == expected

    staged = run(fetch(
        "SELECT extracted_section_number, extracted_section_text, parsing_metadata->>'section_kind', "
        "parsing_metadata->>'act_keys' "
        "FROM statutes_staging WHERE extracted_short_name = :name "
        "ORDER BY created_at, extracted_section_number",
        name=slug,
    ))
    body_rows = [row for row in staged if row[2] == "section"]
    item_rows = [row for row in staged if row[2] == "schedule-item"]
    assert [row[0] for row in body_rows] == ["1", "2", "3"]
    assert [json.loads(row[3]) for row in body_rows] == [["1", "2", "3"]] * 3
    assert sorted(row[0] for row in item_rows) == sorted(expected)
    assert [json.loads(row[3]) for row in item_rows] == [expected] * 5
    assert Counter(row[1] for row in item_rows) == Counter([ALPHA, BETA, SAME, SAME, MORTGAGE])

    outcomes = _gate_and_publish(slug)
    assert [(kind, decision, state) for _key, kind, decision, state, _reason in outcomes] == (
        [("section", "promoted", "embedded")] * 3 + [("schedule-item", "promoted", "embedded")] * 5
    )
    master = _master(slug)
    assert len(master) == 8
    by_key = {row[0]: row for row in master}
    assert by_key["1"][1] == BODY_1 and by_key["1"][2] is False
    assert by_key["2"][1] == BODY_2 and by_key["2"][2] is False
    assert by_key["3"][1] == BODY_3 and by_key["3"][2] is False
    for key, text in zip(expected, [ALPHA, BETA, SAME, SAME, MORTGAGE]):
        assert by_key[key][1] == text and by_key[key][2] is False
        assert key != "1" and not key.startswith("unscoped:")
    assert run(fetch(
        "SELECT count(*) FROM quarantine_queue WHERE reason = 'ambiguous_section_identity'"
    ))[0][0] == 0

    from types import SimpleNamespace

    from scraper.database import SessionLocal
    from scraper.models import StatutesStaging
    from scraper.publication.retrieval import publish_statute

    async def _amend():
        async with SessionLocal() as db:
            async with db.begin():
                row = StatutesStaging(
                    source_site="PakistanCode",
                    source_url="https://pakistancode.gov.pk/english/statues/details/" + slug,
                    extracted_act_name="Schedule Fixture Act",
                    extracted_short_name=slug,
                    extracted_section_number="schedule:second:1",
                    extracted_section_title="Fixture",
                    extracted_section_text=MORTGAGE_AMENDED,
                    raw_text=MORTGAGE_AMENDED,
                    confidence_score=0.85,
                    parsing_metadata={
                        "act_keys": expected,
                        "harvest_at": T_AMEND,
                        "section_kind": "schedule-item",
                        "keying": "fa-f21-017",
                        "source_name": "PakistanCode",
                    },
                )
                db.add(row)
                return await publish_statute(db, row, SimpleNamespace(source_name="PakistanCode"))

    amended = run(_amend())
    assert amended.withheld is False and amended.attached is True and amended.changed is True
    master = _master(slug)
    assert len(master) == 8
    by_key = {row[0]: row for row in master}
    assert by_key["schedule:second:1"][1] == MORTGAGE_AMENDED and by_key["schedule:second:1"][2] is False
    assert by_key["1"][2] is False and by_key["2"][2] is False and by_key["3"][2] is False
    assert by_key[_item_key("first", "1", ALPHA, True)][1] == ALPHA
    assert by_key[_item_key("first", "3", SAME, True, 2)][1] == SAME


def test_fa_17_heading_only_schedule_does_not_retire_body_or_invent_items(corpus_db, monkeypatch):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    slug = "headschd01"
    seeded = _seed_section(slug, SEEDED)
    assert seeded.withheld is False and seeded.id is not None
    _install_pages(monkeypatch, {
        slug: f"<html><h1>The Stamp Act, 1899</h1><div class='section'>{HEADING}</div></html>",
    })
    _harvest()
    staged = run(fetch(
        "SELECT extracted_section_number, extracted_section_text, "
        "(parsing_metadata -> 'act_keys') IS NULL "
        "FROM statutes_staging WHERE extracted_short_name = :name",
        name=slug,
    ))
    assert staged == [("schedule-heading:first", HEADING, True)]
    outcomes = _gate_and_publish(slug)
    assert outcomes == [("schedule-heading:first", "schedule-heading", "promoted", "embedded", None)]
    master = _master(slug)
    assert {(row[0], row[1], row[2]) for row in master} == {
        ("1", SEEDED, False),
        ("schedule-heading:first", HEADING, False),
    }


def test_fa_17_unscoped_div_is_quarantined_and_does_not_retire_body(corpus_db, monkeypatch):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    slug = "unscope001"
    seeded = _seed_section(slug, SEEDED)
    assert seeded.withheld is False and seeded.id is not None
    _install_pages(monkeypatch, {
        slug: (
            "<html><h1>Unscoped Fixture Act</h1>"
            f"<div class='section'>{HEADING}</div>"
            f"<div class='section'>{FLAT}</div>"
            "</html>"
        ),
    })
    _harvest()
    staged = run(fetch(
        "SELECT extracted_section_number, extracted_section_text, parsing_metadata->>'section_kind', "
        "(parsing_metadata -> 'act_keys') IS NULL "
        "FROM statutes_staging WHERE extracted_short_name = :name "
        "ORDER BY created_at, extracted_section_number",
        name=slug,
    ))
    assert len(staged) == 2
    assert staged[0][0] == "schedule-heading:first" and staged[0][2] == "schedule-heading" and staged[0][3] is True
    assert staged[1][1] == FLAT and staged[1][2] == "unscoped" and staged[1][0].startswith("unscoped:1-")
    assert staged[1][3] is True
    outcomes = _gate_and_publish(slug)
    assert outcomes[0] == ("schedule-heading:first", "schedule-heading", "promoted", "embedded", None)
    assert outcomes[1][1] == "unscoped" and outcomes[1][2] == "quarantined" and outcomes[1][3] is None
    assert outcomes[1][4] == "ambiguous_section_identity"
    master = _master(slug)
    assert [row[0] for row in master] == ["1", "schedule-heading:first"]
    assert master[0][1] == SEEDED and master[0][2] is False
    assert all(not str(row[0]).startswith("unscoped:") for row in master)
    kept = run(fetch(
        "SELECT extracted_section_text FROM statutes_staging "
        "WHERE extracted_short_name = :name AND parsing_metadata->>'section_kind' = 'unscoped'",
        name=slug,
    ))
    assert kept == [(FLAT,)]
