"""Audit F23 rules without a database.

* ``scraper.trust.human_review_decision``: the F20 vocabulary, failing closed (spec ruling 7).
* The deterministic publication id (spec ruling 4), recomputed here from the spec's formula.
* Input bounds (spec ruling 12): a malformed id, body or Idempotency-Key is 422 and a wrong admin
  key 401, before the route touches the database. The database dependency is replaced by one that
  records any use, so "no database work" is observed, not assumed.

These import names main does not have, so on main they fail at import; the behavioural RED for F23
is the end-to-end file, tests/test_f23_quarantine_review_db.py.
"""

import uuid

import pytest

from scraper.trust import human_review_decision


# ---------------------------------------------------------------------------------------------
# ruling 7: who may be promoted by a reviewer
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("level", ["trusted", "review"])
def test_trusted_and_review_may_be_promoted_by_a_reviewer(level):
    decision = human_review_decision(level)
    assert (decision.promote, decision.reason) == (True, None)


def test_blocked_is_refused_blocked_source():
    decision = human_review_decision("blocked")
    assert (decision.promote, decision.reason) == (False, "blocked_source")


@pytest.mark.parametrize("raw", [
    None, "", " ", "semi_trusted", "untrusted", "quarantined", "TRUSTED", "Review", " review", "review ",
    "trusted\n", "blocked ", "x", 1, 0, True, False, b"trusted", ["trusted"],
])
def test_anything_outside_the_vocabulary_is_refused_unknown_source(raw):
    decision = human_review_decision(raw)
    assert (decision.promote, decision.reason) == (False, "unknown_source")


# ---------------------------------------------------------------------------------------------
# ruling 4: the publication id
# ---------------------------------------------------------------------------------------------
def test_the_publication_id_is_uuid5_of_the_publication_key():
    from scraper.routers.quarantine import publication_id, publication_key

    ids = [uuid.uuid4() for _ in range(5)]
    for qid in ids:
        assert publication_key(qid) == f"quarantine/{qid}"
        assert publication_id(qid) == uuid.uuid5(uuid.NAMESPACE_URL, f"corpus-service:case_law_master:quarantine/{qid}")
        assert publication_id(qid) == publication_id(uuid.UUID(str(qid)))
    assert len({publication_id(qid) for qid in ids}) == len(ids)


# ---------------------------------------------------------------------------------------------
# ruling 11: when migration 002 counts the append-only triggers as current
# ---------------------------------------------------------------------------------------------
def test_the_append_only_state_is_current_only_when_exact():
    from scraper import quarantine_ledger as ql

    fn = (4242, ql.FUNCTION_BODY)
    row = (ql.ROW_TRIGGER, 4242, "O", ql.ROW_TGTYPE)
    trunc = (ql.TRUNCATE_TRIGGER, 4242, "O", ql.TRUNCATE_TGTYPE)
    assert ql.is_current(fn, [row, trunc]) is True
    not_current = {
        "no function": (None, [row, trunc]),
        "altered body": ((4242, ql.FUNCTION_BODY.replace("RAISE EXCEPTION", "RAISE NOTICE")), [row, trunc]),
        "row trigger missing": (fn, [trunc]),
        "truncate trigger missing": (fn, [row]),
        "row trigger disabled": (fn, [(ql.ROW_TRIGGER, 4242, "D", ql.ROW_TGTYPE), trunc]),
        "truncate trigger replica-only": (fn, [row, (ql.TRUNCATE_TRIGGER, 4242, "R", ql.TRUNCATE_TGTYPE)]),
        "row trigger calls another function": (fn, [(ql.ROW_TRIGGER, 99, "O", ql.ROW_TGTYPE), trunc]),
        "row trigger AFTER, not BEFORE": (fn, [(ql.ROW_TRIGGER, 4242, "O", ql.ROW_TGTYPE & ~2), trunc]),
        "row trigger misses DELETE": (fn, [(ql.ROW_TRIGGER, 4242, "O", ql.ROW_TGTYPE & ~8), trunc]),
        # The defect test (h) found: through asyncpg a raw "char" arrives as bytes, hence ::text in the query.
        "tgenabled as bytes": (fn, [(ql.ROW_TRIGGER, 4242, b"O", ql.ROW_TGTYPE), trunc]),
    }
    assert {name: ql.is_current(*args) for name, args in not_current.items()} == {name: False for name in not_current}


def test_the_append_only_ddl_is_schema_qualified():
    from scraper import quarantine_ledger as ql

    statements = ql.ddl('"corpus"')
    assert len(statements) == 5
    assert all('"corpus".' in s for s in statements)
    assert "BEFORE UPDATE OR DELETE ON \"corpus\".quarantine_decisions FOR EACH ROW" in statements[3]
    assert "BEFORE TRUNCATE ON \"corpus\".quarantine_decisions FOR EACH STATEMENT" in statements[4]


