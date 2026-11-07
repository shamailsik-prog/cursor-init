"""FA-F21-021 on a disposable Postgres database. No live or staging DSN is read.

The clock is ``harvest_at`` stamped at harvest, stored on ``statutes_master`` when that
harvest wins. A later publish whose clock is older does not clear ``is_repealed``,
does not write its text, and does not insert a key the newer harvest omitted.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from test_f20_trust_policy_db import fetch, run

T1 = "2026-11-01T00:00:00+00:00"
T2 = "2026-11-02T00:00:00+00:00"
T3 = "2026-11-03T00:00:00+00:00"
TEXT_2 = "2. Definitions in the persistence fixture, stored by the first harvest."
TEXT_2_AMENDED = "2. Definitions amended by a later harvest of the same numbered section."
TEXT_3 = "3. Original body of section three for the persistence fixture."
TEXT_3_STALE = "3. Older body that a delayed harvest must not write back."
TEXT_3_NEW = "3. Newer body restored when the section returns in a later harvest."
TEXT_1 = "1. Short title of the persistence fixture act, long enough to store."
SOURCE = SimpleNamespace(source_name="PakistanCode")


def _staging(section, text, harvest_at, act_keys, source_id=None):
    from scraper.models import StatutesStaging

    return StatutesStaging(
        source_id=source_id,
        source_site="PakistanCode",
        source_url="https://pakistancode.gov.pk/english/statues/details/ppc1860",
        extracted_act_name="F21 Fixture Act",
        extracted_short_name="ppc1860",
        extracted_section_number=section,
        extracted_section_title="Fixture",
        extracted_section_text=text,
        raw_text=text,
        confidence_score=0.85,
        parsing_metadata={
            "act_keys": act_keys,
            "harvest_at": harvest_at,
            "keying": "fa-f21-017",
            "source_name": "PakistanCode",
        },
    )


def _rows():
    return run(fetch(
        "SELECT section_number, section_text, is_repealed, harvest_at "
        "FROM statutes_master WHERE short_name = 'ppc1860' ORDER BY section_number"
    ))


def test_migration_009_adds_harvest_at_and_a_second_run_changes_nothing(corpus_db):
    first = corpus_db.migrate()
    assert first.returncode == 0, first.stderr
    assert run(fetch(
        "SELECT attname FROM pg_attribute WHERE attrelid = 'statutes_master'::regclass AND attname = 'harvest_at'"
    ))
    corpus_db.admin("ALTER TABLE statutes_master DROP COLUMN harvest_at")
    assert run(fetch(
        "SELECT attname FROM pg_attribute WHERE attrelid = 'statutes_master'::regclass AND attname = 'harvest_at'"
    )) == []
    second = corpus_db.migrate()
    assert second.returncode == 0, second.stderr
    assert run(fetch(
        "SELECT attname FROM pg_attribute WHERE attrelid = 'statutes_master'::regclass AND attname = 'harvest_at'"
    ))
    third = corpus_db.migrate()
    assert third.returncode == 0, third.stderr


def test_fa_f21_021_stale_publish_does_not_resurrect_text_and_rollback_discards_the_write(corpus_db):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr

    async def _publish(section, text, harvest_at, act_keys):
        from scraper.database import SessionLocal
        from scraper.publication.retrieval import publish_statute

        async with SessionLocal() as db:
            async with db.begin():
                row = _staging(section, text, harvest_at, act_keys)
                db.add(row)
                return await publish_statute(db, row, SOURCE)

    first_two = run(_publish("2", TEXT_2, T1, ["2", "3"]))
    first_three = run(_publish("3", TEXT_3, T1, ["2", "3"]))
    assert first_two.stale is False and first_three.stale is False
    stored = {row[0]: row for row in _rows()}
    assert stored["2"][1] == TEXT_2 and stored["3"][1] == TEXT_3
    assert stored["2"][2] is False and stored["3"][2] is False
    section_3_id = run(fetch("SELECT id FROM statutes_master WHERE short_name = 'ppc1860' AND section_number = '3'"))[0][0]

    async def _rollback_amend():
        from scraper.database import SessionLocal
        from scraper.publication.retrieval import publish_statute

        async with SessionLocal() as db:
            await db.begin()
            try:
                await publish_statute(db, _staging("2", TEXT_2_AMENDED, T2, ["2"]), SOURCE)
            finally:
                await db.rollback()

    run(_rollback_amend())
    stored = {row[0]: row for row in _rows()}
    assert stored["2"][1] == TEXT_2 and stored["2"][2] is False
    assert stored["3"][1] == TEXT_3 and stored["3"][2] is False
    assert stored["2"][3] == datetime(2026, 11, 1, tzinfo=timezone.utc)

    amended = run(_publish("2", TEXT_2_AMENDED, T2, ["2"]))
    assert amended.attached is True and amended.changed is True and amended.id == first_two.id
    stored = {row[0]: row for row in _rows()}
    assert stored["2"][1] == TEXT_2_AMENDED and stored["2"][2] is False
    assert stored["3"][1] == TEXT_3 and stored["3"][2] is True
    assert stored["3"][3] == datetime(2026, 11, 2, tzinfo=timezone.utc)
    assert run(fetch("SELECT count(*) FROM statutes_master WHERE short_name = 'ppc1860'"))[0][0] == 2

    async def _stale_through_publish():
        from scraper.database import SessionLocal
        from scraper.tasks import lifecycle
        from scraper.tasks.publish import REASON_STALE_HARVEST, publish

        source_id = uuid.UUID(str((await fetch(
            "SELECT id FROM scraper_sources WHERE source_name = 'PakistanCode'"
        ))[0][0]))
        before = (await fetch("SELECT count(*) FROM embedding_queue"))[0][0]
        async with SessionLocal() as db:
            async with db.begin():
                row = _staging("3", TEXT_3_STALE, T1, ["2", "3"], source_id=source_id)
                db.add(row)
                await db.flush()
                lifecycle.move_through(
                    db, row, [lifecycle.NORMALISED, lifecycle.APPROVED], actor=lifecycle.ACTOR_GATE,
                )
                state = await publish(db, row)
                assert state == lifecycle.DEAD_LETTER
                assert row.state_reason == REASON_STALE_HARVEST
                assert row.published_id is None
                assert row.promoted is False
        after = (await fetch("SELECT count(*) FROM embedding_queue"))[0][0]
        return before, after

    before, after = run(_stale_through_publish())
    assert before == after
    stored = {row[0]: row for row in _rows()}
    assert stored["3"][1] == TEXT_3 and stored["3"][2] is True
    assert run(fetch("SELECT id FROM statutes_master WHERE short_name = 'ppc1860' AND section_number = '3'"))[0][0] == section_3_id

    missing = run(_publish("9", "9. A key the newer harvest never contained and a stale harvest must not insert.", T1, ["2", "9"]))
    assert missing.stale is True and missing.id is None
    assert run(fetch("SELECT count(*) FROM statutes_master WHERE short_name = 'ppc1860' AND section_number = '9'"))[0][0] == 0

    restored = run(_publish("3", TEXT_3_NEW, T3, ["2", "3"]))
    assert restored.stale is False and restored.attached is True and restored.changed is True
    assert restored.id == section_3_id
    stored = {row[0]: row for row in _rows()}
    assert stored["3"][1] == TEXT_3_NEW and stored["3"][2] is False
    assert stored["2"][1] == TEXT_2_AMENDED and stored["2"][2] is False


def test_fa_f21_021_a_stale_publish_waits_for_the_act_lock(corpus_db):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    from sqlalchemy import text

    from scraper.publication.retrieval import STATUTE_LOCK_NAMESPACE, statute_act_lock_key

    async def _seed():
        from scraper.database import SessionLocal
        from scraper.publication.retrieval import publish_statute

        async with SessionLocal() as db:
            async with db.begin():
                await publish_statute(db, _staging("1", TEXT_1, T2, ["1"]), SOURCE)

    run(_seed())

    async def _race():
        from scraper.database import SessionLocal
        from scraper.publication.retrieval import publish_statute

        held = asyncio.Event()
        release = asyncio.Event()
        entered = asyncio.Event()

        async def hold():
            async with SessionLocal() as db:
                async with db.begin():
                    await db.execute(
                        text("SELECT pg_advisory_xact_lock(:namespace, hashtext(:key))"),
                        {"namespace": STATUTE_LOCK_NAMESPACE, "key": statute_act_lock_key("ppc1860")},
                    )
                    held.set()
                    await release.wait()

        async def late():
            await held.wait()
            entered.set()
            started = time.monotonic()
            async with SessionLocal() as db:
                async with db.begin():
                    result = await publish_statute(
                        db,
                        _staging("1", "1. Stale text that must wait and then be refused.", T1, ["1"]),
                        SOURCE,
                    )
            return result, time.monotonic() - started

        holder = asyncio.create_task(hold())
        await held.wait()
        publisher = asyncio.create_task(late())
        await entered.wait()
        await asyncio.sleep(0.4)
        release.set()
        result, elapsed = await publisher
        await holder
        return result, elapsed

    result, elapsed = run(_race())
    assert result.stale is True and result.id is None
    assert elapsed >= 0.3
    stored = _rows()
    assert len(stored) == 1
    assert stored[0][0] == "1" and stored[0][1] == TEXT_1 and stored[0][2] is False
