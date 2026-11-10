"""FA-F21-019 on a disposable Postgres database. No live or staging DSN is read.

The harvester used to store one row when two paragraphs shared a section number, so
the second text never reached ``statutes_master``. A heading-only page used to run
the splitter and could publish the act title over an existing section 1. Neither
happens here. Migrations run only against the fixture database this test creates.
"""

from __future__ import annotations

from types import SimpleNamespace

from test_f20_trust_policy_db import fetch, run

HEADING = "THE FIRST SCHEDULE"
ALPHA = "1. Alpha paragraph is longer than twenty characters for the parser."
BETA = "1. Beta paragraph is also longer than twenty characters and a duplicate number."
SOURCE = SimpleNamespace(source_name="PakistanCode")


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


def _publish_short_name(short_name):
    from sqlalchemy import select

    from scraper.database import SessionLocal
    from scraper.models import StatutesStaging
    from scraper.publication.retrieval import publish_statute

    async def _run():
        async with SessionLocal() as db:
            async with db.begin():
                rows = (await db.execute(
                    select(StatutesStaging)
                    .where(StatutesStaging.extracted_short_name == short_name)
                    .order_by(StatutesStaging.created_at, StatutesStaging.extracted_section_number)
                )).scalars().all()
                return [await publish_statute(db, row, SOURCE) for row in rows]

    return run(_run())


def test_fa_f21_019_repeated_paragraph_text_is_published(corpus_db, monkeypatch):
    """Both paragraphs are stored and published. The old splitter left one staging row."""
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    _install_pages(monkeypatch, {
        "duppara01": f"<html><h1>F21 Paragraph Fixture</h1><p>{ALPHA}</p><p>{BETA}</p></html>",
    })
    _harvest()
    staged = run(fetch(
        "SELECT extracted_section_number, extracted_section_text, parsing_metadata->>'act_keys' "
        "FROM statutes_staging WHERE extracted_short_name = 'duppara01' "
        "ORDER BY created_at, extracted_section_number"
    ))
    assert len(staged) == 2
    blob = " ".join(row[1] for row in staged)
    assert "Alpha paragraph" in blob and "Beta paragraph" in blob
    keys = [row[0] for row in staged]
    assert len(set(keys)) == 2
    assert all(key != "1" and key.startswith("1-") for key in keys)
    assert all(row[2] for row in staged)
    published = _publish_short_name("duppara01")
    assert len(published) == 2
    assert all(item.withheld is False and item.stale is False and item.id is not None for item in published)
    master = run(fetch(
        "SELECT section_number, section_text, is_repealed FROM statutes_master "
        "WHERE short_name = 'duppara01' ORDER BY section_number"
    ))
    assert len(master) == 2
    master_blob = " ".join(row[1] for row in master)
    assert "Alpha paragraph" in master_blob and "Beta paragraph" in master_blob
    assert all(row[2] is False for row in master)
    assert {row[0] for row in master} == set(keys)


def test_fa_f21_019_heading_only_page_does_not_publish_a_spurious_section(corpus_db, monkeypatch):
    """The act title beside a schedule heading is not staged or published as section 1."""
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    _install_pages(monkeypatch, {
        "headonly1": f"<html><h1>The Stamp Act, 1899</h1><div class='section'>{HEADING}</div></html>",
    })
    _harvest()
    staged = run(fetch(
        "SELECT extracted_section_number, extracted_section_text, "
        "(parsing_metadata -> 'act_keys') IS NULL "
        "FROM statutes_staging WHERE extracted_short_name = 'headonly1'"
    ))
    assert staged == [("schedule-heading:1", HEADING, True)]
    published = _publish_short_name("headonly1")
    assert len(published) == 1 and published[0].withheld is False and published[0].id is not None
    master = run(fetch(
        "SELECT section_number, section_text, is_repealed FROM statutes_master "
        "WHERE short_name = 'headonly1' ORDER BY section_number"
    ))
    assert master == [("schedule-heading:1", HEADING, False)]
