"""Audit F28 unit tests: the job outcome vocabulary, the retry classifier, the backoff bound and the
error text a run record may hold (spec docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md,
rulings R1-R4, R7, R8, R15). No database, no network: the end-to-end flow is test_f28_source_outcomes_e2e.py."""

import httpx
import pytest
from sqlalchemy import exc as sa_exc

from scraper.net import fetch_policy
from scraper.tasks import outcomes


class _Driver(Exception):
    """A driver error carrying a SQLSTATE, as asyncpg's do."""

    def __init__(self, sqlstate, message="driver message"):
        super().__init__(message)
        self.sqlstate = sqlstate


def _db_error(sqlstate, message="driver message", invalidated=False):
    return sa_exc.DBAPIError("SELECT 1", {}, _Driver(sqlstate, message), connection_invalidated=invalidated)


# ---------------------------------------------------------------------------------------------
# R7: what may be retried
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "exc",
    [
        httpx.ConnectError("down"),
        httpx.ConnectTimeout("slow"),
        httpx.ReadTimeout("slow"),
        httpx.ReadError("reset"),
        httpx.RemoteProtocolError("peer closed"),
        TimeoutError("deadline"),
        ConnectionResetError("reset"),
        ConnectionRefusedError("refused"),
        _db_error("08006"),  # connection_failure
        _db_error("40001"),  # serialization_failure
        _db_error("53300"),  # too_many_connections
        _db_error("57P01"),  # admin_shutdown
        _db_error("55P03"),  # lock_not_available
        _db_error(None, invalidated=True),
        outcomes.SourceRunFailed("every document request failed", errors={"http_503": 2}, retryable=True),
    ],
    ids=lambda e: type(e).__name__ + ":" + str(getattr(e, "orig", "") or e)[:20],
)
def test_transient_failures_are_retryable(exc):
    assert outcomes.is_retryable(exc) is True


@pytest.mark.parametrize(
    "exc",
    [
        fetch_policy.FetchRefused(fetch_policy.BLOCKED_ADDRESS, "https://pakistancode.gov.pk/", "PakistanCode"),
        fetch_policy.FetchRefused(fetch_policy.DEADLINE, "https://pakistancode.gov.pk/", "PakistanCode"),
        ValueError("parse"),
        KeyError("h1"),
        RuntimeError("ALLOW_LOGIN_SCRAPING is true"),
        FileNotFoundError("import folder"),
        _db_error("23505"),  # unique_violation: about the data, not the connection
        _db_error("22001"),  # string_data_right_truncation
        _db_error("42P01"),  # undefined_table: a deployment fault
        _db_error("42501"),  # insufficient_privilege
        outcomes.SourceRunFailed("every listing request failed", errors={"http_404": 3}, retryable=False),
        outcomes.SourceRefused("NoSuchSource", "source_not_found"),
        outcomes.HarvesterContractError("PakistanCode", None),
        outcomes.RunRecordFailed("PakistanCode"),
        outcomes.BatchFailed(errors={"APIConnectionError": 1}),
    ],
    ids=lambda e: type(e).__name__,
)
def test_everything_else_is_not_retried(exc):
    assert outcomes.is_retryable(exc) is False


def test_retry_bound_and_backoff():
    assert [outcomes.retry_countdown(a) for a in range(6)] == [300, 600, 1200, 2400, 3600, 3600]
    transient = httpx.ConnectError("down")
    assert [outcomes.will_retry(transient, a, 3) for a in range(5)] == [True, True, True, False, False]
    assert outcomes.will_retry(transient, 0, 0) is False  # a direct call cannot be retried
    assert outcomes.will_retry(ValueError("parse"), 0, 3) is False
    assert outcomes.MAX_RETRIES == 3


