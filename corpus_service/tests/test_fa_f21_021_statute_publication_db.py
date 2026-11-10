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


def _publish_row(section, text, harvest_at, act_keys):
    from scraper.database import SessionLocal
    from scraper.publication.retrieval import publish_statute

    async def _run():
        async with SessionLocal() as db:
            async with db.begin():
                row = _staging(section, text, harvest_at, act_keys)
                db.add(row)
                return await publish_statute(db, row, SOURCE)

    return run(_run())


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


def test_pre_clock_rows_accept_a_matching_stamp_and_refuse_a_different_one(corpus_db):
    """Rows left NULL by migration 009 are not an empty act.

    No timestamp is written except the incoming harvest_at of a publish whose text
    already matches. A differing stamped row stays approved. A differing unstamped
    row is dead-lettered. Neither changes text, clears repeal, inserts a key, or retires.
    """
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr

    async def _seed_legacy():
        from scraper.database import SessionLocal
        from scraper.models import StatutesMaster

        async with SessionLocal() as db:
            async with db.begin():
                db.add(StatutesMaster(
                    statute_name="Legacy Act", short_name="ppc1860", section_number="2",
                    section_text=TEXT_2, source_site="PakistanCode", is_repealed=False, harvest_at=None,
                ))
                db.add(StatutesMaster(
                    statute_name="Legacy Act", short_name="ppc1860", section_number="3",
                    section_text=TEXT_3, source_site="PakistanCode", is_repealed=True, harvest_at=None,
                ))

    run(_seed_legacy())

    async def _source_id():
        return uuid.UUID(str((await fetch("SELECT id FROM scraper_sources WHERE source_name = 'PakistanCode'"))[0][0]))

    async def _hold_different_text():
        from scraper.database import SessionLocal
        from scraper.tasks import lifecycle
        from scraper.tasks.publish import publish

        source_id = await _source_id()
        before = (await fetch("SELECT count(*) FROM embedding_queue"))[0][0]
        async with SessionLocal() as db:
            async with db.begin():
                row = _staging("2", TEXT_2_AMENDED, T1, ["2"], source_id=source_id)
                db.add(row)
                await db.flush()
                lifecycle.move_through(db, row, [lifecycle.NORMALISED, lifecycle.APPROVED], actor=lifecycle.ACTOR_GATE)
                state = await publish(db, row)
                assert state == lifecycle.APPROVED
                assert row.lifecycle_state == lifecycle.APPROVED
                assert row.published_id is None
        after = (await fetch("SELECT count(*) FROM embedding_queue"))[0][0]
        return before, after

    before, after = run(_hold_different_text())
    assert before == after
    stored = {row[0]: row for row in _rows()}
    assert stored["2"][1] == TEXT_2 and stored["2"][2] is False and stored["2"][3] is None
    assert stored["3"][1] == TEXT_3 and stored["3"][2] is True and stored["3"][3] is None

    async def _refuse_unstamped():
        from scraper.database import SessionLocal
        from scraper.tasks import lifecycle
        from scraper.tasks.publish import REASON_CLOCK_UNINITIALIZED, publish

        source_id = await _source_id()
        async with SessionLocal() as db:
            async with db.begin():
                row = _staging("2", TEXT_2_AMENDED, T1, ["2"], source_id=source_id)
                row.parsing_metadata = {"act_keys": ["2"], "keying": "fa-f21-017", "source_name": "PakistanCode"}
                db.add(row)
                await db.flush()
                lifecycle.move_through(db, row, [lifecycle.NORMALISED, lifecycle.APPROVED], actor=lifecycle.ACTOR_GATE)
                state = await publish(db, row)
                assert state == lifecycle.DEAD_LETTER
                assert row.state_reason == REASON_CLOCK_UNINITIALIZED
                assert row.published_id is None

    run(_refuse_unstamped())
    stored = {row[0]: row for row in _rows()}
    assert stored["2"][1] == TEXT_2 and stored["2"][3] is None
    assert run(fetch("SELECT count(*) FROM statutes_master WHERE short_name = 'ppc1860'"))[0][0] == 2

    held_new = _publish_row("9", "9. A new key must not appear while the act has no harvest clock.", T1, ["2", "3", "9"])
    assert held_new.baseline_incomplete is True and held_new.clock_held is False and held_new.id is None
    assert run(fetch("SELECT count(*) FROM statutes_master WHERE short_name = 'ppc1860' AND section_number = '9'"))[0][0] == 0

    confirmed = _publish_row("3", TEXT_3, T1, ["3"])
    assert confirmed.stale is False and confirmed.changed is False and confirmed.clock_held is False
    stored = {row[0]: row for row in _rows()}
    assert stored["3"][1] == TEXT_3 and stored["3"][2] is True
    assert stored["3"][3] == datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert stored["2"][1] == TEXT_2 and stored["2"][2] is False and stored["2"][3] is None

    stale = _publish_row("2", TEXT_2_AMENDED, "2026-10-01T00:00:00+00:00", ["2"])
    assert stale.stale is True and stale.id is None
    stored = {row[0]: row for row in _rows()}
    assert stored["2"][1] == TEXT_2 and stored["2"][3] is None

    # Section 2 is still undated. A newer stamp must not change it until that
    # row has its own confirming clock. This does not say the newer text is stale.
    held_amend = _publish_row("2", TEXT_2_AMENDED, T2, ["2", "3"])
    assert held_amend.clock_held is True and held_amend.changed is False and held_amend.id is None
    stored = {row[0]: row for row in _rows()}
    assert stored["2"][1] == TEXT_2 and stored["2"][3] is None
    assert stored["3"][2] is True and stored["3"][1] == TEXT_3

    confirmed_two = _publish_row("2", TEXT_2, T2, ["2", "3"])
    assert confirmed_two.changed is False and confirmed_two.baseline_incomplete is False
    stored = {row[0]: row for row in _rows()}
    assert stored["2"][1] == TEXT_2 and stored["2"][3] == datetime(2026, 11, 2, tzinfo=timezone.utc)
    assert stored["3"][2] is True

    amended = _publish_row("2", TEXT_2_AMENDED, T3, ["2", "3"])
    assert amended.attached is True and amended.changed is True and amended.stale is False
    stored = {row[0]: row for row in _rows()}
    assert stored["2"][1] == TEXT_2_AMENDED and stored["2"][2] is False
    assert stored["2"][3] == datetime(2026, 11, 3, tzinfo=timezone.utc)
    assert stored["3"][2] is True and stored["3"][1] == TEXT_3


