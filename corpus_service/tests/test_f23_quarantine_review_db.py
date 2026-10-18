"""Audit F23 end to end against real Postgres 16 + pgvector.

The real application (``scraper.main.app``) is driven with the real admin key
(``settings.ADMIN_API_KEY``): sequential requests through ``TestClient`` (startup included), the
races through ``httpx.AsyncClient`` over ``ASGITransport`` with two requests in flight. The database
is built by ``python -m scraper.migrate`` exactly as the compose ``migrate`` service runs it, and the
app is bound to a DML-only runtime role the way PR 2b provisions it.

The quarantine rows are made by the real flow: synthetic, 2099-dated staging rows are decided by the
real ``promote_staging_records()``, which quarantines every one of them (a review source, no
citation, a blocked source, an unknown source, a trusted source below the confidence threshold).
Then a reviewer promotes or rejects them through the API.

What the tests expect is written out from the spec
(docs/superpowers/specs/2026-10-18-f23-auditable-quarantine-promotion-design.md), not imported from
the code under test, and this file imports no module that main lacks: on main it fails by
behaviour (a second publication, a 500, a 200 for a missing record, no decision record, no outbox
row, a blocked source published).

Needs CORPUS_TEST_DATABASE_URL (see conftest.py); every test gets a fresh database.
"""

import asyncio
import json
import time
import uuid
from dataclasses import dataclass

import pytest
from sqlalchemy import text

REVIEWER = "Reviewer F23-A (synthetic)"
OTHER_REVIEWER = "Reviewer F23-B (synthetic)"
REASON = "Checked against the certified copy (synthetic 2099 fixture)"

REVIEW_SOURCE = "NasirLawSite"  # seeded review by migrate (F20)
LABELLED_SOURCE = "SindhHighCourtPublic"  # seeded review; shc.py stages its rows under the label below
FAMILY_LABEL = "SindhHighCourt"
TRUSTED_SOURCE = "PakistanLawSite"  # seeded trusted by migrate (F20)
BLOCKED_SOURCE = "F23BlockedSource"  # inserted blocked below
LATER_BLOCKED_SOURCE = "F23LaterBlocked"  # review when quarantined, blocked before the review
MISSING_SOURCE = "F23NoSuchSource"  # names no scraper_sources row

DECISIONS = "quarantine_decisions"
# Spec ruling 4: the published id is uuid5(NAMESPACE_URL, "corpus-service:case_law_master:" + key),
# key = "quarantine/<quarantine id>".
PUBLICATION_NAMESPACE = uuid.NAMESPACE_URL
APPEND_ONLY_SQLSTATE = "23001"  # restrict_violation (spec ruling 5)

# label: (source name or None, citation, title, confidence, the reason promotion must give)
STAGED = {
    "alpha": (REVIEW_SOURCE, "2099 SCMR 2301", "F23 Alpha v. The State", 0.9, "review_source"),
    "alpha_dup": (REVIEW_SOURCE, "2099 SCMR 2301", "F23 Alpha (second copy) v. The State", 0.9, "review_source"),
    "nocite": (REVIEW_SOURCE, None, "F23 Uncited Petitioner v. Province", 0.9, "citation_missing"),
    "race1": (REVIEW_SOURCE, "2099 SCMR 2302", "F23 Race One v. The State", 0.9, "review_source"),
    "race2": (REVIEW_SOURCE, "2099 SCMR 2303", "F23 Race Two v. The State", 0.9, "review_source"),
    "lowconf": (TRUSTED_SOURCE, "2099 SCMR 2304", "F23 Low Confidence v. The State", 0.3, "low_confidence"),
    "blocked": (BLOCKED_SOURCE, "2099 SCMR 2305", "F23 Blocked Source v. The State", 0.9, "blocked_source"),
    "later": (LATER_BLOCKED_SOURCE, "2099 SCMR 2306", "F23 Later Blocked v. The State", 0.9, "review_source"),
    "unknown": (MISSING_SOURCE, "2099 SCMR 2307", "F23 Unknown Source v. The State", 0.9, "unknown_source"),
    "reject_me": (REVIEW_SOURCE, "2099 SCMR 2308", "F23 Rejected Party v. The State", 0.9, "review_source"),
    "labelled": (LABELLED_SOURCE, "2099 SCMR 2309", "F23 Labelled Source v. The State", 0.9, "review_source"),
    "collide": (REVIEW_SOURCE, "2099 SCMR 2310", "F23 Identity Collision v. The State", 0.9, "review_source"),
}
# The staging source_site label, where a harvester writes one that is not the source's own name.
SITE_LABEL = {"labelled": FAMILY_LABEL}


@dataclass(frozen=True)
class Record:
    qid: str
    staging_id: str
    citation: str
    title: str


# ---------------------------------------------------------------------------------------------
# database helpers (as the test's admin role, independent of the app's binding)
# ---------------------------------------------------------------------------------------------
def _admin_run(corpus_db, statements):
    async def go():
        eng = corpus_db.engine_for(corpus_db.url)
        try:
            async with eng.begin() as conn:
                out = []
                for sql, params in statements:
                    res = await conn.execute(text(sql), params or {})
                    out.append(res.mappings().all() if res.returns_rows else None)
                return out
        finally:
            await eng.dispose()

    return asyncio.run(go())


def q(corpus_db, sql, **params):
    return _admin_run(corpus_db, [(sql, params)])[0]


