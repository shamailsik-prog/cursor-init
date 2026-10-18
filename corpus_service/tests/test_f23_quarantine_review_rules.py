"""Audit F23 rules without a database.

* ``scraper.trust.human_review_decision``: the F20 vocabulary, failing closed (spec ruling 7).
* The deterministic publication id (spec ruling 4), recomputed here from the spec's formula.
* Input bounds (spec ruling 12): a malformed id, body or Idempotency-Key is 422 and a wrong admin
  key 401, before the route touches the database. The database dependency is replaced by one that
  records any use, so "no database work" is observed, not assumed.

These import names main does not have, so on main they fail at import; the behavioural RED for F23
is the end-to-end file, tests/test_f23_quarantine_review_db.py.

Re-audit round 2 (spec section 7): the visible-character rule (ruling 22) among the bad bodies; the
review routes answer 401 / 413 / 408 / 422 before reading the body, closing the connection
(rulings 13-16), driven through the ASGI app with a ``receive`` that counts its calls; no admin route
declares a body (ruling 17); a 422 is bounded and never echoes the input (ruling 18); the request
fingerprint (ruling 20). The real-server proof is tests/test_f23_review_body_guard_e2e.py.
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
    "reason with a bidi override": {**GOOD, "reason": "synthetic \u202ereason"},
    "reviewer with a zero-width space": {**GOOD, "reviewer": "Reviewer\u200bF23"},
    "reviewer not a string": {**GOOD, "reviewer": 123},
    "unknown field": {**GOOD, "trust_level": "trusted"},
    "a list": [GOOD],
    # Re-audit round 2, L7 (spec ruling 22): no visible letter or digit, or a line/paragraph separator.
    "reviewer a Hangul filler": {**GOOD, "reviewer": "\u3164"},
    "reviewer a halfwidth Hangul filler": {**GOOD, "reviewer": "\uffa0"},
    "reviewer Hangul choseong and jungseong fillers": {**GOOD, "reviewer": "\u115f\u1160"},
    "reviewer a braille blank": {**GOOD, "reviewer": "\u2800"},
    "reviewer combining marks only": {**GOOD, "reviewer": "\u0301"},
    "reviewer punctuation only": {**GOOD, "reviewer": "-.-"},
    "reviewer with a line separator": {**GOOD, "reviewer": "Reviewer\u2028F23"},
    "reason with a paragraph separator": {**GOOD, "reason": "synthetic\u2029reason"},
    "reason a braille blank": {**GOOD, "reason": "\u2800\u2800"},
    "reason punctuation only": {**GOOD, "reason": "..."},
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


# ---------------------------------------------------------------------------------------------
# re-audit round 2, M1 (spec rulings 13-17): the body is refused before it is read
# ---------------------------------------------------------------------------------------------
MAX_BODY_BYTES = 32 * 1024  # spec ruling 14


def _asgi_call(path, headers, chunks, *, timeout=5.0):
    """One HTTP request straight through the ASGI app. ``receive`` hands out ``chunks`` ((bytes,
    more_body) pairs) and then blocks, as a client that sends nothing more would. Returns the status
    (None when the app did not answer within ``timeout``), the Connection response header and how
    many times the app asked for body data."""
    import asyncio

    from scraper.main import app

    calls = []
    sent = []

    async def receive():
        calls.append(1)
        if chunks:
            data, more = chunks.pop(0)
            return {"type": "http.request", "body": data, "more_body": more}
        await asyncio.Event().wait()

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": "POST", "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "",
        "query_string": b"", "client": ("127.0.0.1", 50000), "server": ("testserver", 80),
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()],
    }

    async def go():
        try:
            await asyncio.wait_for(app(scope, receive, send), timeout)
        except Exception:  # noqa: BLE001 - a timeout or an app error: judged by what was sent
            pass

    asyncio.run(go())
    start = next((m for m in sent if m["type"] == "http.response.start"), None)
    if start is None:
        return None, None, len(calls)
    connection = {k.decode().lower(): v.decode() for k, v in start["headers"]}.get("connection")
    return start["status"], connection, len(calls)


def test_review_routes_answer_before_reading_the_body(api, monkeypatch):
    from scraper.config import settings
    from scraper.routers import quarantine

    # Spec ruling 15's deadline, shortened here; tests/test_f23_review_body_guard_e2e.py waits the real 10 s.
    monkeypatch.setattr(quarantine, "BODY_READ_SECONDS", 0.3, raising=False)
    _client, touched = api
    url = f"/quarantine/{uuid.uuid4()}/promote"
    key = settings.ADMIN_API_KEY
    json_type = {"content-type": "application/json"}
    complete = b'{"reviewer": "\\u2800", "reason": "Synthetic reason"}'  # valid JSON, refused by ruling 22
    observed = {
        "no key, 1 GB declared": _asgi_call(url, {**json_type, "content-length": "1000000000"}, []),
        "wrong key, 1 GB declared": _asgi_call(
            url, {**json_type, "content-length": "1000000000", "x-api-key": "wrong"}, []),
        "key, Content-Length over the cap": _asgi_call(
            url, {**json_type, "content-length": str(MAX_BODY_BYTES + 1), "x-api-key": key}, []),
        "key, malformed id": _asgi_call(
            "/quarantine/not-a-uuid/promote", {**json_type, "content-length": "100", "x-api-key": key}, []),
        "key, malformed Idempotency-Key": _asgi_call(
            url, {**json_type, "content-length": "100", "x-api-key": key, "idempotency-key": "a b"}, []),
        "key, not JSON": _asgi_call(url, {"content-type": "text/plain", "content-length": "100", "x-api-key": key}, []),
        "key, chunked past the cap": _asgi_call(
            url, {**json_type, "transfer-encoding": "chunked", "x-api-key": key},
            [(b"r" * 20_000, True), (b"r" * 20_000, True), (b"r" * 20_000, True)]),
        "key, the body stalls": _asgi_call(
            url, {**json_type, "content-length": "100", "x-api-key": key}, [(b'{"reviewer"', True)]),
        # A server that passes a Content-Length of non-ASCII digits through: the stream decides, never a 500.
        "key, Content-Length of superscript digits": _asgi_call(
            url, {**json_type, "content-length": "\u00b2\u00b3", "x-api-key": key}, []),
        "key, a complete body refused by validation": _asgi_call(
            url, {**json_type, "content-length": str(len(complete)), "x-api-key": key}, [(complete, False)]),
    }
    # (status, Connection header, receive() calls): nothing is read before the key is checked, the
    # cap applies to the declared and the streamed size, and a response sent before the body was
    # complete closes the connection (spec ruling 16).
    assert observed == {
        "no key, 1 GB declared": (401, "close", 0),
        "wrong key, 1 GB declared": (401, "close", 0),
        "key, Content-Length over the cap": (413, "close", 0),
        "key, malformed id": (422, "close", 0),
        "key, malformed Idempotency-Key": (422, "close", 0),
        "key, not JSON": (422, "close", 0),
        "key, chunked past the cap": (413, "close", 2),
        "key, the body stalls": (408, "close", 2),
        "key, Content-Length of superscript digits": (408, "close", 1),
        "key, a complete body refused by validation": (422, None, 1),
    }
    assert touched == []


def test_no_admin_route_reads_a_body_before_authenticating():
    """Spec ruling 17: FastAPI reads a declared body before it runs a route's dependencies, so no route
    that depends on require_admin_api_key may declare one. The review routes read theirs themselves,
    after the key check."""
    from fastapi.routing import APIRoute, iter_route_contexts

    from scraper.auth import require_admin_api_key
    from scraper.main import app

    def calls(dependant):
        for sub in dependant.dependencies:
            yield sub.call
            yield from calls(sub)

    admin, with_body = set(), set()
    for context in iter_route_contexts(app.routes):
        route = context.route
        if not isinstance(route, APIRoute) or require_admin_api_key not in set(calls(route.dependant)):
            continue
        names = {f"{method} {context.path}" for method in route.methods}
        admin |= names
        if route.body_field is not None:
            with_body |= names
    assert {"POST /quarantine/{quarantine_id}/promote", "POST /quarantine/{quarantine_id}/reject",
            "POST /api/start", "POST /api/stop", "POST /admin/sources/{name}/trigger"} <= admin, admin
    assert with_body == set()


# ---------------------------------------------------------------------------------------------
# re-audit round 2, L4/L5 (spec ruling 18): a 422 is bounded and never echoes the input
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("action", ["promote", "reject"])
def test_validation_errors_are_bounded_and_never_echo_the_input(api, action):
    client, touched = api
    extra = {f"x{i:02d}" + "k" * 300: "v" * 50 for i in range(40)}  # about 14 KB, under the cap
    res = client.post(f"/quarantine/{uuid.uuid4()}/{action}", json={**GOOD, **extra}, headers=_headers())
    entries = res.json()["detail"]
    observed = {
        "status": res.status_code,
        "entries": len(entries),
        "only type, loc and msg": all(set(e) == {"type", "loc", "msg"} for e in entries),
        "loc parts at most 64 characters": all(len(p) <= 64 for e in entries for p in e["loc"] if isinstance(p, str)),
        "msg at most 200 characters": all(len(e["msg"]) <= 200 for e in entries),
        "last entry": (entries[-1]["type"], entries[-1]["msg"]),
        "under 4 KB": len(res.content) < 4096,
    }
    assert observed == {"status": 422, "entries": 11, "only type, loc and msg": True,
                        "loc parts at most 64 characters": True, "msg at most 200 characters": True,
                        "last entry": ("too_many_errors", "30 more errors not shown"), "under 4 KB": True}
    assert touched == []


# ---------------------------------------------------------------------------------------------
# re-audit round 2, L8 (spec ruling 25): invisible characters are written as escapes
# ---------------------------------------------------------------------------------------------
F23_FILES = (
    "scraper/routers/quarantine.py", "scraper/quarantine_ledger.py", "migrations/002_quarantine_decisions.py",
    "migrations/003_quarantine_decision_fingerprint.py", "tests/test_f23_quarantine_review_db.py",
    "tests/test_f23_quarantine_review_rules.py", "tests/test_f23_review_hardening_db.py",
    "tests/test_f23_review_body_guard_e2e.py",
)
_INVISIBLE_SO = {"\u2800"}  # braille pattern blank: category So, renders as nothing
_INVISIBLE_LO = {"\u115f", "\u1160", "\u3164", "\uffa0"}  # Hangul fillers


def test_f23_files_write_invisible_characters_as_escapes():
    """A reader of the source must see every character it contains: no format, control, separator,
    combining, private-use or unassigned character, and no blank-rendering letter or symbol, is
    written literally in F23's code or tests (the re-audit found U+202E and U+200B in this file)."""
    import unicodedata
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    found = []
    for name in F23_FILES:
        for number, line in enumerate((root / name).read_text(encoding="utf-8").splitlines(), 1):
            for ch in line:
                if ch.isascii() and (ch.isprintable() or ch == "\t"):
                    continue
                category = unicodedata.category(ch)
                if category[0] not in "LNPS" or ch in _INVISIBLE_SO or ch in _INVISIBLE_LO:
                    found.append(f"{name}:{number}: U+{ord(ch):04X} ({category})")
    assert found == []


# ---------------------------------------------------------------------------------------------
# re-audit round 2, L6 (spec ruling 20): the request fingerprint
# ---------------------------------------------------------------------------------------------
def test_the_request_fingerprint_is_sha256_of_the_canonical_values():
    import hashlib
    import json

    from scraper.routers.quarantine import request_fingerprint

    cases = [("promoted", "Reviewer F23-U (synthetic)", "Synthetic reason"),
             ("rejected", "\u0634\u0645\u0627\u0626\u0644", "line one\nline two\t\"quoted\"")]
    for decision, reviewer, reason in cases:
        canonical = json.dumps({"decision": decision, "reason": reason, "reviewer": reviewer},
                               sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        assert request_fingerprint(decision, reviewer, reason) == hashlib.sha256(canonical.encode("ascii")).hexdigest()
    # The fields are delimited, not concatenated.
    assert request_fingerprint("promoted", "ab", "c") != request_fingerprint("promoted", "a", "bc")