def test_unscoped_sections_are_quarantined_and_do_not_publish_or_retire(corpus_db):
    """An unscoped row is not a master row. Lookup exclusion is not the control.

    A flat heading before any body section does not prove a parent. The gate quarantines
    that div and publish writes nothing, so it cannot retire a body section.
    """
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr

    async def _body():
        from scraper.database import SessionLocal
        from scraper.publication.retrieval import publish_statute

        async with SessionLocal() as db:
            async with db.begin():
                return await publish_statute(db, _staging("1", TEXT_1, T2, ["1"]), SOURCE)

    body = run(_body())
    assert body.stale is False and body.id is not None

    async def _withhold(kind, key):
        from scraper.database import SessionLocal
        from scraper.publication.retrieval import publish_statute
        from scraper.tasks import lifecycle
        from scraper.tasks.publish import publish

        source_id = uuid.UUID(str((await fetch(
            "SELECT id FROM scraper_sources WHERE source_name = 'PakistanCode'"
        ))[0][0]))
        async with SessionLocal() as db:
            async with db.begin():
                row = _staging(key, "1. Ambiguous text that must not become a master row or retire section 1.", T3, ["1"])
                row.parsing_metadata = {
                    **row.parsing_metadata,
                    "section_kind": kind,
                    "act_keys": [key],
                }
                row.source_id = source_id
                db.add(row)
                await db.flush()
                lifecycle.move_through(db, row, [lifecycle.NORMALISED, lifecycle.APPROVED], actor=lifecycle.ACTOR_GATE)
                state = await publish(db, row)
                direct = await publish_statute(db, row, SOURCE)
                assert state == lifecycle.DEAD_LETTER
                assert row.state_reason == "ambiguous_section_identity"
                assert direct.withheld is True and direct.id is None
        return kind

    assert run(_withhold("unscoped", "unscoped:1-abcdef12")) == "unscoped"
    stored = _rows()
    assert [row[0] for row in stored] == ["1"]
    assert stored[0][1] == TEXT_1 and stored[0][2] is False

    async def _gate(kind):
        from scraper.database import SessionLocal
        from scraper.tasks.promotion import gate

        source_id = uuid.UUID(str((await fetch(
            "SELECT id FROM scraper_sources WHERE source_name = 'PakistanCode'"
        ))[0][0]))
        async with SessionLocal() as db:
            async with db.begin():
                row = _staging("schedule:first:9", "9. Quarantined before approval.", T3, None, source_id=source_id)
                row.parsing_metadata = {"section_kind": kind, "keying": "fa-f21-017", "source_name": "PakistanCode"}
                db.add(row)
                await db.flush()
                decision = await gate(db, row)
                assert decision == "quarantined"
                assert row.lifecycle_state == "quarantined"
                assert row.quarantine_reason == "ambiguous_section_identity"
        queued = await fetch(
            "SELECT count(*) FROM quarantine_queue WHERE reason = 'ambiguous_section_identity'"
        )
        return queued[0][0]

    assert run(_gate("unscoped")) >= 1
    assert run(fetch(
        "SELECT count(*) FROM statutes_master WHERE section_number LIKE 'schedule:%' OR section_number LIKE 'unscoped:%'"
    ))[0][0] == 0

    # A publish with no act_keys must not retire the sibling. A present key set still retires.
    incomplete = _publish_row("2", TEXT_2, T3, None)
    assert incomplete.id is not None and incomplete.withheld is False and incomplete.stale is False
    stored = {row[0]: row for row in _rows()}
    assert stored["1"][1] == TEXT_1 and stored["1"][2] is False
    assert stored["2"][2] is False
    retired = _publish_row("4", "4. A complete key set that names only this section retires the others.", T3, ["4"])
    assert retired.id is not None and retired.stale is False
    stored = {row[0]: row for row in _rows()}
    assert stored["4"][2] is False
    assert stored["1"][2] is True and stored["2"][2] is True