def x(corpus_db, sql, **params):
    _admin_run(corpus_db, [(sql, params)])


def has_decisions_table(corpus_db):
    return q(corpus_db, "SELECT to_regclass(:t) IS NOT NULL AS present", t=DECISIONS)[0]["present"]


def decisions_for(corpus_db, qid):
    """The decision rows of one quarantine record, or None when there is no decision table (main)."""
    if not has_decisions_table(corpus_db):
        return None
    return q(corpus_db, f"SELECT * FROM {DECISIONS} WHERE quarantine_id = :id ORDER BY decided_at", id=qid)


def decision_count(corpus_db):
    if not has_decisions_table(corpus_db):
        return None
    return q(corpus_db, f"SELECT count(*) AS n FROM {DECISIONS}")[0]["n"]


def master_rows(corpus_db, *, citation=None, title=None):
    if citation is not None:
        return q(corpus_db, "SELECT * FROM case_law_master WHERE citation = :c", c=citation)
    return q(corpus_db, "SELECT * FROM case_law_master WHERE case_title = :t", t=title)


def queue_row(corpus_db, qid):
    return q(corpus_db, "SELECT * FROM quarantine_queue WHERE id = :id", id=qid)[0]


def staging_row(corpus_db, sid):
    return q(corpus_db, "SELECT * FROM scraper_staging WHERE id = :id", id=sid)[0]


def outbox_rows(corpus_db, record_id=None):
    if record_id is None:
        return q(corpus_db, "SELECT * FROM embedding_queue ORDER BY created_at")
    return q(corpus_db, "SELECT * FROM embedding_queue WHERE record_id = :id", id=record_id)


def published_id(qid):
    return str(uuid.uuid5(PUBLICATION_NAMESPACE, f"corpus-service:case_law_master:quarantine/{qid}"))


def is_pending(row):
    return row["reviewed"] is False and (row["resolution"] or "pending") == "pending"


# ---------------------------------------------------------------------------------------------
# seed: staging rows, decided by the real promotion
# ---------------------------------------------------------------------------------------------
def seed(corpus_db):
    proc = corpus_db.migrate()
    assert proc.returncode == 0, f"migrate failed:\n{proc.stdout[-2000:]}\n{proc.stderr[-4000:]}"
    x(corpus_db,
      "INSERT INTO scraper_sources (source_name, source_url, trust_level) VALUES "
      "(:b, 'https://blocked.invalid', 'blocked'), (:l, 'https://later.invalid', 'review')",
      b=BLOCKED_SOURCE, l=LATER_BLOCKED_SOURCE)
    statements = []
    for label, (source, citation, title, confidence, _reason) in STAGED.items():
        metadata = {"source_name": source, "extraction_method": "html"}
        if source == MISSING_SOURCE:
            sql = ("INSERT INTO scraper_staging (source_site, source_url, raw_text, raw_html, extracted_citation, "
                   "extracted_title, confidence_score, normalised, parsing_metadata) VALUES (:site, :url, :body, "
                   "'<p>synthetic</p>', :citation, :title, :conf, true, CAST(:meta AS jsonb))")
        else:
            sql = ("INSERT INTO scraper_staging (source_id, source_site, source_url, raw_text, raw_html, "
                   "extracted_citation, extracted_title, confidence_score, normalised, parsing_metadata) "
                   "SELECT s.id, :site, :url, :body, '<p>synthetic</p>', :citation, :title, :conf, true, "
                   "CAST(:meta AS jsonb) FROM scraper_sources s WHERE s.source_name = CAST(:sname AS text)")
        statements.append((sql, dict(site=SITE_LABEL.get(label, source), sname=source,
                                     url=f"https://example.invalid/f23/{label}",
                                     body=f"F23 SYNTHETIC JUDGMENT TEXT {label} (2099)", citation=citation,
                                     title=title, conf=confidence, meta=json.dumps(metadata))))
    _admin_run(corpus_db, statements)

    from scraper.tasks.promotion import promote_staging_records

    counts = asyncio.run(promote_staging_records())
    assert counts == {"promoted": 0, "attached": 0, "quarantined": len(STAGED), "failed": 0}, counts

    rows = q(corpus_db,
             "SELECT s.extracted_title AS title, s.id AS sid, qq.id AS qid, qq.reason AS reason "
             "FROM scraper_staging s JOIN quarantine_queue qq ON qq.staging_id = s.id")
    by_title = {r["title"]: r for r in rows}
    records = {}
    for label, (_source, citation, title, _confidence, reason) in STAGED.items():
        row = by_title[title]
        assert row["reason"] == reason, (label, row["reason"])
        records[label] = Record(str(row["qid"]), str(row["sid"]), citation, title)
    return records


@pytest.fixture
def review(corpus_db):
    """Quarantined records made by the real promotion; the app is then bound to the runtime role."""
    records = seed(corpus_db)
    user, password = corpus_db.runtime_role(corpus_writer="none")
    with corpus_db.app_engine_as(user, password):
        yield records, user, password


@pytest.fixture
def client(review):
    from fastapi.testclient import TestClient

    from scraper.main import app

    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


def admin_headers(key=None):
    from scraper.config import settings

    headers = {"X-API-Key": settings.ADMIN_API_KEY}
    if key is not None:
        headers["Idempotency-Key"] = key
    return headers


