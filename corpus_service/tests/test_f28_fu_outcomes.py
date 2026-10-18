"""Audit F28, re-audit round 2: unit tests for the interruption family (M1), the transient database
faults (L4), the run-record redaction (L5) and the listing-failure record (L1).

Spec: docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md, section 6, rulings
R21-R30. Expected values are written out from the spec, not imported from the code under test. No
database, no network: the end-to-end proof is test_f28_fu_prefork_e2e.py and test_f28_fu_e2e.py.
"""

import asyncio
import errno
import pickle
import socket

import httpx
import pytest
from celery.exceptions import SoftTimeLimitExceeded
from sqlalchemy import exc as sa_exc

from scraper.tasks import outcomes

TIME_LIMIT = "time limit exceeded"
CANCELLED = "cancelled before it finished"


def _cancelled_after_the_time_limit():
    """The CancelledError asyncio.run throws into the run's task after billiard's soft-limit handler
    raised while the loop waited on I/O: its __context__ is the SoftTimeLimitExceeded (probe in the
    evidence log)."""
    try:
        try:
            raise SoftTimeLimitExceeded()
        except SoftTimeLimitExceeded:
            raise asyncio.CancelledError()
    except asyncio.CancelledError as exc:
        return exc


# ---------------------------------------------------------------------------------------------
# R21, R23, R25: the interruption family
# ---------------------------------------------------------------------------------------------
def test_interruptions_are_classified_and_never_retried():
    soft = SoftTimeLimitExceeded()
    after_limit = _cancelled_after_the_time_limit()
    bare = asyncio.CancelledError()

    assert all(outcomes.is_interruption(e) for e in (soft, after_limit, bare))
    assert not any(outcomes.is_interruption(e) for e in (ValueError("x"), TimeoutError("t"), KeyboardInterrupt()))
    assert not outcomes.is_interruption(SystemExit(0)) and not outcomes.is_interruption(GeneratorExit())

    assert outcomes.interruption_reason(soft) == TIME_LIMIT
    assert outcomes.interruption_reason(after_limit) == TIME_LIMIT
    assert outcomes.interruption_reason(bare) == CANCELLED

    for exc in (soft, after_limit, bare):
        assert outcomes.is_retryable(exc) is False, exc
        assert outcomes.will_retry(exc, 0, 3) is False, exc


def test_a_run_interrupted_record_names_the_reason_and_what_interrupted_it():
    recorded = outcomes.RunInterrupted.of(_cancelled_after_the_time_limit())
    assert (recorded.reason, recorded.interrupted_by) == (TIME_LIMIT, "CancelledError")
    assert outcomes.describe_error(recorded) == "RunInterrupted: time limit exceeded"
    assert outcomes.is_retryable(recorded) is False

    direct = outcomes.RunInterrupted.of(SoftTimeLimitExceeded())
    assert (direct.reason, direct.interrupted_by) == (TIME_LIMIT, "SoftTimeLimitExceeded")
    bare = outcomes.RunInterrupted.of(asyncio.CancelledError())
    assert (bare.reason, bare.interrupted_by) == (CANCELLED, "CancelledError")

    # R15: it survives Celery's result encoding (pickle, or cls(*args) from JSON).
    for rebuilt in (pickle.loads(pickle.dumps(recorded)), type(recorded)(*recorded.args)):
        assert type(rebuilt) is outcomes.RunInterrupted and str(rebuilt) == str(recorded)
        assert (rebuilt.reason, rebuilt.interrupted_by) == (TIME_LIMIT, "CancelledError")


@pytest.mark.parametrize("make", [SoftTimeLimitExceeded, asyncio.CancelledError], ids=lambda c: c.__name__)
def test_the_tally_re_raises_an_interruption_and_counts_nothing(make):
    """R23: a per-item handler that catches the time limit hands it to the tally, which re-raises it
    instead of counting a failed item."""
    tally = outcomes.Tally()
    tally.item_ok(3)
    interruption = make()
    with pytest.raises(make) as caught:
        tally.item_failed(interruption)
    assert caught.value is interruption
    assert (tally.attempted, tally.succeeded, tally.failed, tally.written, dict(tally.errors)) == (1, 1, 0, 3, {})


