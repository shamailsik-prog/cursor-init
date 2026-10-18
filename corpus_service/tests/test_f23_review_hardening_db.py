"""Audit F23 re-audit round 2 (L1-L7) end to end against real Postgres 16 + pgvector.

The real application, the real admin key, the DML-only runtime role and quarantine rows made by the
real promotion, exactly as tests/test_f23_quarantine_review_db.py sets them up (its fixtures and
helpers are reused). Spec: docs/superpowers/specs/2026-10-18-f23-auditable-quarantine-promotion-design.md,
section 7.

* L1 (ruling 23): one test per mutant that survived the re-audit (Q02, Q03, Q05, Q07b, R01, R02, R07;
  Q08 and Q09 are L2's). The code was already right; these pin it, and each fails on its mutant.
* L2 (ruling 24): the source row's FOR SHARE lock, observed waiting in pg_stat_activity.
* L3 (ruling 19): SQLSTATE 40001 / 40P01 are 409 and 55P03 / 57014 are 503, after rollback.
* L4, L5 (ruling 18): a 422 never echoes the input, and is small.
* L6 (rulings 20, 21): an Idempotency-Key replays only the body it was sent with; migration 003.
* L7 (ruling 22): visually blank reviewer names and reasons are 422.

Expected values are written out from the spec, not imported from the code under test, and this file
imports no module main lacks.
"""

import asyncio
import hashlib
import json
import time
import uuid

import pytest
from sqlalchemy import text

from test_f23_quarantine_review_db import (  # noqa: F401 - fixtures
    OTHER_REVIEWER,
    REASON,
    REVIEW_SOURCE,
    REVIEWER,
    admin_headers,
    body,
    client,
    decide,
    decision_count,
    decisions_for,
    detail,
    error_code,
    is_pending,
    master_rows,
    q,
    queue_row,
    review,
    staging_row,
    x,
)

CITATION_LOCK_NAMESPACE = 0x0F23  # spec ruling 8
DECISIONS = "quarantine_decisions"


def make_record(corpus_db, *, citation=None, source=REVIEW_SOURCE, title=None):
    """A staging row of ``source`` and its pending quarantine_queue row, as promotion leaves them."""
    title = title or f"F23 round two {uuid.uuid4().hex[:8]} v. The State (synthetic 2099)"
    sid = q(corpus_db,
            "INSERT INTO scraper_staging (source_id, source_site, source_url, raw_text, extracted_citation, "
            "extracted_title, confidence_score, normalised, quarantined, quarantine_reason, parsing_metadata) "
            "SELECT s.id, s.source_name, 'https://example.invalid/f23/r2', :raw, :c, :t, 0.9, true, true, "
            "'review_source', CAST(:m AS jsonb) FROM scraper_sources s WHERE s.source_name = :src RETURNING id",
            raw=f"F23 SYNTHETIC JUDGMENT TEXT {title}", c=citation, t=title,
            m=json.dumps({"source_name": source, "extraction_method": "html"}), src=source)[0]["id"]
    qid = q(corpus_db,
            "INSERT INTO quarantine_queue (staging_id, source_site, source_url, extracted_citation, extracted_title, "
            "reason) VALUES (:sid, :site, 'https://example.invalid/f23/r2', :c, :t, 'review_source') RETURNING id",
            sid=sid, site=source, c=citation, t=title)[0]["id"]
    return str(qid), str(sid)


async def _waiting(admin, user, wait_event=None):
    """The runtime role's backends waiting on a lock now: (count, their queries)."""
    sql = "SELECT query FROM pg_stat_activity WHERE usename = :u AND wait_event_type = 'Lock'"
    params = {"u": user}
    if wait_event is not None:
        sql += " AND wait_event = :e"
        params["e"] = wait_event
    async with admin.connect() as conn:
        rows = (await conn.execute(text(sql), params)).scalars().all()
    return len(rows), list(rows)


async def _waiter_locks_on(admin, user, relation):
    """The locks the runtime role's waiting backends hold or wait for on ``relation``. A row-level
    wait shows as a tuple lock whose mode is the row-lock strength: RowShareLock for FOR SHARE."""
    async with admin.connect() as conn:
        rows = (await conn.execute(text(
            "SELECT l.locktype, l.mode, l.granted FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid "
            "WHERE a.usename = :u AND a.wait_event_type = 'Lock' AND l.relation = to_regclass(:r)"),
            {"u": user, "r": relation})).all()
    return sorted({(r.locktype, r.mode, r.granted) for r in rows})


