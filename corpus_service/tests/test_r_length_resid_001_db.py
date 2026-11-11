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


VECTOR = "[" + ",".join(["0.1"] + ["0"] * 1535) + "]"
CHUNK_HASH = "ab" * 32


def _approve_and_publish():
    """Run the publish task, which is what hands a master row to the embedding queue."""
    from sqlalchemy import select, text

    from scraper.database import SessionLocal
    from scraper.models import StatutesStaging
    from scraper.tasks import publish as publish_task

    async def _run():
        async with SessionLocal() as db:
            async with db.begin():
                await db.execute(
                    text(
                        "UPDATE statutes_staging SET lifecycle_state = 'approved' "
                        "WHERE extracted_short_name = :slug"
                    ),
                    {"slug": SLUG},
                )
                rows = (await db.execute(
                    select(StatutesStaging)
                    .where(StatutesStaging.extracted_short_name == SLUG)
                    .order_by(StatutesStaging.extracted_section_number)
                )).scalars().all()
                return [await publish_task.publish(db, row) for row in rows]

    return run(_run())


def test_non_live_rows_are_not_embedded_and_semantic_search_skips_them(corpus_db, monkeypatch):
    """RESID-001-EMBED-001. Placeholders are not queued. A live row that becomes a
    placeholder loses its vector. A repealed row that still has a vector is not a semantic hit.
    """
    from sqlalchemy import select, text

    from scraper.database import SessionLocal
    from scraper.models import StatutesStaging
    from scraper.publication import retrieval

    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    _install_pages(monkeypatch, {SLUG: _page()})
    _harvest()
    states = _approve_and_publish()
    assert states == ["embedded"] * 8
    queued = run(fetch(
        "SELECT m.section_number FROM embedding_queue q "
        "JOIN statutes_master m ON m.id = q.record_id "
        "WHERE m.short_name = :slug ORDER BY m.section_number",
        slug=SLUG,
    ))
    assert [row[0] for row in queued] == ["1", "2", "8"]
    withheld = run(fetch(
        "SELECT t.details->>'embedding_withheld' FROM corpus_lifecycle_transitions t "
        "JOIN statutes_staging s ON s.id = t.record_id "
        "WHERE s.extracted_short_name = :slug AND s.extracted_section_number = '3' "
        "AND t.to_state = 'embedded'",
        slug=SLUG,
    ))
    assert withheld == [("non_live",)]

    async def _plant_flip_and_search():
        async with SessionLocal() as db:
            async with db.begin():
                await db.execute(
                    text(
                        "UPDATE statutes_master SET embedding = CAST(:vec AS vector) "
                        "WHERE short_name = :slug AND section_number IN ('1', '3')"
                    ),
                    {"vec": VECTOR, "slug": SLUG},
                )
                section_1 = (await db.execute(
                    text(
                        "SELECT id FROM statutes_master "
                        "WHERE short_name = :slug AND section_number = '1'"
                    ),
                    {"slug": SLUG},
                )).scalar_one()
                await db.execute(
                    text(
                        "INSERT INTO record_embedding_chunks ("
                        "table_name, record_id, chunk_index, chunk_spec_version, content_hash, "
                        "char_start, char_end, paragraph_start, paragraph_end, "
                        "embedding_model, embedding_dimensions, embedding) "
                        "VALUES ('statutes_master', :id, 0, 'test', :content_hash, "
                        "0, 1, 0, 0, 'text-embedding-3-small', 1536, CAST(:vec AS vector))"
                    ),
                    {"id": section_1, "content_hash": CHUNK_HASH, "vec": VECTOR},
                )
                hits = (await db.execute(retrieval.live_statute_semantic_stmt())).all()
                hit_numbers = {row.section_number for row in hits}
                staging = (await db.execute(
                    select(StatutesStaging).where(
                        StatutesStaging.extracted_short_name == SLUG,
                        StatutesStaging.extracted_section_number == "1",
                    )
                )).scalar_one()
                staging.extracted_section_text = "1. [Omitted.]"
                staging.raw_text = "1. [Omitted.]"
                await retrieval.publish_statute(db, staging, SOURCE)
                outbox = await retrieval.enqueue_embedding(db, retrieval.STATUTE_MASTER, section_1)
                master = (await db.execute(
                    text(
                        "SELECT is_repealed, embedding IS NULL FROM statutes_master WHERE id = :id"
                    ),
                    {"id": section_1},
                )).one()
                chunks = (await db.execute(
                    text(
                        "SELECT count(*) FROM record_embedding_chunks WHERE record_id = :id"
                    ),
                    {"id": section_1},
                )).scalar_one()
                queue = (await db.execute(
                    text("SELECT count(*) FROM embedding_queue WHERE record_id = :id"),
                    {"id": section_1},
                )).scalar_one()
                return hit_numbers, outbox, master, chunks, queue

    hits, outbox, master, chunks, queue = run(_plant_flip_and_search())
    assert hits == {"1"}
    assert outbox is None
    assert master == (True, True)
    assert chunks == 0
    assert queue == 0


