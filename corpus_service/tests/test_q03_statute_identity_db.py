"""Q03 statute identity on disposable Postgres.

One sequential harvest of synthetic act ``q03synth``. Steps H3, H4, H5, H6, H7, H8
and H10 are the fail-first checks: on fa2f43e7 they retire or insert where the
same row should move, leave vectors in place, or leave ``section_version`` at 2.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from test_f20_trust_policy_db import execute, fetch, run

ACT = "Q03 Synthetic Test Act"
SHORT = "q03synth"
SOURCE = SimpleNamespace(source_name="PakistanCode")
VECTOR = "[" + ",".join(["0.1"] + ["0"] * 1535) + "]"
CHUNK_HASH = "cd" * 32

TEXT_1 = "1. Q03 synthetic section one. This test text stays on its own row."
TEXT_2 = "2. Q03 synthetic section two member B. This test text is the stable body."
TEXT_2A = "2A. Q03 synthetic section two A. This test text is deleted by a later harvest."
TEXT_3 = "3. Q03 synthetic section three as first published. This test text is amended twice."
TEXT_3B = "3. Q03 synthetic section three as first amended. This test text replaces the prior body."
TEXT_3C = "3. Q03 synthetic section three as second amended. This test text is the third version."
TEXT_C = "2. Q03 synthetic repeated member C. This test text is the new sibling of member B."
TEXT_C2 = "2. Q03 synthetic repeated member C2. This test text amends member C and keeps its row."


def _day(day: int) -> str:
    return f"2026-11-{day:02d}T00:00:00+00:00"


def _when(day: int) -> datetime:
    return datetime(2026, 11, day, tzinfo=timezone.utc)


def _token(text: str) -> str:
    from scraper.parsers.pakistancode_keys import content_token

    return content_token(text)


def _sha(number: str, text: str) -> str:
    return f"{number}-{_token(text)}"


class _Bag:
    def __init__(self):
        self.errors = []

    def check(self, step):
        return _Check(self, step)


class _Check:
    def __init__(self, bag, step):
        self.bag = bag
        self.step = step

    def __enter__(self):
        return self

    def __exit__(self, typ, exc, tb):
        if typ is AssertionError:
            self.bag.errors.append(f"{self.step}: {exc}")
            return True
        return False


def _staging(short, section, text, harvest_at, act_keys, source_id, act=ACT):
    from scraper.models import StatutesStaging

    return StatutesStaging(
        source_id=source_id,
        source_site="PakistanCode",
        source_url="https://q03.example.invalid/statute",
        extracted_act_name=act,
        extracted_short_name=short,
        extracted_section_number=section,
        extracted_section_title="Q03 synthetic",
        extracted_section_text=text,
        raw_text=text,
        confidence_score=0.9,
        parsing_metadata={
            "act_keys": list(act_keys),
            "harvest_at": harvest_at,
            "keying": "q03",
            "source_name": "PakistanCode",
        },
    )


def _publish_many(rows, order, *, consumer_keys=()):
    """Flush every sibling, then publish ``order``. ``consumer_keys`` go through ``publish``."""
    from scraper.database import SessionLocal
    from scraper.publication.retrieval import publish_statute
    from scraper.tasks import lifecycle
    from scraper.tasks.publish import publish

    async def _run():
        async with SessionLocal() as db:
            async with db.begin():
                for row in rows:
                    db.add(row)
                await db.flush()
                by_key = {row.extracted_section_number: row for row in rows}
                states = {}
                for key in order:
                    row = by_key[key]
                    if key in consumer_keys:
                        lifecycle.move_through(
                            db, row, [lifecycle.NORMALISED, lifecycle.APPROVED], actor=lifecycle.ACTOR_GATE,
                        )
                        states[key] = await publish(db, row)
                    else:
                        await publish_statute(db, row, SOURCE)
                        states[key] = None
                return {key: by_key[key].id for key in order}, states

    return run(_run())


def _rows(short):
    return run(fetch(
        "SELECT id, section_number, section_text, is_repealed, harvest_at "
        "FROM statutes_master WHERE short_name = :s ORDER BY section_number",
        s=short,
    ))


def _plant(record_id):
    async def _run():
        from sqlalchemy import text

        from scraper.database import SessionLocal

        async with SessionLocal() as db:
            async with db.begin():
                await db.execute(
                    text("UPDATE statutes_master SET embedding = CAST(:vec AS vector) WHERE id = :id"),
                    {"vec": VECTOR, "id": record_id},
                )
                await db.execute(
                    text(
                        "INSERT INTO record_embedding_chunks ("
                        "table_name, record_id, chunk_index, chunk_spec_version, content_hash, "
                        "char_start, char_end, paragraph_start, paragraph_end, "
                        "embedding_model, embedding_dimensions, embedding) "
                        "VALUES ('statutes_master', :id, 0, 'q03', :content_hash, "
                        "0, 1, 0, 0, 'text-embedding-3-small', 1536, CAST(:vec AS vector))"
                    ),
                    {"id": record_id, "content_hash": CHUNK_HASH, "vec": VECTOR},
                )
                await db.execute(
                    text(
                        "INSERT INTO embedding_queue (record_id, table_name, status) "
                        "VALUES (:id, 'statutes_master', 'completed')"
                    ),
                    {"id": record_id},
                )

    run(_run())


def _vectors(record_id):
    return run(fetch(
        "SELECT (m.embedding IS NULL) AS gone, "
        "(SELECT count(*) FROM record_embedding_chunks c WHERE c.record_id = m.id) AS chunks, "
        "(SELECT q.status FROM embedding_queue q WHERE q.record_id = m.id "
        "AND q.table_name = 'statutes_master') AS queue_status "
        "FROM statutes_master m WHERE m.id = :id",
        id=record_id,
    ))[0]


def _version(staging_id):
    rows = run(fetch(
        "SELECT parsing_metadata FROM statutes_staging WHERE id = :id",
        id=staging_id,
    ))
    return rows[0][0] or {}


def _wipe(short):
    run(execute(
        "DELETE FROM record_embedding_chunks WHERE record_id IN "
        "(SELECT id FROM statutes_master WHERE short_name = :s)",
        "DELETE FROM embedding_queue WHERE record_id IN "
        "(SELECT id FROM statutes_master WHERE short_name = :s)",
        "DELETE FROM embedding_attempts WHERE record_id IN "
        "(SELECT id FROM statutes_master WHERE short_name = :s)",
        "DELETE FROM statutes_staging WHERE extracted_short_name = :s",
        "DELETE FROM statutes_master WHERE short_name = :s",
        params={"s": short},
    ))


def _order_run(source_id, first_key):
    """H1 then H6. ``first_key`` is published before the other repeated key."""
    short = "q03ord"
    keys = ["1", "2"]
    texts = {"1": TEXT_1, "2": TEXT_2}
    staged = [_staging(short, key, texts[key], _day(1), keys, source_id, act="Q03 Synthetic Order Act") for key in keys]
    _publish_many(staged, keys)
    stored = {row[1]: row for row in _rows(short)}
    id2 = stored["2"][0]
    sha_b = _sha("2", TEXT_2)
    sha_c = _sha("2", TEXT_C)
    harvest_keys = ["1", sha_b, sha_c]
    bodies = {"1": TEXT_1, sha_b: TEXT_2, sha_c: TEXT_C}
    second = [
        _staging(short, key, bodies[key], _day(6), harvest_keys, source_id, act="Q03 Synthetic Order Act")
        for key in harvest_keys
    ]
    other = sha_c if first_key == sha_b else sha_b
    _publish_many(second, [first_key, other])
    final = frozenset((row[0], row[1], row[2], row[3]) for row in _rows(short))
    id2_row = next(row for row in _rows(short) if row[0] == id2)
    return final, id2_row


def test_q03_statute_identity_sequence(corpus_db):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    source_id = uuid.UUID(str(run(fetch(
        "SELECT id FROM scraper_sources WHERE source_name = 'PakistanCode'"
    ))[0][0]))
    bag = _Bag()

    h1_keys = ["1", "2", "3"]
    h1_text = {"1": TEXT_1, "2": TEXT_2, "3": TEXT_3}
    h1_rows = [_staging(SHORT, key, h1_text[key], _day(1), h1_keys, source_id) for key in h1_keys]
    _publish_many(h1_rows, h1_keys)
    h1 = {row[1]: row for row in _rows(SHORT)}
    assert set(h1) == {"1", "2", "3"}
    assert all(row[3] is False for row in h1.values())
    id1, id2, id3 = h1["1"][0], h1["2"][0], h1["3"][0]

    h2_keys = ["1", "2", "2A", "3"]
    h2_text = {"1": TEXT_1, "2": TEXT_2, "2A": TEXT_2A, "3": TEXT_3}
    h2_rows = [_staging(SHORT, key, h2_text[key], _day(2), h2_keys, source_id) for key in h2_keys]
    _publish_many(h2_rows, ["2A", "1", "2", "3"])
    h2 = {row[1]: row for row in _rows(SHORT)}
    assert h2["1"][0] == id1 and h2["2"][0] == id2 and h2["3"][0] == id3
    assert h2["2A"][3] is False and h2["2A"][0] not in {id1, id2, id3}
    assert all(row[3] is False for row in h2.values())
    id2a = h2["2A"][0]

    _plant(id2a)
    h3_keys = ["1", "2", "3"]
    h3_rows = [_staging(SHORT, "1", TEXT_1, _day(3), h3_keys, source_id)]
    _publish_many(h3_rows, ["1"])
    with bag.check("H3"):
        retired = {row[0]: row for row in _rows(SHORT)}[id2a]
        assert retired[1] == "2A" and retired[3] is True and retired[4] == _when(3)
        gone, chunks, queue = _vectors(id2a)
        assert gone is True and chunks == 0 and queue is None

    _plant(id3)
    h4 = _staging(SHORT, "3", TEXT_3B, _day(4), h3_keys, source_id)
    published, states = _publish_many([h4], ["3"], consumer_keys={"3"})
    with bag.check("H4"):
        assert states["3"] == "embedded"
        row3 = {row[0]: row for row in _rows(SHORT)}[id3]
        assert row3[0] == id3 and row3[1] == "3" and row3[2] == TEXT_3B and row3[3] is False
        gone, chunks, queue = _vectors(id3)
        assert gone is True and chunks == 0 and queue == "pending"
        assert _version(published["3"])["section_version"] == 2

    h5 = _staging(SHORT, "3", TEXT_3C, _day(5), h3_keys, source_id)
    published5, _states5 = _publish_many([h5], ["3"])
    with bag.check("H5"):
        row3 = {row[0]: row for row in _rows(SHORT)}[id3]
        assert row3[1] == "3" and row3[2] == TEXT_3C
        assert _version(published5["3"])["section_version"] == 3

    sha_b = _sha("2", TEXT_2)
    sha_c = _sha("2", TEXT_C)
    before = len(_rows(SHORT))
    h6_keys = ["1", sha_b, sha_c, "3"]
    h6_text = {"1": TEXT_1, sha_b: TEXT_2, sha_c: TEXT_C, "3": TEXT_3C}
    h6_rows = [_staging(SHORT, key, h6_text[key], _day(6), h6_keys, source_id) for key in h6_keys]
    _publish_many(h6_rows, [sha_b, sha_c, "1", "3"])
    with bag.check("H6"):
        current = _rows(SHORT)
        by_id = {row[0]: row for row in current}
        assert by_id[id2][1] == sha_b and by_id[id2][2] == TEXT_2 and by_id[id2][3] is False
        created = [row for row in current if row[2] == TEXT_C]
        assert len(created) == 1 and created[0][1] == sha_c and created[0][3] is False
        assert not any(row[1] == "2" and row[3] is False for row in current)
        assert len(current) == before + 1
    id_c = next(row[0] for row in _rows(SHORT) if row[2] == TEXT_C)

    sha_c2 = _sha("2", TEXT_C2)
    _plant(id_c)
    h7_keys = ["1", sha_b, sha_c2, "3"]
    h7 = _staging(SHORT, sha_c2, TEXT_C2, _day(7), h7_keys, source_id)
    published7, states7 = _publish_many([h7], [sha_c2], consumer_keys={sha_c2})
    with bag.check("H7"):
        assert states7[sha_c2] == "embedded"
        moved = {row[0]: row for row in _rows(SHORT)}[id_c]
        assert moved[1] == sha_c2 and moved[2] == TEXT_C2 and moved[3] is False
        untouched = {row[0]: row for row in _rows(SHORT)}[id2]
        assert untouched[1] == sha_b and untouched[2] == TEXT_2 and untouched[3] is False
        gone, chunks, queue = _vectors(id_c)
        assert gone is True and chunks == 0 and queue == "pending"
        assert _version(published7[sha_c2])["identity_predecessor_key"] == sha_c

    h8_keys = ["1", "2", "3"]
    h8 = _staging(SHORT, "2", TEXT_2, _day(8), h8_keys, source_id)
    _publish_many([h8], ["2"])
    with bag.check("H8"):
        final = _rows(SHORT)
        by_id = {row[0]: row for row in final}
        assert by_id[id2][1] == "2" and by_id[id2][2] == TEXT_2 and by_id[id2][3] is False
        assert not any(row[1] == sha_b for row in final)
        assert by_id[id_c][1] == sha_c2 and by_id[id_c][3] is True

    amb = "q03amb"
    amb_b = _sha("2", TEXT_2)
    amb_c = _sha("2", TEXT_C)
    amb_keys = [amb_b, amb_c]
    amb_rows = [
        _staging(amb, amb_b, TEXT_2, _day(1), amb_keys, source_id, act="Q03 Synthetic Ambiguity Act"),
        _staging(amb, amb_c, TEXT_C, _day(1), amb_keys, source_id, act="Q03 Synthetic Ambiguity Act"),
    ]
    _publish_many(amb_rows, amb_keys)
    amb_b2 = _sha("2", TEXT_3B)
    amb_c2 = _sha("2", TEXT_C2)
    changed_keys = [amb_b2, amb_c2]
    changed_rows = [
        _staging(amb, amb_b2, TEXT_3B, _day(9), changed_keys, source_id, act="Q03 Synthetic Ambiguity Act"),
        _staging(amb, amb_c2, TEXT_C2, _day(9), changed_keys, source_id, act="Q03 Synthetic Ambiguity Act"),
    ]
    published_amb, _states = _publish_many(changed_rows, changed_keys)
    amb_now = _rows(amb)
    by_key = {row[1]: row for row in amb_now}
    assert by_key[amb_b][3] is True and by_key[amb_c][3] is True
    assert by_key[amb_b2][3] is False and by_key[amb_c2][3] is False
    assert by_key[amb_b][0] != by_key[amb_b2][0]
    for staging_id in published_amb.values():
        assert "identity_successor_of" not in (_version(staging_id) or {})

    _wipe("q03ord")
    first_set, first_id2 = _order_run(source_id, _sha("2", TEXT_2))
    _wipe("q03ord")
    second_set, second_id2 = _order_run(source_id, _sha("2", TEXT_C))
    with bag.check("H10"):
        assert first_set == second_set
        assert first_id2[1] == _sha("2", TEXT_2) and first_id2[3] is False
        assert second_id2[1] == _sha("2", TEXT_2) and second_id2[3] is False
        assert first_id2[0] == second_id2[0]

    before_stale = _rows(SHORT)
    stale_keys = ["1", sha_b, sha_c, "3"]
    stale = _staging(SHORT, sha_b, TEXT_2, _day(6), stale_keys, source_id)

    async def _stale():
        from scraper.database import SessionLocal
        from scraper.tasks import lifecycle
        from scraper.tasks.publish import REASON_STALE_HARVEST, publish

        async with SessionLocal() as db:
            async with db.begin():
                db.add(stale)
                await db.flush()
                lifecycle.move_through(
                    db, stale, [lifecycle.NORMALISED, lifecycle.APPROVED], actor=lifecycle.ACTOR_GATE,
                )
                state = await publish(db, stale)
                return state, stale.state_reason

    state, reason = run(_stale())
    assert state == "dead_letter" and reason == "stale_harvest"
    from scraper.tasks.publish import REASON_STALE_HARVEST
    assert reason == REASON_STALE_HARVEST
    assert _rows(SHORT) == before_stale

    root = Path(__file__).resolve().parents[1]
    publication = root / "scraper" / "publication"
    offenders = []
    for path in root.rglob("*.py"):
        if "tests" in path.parts or path.is_relative_to(publication):
            continue
        if "statute_section_version" in path.read_text(encoding="utf-8"):
            offenders.append(str(path.relative_to(root)))
    assert offenders == []

    if bag.errors:
        pytest.fail(
            "Q03 steps that must pass after the identity fix failed:\n" + "\n".join(bag.errors)
        )