async def _until_waiting(admin, user, tasks, n, *, wait_event=None, seconds=30):
    count, queries = 0, []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        count, queries = await _waiting(admin, user, wait_event)
        if count + sum(t.done() for t in tasks) >= n:
            break
        await asyncio.sleep(0.05)
    return count, queries


ANSWER_SECONDS = 30  # a request the test has released answers well within this


async def _answered(awaitable, release, seconds=ANSWER_SECONDS):
    """The request(s) ``awaitable`` resolves to. If they are still waiting after ``seconds`` (the
    code took a lock in another order than the test expects), ``release`` frees whatever the test
    holds, the requests are let finish, and the test fails instead of hanging."""
    task = asyncio.ensure_future(awaitable)
    try:
        return await asyncio.wait_for(asyncio.shield(task), seconds)
    except asyncio.TimeoutError:
        await release()
        await asyncio.wait_for(task, seconds)
        raise AssertionError(f"a request was still waiting {seconds} s after the test released it") from None


async def _nothing():
    return None


def _asgi_client():
    import httpx

    from scraper.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                             base_url="http://testserver")


def _post(ac, qid, action, *, reviewer=REVIEWER, reason=REASON, key=None):
    return ac.post(f"/quarantine/{qid}/{action}", json=body(reviewer, reason), headers=admin_headers(key))


# ---------------------------------------------------------------------------------------------
# L1: the surviving mutants, pinned
# ---------------------------------------------------------------------------------------------
def test_l1_rows_that_are_not_pending_are_409_and_write_nothing(client, review, corpus_db):
    """Mutants Q02 (reviewed ignored) and Q03 (resolution ignored). Only pending is decidable: a row
    main's promote marked reviewed (resolution still 'pending'), and needs_edit / escalated rows, are
    409 already_resolved with no decision; a row with a NULL resolution is pending (ruling 1)."""
    records, _user, _pw = review
    x(corpus_db, "UPDATE quarantine_queue SET reviewed = true WHERE id = :i", i=records["alpha"].qid)
    x(corpus_db, "UPDATE quarantine_queue SET resolution = 'needs_edit' WHERE id = :i", i=records["race1"].qid)
    x(corpus_db, "UPDATE quarantine_queue SET resolution = 'escalated' WHERE id = :i", i=records["race2"].qid)
    x(corpus_db, "UPDATE quarantine_queue SET resolution = NULL WHERE id = :i", i=records["nocite"].qid)
    observed = {}
    for label, action in (("alpha", "promote"), ("alpha", "reject"), ("race1", "promote"), ("race1", "reject"),
                          ("race2", "promote"), ("race2", "reject")):
        res = decide(client, records[label].qid, action)
        d = detail(res)
        observed[f"{label} {action}"] = (res.status_code, error_code(res),
                                         d.get("decision") if isinstance(d, dict) else "not a dict")
    observed["master rows for the reviewed row"] = len(master_rows(corpus_db, citation=records["alpha"].citation))
    observed["decisions before the NULL-resolution row"] = decision_count(corpus_db)
    observed["NULL resolution promote"] = decide(client, records["nocite"].qid, "promote").status_code
    refused = (409, "already_resolved", None)
    assert observed == {
        "alpha promote": refused, "alpha reject": refused, "race1 promote": refused, "race1 reject": refused,
        "race2 promote": refused, "race2 reject": refused,
        "master rows for the reviewed row": 0,
        "decisions before the NULL-resolution row": 0,
        "NULL resolution promote": 200,
    }