def _without_clock(section, text, act_keys):
    row = _staging(section, text, None, act_keys)
    row.parsing_metadata = {"act_keys": act_keys, "keying": "fa-f21-017", "source_name": "PakistanCode"}
    return row


def test_a_stamped_harvest_publishes_every_section_and_an_unstamped_batch_does_not(corpus_db):
    """The harvester stamps one clock on the batch. The legacy fixture did not.

    Stamped sections of an empty act all publish. Unstamped sections after the
    first NULL row are ``harvest_clock_uninitialized``. After a clock exists,
    an unstamped change is ``stale_harvest`` and writes nothing.
    """
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr

    async def _source_id():
        return uuid.UUID(str((await fetch("SELECT id FROM scraper_sources WHERE source_name = 'PakistanCode'"))[0][0]))

    async def _through(row):
        from scraper.database import SessionLocal
        from scraper.tasks import lifecycle
        from scraper.tasks.publish import publish

        source_id = await _source_id()
        async with SessionLocal() as db:
            async with db.begin():
                row.source_id = source_id
                db.add(row)
                await db.flush()
                lifecycle.move_through(db, row, [lifecycle.NORMALISED, lifecycle.APPROVED], actor=lifecycle.ACTOR_GATE)
                state = await publish(db, row)
                return state, row.lifecycle_state, row.state_reason

    for section, text in (("1", TEXT_1), ("2", TEXT_2), ("3", TEXT_3)):
        state, lifecycle_state, reason = run(_through(_staging(section, text, T1, None)))
        assert state == "embedded" and lifecycle_state == "embedded" and reason is None
    stored = {row[0]: row for row in _rows()}
    assert set(stored) == {"1", "2", "3"}
    assert all(row[2] is False and row[3] == datetime(2026, 11, 1, tzinfo=timezone.utc) for row in stored.values())

    def _legacy(section, text):
        row = _without_clock(section, text, None)
        row.extracted_short_name = "legacyconc"
        return row

    first_state, _first_life, first_reason = run(_through(_legacy("1", TEXT_1)))
    second_state, second_life, second_reason = run(_through(_legacy("2", TEXT_2)))
    assert first_state == "embedded" and first_reason is None
    assert second_state == "dead_letter" and second_life == "dead_letter"
    assert second_reason == "harvest_clock_uninitialized"
    assert run(fetch("SELECT count(*), max(harvest_at) FROM statutes_master WHERE short_name = 'legacyconc'"))[0] == (1, None)

    stale_state, stale_life, stale_reason = run(_through(_without_clock("1", TEXT_1 + " changed", ["1"])))
    assert stale_state == "dead_letter" and stale_life == "dead_letter" and stale_reason == "stale_harvest"
    stored = {row[0]: row for row in _rows()}
    assert stored["1"][1] == TEXT_1 and stored["1"][3] == datetime(2026, 11, 1, tzinfo=timezone.utc)


