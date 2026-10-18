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
def _current_state():
    from scraper import quarantine_ledger as ql

    function = {"oid": 4242, **ql.EXPECTED_FUNCTION}
    triggers = [
        {"tgname": ql.ROW_TRIGGER, **ql.expected_trigger(4242, ql.ROW_TGTYPE)},
        {"tgname": ql.TRUNCATE_TRIGGER, **ql.expected_trigger(4242, ql.TRUNCATE_TGTYPE)},
    ]
    return function, triggers


def _with(rows, name, **changes):
    return [{**row, **changes} if row["tgname"] == name else row for row in rows]


def test_the_append_only_state_is_current_only_when_exact():
    """Review round (Copilot thread 4305754687): every attribute that changes what the function does or
    when a trigger fires makes the state not current, so migrate rebuilds it (fail closed)."""
    from scraper import quarantine_ledger as ql

    fn, trg = _current_state()
    row, trunc = ql.ROW_TRIGGER, ql.TRUNCATE_TRIGGER
    assert ql.is_current(fn, trg) is True
    assert ql.is_current(fn, list(reversed(trg))) is True
    not_current = {
        "no function": (None, trg),
        "no-op body": ({**fn, "prosrc": "BEGIN RETURN NEW; END"}, trg),
        "body without the raise": ({**fn, "prosrc": ql.FUNCTION_BODY.replace("RAISE EXCEPTION", "RAISE NOTICE")}, trg),
        "another language": ({**fn, "lanname": "plpython3u"}, trg),
        "SECURITY DEFINER": ({**fn, "prosecdef": True}, trg),
        "SET options": ({**fn, "no_config": False}, trg),
        "strict": ({**fn, "proisstrict": True}, trg),
        "a procedure": ({**fn, "prokind": "p"}, trg),
        "row trigger missing": (fn, [t for t in trg if t["tgname"] != row]),
        "truncate trigger missing": (fn, [t for t in trg if t["tgname"] != trunc]),
        "row trigger WHEN (false)": (fn, _with(trg, row, no_qual=False)),
        "row trigger UPDATE OF reason": (fn, _with(trg, row, attr_count=1)),
        "row trigger FOR EACH STATEMENT": (fn, _with(trg, row, tgtype=ql.ROW_TGTYPE & ~1)),
        "row trigger AFTER, not BEFORE": (fn, _with(trg, row, tgtype=ql.ROW_TGTYPE & ~2)),
        "row trigger misses DELETE": (fn, _with(trg, row, tgtype=ql.ROW_TGTYPE & ~8)),
        "row trigger misses UPDATE": (fn, _with(trg, row, tgtype=ql.ROW_TGTYPE & ~16)),
        "row trigger enabled only in origin mode ('O')": (fn, _with(trg, row, tgenabled="O")),
        "row trigger replica-only": (fn, _with(trg, row, tgenabled="R")),
        "row trigger disabled": (fn, _with(trg, row, tgenabled="D")),
        "truncate trigger enabled only in origin mode ('O')": (fn, _with(trg, trunc, tgenabled="O")),
        "row trigger calls another function": (fn, _with(trg, row, tgfoid=99)),
        "row trigger with arguments": (fn, _with(trg, row, tgnargs=1)),
        "row trigger is a constraint trigger": (fn, _with(trg, row, no_constraint=False)),
        "row trigger deferrable": (fn, _with(trg, row, tgdeferrable=True)),
        "row trigger initially deferred": (fn, _with(trg, row, tginitdeferred=True)),
        "row trigger with transition tables": (fn, _with(trg, row, no_transition_tables=False)),
        "row trigger cloned from a parent": (fn, _with(trg, row, no_parent=False)),
        "truncate trigger per row": (fn, _with(trg, trunc, tgtype=ql.TRUNCATE_TGTYPE | 1)),
        # The defect test (h) found: through asyncpg a raw "char" arrives as bytes, hence ::text in the query.
        "tgenabled as bytes": (fn, _with(trg, row, tgenabled=b"A")),
    }
    assert {name: ql.is_current(*args) for name, args in not_current.items()} == {name: False for name in not_current}


def test_the_append_only_ddl_rebuilds_from_nothing_schema_qualified():
    from scraper import quarantine_ledger as ql

    statements = ql.ddl('"corpus"')
    assert all('"corpus".' in s for s in statements)
    assert statements[:3] == (
        f'DROP TRIGGER IF EXISTS {ql.ROW_TRIGGER} ON "corpus".quarantine_decisions',
        f'DROP TRIGGER IF EXISTS {ql.TRUNCATE_TRIGGER} ON "corpus".quarantine_decisions',
        f'DROP FUNCTION IF EXISTS "corpus".{ql.FUNCTION}() CASCADE',
    )
    assert statements[3].startswith(f'CREATE FUNCTION "corpus".{ql.FUNCTION}() RETURNS trigger LANGUAGE plpgsql')
    assert 'BEFORE DELETE OR UPDATE ON "corpus".quarantine_decisions FOR EACH ROW EXECUTE' in statements[4]
    assert 'WHEN' not in statements[4] and ' OF ' not in statements[4]
    assert 'BEFORE TRUNCATE ON "corpus".quarantine_decisions FOR EACH STATEMENT EXECUTE' in statements[5]
    assert statements[6:] == (
        f'ALTER TABLE "corpus".quarantine_decisions ENABLE ALWAYS TRIGGER {ql.ROW_TRIGGER}',
        f'ALTER TABLE "corpus".quarantine_decisions ENABLE ALWAYS TRIGGER {ql.TRUNCATE_TRIGGER}',
    )


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