def test_l1_two_queue_rows_on_one_staging_row_publish_once(client, review, corpus_db):
    """Mutant Q05 (staging_already_promoted check removed): the second queue row over an already
    promoted staging row is 409 and does not overwrite the lineage."""
    first_qid, sid = make_record(corpus_db, citation=None)
    second_qid = str(q(corpus_db,
                       "INSERT INTO quarantine_queue (staging_id, source_site, source_url, extracted_citation, "
                       "extracted_title, reason) SELECT staging_id, source_site, source_url, extracted_citation, "
                       "extracted_title, reason FROM quarantine_queue WHERE id = :i RETURNING id", i=first_qid)[0]["id"])
    first = decide(client, first_qid, "promote")
    lineage = str(staging_row(corpus_db, sid)["promoted_to_id"])
    second = decide(client, second_qid, "promote")
    title = queue_row(corpus_db, first_qid)["extracted_title"]
    observed = {
        "first": first.status_code,
        "second": (second.status_code, error_code(second), (detail(second) or {}).get("promoted_to_id")),
        "master rows for the staging row": len(master_rows(corpus_db, title=title)),
        "lineage after the second": str(staging_row(corpus_db, sid)["promoted_to_id"]),
        "second still pending": is_pending(queue_row(corpus_db, second_qid)),
    }
    assert observed == {
        "first": 200,
        "second": (409, "staging_already_promoted", lineage),
        "master rows for the staging row": 1,
        "lineage after the second": lineage,
        "second still pending": True,
    }


def test_l1_another_key_on_a_promoted_record_is_409_not_a_replay(client, review, corpus_db):
    """Mutant R01 (the replay ignores the key's value): a different Idempotency-Key is another
    request, so a resolved record answers 409, never another reviewer's stored result."""
    records, _user, _pw = review
    qid = records["nocite"].qid
    first = decide(client, qid, "promote", key="f23-r2-first")
    second = decide(client, qid, "promote", key="f23-r2-second", reviewer=OTHER_REVIEWER)
    assert (first.status_code, second.status_code, error_code(second)) == (200, 409, "already_resolved")
    assert decision_count(corpus_db) == 1


def test_l1_a_padded_citation_is_refused_as_already_published(client, review, corpus_db):
    """Mutant R02 (the citation is not trimmed before the collision check): a queue row whose
    citation is the published one with surrounding spaces must not publish a second row."""
    records, _user, _pw = review
    citation = records["alpha"].citation
    assert decide(client, records["alpha"].qid, "promote").status_code == 200
    padded_qid, _sid = make_record(corpus_db, citation=f"  {citation}  ")
    res = decide(client, padded_qid, "promote")
    observed = {
        "padded": (res.status_code, error_code(res)),
        "rows with the exact citation": len(master_rows(corpus_db, citation=citation)),
        "rows with the padded citation": len(master_rows(corpus_db, citation=f"  {citation}  ")),
        "still pending": is_pending(queue_row(corpus_db, padded_qid)),
    }
    assert observed == {"padded": (409, "citation_already_published"), "rows with the exact citation": 1,
                        "rows with the padded citation": 0, "still pending": True}


def test_l1_the_decision_records_the_trust_read_at_decision_time(client, review, corpus_db):
    """Mutant R07 (the quarantine-time trust is recorded): a record quarantined while its source was
    'review' and promoted after the source became 'trusted' records 'trusted' (ruling 5)."""
    records, _user, _pw = review
    x(corpus_db, "UPDATE scraper_sources SET trust_level = 'trusted' WHERE source_name = :n", n=REVIEW_SOURCE)
    res = decide(client, records["race1"].qid, "promote")
    [decision] = decisions_for(corpus_db, records["race1"].qid)
    assert (res.status_code, decision["source_trust_level"]) == (200, "trusted")


def test_l1_two_records_with_one_citation_serialise_on_the_advisory_lock(review, corpus_db):
    """Mutant Q07b (the per-citation advisory lock removed): with the citation's lock held from
    outside, both promotes are seen waiting on it; released together, one publishes and the other is
    refused with exactly 409 citation_already_published (without the lock the unique key would still
    stop a second row, but as a 409 conflict at commit)."""
    from scraper.tasks.promotion import citation_lock_key

    _records, user, _pw = review
    citation = "2099 SCMR 2350"
    qids = [make_record(corpus_db, citation=citation)[0] for _ in range(2)]

    async def go():
        admin = corpus_db.engine_for(corpus_db.url)
        try:
            async with admin.connect() as holder:
                await holder.begin()
                await holder.execute(text("SELECT pg_advisory_xact_lock(:n, hashtext(:k))"),
                                     {"n": CITATION_LOCK_NAMESPACE, "k": citation_lock_key(citation)})
                async with _asgi_client() as ac:
                    tasks = [asyncio.create_task(_post(ac, qid, "promote", reviewer=reviewer))
                             for qid, reviewer in zip(qids, (REVIEWER, OTHER_REVIEWER))]
                    waiting, _queries = await _until_waiting(admin, user, tasks, 2, wait_event="advisory")
                    await holder.rollback()
                    return waiting, await _answered(asyncio.gather(*tasks), _nothing)
        finally:
            await admin.dispose()

    waiting, responses = asyncio.run(go())
    observed = {
        "waiting on the citation's advisory lock": waiting,
        "statuses": sorted(r.status_code for r in responses),
        "loser": [error_code(r) for r in responses if r.status_code != 200],
        "rows with the citation": len(master_rows(corpus_db, citation=citation)),
    }
    assert observed == {"waiting on the citation's advisory lock": 2, "statuses": [200, 409],
                        "loser": ["citation_already_published"], "rows with the citation": 1}


