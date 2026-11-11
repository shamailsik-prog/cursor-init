"""R-LENGTH-RESID-001 from extraction to the live-law list. Disposable Postgres only.

A PakistanCode page of numbered placeholders and real sections is harvested and
published. Placeholders keep their keys and raw text and are marked
``is_repealed``. ``list_statutes`` does not serve them. Real sections are served.
``statute_detail`` still returns the placeholder text. No live database is used.
"""

from __future__ import annotations

from types import SimpleNamespace

from test_f20_trust_policy_db import fetch, run

SOURCE = SimpleNamespace(source_name="PakistanCode")
SLUG = "resid001fx"
ACT = "Resid001 Placeholder Fixture Act 2099"
BODY = "1. Short title. This Act may be called the Resid001 Placeholder Fixture Act, 2099."
REPEAL = "2. Repeal. The Earlier Fixture Act, 1908, is hereby repealed."
OMITTED = "3. [Omitted.]"
STARS = "4. * * *"
REP_BY = "5. [Rep. by Ord. X of 1980]"
OMITTED_BY = "6. Omitted by the Finance Act, 1990 (X of 1990), s. 3."
REPEALED = "7. [Repealed]"
SAVINGS = (
    "8. Savings. Anything done under the repealed Act shall be deemed omitted "
    "from this Act only where a court so directs, and this section otherwise continues in force."
)
DIVS = (BODY, REPEAL, OMITTED, STARS, REP_BY, OMITTED_BY, REPEALED, SAVINGS)
LIVE = {"1", "2", "8"}
NON_LIVE = {"3": "omitted", "4": "omitted", "5": "repealed", "6": "omitted", "7": "repealed"}


def _page() -> str:
    divs = "".join(f"<div class='section'>{text}</div>" for text in DIVS)
    return f"<html><h1>{ACT}</h1>{divs}</html>"


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


def _publish():
    from sqlalchemy import select

    from scraper.database import SessionLocal
    from scraper.models import StatutesStaging
    from scraper.publication.retrieval import publish_statute

    async def _run():
        async with SessionLocal() as db:
            async with db.begin():
                rows = (await db.execute(
                    select(StatutesStaging)
                    .where(StatutesStaging.extracted_short_name == SLUG)
                    .order_by(StatutesStaging.created_at, StatutesStaging.extracted_section_number)
                )).scalars().all()
                return [await publish_statute(db, row, SOURCE) for row in rows]

    return run(_run())


def test_placeholders_are_stored_and_omitted_from_the_live_statute_list(corpus_db, monkeypatch):
    from scraper.public_corpus import list_statutes, statute_detail

    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    _install_pages(monkeypatch, {SLUG: _page()})
    _harvest()
    staged = run(fetch(
        "SELECT extracted_section_number, extracted_section_text, "
        "parsing_metadata->>'provision_status' "
        "FROM statutes_staging WHERE extracted_short_name = :slug "
        "ORDER BY extracted_section_number",
        slug=SLUG,
    ))
    assert [row[0] for row in staged] == [str(n) for n in range(1, 9)]
    assert [row[1] for row in staged] == list(DIVS)
    status = {row[0]: row[2] for row in staged}
    assert status["1"] is None and status["2"] is None and status["8"] is None
    assert {key: status[key] for key in NON_LIVE} == NON_LIVE
    published = _publish()
    assert len(published) == 8
    assert all(item.id is not None and item.withheld is False and item.stale is False for item in published)
    master = run(fetch(
        "SELECT id, section_number, section_text, is_repealed FROM statutes_master "
        "WHERE short_name = :slug ORDER BY section_number",
        slug=SLUG,
    ))
    assert len(master) == 8
    by_number = {row[1]: row for row in master}
    assert [row[1] for row in master] == [str(n) for n in range(1, 9)]
    for number, text in zip([str(n) for n in range(1, 9)], DIVS):
        assert by_number[number][2] == text
        assert by_number[number][3] is (number in NON_LIVE)
    page = run(list_statutes("Resid001", None, 20, include_repealed=False, timeout_ms=2000))
    served = {item.section_number for item in page.items}
    assert served == LIVE
    assert all(item.is_repealed is False for item in page.items)
    opted = run(list_statutes("Resid001", None, 20, include_repealed=True, timeout_ms=2000))
    assert {item.section_number for item in opted.items} == LIVE | set(NON_LIVE)
    detail = run(statute_detail(by_number["3"][0], timeout_ms=2000))
    assert detail is not None
    assert detail.section_number == "3"
    assert detail.section_text == OMITTED
    assert detail.is_repealed is True
    live = run(statute_detail(by_number["2"][0], timeout_ms=2000))
    assert live is not None
    assert live.section_text == REPEAL
    assert live.is_repealed is False