def body(reviewer=REVIEWER, reason=REASON):
    return {"reviewer": reviewer, "reason": reason}


def decide(client, qid, action, *, reviewer=REVIEWER, reason=REASON, key=None):
    return client.post(f"/quarantine/{qid}/{action}", json=body(reviewer, reason), headers=admin_headers(key))


def detail(res):
    try:
        payload = res.json()
    except ValueError:
        return f"non-JSON body of {len(res.content)} bytes"
    return payload.get("detail") if isinstance(payload, dict) and "detail" in payload else payload


def error_code(res):
    d = detail(res)
    return d.get("error") if isinstance(d, dict) else None


# ---------------------------------------------------------------------------------------------
# (a) repeated approval
# ---------------------------------------------------------------------------------------------
def test_a_repeated_approval_publishes_once(client, review, corpus_db):
    records, _user, _pw = review
    nocite = records["nocite"]
    first = decide(client, nocite.qid, "promote")
    second = decide(client, nocite.qid, "promote", reviewer=OTHER_REVIEWER)
    alpha = decide(client, records["alpha"].qid, "promote")
    alpha_dup = decide(client, records["alpha_dup"].qid, "promote")
    decisions = decisions_for(corpus_db, nocite.qid)
    observed = {
        "uncited: statuses": (first.status_code, second.status_code),
        "uncited: second error": error_code(second),
        "uncited: master rows": len(master_rows(corpus_db, title=nocite.title)),
        "uncited: decision rows": None if decisions is None else len(decisions),
        "cited: statuses": (alpha.status_code, alpha_dup.status_code),
        "cited: duplicate error": error_code(alpha_dup),
        "cited: master rows": len(master_rows(corpus_db, citation=records["alpha"].citation)),
        "cited: duplicate still pending": is_pending(queue_row(corpus_db, records["alpha_dup"].qid)),
    }
    expected = {
        "uncited: statuses": (200, 409),
        "uncited: second error": "already_resolved",
        "uncited: master rows": 1,
        "uncited: decision rows": 1,
        "cited: statuses": (200, 409),
        "cited: duplicate error": "citation_already_published",
        "cited: master rows": 1,
        "cited: duplicate still pending": True,
    }
    assert observed == expected
    # The loser's 409 names the decision that won (spec ruling 2).
    won = detail(second)["decision"]
    assert won["decision"] == "promoted" and won["reviewer"] == REVIEWER and won["id"] == str(decisions[0]["id"])


# ---------------------------------------------------------------------------------------------
# (b) racing decisions, released together from a held queue-row lock
# ---------------------------------------------------------------------------------------------
async def _lock_waiters(admin, user):
    async with admin.connect() as conn:
        return (await conn.execute(text(
            "SELECT count(*) FROM pg_stat_activity WHERE usename = :u AND wait_event_type = 'Lock'"
        ), {"u": user})).scalar()


async def _race(corpus_db, user, qid, actions):
    """Hold the queue row FOR UPDATE from another connection, send every request, wait until each
    one is either finished or waiting on a lock, then release them together. Returns the number of
    requests seen waiting and the responses in request order."""
    import httpx

    from scraper.main import app

    admin = corpus_db.engine_for(corpus_db.url)
    try:
        async with admin.connect() as holder:
            await holder.begin()
            await holder.execute(text("SELECT 1 FROM quarantine_queue WHERE id = :id FOR UPDATE"), {"id": qid})
            transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as ac:
                reviewers = (REVIEWER, OTHER_REVIEWER)
                tasks = [
                    asyncio.create_task(ac.post(f"/quarantine/{qid}/{action}", json=body(reviewers[i]),
                                                headers=admin_headers()))
                    for i, action in enumerate(actions)
                ]
                waiting, deadline = 0, time.monotonic() + 30
                while time.monotonic() < deadline:
                    waiting = await _lock_waiters(admin, user)
                    if waiting + sum(t.done() for t in tasks) >= len(tasks):
                        break
                    await asyncio.sleep(0.05)
                await holder.rollback()
                responses = await asyncio.gather(*tasks)
        return waiting, responses
    finally:
        await admin.dispose()


def test_b_racing_decisions_make_exactly_one_transition(review, corpus_db):
    records, user, _pw = review
    observed, expected = {}, {}
    for label, actions in (("race1", ("promote", "promote")), ("race2", ("promote", "reject"))):
        record = records[label]
        waiting, responses = asyncio.run(_race(corpus_db, user, record.qid, actions))
        statuses = sorted(r.status_code for r in responses)
        winner = next((actions[i] for i, r in enumerate(responses) if r.status_code == 200), None)
        decisions = decisions_for(corpus_db, record.qid)
        row = queue_row(corpus_db, record.qid)
        observed[label] = {
            "statuses": statuses,
            "loser error": [error_code(r) for r in responses if r.status_code != 200],
            "decision rows": None if decisions is None else [d["decision"] for d in decisions],
            "master rows": len(master_rows(corpus_db, citation=record.citation)),
            "queue resolution": row["resolution"],
        }
        winner_decision = {"promote": "promoted", "reject": "rejected"}.get(winner)
        expected[label] = {
            "statuses": [200, 409],
            "loser error": ["already_resolved"],
            "decision rows": [winner_decision],
            "master rows": 1 if winner == "promote" else 0,
            "queue resolution": {"promote": "approved", "reject": "rejected"}.get(winner),
        }
        # Both requests were in flight together: each was waiting on a lock when it was released.
        observed[label]["requests waiting at release"] = waiting
        expected[label]["requests waiting at release"] = len(actions)
    assert observed == expected