# ---------------------------------------------------------------------------------------------
# R1-R3: the tally and the outcome of a run
# ---------------------------------------------------------------------------------------------
def test_outcomes_ok_partial_empty():
    ok = outcomes.Tally()
    ok.item_ok(3)
    ok.item_ok(0)
    result = ok.finish()
    assert (result.attempted, result.succeeded, result.failed, result.written, result.outcome) == (2, 2, 0, 3, "ok")

    partial = outcomes.Tally()
    partial.item_ok(1)
    partial.item_failed("http_500")
    result = partial.finish()
    assert (result.outcome, result.errors) == ("partial", {"http_500": 1})

    empty = outcomes.Tally().finish(note="idle: no_api_key_or_import_files")
    assert (empty.attempted, empty.written, empty.outcome, empty.note) == (0, 0, "empty", "idle: no_api_key_or_import_files")
    nothing_parsed = outcomes.Tally()
    nothing_parsed.item_ok(0)
    assert nothing_parsed.finish().outcome == "empty"


def test_every_item_failing_fails_the_run_and_only_an_all_transient_run_is_retryable():
    transient = outcomes.Tally()
    transient.item_failed(httpx.ConnectError("down"))
    transient.item_failed("http_503")
    with pytest.raises(outcomes.SourceRunFailed) as caught:
        transient.finish()
    assert caught.value.retryable is True
    assert caught.value.reason == "every document request failed"
    assert caught.value.errors == {"ConnectError": 1, "http_503": 1}

    mixed = outcomes.Tally()
    mixed.item_failed("http_503")
    mixed.item_failed("http_404")
    with pytest.raises(outcomes.SourceRunFailed) as caught:
        mixed.finish()
    assert caught.value.retryable is False

    refused = outcomes.Tally()
    refused.item_failed(fetch_policy.FetchRefused(fetch_policy.HOST_NOT_ALLOWED, "https://x.invalid/", "NasirLawSite"))
    with pytest.raises(outcomes.SourceRunFailed) as caught:
        refused.finish()
    assert caught.value.errors == {"FetchRefused(host_not_allowed)": 1} and caught.value.retryable is False


def test_listing_stage_fails_only_when_every_listing_request_failed():
    listings = outcomes.Tally()
    listings.item_failed("http_404")
    listings.item_ok()
    listings.raise_if_all_failed("every listing request failed")  # one loaded: no failure

    dead = outcomes.Tally()
    dead.item_failed(httpx.ConnectError("down"))
    with pytest.raises(outcomes.SourceRunFailed) as caught:
        dead.raise_if_all_failed("every listing request failed")
    assert caught.value.reason == "every listing request failed" and caught.value.retryable is True
    outcomes.Tally().raise_if_all_failed("every listing request failed")  # nothing tried: nothing failed


def test_an_empty_text_layer_is_a_failed_document_never_progress():
    """Review round, Codex P1 (spec R16): a PDF whose extraction is empty is a failed item."""
    assert outcomes.has_text("Short title. 1") is True
    assert [outcomes.has_text(t) for t in ("", "   \n\t ", None)] == [False, False, False]
    # Copilot 4305705122: the signature is checked before extraction wherever a body is assumed a PDF.
    assert outcomes.looks_like_pdf(b"%PDF-1.7\n...") is True
    assert [outcomes.looks_like_pdf(b) for b in (b"", b"%PDF", b"<html>%PDF-1.4")] == [False] * 3
    unreadable = outcomes.Tally()
    unreadable.item_failed(outcomes.ERROR_EMPTY_PDF_TEXT)
    with pytest.raises(outcomes.SourceRunFailed) as caught:
        unreadable.finish()
    assert caught.value.errors == {"empty_pdf_text": 1} and caught.value.retryable is False


def test_failed_discovery_requests_make_a_run_partial_and_all_failing_fails_it():
    """Review round, Codex P2 (spec R17): secondary discovery requests (the IHC feeds) are counted."""
    feeds = outcomes.Tally()
    feeds.item_failed("http_503")
    feeds.item_failed(outcomes.ERROR_FEED_UNPARSEABLE)
    with pytest.raises(outcomes.SourceRunFailed) as caught:
        feeds.raise_if_all_failed(outcomes.REASON_FEEDS_FAILED)
    assert caught.value.reason == "every feed request failed" and caught.value.retryable is False

    run = outcomes.Tally()
    some = outcomes.Tally()
    some.item_ok()
    some.item_failed("http_503")
    run.add_discovery_failures(some)
    run.item_ok(1)
    result = run.finish()
    assert (result.outcome, result.discovery_failed, result.discovery_errors) == ("partial", 1, {"http_503": 1})
    summary = result.summary()
    assert (summary["discovery_failed"], summary["discovery_errors"]) == (1, {"http_503": 1})
    nothing_found = outcomes.Tally()
    nothing_found.add_discovery_failures(some)
    assert nothing_found.finish().outcome == "partial"  # a feed failed and nothing else was found
    assert outcomes.Tally().finish().summary()["discovery_failed"] == 0