# ---------------------------------------------------------------------------------------------
# L2: the source FOR SHARE lock is observable
# ---------------------------------------------------------------------------------------------
def test_l2_the_source_for_share_lock_waits_for_a_concurrent_block(review, corpus_db):
    """Mutants Q08 (the source is not re-read under FOR SHARE) and Q09 (populate_existing dropped).
    A transaction blocking the source is in flight: the promote waits on the source row (seen in
    pg_stat_activity), and after the block commits it is refused blocked_source (ruling 24)."""
    records, user, _pw = review
    qid = records["race1"].qid

    async def go():
        admin = corpus_db.engine_for(corpus_db.url)
        try:
            async with admin.connect() as holder:
                await holder.begin()
                await holder.execute(text("UPDATE scraper_sources SET trust_level = 'blocked' WHERE source_name = :n"),
                                     {"n": REVIEW_SOURCE})
                async with _asgi_client() as ac:
                    task = asyncio.create_task(_post(ac, qid, "promote"))
                    waiting, queries = await _until_waiting(admin, user, [task], 1)
                    locks = await _waiter_locks_on(admin, user, "scraper_sources")
                    finished_early = task.done()
                    await holder.commit()
                    return waiting, (queries, locks), finished_early, await _answered(task, _nothing)
        finally:
            await admin.dispose()

    waiting, (queries, locks), finished_early, res = asyncio.run(go())
    d = detail(res)
    observed = {
        "waiting": waiting,
        # pg_stat_activity cuts the query text at track_activity_query_size, so the lock is read from
        # pg_locks: the waiter holds the tuple lock of a FOR SHARE (RowShareLock) on scraper_sources.
        "the wait is a SELECT on scraper_sources": all(s.startswith("SELECT scraper_sources.") for s in queries)
        and bool(queries),
        "the waiter's tuple lock is FOR SHARE": ("tuple", "RowShareLock", True) in locks,
        "answered before the block committed": finished_early,
        "answer": (res.status_code, error_code(res), d.get("trust_reason") if isinstance(d, dict) else None),
        "still pending": is_pending(queue_row(corpus_db, qid)),
        "decisions": decision_count(corpus_db),
    }
    assert observed == {"waiting": 1, "the wait is a SELECT on scraper_sources": True,
                        "the waiter's tuple lock is FOR SHARE": True,
                        "answered before the block committed": False,
                        "answer": (409, "source_not_promotable", "blocked_source"), "still pending": True,
                        "decisions": 0}, (queries, locks)


# ---------------------------------------------------------------------------------------------
# L3: contention is 409 or 503 after rollback, never 500
# ---------------------------------------------------------------------------------------------
# sqlstate: (role settings for the runtime role, status, error, Retry-After) from spec ruling 19.
CONTENTION = {
    "40001": ({"default_transaction_isolation": "'repeatable read'"}, 409, "transaction_aborted", None),
    "40P01": ({"deadlock_timeout": "'2s'"}, 409, "transaction_aborted", None),
    "55P03": ({"lock_timeout": "'300ms'"}, 503, "database_busy", "1"),
    "57014": ({"statement_timeout": "'300ms'"}, 503, "database_busy", "1"),
}