# ---------------------------------------------------------------------------------------------
# (c) missing records
# ---------------------------------------------------------------------------------------------
def test_c_missing_record_is_404_and_a_record_without_staging_is_never_acknowledged(client, review, corpus_db):
    _records, _user, _pw = review
    missing = str(uuid.uuid4())
    x(corpus_db,
      "INSERT INTO quarantine_queue (source_site, extracted_citation, extracted_title, reason) "
      "VALUES (:site, '2099 SCMR 2399', 'F23 Orphan v. The State', 'review_source')", site=REVIEW_SOURCE)
    orphan = str(q(corpus_db, "SELECT id FROM quarantine_queue WHERE extracted_citation = '2099 SCMR 2399'")[0]["id"])
    promote_missing = decide(client, missing, "promote")
    reject_missing = decide(client, missing, "reject")
    malformed = decide(client, "not-a-uuid", "promote")
    orphan_res = decide(client, orphan, "promote")
    observed = {
        "promote unknown id": promote_missing.status_code,
        "reject unknown id": reject_missing.status_code,
        "malformed id": malformed.status_code,
        "no staging row": (orphan_res.status_code, error_code(orphan_res)),
        "no staging row: master rows": len(master_rows(corpus_db, citation="2099 SCMR 2399")),
        "no staging row: still pending": is_pending(queue_row(corpus_db, orphan)),
        "decisions written": decision_count(corpus_db),
    }
    expected = {
        "promote unknown id": 404,
        "reject unknown id": 404,
        "malformed id": 422,
        "no staging row": (409, "staging_record_missing"),
        "no staging row: master rows": 0,
        "no staging row: still pending": True,
        "decisions written": 0,
    }
    assert observed == expected