def test_embedding_worker_does_not_embed_a_repealed_statute(corpus_db):
    """A queue row that already names a non-live statute is closed with no provider call, and its vector is removed."""
    from sqlalchemy import text

    from scraper.database import SessionLocal
    from scraper.tasks.embeddings import BatchCounts, _Batch

    class _Refuse:
        def __getattr__(self, name):
            raise AssertionError(f"provider used: {name}")

    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr

    async def _seed_and_run():
        async with SessionLocal() as db:
            async with db.begin():
                record_id = (await db.execute(
                    text(
                        "INSERT INTO statutes_master ("
                        "statute_name, short_name, section_number, section_text, source_site, "
                        "is_repealed, embedding) "
                        "VALUES ('Worker Fixture', 'resid001wk', '3', '3. [Omitted.]', "
                        "'PakistanCode', true, CAST(:vec AS vector)) RETURNING id"
                    ),
                    {"vec": VECTOR},
                )).scalar_one()
                await db.execute(
                    text(
                        "INSERT INTO embedding_queue (record_id, table_name) "
                        "VALUES (:id, 'statutes_master')"
                    ),
                    {"id": record_id},
                )
                await db.execute(
                    text(
                        "INSERT INTO record_embedding_chunks ("
                        "table_name, record_id, chunk_index, chunk_spec_version, content_hash, "
                        "char_start, char_end, paragraph_start, paragraph_end, "
                        "embedding_model, embedding_dimensions, embedding) "
                        "VALUES ('statutes_master', :id, 0, 'test', :content_hash, "
                        "0, 1, 0, 0, 'text-embedding-3-small', 1536, CAST(:vec AS vector))"
                    ),
                    {"id": record_id, "content_hash": CHUNK_HASH, "vec": VECTOR},
                )
        counts = BatchCounts()
        await _Batch(_Refuse(), counts).run()
        async with SessionLocal() as db:
            stored = (await db.execute(
                text(
                    "SELECT m.embedding IS NULL, q.status, q.error_message, "
                    "(SELECT count(*) FROM record_embedding_chunks c WHERE c.record_id = m.id) "
                    "FROM statutes_master m JOIN embedding_queue q ON q.record_id = m.id "
                    "WHERE m.short_name = 'resid001wk'"
                )
            )).one()
        return counts.provider_calls, stored

    calls, stored = run(_seed_and_run())
    assert calls == 0
    assert stored == (True, "completed", "non_live", 0)


SCHEDULE_SLUG = "resid001sc"
SCHEDULE_ACT = "Resid001 Schedule Fixture Act 2099"
SCHEDULE_BODY = "1. Short title. This Act may be called the Resid001 Schedule Fixture Act, 2099."
SCHEDULE_REP = "2. Rep."


def test_schedule_rep_item_is_schedule_key_and_repealed(corpus_db, monkeypatch):
    """A body section, then a schedule heading, then ``2. Rep.`` publishes as schedule:L:N.

    The item is repealed. It is not an ``unscoped`` key. A heading that appears
    before any body section stays unscoped by the locked schedule rule; this page
    opens schedule scope first.
    """
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    divs = (SCHEDULE_BODY, "Schedule 1", SCHEDULE_REP)
    page = f"<html><h1>{SCHEDULE_ACT}</h1>" + "".join(
        f"<div class='section'>{text}</div>" for text in divs
    ) + "</html>"
    _install_pages(monkeypatch, {SCHEDULE_SLUG: page})
    from sqlalchemy import select

    from scraper.database import SessionLocal
    from scraper.models import StatutesStaging
    from scraper.publication.retrieval import publish_statute

    _harvest()
    staged = run(fetch(
        "SELECT extracted_section_number, parsing_metadata->>'section_kind', "
        "parsing_metadata->>'provision_status' "
        "FROM statutes_staging WHERE extracted_short_name = :slug "
        "ORDER BY created_at",
        slug=SCHEDULE_SLUG,
    ))
    assert staged == [
        ("1", "section", None),
        ("schedule-heading:1", "schedule-heading", None),
        ("schedule:1:2", "schedule-item", "repealed"),
    ]
    assert not any(row[0].startswith("unscoped") for row in staged)

    async def _publish_schedule():
        async with SessionLocal() as db:
            async with db.begin():
                rows = (await db.execute(
                    select(StatutesStaging)
                    .where(StatutesStaging.extracted_short_name == SCHEDULE_SLUG)
                    .order_by(StatutesStaging.created_at)
                )).scalars().all()
                for row in rows:
                    await publish_statute(db, row, SOURCE)

    run(_publish_schedule())
    master = run(fetch(
        "SELECT section_number, section_text, is_repealed FROM statutes_master "
        "WHERE short_name = :slug ORDER BY section_number",
        slug=SCHEDULE_SLUG,
    ))
    by_key = {row[0]: row for row in master}
    assert "unscoped" not in "".join(by_key)
    assert by_key["schedule:1:2"][1] == SCHEDULE_REP
    assert by_key["schedule:1:2"][2] is True
    assert by_key["1"][2] is False