def test_the_bound_run_tally_is_the_one_harvesters_count_into():
    bound = outcomes.Tally()
    assert outcomes.run_tally() is not outcomes.run_tally()  # unbound: a fresh tally each time
    with outcomes.bind_run_tally(bound):
        assert outcomes.run_tally() is bound
        outcomes.run_tally().item_ok(2)
    assert bound.written == 2
    assert outcomes.run_tally() is not bound


def test_database_errors_are_recognised():
    assert outcomes.is_database_error(_db_error("23505"))
    assert outcomes.is_database_error(sa_exc.PendingRollbackError("rolled back"))
    assert not outcomes.is_database_error(httpx.ConnectError("down"))
    assert not outcomes.is_database_error(ValueError("parse"))


# ---------------------------------------------------------------------------------------------
# R8: what a run record may say about an error
# ---------------------------------------------------------------------------------------------
def test_error_text_never_carries_credentials_or_row_data():
    db = _db_error("23505", 'duplicate key value violates unique constraint; DETAIL: Key (citation)=(2099 SCMR 1) '
                            "postgresql://corpus_app:Sup3r-Secret@db:5432/corpus")
    text = outcomes.describe_error(db)
    assert text == "DBAPIError (SQLSTATE 23505)", text

    wrapped = outcomes.describe_error(ValueError("fetch of https://user:pa55word@example.invalid/x failed\nforged line"))
    assert "pa55word" not in wrapped and "user:" not in wrapped and "***@example.invalid" in wrapped, wrapped
    assert "\n" not in wrapped and wrapped.startswith("ValueError: "), wrapped

    refused = fetch_policy.FetchRefused(fetch_policy.USERINFO, "https://f28:f28@pakistancode.gov.pk/", "PakistanCode")
    text = outcomes.describe_error(refused)
    assert text.startswith("FetchRefused: ") and "f28:f28" not in text, text

    long = outcomes.describe_error(RuntimeError("x" * 5000))
    assert len(long) <= 1000, len(long)


@pytest.mark.parametrize(
    "exc",
    [
        outcomes.SourceRunFailed("every listing request failed", errors={"ConnectError": 4}, retryable=True),
        outcomes.SourceRefused("NoSuchSource", "source_not_found"),
        outcomes.HarvesterContractError("PakistanCode", None),
        outcomes.RunRecordFailed("PakistanCode"),
        outcomes.BatchFailed(errors={"APIConnectionError": 1}),
    ],
    ids=lambda e: type(e).__name__,
)
def test_failures_survive_celerys_result_serialisation(exc):
    """Celery pickles a task's exception, or rebuilds it from a JSON result as ``cls(*args)``; an
    exception that cannot be rebuilt reaches the caller as UnpickleableExceptionWrapper."""
    import pickle

    for rebuilt in (pickle.loads(pickle.dumps(exc)), type(exc)(*exc.args)):
        assert type(rebuilt) is type(exc) and str(rebuilt) == str(exc)
        assert outcomes.is_retryable(rebuilt) == outcomes.is_retryable(exc)


def test_error_keys():
    assert outcomes.error_key(httpx.ConnectError("down")) == "ConnectError"
    assert outcomes.error_key("http_404") == "http_404"
    assert outcomes.error_key(
        fetch_policy.FetchRefused(fetch_policy.BLOCKED_ADDRESS, "https://x.invalid/", "NasirLawSite")
    ) == "FetchRefused(blocked_address)"