# ---------------------------------------------------------------------------------------------
# (d) the decision record
# ---------------------------------------------------------------------------------------------
def test_d_the_decision_record_carries_reviewer_reason_and_states(client, review, corpus_db):
    records, user, password = review
    alpha = records["alpha"]
    key = f"f23-review-{uuid.uuid4()}"
    res = decide(client, alpha.qid, "promote", key=key)
    assert res.status_code == 200, detail(res)
    decisions = decisions_for(corpus_db, alpha.qid)
    assert decisions is not None, f"no {DECISIONS} table: the promotion left no decision record"
    assert len(decisions) == 1, decisions
    d = decisions[0]
    case_id = published_id(alpha.qid)
    st = staging_row(corpus_db, alpha.staging_id)
    qq = queue_row(corpus_db, alpha.qid)
    [master] = master_rows(corpus_db, citation=alpha.citation)
    [outbox] = outbox_rows(corpus_db, case_id)
    decided_at = d["decided_at"]

    assert {k: d[k] for k in ("decision", "reviewer", "reviewer_auth", "reason", "request_key", "source_trust_level",
                               "source_resolved_by", "publication_key", "published_table")} == {
        "decision": "promoted", "reviewer": REVIEWER, "reviewer_auth": "shared_admin_key", "reason": REASON,
        "request_key": key, "source_trust_level": "review", "source_resolved_by": "source_id",
        "publication_key": f"quarantine/{alpha.qid}", "published_table": "case_law_master",
    }
    assert (str(d["quarantine_id"]), str(d["staging_id"]), str(d["published_id"]), str(d["embedding_outbox_id"])) == (
        alpha.qid, alpha.staging_id, case_id, str(outbox["id"]))
    assert d["prior_state"] == {
        "quarantine": {"reviewed": False, "resolution": "pending", "reviewed_by": None, "reviewed_at": None,
                       "reason": "review_source"},
        "staging": {"promoted": False, "promoted_to_id": None, "quarantined": True,
                    "quarantine_reason": "review_source"},
    }
    assert d["new_state"] == {
        "quarantine": {"reviewed": True, "resolution": "approved", "reviewed_by": REVIEWER,
                       "reviewed_at": decided_at.isoformat(), "reason": "review_source"},
        "staging": {"promoted": True, "promoted_to_id": case_id, "quarantined": True,
                    "quarantine_reason": "review_source"},
    }
    # The queue row, the staging lineage and the published row all agree with the decision.
    assert (qq["reviewed"], qq["reviewed_by"], qq["reviewed_at"], qq["resolution"], qq["resolution_notes"]) == (
        True, REVIEWER, decided_at, "approved", REASON)
    assert (st["promoted"], st["promoted_at"], str(st["promoted_to_id"])) == (True, decided_at, case_id)
    assert (str(master["id"]), master["is_promoted"], master["promoted_at"], master["source_site"],
            master["full_text"], master["case_title"]) == (
        case_id, True, decided_at, REVIEW_SOURCE, "F23 SYNTHETIC JUDGMENT TEXT alpha (2099)", alpha.title)
    first = res.json()
    assert first == {
        "status": "promoted", "quarantine_id": alpha.qid, "decision_id": str(d["id"]), "decision": "promoted",
        "reviewer": REVIEWER, "decided_at": decided_at.isoformat(), "publication_key": f"quarantine/{alpha.qid}",
        "case_id": case_id, "embedding_outbox_id": str(outbox["id"]), "replayed": False,
    }

    # Retrieval: the human-reviewed row is served by the public API (F24's published boundary).
    public = client.get(f"/cases/{case_id}")
    assert public.status_code == 200 and public.json()["citation"] == alpha.citation, public.text[:300]

    # A replay with the same key is a no-op returning the same result; another decision with it is 409.
    replay = decide(client, alpha.qid, "promote", key=key)
    assert replay.status_code == 200 and replay.json() == {**first, "replayed": True}, detail(replay)
    other = decide(client, alpha.qid, "reject", key=key)
    assert (other.status_code, error_code(other)) == (409, "already_resolved")
    assert (decision_count(corpus_db), len(master_rows(corpus_db, citation=alpha.citation)),
            len(outbox_rows(corpus_db))) == (1, 1, 1)

    # Missing or empty reviewer and reason, or an unknown field: 422, nothing written.
    reject_me = records["reject_me"]
    bad = [
        client.post(f"/quarantine/{reject_me.qid}/reject", json={"reason": REASON}, headers=admin_headers()),
        client.post(f"/quarantine/{reject_me.qid}/reject", json={"reviewer": REVIEWER}, headers=admin_headers()),
        decide(client, reject_me.qid, "reject", reviewer="   "),
        decide(client, reject_me.qid, "promote", reason=""),
        client.post(f"/quarantine/{reject_me.qid}/promote", json={**body(), "trust_level": "trusted"},
                    headers=admin_headers()),
        client.post(f"/quarantine/{reject_me.qid}/promote", headers=admin_headers()),
        decide(client, reject_me.qid, "promote", key="not a valid key!"),
    ]
    assert [r.status_code for r in bad] == [422] * len(bad), [detail(r) for r in bad]
    assert is_pending(queue_row(corpus_db, reject_me.qid)) and decision_count(corpus_db) == 1

    # A reject is a decision too: recorded, no publication, the staging row stays quarantined.
    rejected = decide(client, reject_me.qid, "reject", reviewer=OTHER_REVIEWER, reason="Not a judgment (synthetic)")
    assert rejected.status_code == 200, detail(rejected)
    [r] = decisions_for(corpus_db, reject_me.qid)
    rst = staging_row(corpus_db, reject_me.staging_id)
    rqq = queue_row(corpus_db, reject_me.qid)
    assert (r["decision"], r["reviewer"], r["reason"], r["publication_key"], r["published_id"],
            r["embedding_outbox_id"], r["new_state"]["quarantine"]["resolution"]) == (
        "rejected", OTHER_REVIEWER, "Not a judgment (synthetic)", None, None, None, "rejected")
    assert (rqq["resolution"], rqq["reviewed_by"], rst["promoted"], rst["quarantined"]) == (
        "rejected", OTHER_REVIEWER, False, True)
    assert master_rows(corpus_db, citation=reject_me.citation) == []

    # Append-only: the runtime role (DML granted, as in production) can neither rewrite nor delete
    # a decision.
    async def tamper(sql):
        eng = corpus_db.engine_for(corpus_db.url_as(user, password))
        try:
            async with eng.begin() as conn:
                await conn.execute(text(sql), {"id": d["id"]})
            return "allowed"
        except Exception as exc:  # noqa: BLE001 - classified by SQLSTATE
            orig = getattr(exc, "orig", None)
            return getattr(orig, "sqlstate", None) or getattr(getattr(orig, "__cause__", None), "sqlstate", None)
        finally:
            await eng.dispose()

    assert asyncio.run(tamper(f"UPDATE {DECISIONS} SET reason = 'rewritten' WHERE id = :id")) == APPEND_ONLY_SQLSTATE
    assert asyncio.run(tamper(f"DELETE FROM {DECISIONS} WHERE id = :id")) == APPEND_ONLY_SQLSTATE
    assert decisions_for(corpus_db, alpha.qid)[0]["reason"] == REASON


# ---------------------------------------------------------------------------------------------
# (e) untrusted sources
# ---------------------------------------------------------------------------------------------
def test_e_an_untrusted_source_is_refused(client, review, corpus_db):
    records, _user, _pw = review
    x(corpus_db, "UPDATE scraper_sources SET trust_level = 'blocked' WHERE source_name = :n", n=LATER_BLOCKED_SOURCE)
    refused = {label: decide(client, records[label].qid, "promote") for label in ("blocked", "later", "unknown")}
    allowed = {label: decide(client, records[label].qid, "promote") for label in ("lowconf", "alpha", "labelled")}
    observed = {
        label: {
            "status": res.status_code,
            "error": error_code(res),
            "trust reason": detail(res).get("trust_reason") if isinstance(detail(res), dict) else None,
            "master rows": len(master_rows(corpus_db, citation=records[label].citation)),
            "still pending": is_pending(queue_row(corpus_db, records[label].qid)),
        }
        for label, res in refused.items()
    }
    observed["allowed"] = {label: res.status_code for label, res in allowed.items()}
    observed["trusted low confidence published as"] = [
        r["source_site"] for r in master_rows(corpus_db, citation=records["lowconf"].citation)]
    # Ruling 8: source_site names the source whose trust was verified, not the staging label.
    observed["labelled record published as"] = [
        r["source_site"] for r in master_rows(corpus_db, citation=records["labelled"].citation)]
    observed["decisions"] = decision_count(corpus_db)
    expected = {
        "blocked": {"status": 409, "error": "source_not_promotable", "trust reason": "blocked_source",
                    "master rows": 0, "still pending": True},
        "later": {"status": 409, "error": "source_not_promotable", "trust reason": "blocked_source",
                  "master rows": 0, "still pending": True},
        "unknown": {"status": 409, "error": "source_not_promotable", "trust reason": "unknown_source",
                    "master rows": 0, "still pending": True},
        "allowed": {"lowconf": 200, "alpha": 200, "labelled": 200},
        "trusted low confidence published as": [TRUSTED_SOURCE],
        "labelled record published as": [LABELLED_SOURCE],
        "decisions": 3,
    }
    assert observed == expected