async def _contend(corpus_db, user, qid, sid, sqlstate):
    """Make the promote of ``qid`` meet ``sqlstate`` deterministically and return its response."""
    admin = corpus_db.engine_for(corpus_db.url)
    try:
        async with admin.connect() as holder:
            await holder.begin()
            async with _asgi_client() as ac:
                if sqlstate == "40001":
                    # A concurrent update of the queue row commits after the request's snapshot: under
                    # REPEATABLE READ its FOR UPDATE cannot serialise.
                    await holder.execute(text("UPDATE quarantine_queue SET source_url = source_url WHERE id = :i"),
                                         {"i": qid})
                    task = asyncio.create_task(_post(ac, qid, "promote"))
                    await _until_waiting(admin, user, [task], 1)
                    await holder.commit()
                    return await _answered(task, _nothing)
                if sqlstate == "40P01":
                    # The holder takes the staging row, the request takes the queue row and waits for the
                    # staging row, then the holder asks for the queue row: a cycle. The request's
                    # deadlock check (2 s) fires long before the holder's (30 s), so the request is the
                    # one aborted. The holder never waits more than 20 s itself.
                    await holder.execute(text("SET LOCAL deadlock_timeout = '30s'"))
                    await holder.execute(text("SET LOCAL lock_timeout = '20s'"))
                    await holder.execute(text("SELECT 1 FROM scraper_staging WHERE id = :i FOR UPDATE"), {"i": sid})
                    task = asyncio.create_task(_post(ac, qid, "promote"))
                    await _until_waiting(admin, user, [task], 1)
                    closing = asyncio.create_task(holder.execute(
                        text("SELECT 1 FROM quarantine_queue WHERE id = :i FOR UPDATE"), {"i": qid}))

                    async def release():
                        await asyncio.gather(closing, return_exceptions=True)
                        await holder.rollback()

                    res = await _answered(task, release)
                    await release()
                    return res
                # 55P03 / 57014: the queue row is held while the request's lock or statement times out.
                await holder.execute(text("SELECT 1 FROM quarantine_queue WHERE id = :i FOR UPDATE"), {"i": qid})
                res = await _answered(_post(ac, qid, "promote"), holder.rollback)
                await holder.rollback()
                return res
    finally:
        await admin.dispose()


@pytest.mark.parametrize("sqlstate", sorted(CONTENTION))
def test_l3_contention_is_409_or_503_after_rollback(client, review, corpus_db, sqlstate):
    records, user, _pw = review
    rec = records["race1"]
    settings_for_role, status, error, retry_after = CONTENTION[sqlstate]
    for name, value in settings_for_role.items():
        corpus_db.admin(f'ALTER ROLE "{user}" SET {name} = {value}')
    res = asyncio.run(_contend(corpus_db, user, rec.qid, rec.staging_id, sqlstate))
    for name in settings_for_role:
        corpus_db.admin(f'ALTER ROLE "{user}" RESET {name}')
    d = detail(res)
    observed = {
        "status": res.status_code,
        "detail": d if isinstance(d, dict) else res.text[:200],
        "Retry-After": res.headers.get("retry-after"),
        "SQL or driver text in the body": any(s in res.text for s in ("SELECT", "quarantine_queue", "asyncpg")),
        "still pending": is_pending(queue_row(corpus_db, rec.qid)),
        "decisions": decision_count(corpus_db),
        "a retry": decide(client, rec.qid, "promote").status_code,
    }
    assert observed == {
        "status": status,
        "detail": {"error": error, "sqlstate": sqlstate, "retryable": True},
        "Retry-After": retry_after,
        "SQL or driver text in the body": False,
        "still pending": True,
        "decisions": 0,
        "a retry": 200,
    }


# ---------------------------------------------------------------------------------------------
# L4, L5: a 422 never echoes the input
# ---------------------------------------------------------------------------------------------
def test_l4_l5_a_422_never_echoes_the_input_and_stays_small(client, review, corpus_db):
    records, _user, _pw = review
    qid = records["reject_me"].qid
    url = f"/quarantine/{qid}/reject"
    raw = {
        "lone surrogate in the reviewer": b'{"reviewer": "a\\ud800b", "reason": "ok"}',
        "lone surrogate in the reason": b'{"reviewer": "Reviewer", "reason": "\\udfff"}',
        "lone surrogate as an unknown field's name": b'{"reviewer": "Reviewer", "reason": "ok", "\\ud800x": 1}',
        "a 20,000-character reviewer": json.dumps({"reviewer": "r" * 20_000, "reason": "ok"}).encode(),
        "malformed JSON": b'{"reviewer": "Reviewer", ',
    }
    observed = {}
    for label, content in raw.items():
        res = client.post(url, content=content, headers={**admin_headers(), "Content-Type": "application/json"})
        entries = res.json().get("detail") if res.headers.get("content-type", "").startswith("application/json") else None
        observed[label] = {
            "status": res.status_code,
            "under 2 KB": len(res.content) < 2048,
            "echoes input": not isinstance(entries, list) or any("input" in e or "ctx" in e for e in entries)
            or "rrrrrrrrrr" in res.text,
        }
    huge = client.post(url, json={"reviewer": "r" * 10_000_000, "reason": "ok"}, headers=admin_headers())
    observed["a 10 MB reviewer"] = (huge.status_code, len(huge.content) < 2048)
    observed["still pending"] = is_pending(queue_row(corpus_db, qid))
    clean = {"status": 422, "under 2 KB": True, "echoes input": False}
    assert observed == {**{label: clean for label in raw}, "a 10 MB reviewer": (413, True), "still pending": True}