# ---------------------------------------------------------------------------------------------
# R28 (L4): transient database connection faults
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "exc",
    [
        socket.gaierror(socket.EAI_AGAIN, "Temporary failure in name resolution"),
        OSError(errno.ENETUNREACH, "Network is unreachable"),
        OSError(errno.EHOSTUNREACH, "No route to host"),
        sa_exc.TimeoutError("QueuePool limit of size 20 overflow 30 reached, connection timed out, timeout 30.00"),
    ],
    ids=["gaierror-EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "pool-checkout-timeout"],
)
def test_transient_database_connection_faults_are_retried(exc):
    assert outcomes.is_retryable(exc) is True
    assert outcomes.will_retry(exc, 0, 3) is True and outcomes.will_retry(exc, 3, 3) is False


@pytest.mark.parametrize(
    "exc",
    [
        socket.gaierror(socket.EAI_NONAME, "Name or service not known"),
        OSError(errno.ENOENT, "No such file or directory"),
        OSError(errno.EACCES, "Permission denied"),
    ],
    ids=["gaierror-EAI_NONAME", "ENOENT", "EACCES"],
)
def test_other_os_errors_stay_permanent(exc):
    assert outcomes.is_retryable(exc) is False


# ---------------------------------------------------------------------------------------------
# R29 (L5): no credential reaches a run record
# ---------------------------------------------------------------------------------------------
SECRET = "S3cr3tF28"

# The re-audit's 13 cases (redaction_probe.py), verbatim, then the further shapes R29 names.
REDACTION_CASES = {
    "url userinfo": RuntimeError(f"GET https://user:{SECRET}@host.example/x failed"),
    "dsn userinfo": RuntimeError(f"connect postgresql+asyncpg://corpus:{SECRET}@db:5432/corpus failed"),
    "password containing @": RuntimeError(f"https://user:p@{SECRET}@host.example/x"),
    "password containing /": RuntimeError(f"https://user:ab/{SECRET}@host.example/x"),
    "query token": RuntimeError(f"GET https://api.example/v1?token={SECRET}&x=1 failed"),
    "query api_key": RuntimeError(f"GET https://api.example/v1?api_key={SECRET} failed"),
    "libpq keyword dsn": RuntimeError(f"could not connect: host=db user=corpus password={SECRET} dbname=c"),
    "bearer header": RuntimeError(f"401 for Authorization: Bearer {SECRET}"),
    "redis url": ConnectionError(f"Error connecting to rediss://:{SECRET}@redis:6380/0"),
    "openai-style key": RuntimeError(f"Incorrect API key provided: sk-{SECRET}abcdefghijkl"),
    "httpx connect error": httpx.ConnectError(f"[Errno -2] https://user:{SECRET}@h/"),
    "sqlalchemy dbapi": sa_exc.OperationalError("SELECT 1", {}, Exception(f"password={SECRET}")),
    "control chars": RuntimeError("line1\nF28 source alert: forged\r\x1b[31m"),
    # R29's further shapes
    "control chars around userinfo": RuntimeError(f"line1\nhttps://u:{SECRET}@h/\r\x1b[31m"),
    "query apikey": RuntimeError(f"GET https://api.example/v1?apikey={SECRET}"),
    "query access_token": RuntimeError(f"GET https://api.example/v1?x=1&access_token={SECRET}"),
    "query key": RuntimeError(f"GET https://maps.example/api?key={SECRET}&q=1"),
    "query secret": RuntimeError(f"POST /oauth?client_id=a&client_secret={SECRET}"),
    "query sig": RuntimeError(f"GET https://blob.example/f.pdf?sv=1&sig={SECRET}"),
    "query signature": RuntimeError(f"GET https://bucket.example/f.pdf?Signature={SECRET}&Expires=1"),
    "quoted keyword password": RuntimeError(f"connect failed: host=db password='{SECRET} with space' dbname=c"),
    "basic header": RuntimeError(f"Authorization: Basic {SECRET}=="),
    "x-api-key header": RuntimeError(f"403 with X-Api-Key: {SECRET}"),
    "bare bearer": RuntimeError(f"token rejected: Bearer {SECRET}.part2"),
    "sk-proj key": RuntimeError(f"bad key sk-proj-{SECRET}_abcdefgh"),
}