# ---------------------------------------------------------------------------------------------
# (f) the embedding outbox
# ---------------------------------------------------------------------------------------------
def test_f_the_embedding_outbox_row_exists_exactly_once(client, review, corpus_db):
    records, _user, _pw = review
    alpha = records["alpha"]
    key = f"f23-outbox-{uuid.uuid4()}"
    first = decide(client, alpha.qid, "promote", key=key)
    replay = decide(client, alpha.qid, "promote", key=key)
    duplicate = decide(client, alpha.qid, "promote", reviewer=OTHER_REVIEWER)
    rejected = decide(client, records["reject_me"].qid, "reject")
    case_id = published_id(alpha.qid)
    rows = outbox_rows(corpus_db, case_id)
    decisions = decisions_for(corpus_db, alpha.qid)
    observed = {
        "statuses": (first.status_code, replay.status_code, duplicate.status_code, rejected.status_code),
        "outbox rows for the published id": [(r["table_name"], r["status"]) for r in rows],
        "outbox rows in total": len(outbox_rows(corpus_db)),
        "decision names the outbox row": (
            None if not decisions or not rows else str(decisions[0]["embedding_outbox_id"]) == str(rows[0]["id"])),
    }
    expected = {
        "statuses": (200, 200, 409, 200),
        "outbox rows for the published id": [("case_law_master", "pending")],
        "outbox rows in total": 1,
        "decision names the outbox row": True,
    }
    assert observed == expected


# ---------------------------------------------------------------------------------------------
# (g) the identity backstop: a collision the checks cannot see is 409, never 500, never a write
# ---------------------------------------------------------------------------------------------
def test_g_an_identity_collision_is_409_and_writes_nothing(client, review, corpus_db):
    records, _user, _pw = review
    collide = records["collide"]
    # A row already holds the id this record would publish under (ruling 4), with another citation,
    # so neither the state check nor the citation check sees it; only the primary key does.
    x(corpus_db,
      "INSERT INTO case_law_master (id, citation, case_title, source_site, is_promoted) "
      "VALUES (:id, '2099 SCMR 2390', 'F23 Squatter v. The State', :site, false)",
      id=published_id(collide.qid), site=REVIEW_SOURCE)
    res = decide(client, collide.qid, "promote")
    observed = {
        "status": res.status_code,
        "error": error_code(res),
        "still pending": is_pending(queue_row(corpus_db, collide.qid)),
        "staging promoted": staging_row(corpus_db, collide.staging_id)["promoted"],
        "master rows with its citation": len(master_rows(corpus_db, citation=collide.citation)),
        "outbox rows": len(outbox_rows(corpus_db)),
        "decisions": decision_count(corpus_db),
    }
    expected = {
        "status": 409,
        "error": "conflict",
        "still pending": True,
        "staging promoted": False,
        "master rows with its citation": 0,
        "outbox rows": 0,
        "decisions": 0,
    }
    assert observed == expected


# ---------------------------------------------------------------------------------------------
# (h) migration 002: append-only for every role, idempotent, and self-repairing
# ---------------------------------------------------------------------------------------------
TRIGGERS_SQL = (
    "SELECT tgname, tgenabled::text AS tgenabled, tgfoid::regprocedure::text AS fn FROM pg_trigger "
    "WHERE tgrelid = to_regclass(:t) AND NOT tgisinternal ORDER BY tgname"
)
TRIGGER_OIDS_SQL = "SELECT oid FROM pg_trigger WHERE tgrelid = to_regclass(:t) AND NOT tgisinternal ORDER BY tgname"


def _sqlstate_of(exc):
    orig = getattr(exc, "orig", None)
    return getattr(orig, "sqlstate", None) or getattr(getattr(orig, "__cause__", None), "sqlstate", None)