# ---------------------------------------------------------------------------------------------
# Re-audit F28 (REAUDIT_F28.md): FA-corpus-005 and FA-corpus-004.
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("body", [
    b"\r\n%PDF-1.4\n...",                 # a leading CRLF
    b"\xef\xbb\xbf%PDF-1.7\n...",          # a UTF-8 BOM
    b" \n%PDF-1.5\n...",                   # leading whitespace
    b"\x00" * 1000 + b"%PDF-1.4\n",       # junk before the header, signature ends inside the window
])
def test_fa_corpus_005_the_signature_may_sit_anywhere_in_the_first_1024_bytes(body):
    """FA-corpus-005: the PDF spec allows bytes before the header, and the extractor has always
    accepted the signature anywhere in the first 1024 bytes; the harvesters' check must agree."""
    assert outcomes.looks_like_pdf(body) is True


@pytest.mark.parametrize("body", [
    None,
    b"",
    b"%PDF1.4\n",                                        # no dash: not the PDF header
    b"\x00" * 1024 + b"%PDF-1.4\n",                      # the signature starts past the window
    b"<html><body>" + b"x" * 1100 + b"%PDF-1.4</body></html>",  # an HTML page mentioning it late
    b"<html>%PDF-1.4",                                    # an HTML error page is never a PDF
    b"  <!DOCTYPE html><p>%PDF-1.4</p>",                 # nor with whitespace before it
])
def test_fa_corpus_005_what_is_still_not_a_pdf(body):
    assert outcomes.looks_like_pdf(body) is False


PARITY_INPUTS = [
    b"%PDF-1.7\n" + b"\x00" * 2048,
    b"\r\n%PDF-1.4\n" + b"\x00" * 2048,
    b"\xef\xbb\xbf%PDF-1.7\n" + b"\x00" * 2048,
    b"%PDF1.4\n" + b"\x00" * 2048,
    b"\x00" * 1024 + b"%PDF-1.4\n" + b"\x00" * 2048,
    b"<html>%PDF-1.4" + b"\x00" * 2048,
    b"GIF89a" + b"\x00" * 2048,
]


@pytest.mark.parametrize("body", PARITY_INPUTS)
def test_fa_corpus_005_harvesters_and_extractor_apply_one_signature_rule(body, caplog):
    """Parity: looks_like_pdf(x) is True exactly when the extractor's validation neither refuses x
    nor warns that it lacks the PDF signature."""
    import logging

    from scraper.parsers import pdf_extractor

    with caplog.at_level(logging.WARNING, logger=pdf_extractor.logger.name):
        try:
            pdf_extractor._validate_pdf_bytes(body, "f28://parity")
            extractor_accepts = not any("missing PDF magic" in r.getMessage() for r in caplog.records)
        except pdf_extractor.PDFDownloadError:
            extractor_accepts = False
    assert outcomes.looks_like_pdf(body) is extractor_accepts


INVISIBLE_ONLY = [
    "\u200c",                      # ZWNJ
    "\u200d\u200d",                # ZWJ
    "\u2060",                      # WORD JOINER
    "\u00ad  \u200e",              # SOFT HYPHEN, LRM
    "\u200f\ufeff\u200b",          # RLM, BOM, ZWSP
    "\u202a\u202e\u2066\u2069",    # bidi embeddings and isolates
    " \u00a0\n\u200c\t\u2060 \r",  # mixed with whitespace and NBSP
    "\x00\x07\u200c",              # control characters (Cc) with a ZWNJ
    "\u3000\u2028\u2029\u200d",    # Zs / Zl / Zp separators with a ZWJ
]


@pytest.mark.parametrize("text", INVISIBLE_ONLY)
def test_fa_corpus_004_invisible_characters_alone_are_no_text(text):
    """FA-corpus-004: text made only of whitespace and format/invisible characters is an empty
    extraction, a failed document (ERROR_EMPTY_PDF_TEXT), never progress."""
    assert outcomes.has_text(text) is False


@pytest.mark.parametrize("text", ["a", "7", "\u200cA\u200d", "ہو\u200cگا", "پاکستان\u200c کی عدالت"])
def test_fa_corpus_004_real_text_still_counts_including_urdu_with_zwnj(text):
    """Urdu legitimately carries ZWNJ/ZWJ between letters: only text with NOTHING else is rejected,
    and has_text does not change the text it is given."""
    before = str(text)
    assert outcomes.has_text(text) is True
    assert text == before