# ---------------------------------------------------------------------------------------------
# L6: an Idempotency-Key replays only the body it was sent with
# ---------------------------------------------------------------------------------------------
def fingerprint(decision, reviewer, reason):
    """Spec ruling 20, written out here: SHA-256 of the canonical JSON of the validated values."""
    canonical = json.dumps({"decision": decision, "reason": reason, "reviewer": reviewer},
                           sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("ascii")).hexdigest()


def test_l6_the_same_key_with_another_body_is_422_not_a_replay(client, review, corpus_db):
    records, _user, _pw = review
    qid = records["alpha"].qid
    key = f"f23-r2-l6-{uuid.uuid4()}"
    first = decide(client, qid, "promote", key=key)
    responses = {
        "another reviewer": decide(client, qid, "promote", key=key, reviewer=OTHER_REVIEWER),
        "another reason": decide(client, qid, "promote", key=key, reason="Another reason (synthetic)"),
        "the same body": decide(client, qid, "promote", key=key),
        "the same body padded": decide(client, qid, "promote", key=key, reviewer=f"  {REVIEWER} "),
        "the other decision": decide(client, qid, "reject", key=key),
    }
    rows = q(corpus_db, f"SELECT * FROM {DECISIONS} WHERE quarantine_id = :i", i=qid)
    observed = {label: (r.status_code, error_code(r) if r.status_code != 200 else r.json().get("replayed"))
                for label, r in responses.items()}
    observed["first"] = first.status_code
    observed["decisions"] = len(rows)
    observed["stored fingerprint"] = rows[0].get("request_fingerprint") if rows else None
    assert observed == {
        "first": 200,
        "another reviewer": (422, "idempotency_key_reused"),
        "another reason": (422, "idempotency_key_reused"),
        "the same body": (200, True),
        "the same body padded": (200, True),  # the fingerprint is over the validated (trimmed) values
        "the other decision": (409, "already_resolved"),
        "decisions": 1,
        "stored fingerprint": fingerprint("promoted", REVIEWER, REASON),
    }