def test_h_migration_002_is_append_only_idempotent_and_restores_a_dropped_trigger(corpus_db):
    first = corpus_db.migrate()
    assert first.returncode == 0, first.stderr[-3000:]
    assert has_decisions_table(corpus_db), f"no {DECISIONS} table after migrate"
    triggers = [dict(r) for r in q(corpus_db, TRIGGERS_SQL, t=DECISIONS)]
    oids = q(corpus_db, TRIGGER_OIDS_SQL, t=DECISIONS)
    assert triggers == [
        {"tgname": "quarantine_decisions_no_truncate", "tgenabled": "A", "fn": "quarantine_decisions_append_only()"},
        {"tgname": "quarantine_decisions_no_update_delete", "tgenabled": "A",
         "fn": "quarantine_decisions_append_only()"},
    ], triggers

    # Even the admin (a superuser here) cannot TRUNCATE, UPDATE or DELETE a decision.
    x(corpus_db,
      f"INSERT INTO {DECISIONS} (id, quarantine_id, decision, reviewer, reviewer_auth, reason, prior_state, "
      "new_state) VALUES (gen_random_uuid(), gen_random_uuid(), 'rejected', 'Reviewer F23-H (synthetic)', "
      "'shared_admin_key', 'synthetic', CAST('{}' AS jsonb), CAST('{}' AS jsonb))")
    codes = {}
    for sql in (f"TRUNCATE {DECISIONS}", f"UPDATE {DECISIONS} SET reason = 'x'", f"DELETE FROM {DECISIONS}"):
        try:
            x(corpus_db, sql)
            codes[sql.split()[0]] = "allowed"
        except Exception as exc:  # noqa: BLE001 - classified by SQLSTATE
            codes[sql.split()[0]] = _sqlstate_of(exc)
    assert codes == {"TRUNCATE": APPEND_ONLY_SQLSTATE, "UPDATE": APPEND_ONLY_SQLSTATE, "DELETE": APPEND_ONLY_SQLSTATE}
    assert decision_count(corpus_db) == 1

    # A second migrate leaves a current database untouched.
    second = corpus_db.migrate()
    assert second.returncode == 0, second.stderr[-3000:]
    assert q(corpus_db, TRIGGER_OIDS_SQL, t=DECISIONS) == oids
    assert "append-only trigger already current" in second.stderr + second.stdout

    # A dropped or disabled trigger is put back by the next migrate.
    x(corpus_db, f"DROP TRIGGER quarantine_decisions_no_update_delete ON {DECISIONS}")
    x(corpus_db, f"ALTER TABLE {DECISIONS} DISABLE TRIGGER quarantine_decisions_no_truncate")
    third = corpus_db.migrate()
    assert third.returncode == 0, third.stderr[-3000:]
    assert [dict(r) for r in q(corpus_db, TRIGGERS_SQL, t=DECISIONS)] == triggers


# ---------------------------------------------------------------------------------------------
# (i) review round (Copilot thread 4305754687): migrate repairs every drift of the triggers or the
# function, and the triggers fire in every session_replication_role
# ---------------------------------------------------------------------------------------------
ROW_TRIGGER_NAME = "quarantine_decisions_no_update_delete"
TRUNCATE_TRIGGER_NAME = "quarantine_decisions_no_truncate"
APPEND_ONLY_FUNCTION = "quarantine_decisions_append_only"
# What pg_get_triggerdef renders for the two triggers after migrate (PostgreSQL 16, public schema).
EXPECTED_TRIGGER_DEFS = {
    ROW_TRIGGER_NAME: (
        f"CREATE TRIGGER {ROW_TRIGGER_NAME} BEFORE DELETE OR UPDATE ON public.{DECISIONS} "
        f"FOR EACH ROW EXECUTE FUNCTION {APPEND_ONLY_FUNCTION}()"),
    TRUNCATE_TRIGGER_NAME: (
        f"CREATE TRIGGER {TRUNCATE_TRIGGER_NAME} BEFORE TRUNCATE ON public.{DECISIONS} "
        f"FOR EACH STATEMENT EXECUTE FUNCTION {APPEND_ONLY_FUNCTION}()"),
}
_RECREATE_ROW_TRIGGER = f"DROP TRIGGER {ROW_TRIGGER_NAME} ON {DECISIONS}"
# Re-audit round 2, L1 (mutants N08 and N09): a recreated trigger is enabled 'O' by default, and that
# alone makes migrate rebuild it, so the WHEN clause or the column list would never be what migrate
# saw. Every drift that recreates the row trigger therefore ends with ENABLE ALWAYS: the drift is
# then the one attribute it names. "origin_enabled" keeps the 'O' case.
_ALWAYS_ROW_TRIGGER = f"ALTER TABLE {DECISIONS} ENABLE ALWAYS TRIGGER {ROW_TRIGGER_NAME}"
# Each drift is applied by the admin after a first migrate. "bypass" says whether, before the next
# migrate, the runtime role can then rewrite a decision (the drift is a real hole, not just a change).
DRIFTS = {
    "when_false": ([
        _RECREATE_ROW_TRIGGER,
        f"CREATE TRIGGER {ROW_TRIGGER_NAME} BEFORE UPDATE OR DELETE ON {DECISIONS} FOR EACH ROW WHEN (false) "
        f"EXECUTE FUNCTION {APPEND_ONLY_FUNCTION}()",
        _ALWAYS_ROW_TRIGGER,
    ], True),
    "update_of_reason": ([
        _RECREATE_ROW_TRIGGER,
        f"CREATE TRIGGER {ROW_TRIGGER_NAME} BEFORE UPDATE OF reason OR DELETE ON {DECISIONS} FOR EACH ROW "
        f"EXECUTE FUNCTION {APPEND_ONLY_FUNCTION}()",
        _ALWAYS_ROW_TRIGGER,
    ], True),
    "for_each_statement": ([
        _RECREATE_ROW_TRIGGER,
        f"CREATE TRIGGER {ROW_TRIGGER_NAME} BEFORE UPDATE OR DELETE ON {DECISIONS} FOR EACH STATEMENT "
        f"EXECUTE FUNCTION {APPEND_ONLY_FUNCTION}()",
        _ALWAYS_ROW_TRIGGER,
    ], False),
    # Enabled in origin mode only: the runtime role is still refused, a replica-mode session is not.
    "origin_enabled": ([f"ALTER TABLE {DECISIONS} ENABLE TRIGGER {ROW_TRIGGER_NAME}"], False),
    "no_op_function": ([
        f"CREATE OR REPLACE FUNCTION {APPEND_ONLY_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS "
        "$noop$ BEGIN IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $noop$",
    ], True),
    # No drift at all: the triggers must not be skipped by a session in replica mode.
    "replica_mode": ([], False),
}


