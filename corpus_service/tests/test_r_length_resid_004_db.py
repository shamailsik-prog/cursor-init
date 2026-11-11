"""R-LENGTH-RESID-004 from harvest to the live statute list. Disposable Postgres only.

One Act page carries a long citation footnote and the real section of the same
number, footnote first and footnote last. Publish serves the real body. The
footnote is not staged and is not served. A second page of only those notes
stages nothing. No live database is used.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from test_f20_trust_policy_db import fetch, run

SOURCE = SimpleNamespace(source_name="PakistanCode")
SLUG = "resid004fx"
NOTES = "resid004nt"
ACT = "Resid004 Footnote Fixture Act 2099"
NOTES_ACT = "Resid004 Notes Only Act 2099"
REAL_1 = (
    "1. Short title. This Act may be called the Resid004 Footnote Fixture Act, 2099, "
    "and it extends to Pakistan."
)
SUBS = "1. Subs. by the Finance Act, 1991 (XII of 1991), s. 3."
INS = "3. Ins. by Ord. XXV of 1980, s. 2"
REAL_3 = (
    "3. Definitions. In this Act, words and expressions have the meanings "
    "given in this section and in no other."
)
AMEND = (
    "4. Amendment of section 4.- In section 4, for the word tax the word duty "
    "shall be substituted and the registrar shall record the change in the roll."
)
OMITTED_BY = "5. Omitted by the Finance Act, 1990 (X of 1990), s. 3."
REAL_6 = (
    "6. Added duties of the registrar are to keep the roll and to certify "
    "a copy on payment of the prescribed fee."
)
ADDED = "6. Added by Act II of 2001."
FOR_WORDS = '1. Subs. by Ord. No. XXV of 2001, s. 2, for "words"'
DIVS = (REAL_1, SUBS, INS, REAL_3, AMEND, OMITTED_BY, REAL_6, ADDED, FOR_WORDS)
KEPT = (REAL_1, REAL_3, AMEND, OMITTED_BY, REAL_6)
LIVE = {"1": REAL_1, "3": REAL_3, "4": AMEND, "6": REAL_6}
FOOTNOTES = (SUBS, INS, ADDED, FOR_WORDS)


def _page(title, divs) -> str:
    body = "".join(f"<div class='section'>{text}</div>" for text in divs)
    return f"<html><h1>{title}</h1>{body}</html>"


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


def _keys(raw):
    if raw is None:
        return None
    if isinstance(raw, str):
        return json.loads(raw)
    return list(raw)


def test_a_long_footnote_is_not_served_and_the_real_section_is(corpus_db, monkeypatch):
    from scraper.public_corpus import list_statutes, statute_detail

    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    _install_pages(monkeypatch, {
        SLUG: _page(ACT, DIVS),
        NOTES: _page(NOTES_ACT, FOOTNOTES),
    })
    _harvest()
    staged = run(fetch(
        "SELECT extracted_section_number, extracted_section_text, "
        "parsing_metadata->>'provision_status', parsing_metadata->'act_keys' "
        "FROM statutes_staging WHERE extracted_short_name = :slug "
        "ORDER BY extracted_section_number",
        slug=SLUG,
    ))
    assert [row[0] for row in staged] == ["1", "3", "4", "5", "6"]
    assert [row[1] for row in staged] == list(KEPT)
    status = {row[0]: row[2] for row in staged}
    assert status["1"] is None and status["3"] is None and status["4"] is None and status["6"] is None
    assert status["5"] == "omitted"
    assert all(_keys(row[3]) == ["1", "3", "4", "5", "6"] for row in staged)
    leaked = run(fetch(
        "SELECT count(*) FROM statutes_staging "
        "WHERE extracted_section_text LIKE :needle OR raw_text LIKE :needle",
        needle="%Subs. by the Finance Act%",
    ))
    assert leaked[0][0] == 0
    for needle in ("%Ins. by Ord. XXV%", "%Added by Act II of 2001%", "%Ord. No. XXV of 2001%", '%for "words"%'):
        hit = run(fetch(
            "SELECT count(*) FROM statutes_staging "
            "WHERE extracted_section_text LIKE :needle OR raw_text LIKE :needle",
            needle=needle,
        ))
        assert hit[0][0] == 0
    notes = run(fetch(
        "SELECT count(*) FROM statutes_staging WHERE extracted_short_name = :slug",
        slug=NOTES,
    ))
    assert notes[0][0] == 0
    published = _publish()
    assert len(published) == 5
    assert all(item.id is not None and item.withheld is False and item.stale is False for item in published)
    master = run(fetch(
        "SELECT id, section_number, section_text, is_repealed FROM statutes_master "
        "WHERE short_name = :slug ORDER BY section_number",
        slug=SLUG,
    ))
    assert [row[1] for row in master] == ["1", "3", "4", "5", "6"]
    by_number = {row[1]: row for row in master}
    for number, text in LIVE.items():
        assert by_number[number][2] == text
        assert by_number[number][3] is False
    assert by_number["5"][2] == OMITTED_BY
    assert by_number["5"][3] is True
    page = run(list_statutes("Footnote Fixture", None, 20, include_repealed=False, timeout_ms=2000))
    assert {item.section_number for item in page.items} == set(LIVE)
    assert all(item.is_repealed is False for item in page.items)
    for number, text in LIVE.items():
        detail = run(statute_detail(by_number[number][0], timeout_ms=2000))
        assert detail is not None
        assert detail.section_number == number
        assert detail.section_text == text
        assert detail.is_repealed is False
        assert SUBS not in detail.section_text
        assert INS not in detail.section_text
        assert ADDED not in detail.section_text
    repealed = run(statute_detail(by_number["5"][0], timeout_ms=2000))
    assert repealed is not None
    assert repealed.section_text == OMITTED_BY
    assert repealed.is_repealed is True
    notes_master = run(fetch(
        "SELECT count(*) FROM statutes_master WHERE short_name = :slug",
        slug=NOTES,
    ))
    assert notes_master[0][0] == 0