def test_l6_migration_003_adds_the_fingerprint_and_a_row_without_one_replays_by_its_values(client, review, corpus_db):
    records, _user, _pw = review
    columns = "SELECT column_name, data_type, character_maximum_length FROM information_schema.columns " \
              "WHERE table_name = :t AND column_name = 'request_fingerprint'"
    check = "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = :c"
    constraint = "ck_quarantine_decisions_request_fingerprint"
    observed = {"column after migrate": [dict(r) for r in q(corpus_db, columns, t=DECISIONS)],
                "constraint after migrate": len(q(corpus_db, check, c=constraint))}

    # A database migrated before 003: no column. The next migrate adds it, the one after is a no-op.
    x(corpus_db, f"ALTER TABLE {DECISIONS} DROP COLUMN IF EXISTS request_fingerprint")
    added = corpus_db.migrate()
    again = corpus_db.migrate()
    observed["migrate on a pre-003 table"] = (added.returncode, "request_fingerprint added" in added.stderr + added.stdout)
    observed["migrate again"] = (again.returncode, "request_fingerprint already current" in again.stderr + again.stdout)
    observed["column after repair"] = [dict(r) for r in q(corpus_db, columns, t=DECISIONS)]
    try:
        x(corpus_db, f"INSERT INTO {DECISIONS} (quarantine_id, decision, reviewer, reviewer_auth, reason, prior_state, "
                     "new_state, request_fingerprint) VALUES (gen_random_uuid(), 'rejected', 'R', 'shared_admin_key', 'r', "
                     "CAST('{}' AS jsonb), CAST('{}' AS jsonb), 'not-hex')")
        observed["a malformed fingerprint"] = "allowed"
    except Exception as exc:  # noqa: BLE001 - classified by SQLSTATE
        orig = getattr(exc, "orig", None)
        observed["a malformed fingerprint"] = getattr(orig, "sqlstate", None) or getattr(
            getattr(orig, "__cause__", None), "sqlstate", None)

    # A decision written before the column existed (NULL fingerprint) is compared by its stored values.
    rec = records["reject_me"]
    x(corpus_db, "UPDATE quarantine_queue SET reviewed = true, resolution = 'rejected' WHERE id = :i", i=rec.qid)
    x(corpus_db, f"INSERT INTO {DECISIONS} (quarantine_id, staging_id, decision, reviewer, reviewer_auth, reason, "
                 "prior_state, new_state, request_key) VALUES (:q, :s, 'rejected', :r, 'shared_admin_key', :why, "
                 "CAST('{}' AS jsonb), CAST('{}' AS jsonb), 'f23-legacy-key')",
      q=rec.qid, s=rec.staging_id, r=REVIEWER, why=REASON)
    same = decide(client, rec.qid, "reject", key="f23-legacy-key")
    other = decide(client, rec.qid, "reject", key="f23-legacy-key", reviewer=OTHER_REVIEWER)
    observed["legacy row, same body"] = (same.status_code, same.json().get("replayed") if same.status_code == 200 else None)
    observed["legacy row, another reviewer"] = (other.status_code, error_code(other))
    column = [{"column_name": "request_fingerprint", "data_type": "character varying", "character_maximum_length": 64}]
    assert observed == {
        "column after migrate": column,
        "constraint after migrate": 1,
        "migrate on a pre-003 table": (0, True),
        "migrate again": (0, True),
        "column after repair": column,
        "a malformed fingerprint": "23514",
        "legacy row, same body": (200, True),
        "legacy row, another reviewer": (422, "idempotency_key_reused"),
    }


# ---------------------------------------------------------------------------------------------
# L7: visually blank names and reasons
# ---------------------------------------------------------------------------------------------
BLANK_REVIEWERS = {
    "Hangul filler U+3164": "\u3164",
    "halfwidth Hangul filler U+FFA0": "\uffa0",
    "Hangul choseong and jungseong fillers": "\u115f\u1160",
    "braille blank U+2800": "\u2800",
    "combining marks only": "\u0301\u0308",
    "line separator U+2028 inside": "Reviewer\u2028F23",
    "paragraph separator U+2029 inside": "Reviewer\u2029F23",
    "ideographic space and a filler": "\u3000\u3164\u3000",
    "punctuation only": "...",
}
BLANK_REASONS = {
    "braille blank U+2800": "\u2800",
    "punctuation only": "-- . --",
    "paragraph separator U+2029 inside": "Checked\u2029again",
}
VISIBLE_REVIEWERS = {
    "Urdu": "\u0634\u0645\u0627\u0626\u0644 \u0633\u06a9\u0646\u062f\u0631",
    "decomposed accent": "Zai\u0308d",
    "digits": "007",
}


def test_l7_visually_blank_names_and_reasons_are_422(client, review, corpus_db):
    records, _user, _pw = review
    qid = records["reject_me"].qid
    observed = {f"reviewer: {label}": decide(client, qid, "reject", reviewer=name).status_code
                for label, name in BLANK_REVIEWERS.items()}
    observed.update({f"reason: {label}": decide(client, qid, "reject", reason=why).status_code
                     for label, why in BLANK_REASONS.items()})
    observed["still pending"] = is_pending(queue_row(corpus_db, qid))
    observed["decisions"] = decision_count(corpus_db)
    for label, name in VISIBLE_REVIEWERS.items():
        fresh, _sid = make_record(corpus_db)
        res = decide(client, fresh, "reject", reviewer=name)
        stored = decisions_for(corpus_db, fresh)
        observed[f"visible: {label}"] = (res.status_code, stored[0]["reviewer"] if stored else None)
    assert observed == {
        **{f"reviewer: {label}": 422 for label in BLANK_REVIEWERS},
        **{f"reason: {label}": 422 for label in BLANK_REASONS},
        "still pending": True,
        "decisions": 0,
        # Stored as given (trimmed), not normalised.
        **{f"visible: {label}": (200, name) for label, name in VISIBLE_REVIEWERS.items()},
    }
