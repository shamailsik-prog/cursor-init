"""Q03-RACE-PROOF-001. Two sessions publish one PakistanCode harvest.

The act is synthetic ("Q04 Synthetic Race Act", short name ``q04race``). Section
text is labelled test text, not statute wording. Ordering uses asyncio events and
``pg_locks`` (advisory, granted = false). No sleep decides who runs, and the two
``publish`` calls are not a bare gather.

H1 is published sequentially with a real ``harvest_at``. H2 rows are approved
before either session claims. S1 and S2 each claim with
``corpus_pipeline._claim_oldest`` (FOR UPDATE SKIP LOCKED) and then call
``scraper.tasks.publish.publish``.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

from sqlalchemy import text

from test_f20_trust_policy_db import execute, fetch, run, sqlstate

ACT = "Q04 Synthetic Race Act"
SHORT = "q04race"
SOURCE_NAME = "PakistanCode"

TEXT_A = "1. Q04 synthetic race section one. This labelled test text is not statute wording."
TEXT_B = "2. Q04 synthetic race member B. This labelled test text is the stable body."
TEXT_C = "2. Q04 synthetic race member C. This labelled test text is the new sibling."
TEXT_B2 = "2. Q04 synthetic race member B amended. This labelled test text replaces member B."
TEXT_C2 = "2. Q04 synthetic race member C amended. This labelled test text replaces member C."

T1 = "2026-11-01T00:00:00+00:00"
T2 = "2026-11-02T00:00:00+00:00"
LOCK_STATES = {"40P01", "55P03", "57014"}


def _when(token: str) -> datetime:
    return datetime.fromisoformat(token)


def _sha(number: str, text: str) -> str:
    from scraper.parsers.pakistancode_keys import content_token

    return f"{number}-{content_token(text)}"


class _Holder:
    def __init__(self):
        self.claimed = asyncio.Event()
        self.start_publish = asyncio.Event()
        self.publish_returned = asyncio.Event()
        self.release = asyncio.Event()
        self.row_id = None
        self.key = None
        self.pid = None
        self.published_id = None
        self.state = None
        self.error = None
        self.rolled_back = False
        self.do_rollback = False


def _source_id():
    return uuid.UUID(str(run(fetch(
        "SELECT id FROM scraper_sources WHERE source_name = 'PakistanCode'"
    ))[0][0]))


def _wipe(short=SHORT):
    run(execute(
        "DELETE FROM record_embedding_chunks WHERE record_id IN "
        "(SELECT id FROM statutes_master WHERE short_name = :s)",
        "DELETE FROM embedding_queue WHERE record_id IN "
        "(SELECT id FROM statutes_master WHERE short_name = :s)",
        "DELETE FROM embedding_attempts WHERE record_id IN "
        "(SELECT id FROM statutes_master WHERE short_name = :s)",
        "DELETE FROM corpus_lifecycle_transitions WHERE record_id IN "
        "(SELECT id FROM statutes_staging WHERE extracted_short_name = :s)",
        "DELETE FROM statutes_staging WHERE extracted_short_name = :s",
        "DELETE FROM statutes_master WHERE short_name = :s",
        params={"s": short},
    ))


def _rows(short=SHORT):
    return run(fetch(
        "SELECT id, section_number, section_text, is_repealed, harvest_at "
        "FROM statutes_master WHERE short_name = :s ORDER BY section_number",
        s=short,
    ))


def _signature(short=SHORT):
    return frozenset((row[0], row[1], row[2], row[3], row[4]) for row in _rows(short))


async def _afetch(sql, **params):
    from scraper import database

    async with database.engine.connect() as conn:
        return (await conn.execute(text(sql), params)).all()


def _staging(source_id, section, text, harvest_at, act_keys, created_at):
    from scraper.models import StatutesStaging

    return StatutesStaging(
        source_id=source_id,
        source_site=SOURCE_NAME,
        source_url="https://q04.example.invalid/statute",
        extracted_act_name=ACT,
        extracted_short_name=SHORT,
        extracted_section_number=section,
        extracted_section_title="Q04 synthetic",
        extracted_section_text=text,
        raw_text=text,
        confidence_score=0.9,
        created_at=created_at,
        parsing_metadata={
            "act_keys": list(act_keys),
            "harvest_at": harvest_at,
            "keying": "q04",
            "source_name": SOURCE_NAME,
            "section_kind": "section",
        },
    )


def _publish_sequential(rows):
    from scraper.database import SessionLocal
    from scraper.publication.retrieval import publish_statute

    source = type("Src", (), {"source_name": SOURCE_NAME})()

    async def _go():
        async with SessionLocal() as db:
            async with db.begin():
                for row in rows:
                    db.add(row)
                await db.flush()
                for row in rows:
                    await publish_statute(db, row, source)

    run(_go())


def _stage_approved(rows):
    from scraper.database import SessionLocal
    from scraper.tasks import lifecycle

    async def _go():
        async with SessionLocal() as db:
            async with db.begin():
                for row in rows:
                    db.add(row)
                await db.flush()
                for row in rows:
                    lifecycle.move_through(
                        db, row, [lifecycle.NORMALISED, lifecycle.APPROVED], actor=lifecycle.ACTOR_GATE,
                    )
                return {row.extracted_section_number: row.id for row in rows}

    return run(_go())


def _forbid(exc):
    code = sqlstate(exc)
    assert code not in LOCK_STATES, f"{code}: {exc}"


def _publish_phase():
    from scraper.tasks import lifecycle
    from scraper.tasks.corpus_pipeline import PHASES

    return next(
        phase for phase in PHASES[lifecycle.JOB_TYPE_PUBLISH]
        if phase.name == "publish" and phase.state == lifecycle.APPROVED
    )


async def _seen_for(our_ids):
    from scraper.models import ScraperStaging, StatutesStaging

    cases = await _afetch("SELECT id FROM scraper_staging WHERE lifecycle_state = 'approved'")
    statutes = await _afetch("SELECT id FROM statutes_staging WHERE lifecycle_state = 'approved'")
    ours = {uuid.UUID(str(item)) for item in our_ids}
    return {
        ScraperStaging: [uuid.UUID(str(row[0])) for row in cases],
        StatutesStaging: [uuid.UUID(str(row[0])) for row in statutes if uuid.UUID(str(row[0])) not in ours],
    }


async def _holder_body(holder, seen, phase, claim_gate):
    from scraper.database import SessionLocal
    from scraper.tasks.corpus_pipeline import _claim_oldest
    from scraper.tasks.publish import publish

    try:
        async with SessionLocal() as db:
            async with db.begin():
                await db.execute(text("SET LOCAL lock_timeout = '15s'"))
                await db.execute(text("SET LOCAL statement_timeout = '30s'"))
                holder.pid = (await db.execute(text("SELECT pg_backend_pid()"))).scalar_one()
                await claim_gate.wait()
                row = await _claim_oldest(db, phase, seen)
                assert row is not None, "claim returned no row"
                holder.row_id = row.id
                holder.key = row.extracted_section_number
                holder.claimed.set()
                await holder.start_publish.wait()
                holder.state = await publish(db, row)
                holder.published_id = row.published_id
                holder.publish_returned.set()
                await holder.release.wait()
                if holder.do_rollback:
                    raise RuntimeError("q04 deliberate rollback")
    except Exception as exc:
        _forbid(exc)
        if isinstance(exc, RuntimeError) and "deliberate rollback" in str(exc):
            holder.rolled_back = True
            holder.claimed.set()
            holder.publish_returned.set()
            return
        holder.error = exc
        holder.claimed.set()
        holder.publish_returned.set()
        raise


async def _wait_for_waiter(pid):
    from scraper import database
    from scraper.publication.retrieval import STATUTE_LOCK_NAMESPACE, statute_act_lock_key

    key = statute_act_lock_key(SHORT)
    last = []
    async with database.engine.connect() as conn:
        for _ in range(2000):
            last = (await conn.execute(text(
                "SELECT pid, granted FROM pg_locks "
                "WHERE locktype = 'advisory' AND classid = :ns AND objid = hashtext(:key)"
            ), {"ns": STATUTE_LOCK_NAMESPACE, "key": key})).all()
            if any(row.pid == pid and row.granted is False for row in last):
                return last
            await asyncio.sleep(0)
    raise AssertionError(f"pid {pid} never waited on advisory act lock {key}: {last}")


async def _republish(staging_id):
    from sqlalchemy import select

    from scraper.database import SessionLocal
    from scraper.models import StatutesStaging
    from scraper.tasks.publish import publish

    async with SessionLocal() as db:
        async with db.begin():
            row = (await db.execute(
                select(StatutesStaging).where(StatutesStaging.id == staging_id)
            )).scalars().one()
            state = await publish(db, row)
            return state, row.published_id, row.extracted_section_number


def _seed_unique(source_id):
    h1_keys = ["1", "2"]
    _publish_sequential([
        _staging(source_id, "1", TEXT_A, T1, h1_keys, datetime(2026, 11, 1, 0, 0, 1, tzinfo=timezone.utc)),
        _staging(source_id, "2", TEXT_B, T1, h1_keys, datetime(2026, 11, 1, 0, 0, 2, tzinfo=timezone.utc)),
    ])
    stored = {row[1]: row for row in _rows()}
    assert set(stored) == {"1", "2"}
    assert all(row[4] == _when(T1) for row in stored.values())
    assert run(fetch(
        "SELECT count(*) FROM statutes_master WHERE short_name = :s AND harvest_at IS NULL",
        s=SHORT,
    ))[0][0] == 0
    sha_b, sha_c = _sha("2", TEXT_B), _sha("2", TEXT_C)
    h2_keys = ["1", sha_b, sha_c]
    bodies = {"1": TEXT_A, sha_b: TEXT_B, sha_c: TEXT_C}
    created = {
        sha_c: datetime(2026, 11, 2, 0, 0, 1, tzinfo=timezone.utc),
        sha_b: datetime(2026, 11, 2, 0, 0, 2, tzinfo=timezone.utc),
        "1": datetime(2026, 11, 2, 0, 0, 3, tzinfo=timezone.utc),
    }
    ids = _stage_approved([
        _staging(source_id, key, bodies[key], T2, h2_keys, created[key]) for key in (sha_c, sha_b, "1")
    ])
    return {
        "id1": stored["1"][0], "id2": stored["2"][0],
        "sha_b": sha_b, "sha_c": sha_c, "ids": ids,
    }


def _seed_repeated(source_id):
    sha_b, sha_c = _sha("2", TEXT_B), _sha("2", TEXT_C)
    h1_keys = [sha_b, sha_c]
    _publish_sequential([
        _staging(source_id, sha_b, TEXT_B, T1, h1_keys, datetime(2026, 11, 1, 0, 0, 1, tzinfo=timezone.utc)),
        _staging(source_id, sha_c, TEXT_C, T1, h1_keys, datetime(2026, 11, 1, 0, 0, 2, tzinfo=timezone.utc)),
    ])
    stored = {row[1]: row for row in _rows()}
    sha_b2, sha_c2 = _sha("2", TEXT_B2), _sha("2", TEXT_C2)
    h2_keys = [sha_b2, sha_c2]
    created = {
        sha_b2: datetime(2026, 11, 2, 0, 0, 1, tzinfo=timezone.utc),
        sha_c2: datetime(2026, 11, 2, 0, 0, 2, tzinfo=timezone.utc),
    }
    ids = _stage_approved([
        _staging(source_id, sha_b2, TEXT_B2, T2, h2_keys, created[sha_b2]),
        _staging(source_id, sha_c2, TEXT_C2, T2, h2_keys, created[sha_c2]),
    ])
    return {
        "old_b": stored[sha_b][0], "old_c": stored[sha_c][0],
        "sha_b": sha_b, "sha_c": sha_c, "sha_b2": sha_b2, "sha_c2": sha_c2, "ids": ids,
    }


async def _claim_pair(ids):
    phase = _publish_phase()
    seen = await _seen_for(ids.values())
    s1, s2 = _Holder(), _Holder()
    first, second = asyncio.Event(), asyncio.Event()
    first.set()
    t1 = asyncio.create_task(_holder_body(s1, seen, phase, first))
    t2 = asyncio.create_task(_holder_body(s2, seen, phase, second))
    await s1.claimed.wait()
    second.set()
    await s2.claimed.wait()
    assert s1.row_id != s2.row_id
    assert s1.error is None and s2.error is None
    return s1, s2, t1, t2


async def _release_in_order(leader, follower, leader_task, follower_task):
    leader.start_publish.set()
    await leader.publish_returned.wait()
    assert leader.error is None, leader.error
    follower.start_publish.set()
    await _wait_for_waiter(follower.pid)
    leader.release.set()
    await leader_task
    assert leader.error is None, leader.error
    await follower.publish_returned.wait()
    assert follower.error is None, follower.error
    follower.release.set()
    await follower_task
    assert follower.error is None, follower.error
    assert leader.state == "embedded" and follower.state == "embedded"


async def _assert_unique(seed, published):
    rows = await _afetch(
        "SELECT id, section_number, section_text, is_repealed, harvest_at "
        "FROM statutes_master WHERE short_name = :s",
        s=SHORT,
    )
    by_id = {row[0]: row for row in rows}
    sha_b, sha_c = seed["sha_b"], seed["sha_c"]
    assert by_id[seed["id2"]][1] == sha_b
    assert by_id[seed["id2"]][2] == TEXT_B and by_id[seed["id2"]][3] is False
    created = [row for row in rows if row[1] == sha_c]
    assert len(created) == 1 and created[0][2] == TEXT_C and created[0][3] is False
    assert created[0][0] != seed["id2"]
    assert not any(row[1] == "2" for row in rows)
    assert len(rows) == 3
    assert by_id[seed["id2"]][1] != sha_c
    by_key = {row[1]: row[0] for row in rows}
    assert published[sha_c] == by_key[sha_c]
    assert published[sha_b] == by_key[sha_b]
    assert published["1"] == by_key["1"]
    assert all(row[4] == _when(T2) for row in rows)


async def _play(seed, *, first="s1", rollback=False, barrier=False):
    sha_b, sha_c = seed["sha_b"], seed["sha_c"]
    s1, s2, t1, t2 = await _claim_pair(seed["ids"])
    assert s1.key == sha_c and s2.key == sha_b, (s1.key, s2.key)
    published = {}
    if barrier:
        s1.start_publish.set()
        s2.start_publish.set()
        while not (s1.publish_returned.is_set() or s2.publish_returned.is_set()):
            await asyncio.sleep(0)
        winner, loser = (s1, s2) if s1.publish_returned.is_set() else (s2, s1)
        winner_task, loser_task = (t1, t2) if winner is s1 else (t2, t1)
        assert not loser.publish_returned.is_set()
        locks = await _wait_for_waiter(loser.pid)
        assert any(row.pid == winner.pid and row.granted is True for row in locks)
        winner.release.set()
        await winner_task
        await loser.publish_returned.wait()
        loser.release.set()
        await loser_task
        assert winner.error is None and loser.error is None
        assert winner.state == "embedded" and loser.state == "embedded"
        published[s1.key] = s1.published_id
        published[s2.key] = s2.published_id
    elif rollback:
        s1.start_publish.set()
        await s1.publish_returned.wait()
        assert s1.error is None
        s1.do_rollback = True
        s1.release.set()
        await t1
        assert s1.rolled_back is True
        meta_rows = await _afetch(
            "SELECT parsing_metadata, lifecycle_state FROM statutes_staging WHERE id = :id",
            id=s1.row_id,
        )
        meta, state = meta_rows[0][0] or {}, meta_rows[0][1]
        assert "identity_harvest_pairs" not in meta
        assert "identity_successor_of" not in meta
        assert state == "approved"
        stamped = await _afetch(
            "SELECT count(*) FROM statutes_master WHERE short_name = :s AND harvest_at = :t",
            s=SHORT, t=_when(T2),
        )
        assert stamped[0][0] == 0
        # Release the follower's claim gate only after the rollback is visible.
        # The follower was already claimed; start its publish now, as the new first publish.
        s2.start_publish.set()
        await s2.publish_returned.wait()
        assert s2.error is None and s2.state == "embedded"
        s2.release.set()
        await t2
        state, published_id, key = await _republish(s1.row_id)
        assert state == "embedded" and key == sha_c
        published[sha_c] = published_id
        published[sha_b] = s2.published_id
    elif first == "s1":
        await _release_in_order(s1, s2, t1, t2)
        published[sha_c] = s1.published_id
        published[sha_b] = s2.published_id
    else:
        await _release_in_order(s2, s1, t2, t1)
        published[sha_b] = s2.published_id
        published[sha_c] = s1.published_id
    state, published_id, key = await _republish(seed["ids"]["1"])
    assert state == "embedded" and key == "1"
    published["1"] = published_id
    await _assert_unique(seed, published)


async def _play_multi(seed, *, first="s1"):
    s1, s2, t1, t2 = await _claim_pair(seed["ids"])
    assert s1.key == seed["sha_b2"] and s2.key == seed["sha_c2"]
    if first == "s1":
        await _release_in_order(s1, s2, t1, t2)
    else:
        await _release_in_order(s2, s1, t2, t1)
    rows = await _afetch(
        "SELECT id, section_number, is_repealed FROM statutes_master WHERE short_name = :s",
        s=SHORT,
    )
    by_id = {row[0]: row for row in rows}
    assert by_id[seed["old_b"]][1] == seed["sha_b"] and by_id[seed["old_b"]][2] is True
    assert by_id[seed["old_c"]][1] == seed["sha_c"] and by_id[seed["old_c"]][2] is True
    live = [row for row in rows if row[2] is False]
    assert {row[1] for row in live} == {seed["sha_b2"], seed["sha_c2"]}
    assert all(row[0] not in {seed["old_b"], seed["old_c"]} for row in live)
    for staging_id in (s1.row_id, s2.row_id):
        meta_rows = await _afetch(
            "SELECT parsing_metadata, lifecycle_state FROM statutes_staging WHERE id = :id",
            id=staging_id,
        )
        meta, state = meta_rows[0][0] or {}, meta_rows[0][1]
        assert state == "embedded"
        assert "identity_successor_of" not in meta


def test_q04_concurrent_publish_r1_to_r4(corpus_db):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    source_id = _source_id()
    signatures = []
    for kwargs in ({"first": "s1"}, {"first": "s2"}, {"barrier": True}, {"first": "s1", "rollback": True}):
        _wipe()
        seed = _seed_unique(source_id)
        run(_play(seed, **kwargs))
        signatures.append(_signature())
    assert signatures[0] == signatures[1] == signatures[2] == signatures[3]


def test_q04_concurrent_publish_r5_both_orders(corpus_db):
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    source_id = _source_id()
    signatures = []
    for first in ("s1", "s2"):
        _wipe()
        seed = _seed_repeated(source_id)
        run(_play_multi(seed, first=first))
        signatures.append(_signature())
    assert signatures[0] == signatures[1]
    live = [row for row in signatures[0] if row[3] is False]
    retired = [row for row in signatures[0] if row[3] is True]
    assert len(live) == 2 and len(retired) == 2
    assert {row[0] for row in live}.isdisjoint({row[0] for row in retired})