def _attempts(corpus_db, url, decision_id, *, replica=False):
    """SQLSTATE (or "allowed") of each write attempt on one decision, each in its own transaction that
    is always rolled back, so an allowed attempt changes nothing for the next one."""
    statements = {
        "UPDATE reviewer": f"UPDATE {DECISIONS} SET reviewer = 'rewritten' WHERE id = :id",
        "UPDATE reason": f"UPDATE {DECISIONS} SET reason = 'rewritten' WHERE id = :id",
        "DELETE": f"DELETE FROM {DECISIONS} WHERE id = :id",
        "TRUNCATE": f"TRUNCATE {DECISIONS}",
    }

    async def go():
        eng = corpus_db.engine_for(url)
        out = {}
        try:
            for name, sql in statements.items():
                async with eng.connect() as conn:
                    tx = await conn.begin()
                    try:
                        if replica:
                            await conn.execute(text("SET LOCAL session_replication_role = replica"))
                        await conn.execute(text(sql), {"id": decision_id})
                        out[name] = "allowed"
                    except Exception as exc:  # noqa: BLE001 - classified by SQLSTATE
                        out[name] = _sqlstate_of(exc)
                    finally:
                        await tx.rollback()
        finally:
            await eng.dispose()
        return out

    return asyncio.run(go())


@pytest.mark.parametrize("drift", sorted(DRIFTS))
def test_i_migrate_repairs_every_drift_and_the_triggers_fire_in_every_replication_role(corpus_db, drift):
    first = corpus_db.migrate()
    assert first.returncode == 0, first.stderr[-3000:]
    decision_id = str(uuid.uuid4())
    x(corpus_db,
      f"INSERT INTO {DECISIONS} (id, quarantine_id, decision, reviewer, reviewer_auth, reason, prior_state, "
      "new_state) VALUES (:id, gen_random_uuid(), 'rejected', 'Reviewer F23-I (synthetic)', 'shared_admin_key', "
      "'synthetic', CAST('{}' AS jsonb), CAST('{}' AS jsonb))", id=decision_id)
    user, password = corpus_db.runtime_role(corpus_writer="none")
    runtime_url = corpus_db.url_as(user, password)
    statements, bypass = DRIFTS[drift]
    for sql in statements:
        x(corpus_db, sql)
    if bypass:  # the drift really opens a hole before migrate runs (the test is not vacuous)
        before = _attempts(corpus_db, runtime_url, decision_id)
        assert before["UPDATE reviewer"] == "allowed", before

    repaired = corpus_db.migrate()
    assert repaired.returncode == 0, repaired.stderr[-3000:]
    logs = repaired.stderr + repaired.stdout
    if statements:
        assert "made append-only" in logs and "append-only trigger already current" not in logs, logs[-2000:]

    observed = {
        "runtime role": _attempts(corpus_db, runtime_url, decision_id),
        "superuser": _attempts(corpus_db, corpus_db.url, decision_id),
        "superuser in replica mode": _attempts(corpus_db, corpus_db.url, decision_id, replica=True),
        "triggers": {
            r["tgname"]: (r["tgenabled"], r["def"])
            for r in q(corpus_db,
                       "SELECT tgname, tgenabled::text AS tgenabled, pg_get_triggerdef(oid) AS def FROM pg_trigger "
                       "WHERE tgrelid = to_regclass(:t) AND NOT tgisinternal", t=DECISIONS)
        },
        "function": [dict(r) for r in q(corpus_db,
            "SELECT l.lanname, p.prorettype::regtype::text AS rettype, p.prosecdef, p.proconfig IS NULL AS no_config, "
            "p.prosrc LIKE '%RAISE EXCEPTION%restrict_violation%' AS raises FROM pg_proc p "
            "JOIN pg_language l ON l.oid = p.prolang WHERE p.proname = :f", f=APPEND_ONLY_FUNCTION)],
    }
    refused = {"UPDATE reviewer": APPEND_ONLY_SQLSTATE, "UPDATE reason": APPEND_ONLY_SQLSTATE,
               "DELETE": APPEND_ONLY_SQLSTATE, "TRUNCATE": APPEND_ONLY_SQLSTATE}
    expected = {
        # The runtime role holds no TRUNCATE privilege (DML only), so its TRUNCATE stops at 42501
        # before the trigger; the superuser's shows the trigger itself.
        "runtime role": {**refused, "TRUNCATE": "42501"},
        "superuser": refused,
        "superuser in replica mode": refused,
        "triggers": {name: ("A", definition) for name, definition in EXPECTED_TRIGGER_DEFS.items()},
        "function": [{"lanname": "plpgsql", "rettype": "trigger", "prosecdef": False, "no_config": True,
                      "raises": True}],
    }
    assert observed == expected