def test_one_matching_stamp_does_not_date_or_rewrite_its_siblings(corpus_db):
    """Unknown history: a matching stamp dates that row only.

    There is no stored baseline against which the sibling text could be called
    historically stale. The same clock must not change it, repeal it, or insert
    a key. A later clock may, once every existing row has its own stamp.
    """
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    text_2 = "2. Body two text long enough for the unknown-history baseline."
    text_2_changed = "2. Body two changed at the same clock as the first matching stamp."
    text_3 = "3. Body three stays in force while any sibling is undated."

    async def _seed():
        from scraper.database import SessionLocal
        from scraper.models import StatutesMaster

        async with SessionLocal() as db:
            async with db.begin():
                for section, text in (("1", TEXT_1), ("2", text_2), ("3", text_3)):
                    db.add(StatutesMaster(
                        statute_name="Legacy Act", short_name="ppc1860", section_number=section,
                        section_text=text, source_site="PakistanCode", is_repealed=False, harvest_at=None,
                    ))

    run(_seed())
    matched = _publish_row("1", TEXT_1, T1, ["1", "2", "3"])
    assert matched.changed is False and matched.baseline_incomplete is False
    stored = {row[0]: row for row in _rows()}
    assert stored["1"][3] == datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert stored["2"][3] is None and stored["3"][3] is None

    async def _equal_clock():
        from scraper.database import SessionLocal
        from scraper.tasks import lifecycle
        from scraper.tasks.publish import REASON_BASELINE_INCOMPLETE, publish

        source_id = uuid.UUID(str((await fetch("SELECT id FROM scraper_sources WHERE source_name = 'PakistanCode'"))[0][0]))
        async with SessionLocal() as db:
            async with db.begin():
                row = _staging("2", text_2_changed, T1, ["2"], source_id=source_id)
                db.add(row)
                await db.flush()
                lifecycle.move_through(db, row, [lifecycle.NORMALISED, lifecycle.APPROVED], actor=lifecycle.ACTOR_GATE)
                state = await publish(db, row)
                assert state == lifecycle.DEAD_LETTER
                assert row.state_reason == REASON_BASELINE_INCOMPLETE
                assert row.published_id is None
                return row.lifecycle_state

    assert run(_equal_clock()) == "dead_letter"
    stored = {row[0]: row for row in _rows()}
    assert stored["2"][1] == text_2 and stored["2"][2] is False and stored["2"][3] is None
    assert stored["1"][2] is False and stored["3"][2] is False
    assert run(fetch("SELECT count(*) FROM statutes_master WHERE short_name = 'ppc1860'"))[0][0] == 3

    inserted = _publish_row("4", "4. A new key must wait until every legacy row has its own clock.", T2, ["4"])
    assert inserted.baseline_incomplete is True and inserted.id is None
    stored = {row[0]: row for row in _rows()}
    assert "4" not in stored
    assert stored["1"][2] is False and stored["2"][2] is False and stored["3"][2] is False

    assert _publish_row("2", text_2, T1, ["1", "2", "3"]).changed is False
    assert _publish_row("3", text_3, T1, ["1", "2", "3"]).changed is False
    amended = _publish_row("2", text_2_changed, T2, ["2"])
    assert amended.changed is True and amended.stale is False
    stored = {row[0]: row for row in _rows()}
    assert stored["2"][1] == text_2_changed and stored["2"][2] is False
    assert stored["1"][2] is True and stored["3"][2] is True


def test_matching_stamp_and_equal_clock_sibling_publish_do_not_interleave(corpus_db):
    """The act lock serialises the two publishes. Neither order rewrites the sibling."""
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    text_2 = "2. Body two text long enough for the concurrent baseline."

    async def _seed():
        from scraper.database import SessionLocal
        from scraper.models import StatutesMaster

        async with SessionLocal() as db:
            async with db.begin():
                for section, text in (("1", TEXT_1), ("2", text_2)):
                    db.add(StatutesMaster(
                        statute_name="Legacy Act", short_name="ppc1860", section_number=section,
                        section_text=text, source_site="PakistanCode", is_repealed=False, harvest_at=None,
                    ))

    run(_seed())

    async def _race():
        from scraper.database import SessionLocal
        from scraper.publication.retrieval import publish_statute

        async def confirm():
            async with SessionLocal() as db:
                async with db.begin():
                    return await publish_statute(db, _staging("1", TEXT_1, T1, ["1", "2"]), SOURCE)

        async def sibling():
            async with SessionLocal() as db:
                async with db.begin():
                    return await publish_statute(
                        db, _staging("2", text_2 + " changed", T1, ["2"]), SOURCE,
                    )

        return await asyncio.gather(confirm(), sibling())

    confirmed, sibling = run(_race())
    assert confirmed.changed is False and confirmed.id is not None
    assert sibling.changed is False and sibling.id is None
    stored = {row[0]: row for row in _rows()}
    assert stored["1"][1] == TEXT_1 and stored["1"][3] == datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert stored["2"][1] == text_2 and stored["2"][2] is False and stored["2"][3] is None