# ---------------------------------------------------------------------------------------------
# ruling 12: bounded inputs, refused before any database work
# ---------------------------------------------------------------------------------------------
class _DatabaseTouched(Exception):
    pass


class _RecordingSession:
    """Stands in for the AsyncSession: any use is recorded and raises."""

    def __init__(self, log):
        self._log = log

    def __getattr__(self, name):
        self._log.append(name)
        raise _DatabaseTouched(name)


@pytest.fixture
def api():
    from fastapi.testclient import TestClient

    from scraper.database import get_db
    from scraper.main import app

    touched = []

    async def recording_db():
        yield _RecordingSession(touched)

    app.dependency_overrides[get_db] = recording_db
    try:
        # Not entered as a context manager: no startup, so nothing connects at all.
        yield TestClient(app, raise_server_exceptions=False), touched
    finally:
        app.dependency_overrides.pop(get_db, None)


def _headers(key=None, admin=True):
    from scraper.config import settings

    headers = {"X-API-Key": settings.ADMIN_API_KEY if admin else "wrong-key"}
    if key is not None:
        headers["Idempotency-Key"] = key
    return headers


GOOD = {"reviewer": "Reviewer F23-U (synthetic)", "reason": "Synthetic reason"}
BAD_BODIES = {
    "no body": None,
    "no reviewer": {"reason": "Synthetic reason"},
    "no reason": {"reviewer": "Reviewer F23-U (synthetic)"},
    "empty reviewer": {**GOOD, "reviewer": ""},
    "blank reviewer": {**GOOD, "reviewer": "   "},
    "blank reason": {**GOOD, "reason": " \n\t "},
    "reviewer with a newline": {**GOOD, "reviewer": "Reviewer\nF23"},
    "reviewer too long": {**GOOD, "reviewer": "r" * 256},
    "reason too long": {**GOOD, "reason": "r" * 2001},
    "reason with NUL": {**GOOD, "reason": "synthetic\x00reason"},
    "reason with a bidi override": {**GOOD, "reason": "synthetic ‮reason"},
    "reviewer with a zero-width space": {**GOOD, "reviewer": "Reviewer​F23"},
    "reviewer not a string": {**GOOD, "reviewer": 123},
    "unknown field": {**GOOD, "trust_level": "trusted"},
    "a list": [GOOD],
}
BAD_KEYS = {"space": "has space", "too long": "k" * 129, "empty": "", "non-ascii": "clé".encode("utf-8"),
            "slash": "a/b"}


@pytest.mark.parametrize("action", ["promote", "reject"])
def test_bad_bodies_are_422_before_any_database_work(api, action):
    client, touched = api
    qid = uuid.uuid4()
    statuses = {}
    for name, payload in BAD_BODIES.items():
        kwargs = {} if payload is None else {"json": payload}
        statuses[name] = client.post(f"/quarantine/{qid}/{action}", headers=_headers(), **kwargs).status_code
    assert statuses == {name: 422 for name in BAD_BODIES}
    assert touched == []


@pytest.mark.parametrize("action", ["promote", "reject"])
def test_bad_ids_keys_and_admin_keys_are_refused_before_any_database_work(api, action):
    client, touched = api
    qid = uuid.uuid4()
    observed = {f"key {name}": client.post(f"/quarantine/{qid}/{action}", json=GOOD, headers=_headers(key)).status_code
                for name, key in BAD_KEYS.items()}
    for bad_id in ("not-a-uuid", "1", "00000000-0000-0000-0000-00000000000g"):
        observed[f"id {bad_id}"] = client.post(f"/quarantine/{bad_id}/{action}", json=GOOD, headers=_headers()).status_code
    observed["wrong admin key"] = client.post(f"/quarantine/{qid}/{action}", json=GOOD,
                                              headers=_headers(admin=False)).status_code
    observed["no admin key"] = client.post(f"/quarantine/{qid}/{action}", json=GOOD).status_code
    expected = {f"key {name}": 422 for name in BAD_KEYS}
    expected.update({"id not-a-uuid": 422, "id 1": 422, "id 00000000-0000-0000-0000-00000000000g": 422,
                     "wrong admin key": 401, "no admin key": 401})
    assert observed == expected
    assert touched == []


@pytest.mark.parametrize("action", ["promote", "reject"])
def test_a_valid_request_reaches_the_database(api, action):
    """The recording session is not vacuous: valid input at the limits goes on to the database."""
    client, touched = api
    body = {"reviewer": "r" * 255, "reason": "line one\nline two\t" + "r" * 1980}
    res = client.post(f"/quarantine/{uuid.uuid4()}/{action}", json=body,
                      headers=_headers("f23-unit:key_1.A-" + "k" * 100))
    assert res.status_code == 500 and touched, (res.status_code, touched)