@pytest.mark.parametrize("name", sorted(REDACTION_CASES))
def test_describe_error_redacts_every_credential_shape(name):
    exc = REDACTION_CASES[name]
    text = outcomes.describe_error(exc)
    assert SECRET not in text, f"{name} leaked: {text}"
    assert "S3cr3t" not in text, f"{name} leaked part of the secret: {text}"
    assert text.startswith(type(exc).__name__), text
    assert all(c.isprintable() for c in text), repr(text)


def test_redaction_keeps_the_context_an_operator_needs():
    """Over-redaction is the safe side, but the host, the path and the non-secret parameters stay."""
    assert outcomes.describe_error(REDACTION_CASES["url userinfo"]) == "RuntimeError: GET https://***@host.example/x failed"
    assert outcomes.describe_error(REDACTION_CASES["password containing /"]) == "RuntimeError: https://***@host.example/x"
    assert outcomes.describe_error(REDACTION_CASES["query token"]) == "RuntimeError: GET https://api.example/v1?token=***&x=1 failed"
    assert outcomes.describe_error(REDACTION_CASES["libpq keyword dsn"]) == (
        "RuntimeError: could not connect: host=db user=corpus password=*** dbname=c"
    )
    assert outcomes.describe_error(REDACTION_CASES["bearer header"]) == "RuntimeError: 401 for Authorization: Bearer ***"
    assert outcomes.describe_error(REDACTION_CASES["openai-style key"]) == "RuntimeError: Incorrect API key provided: sk-***"
    assert outcomes.describe_error(REDACTION_CASES["sqlalchemy dbapi"]) == "OperationalError"
    assert outcomes.describe_error(RuntimeError("GET https://pakistancode.gov.pk/federal?page=2 failed")) == (
        "RuntimeError: GET https://pakistancode.gov.pk/federal?page=2 failed"
    )


# ---------------------------------------------------------------------------------------------
# R30 (L1): listing failures are recorded; only Nasir's make the run partial
# ---------------------------------------------------------------------------------------------
def _listings(*failures, loaded=1):
    stage = outcomes.Tally()
    for _ in range(loaded):
        stage.item_ok()
    for failure in failures:
        stage.item_failed(failure)
    return stage


def test_listing_failures_are_recorded_under_listing_keys_without_changing_a_court_outcome():
    listings = _listings("http_404", "http_404", httpx.ConnectError("down"))
    court = outcomes.Tally()
    court.add_listing_failures(listings)
    court.item_ok(1)
    result = court.finish()
    assert (result.outcome, result.discovery_failed) == ("ok", 0)
    assert result.discovery_errors == {"listing:http_404": 2, "listing:ConnectError": 1}
    assert result.summary()["discovery_errors"] == {"listing:http_404": 2, "listing:ConnectError": 1}

    idle_court = outcomes.Tally()
    idle_court.add_listing_failures(listings)
    assert idle_court.finish().outcome == "empty"  # R17 stands: recorded, not partial


def test_nasir_reporter_failures_make_the_run_partial():
    reporters = _listings("http_503", "http_503", "http_503", httpx.ConnectError("down"))
    nasir = outcomes.Tally()
    nasir.add_listing_failures(reporters, makes_partial=True)
    result = nasir.finish()
    assert (result.outcome, result.attempted, result.written, result.discovery_failed) == ("partial", 0, 0, 4)
    assert result.discovery_errors == {"listing:http_503": 3, "listing:ConnectError": 1}

    feeds = _listings("http_503")
    both = outcomes.Tally()
    both.add_discovery_failures(feeds)  # R17's feed keys stay unprefixed
    both.add_listing_failures(reporters)
    assert both.finish().discovery_errors == {"http_503": 1, "listing:http_503": 3, "listing:ConnectError": 1}
