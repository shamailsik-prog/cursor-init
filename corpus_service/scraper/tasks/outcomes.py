"""Audit F28: what a corpus job run ended as, and whether Celery may retry it.

Spec: docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md (rulings R1-R30).

A run ends in one of five outcomes (R1): ``ok`` (rows written, no item failed), ``partial`` (some items
failed, at least one succeeded), ``empty`` (it worked and found nothing to write), ``skipped`` (a
deliberate policy decision not to run) and ``failed``. Only ``failed`` raises, so only ``failed`` is a
Celery FAILURE.

Harvesters count every document they try in a ``Tally`` (R3) and return ``Tally.finish()``, a
``HarvestResult``. ``finish`` raises ``SourceRunFailed`` when every document failed; a listing stage
calls ``raise_if_all_failed`` (R2). The dispatcher binds the run's tally (``bind_run_tally``) so a run
that fails part way still records what it wrote; a harvester gets it with ``run_tally()``.

Retries (R7) are bounded and explicit: ``will_retry`` / ``retry_countdown``. Only transient faults are
retried: network and timeout errors, a lost database connection, a transient SQLSTATE, or a
``SourceRunFailed`` whose item failures were all transient. An F25 refusal is never retried.

``describe_error`` is the only text a run record holds about an exception (R8): the class, and for a
database error only its SQLSTATE, since a driver message can carry row data or the DSN; any other
message with its credentials redacted (R29).

Re-audit round 2 (R21-R30): Celery's soft time limit, and the cancellation ``asyncio.run`` delivers
when that limit escapes the event loop, are the interruption family ``INTERRUPTIONS``. The tally
re-raises one instead of counting it (R23); the dispatcher records it as ``RunInterrupted`` and
re-raises the original (R21); it is never retried (R25).
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import errno
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, Optional

import httpx
from celery.exceptions import SoftTimeLimitExceeded
from sqlalchemy import exc as sa_exc

from scraper.net import fetch_policy
from scraper.parsers.pdf_signature import PDF_SIGNATURE, has_pdf_signature  # noqa: F401 (PDF_SIGNATURE re-exported)

# ---------------------------------------------------------------------------------------------
# Vocabulary (R1)
# ---------------------------------------------------------------------------------------------
OUTCOME_OK = "ok"
OUTCOME_PARTIAL = "partial"
OUTCOME_EMPTY = "empty"
OUTCOME_SKIPPED = "skipped"
OUTCOME_FAILED = "failed"

REASON_LISTINGS_FAILED = "every listing request failed"
REASON_DOCUMENTS_FAILED = "every document request failed"

# Per-item error codes that are not an HTTP status or an exception (R3, R16).
ERROR_NOT_PDF = "not_pdf"  # a body assumed to be a PDF has no %PDF- signature in its first 1024 bytes
ERROR_EMPTY_PDF_TEXT = "empty_pdf_text"  # a PDF whose extraction is empty or whitespace only
ERROR_FEED_UNPARSEABLE = "feed_unparseable"  # a discovery feed answered 200 with a payload that does not parse

REASON_FEEDS_FAILED = "every feed request failed"

# Audit F26 (spec docs/superpowers/specs/2026-10-18-f26-bounded-isolated-pdf-processing-design.md, R10):
# why the PDF intake refused a document. Each is a failed document, never progress, never retried.
ERROR_PDF_TOO_LARGE = "pdf_too_large"  # over PDF_MAX_SIZE_MB, refused by the fetch boundary while reading
ERROR_PDF_ACTIVE_CONTENT = "pdf_active_content"  # JavaScript, a launch action, an attachment, XFA
ERROR_RAW_STORE_FULL = "raw_store_full"  # the raw PDF store is at its bound
ERROR_RAW_STORE_FAILED = "raw_store_failed"  # the raw PDF store could not keep the document
ERROR_PDF_PARSE_TIMEOUT = "pdf_parse_timeout"  # the sandbox's wall or CPU limit
ERROR_PDF_MEMORY_LIMIT = "pdf_memory_limit"  # the sandbox's address-space limit
ERROR_PDF_PAGE_LIMIT = "pdf_page_limit"
ERROR_PDF_TEXT_LIMIT = "pdf_text_limit"
ERROR_PDF_PARSE_CRASHED = "pdf_parse_crashed"  # the sandbox died on a signal
ERROR_PDF_PARSE_FAILED = "pdf_parse_failed"  # the sandbox gave no usable answer


def looks_like_pdf(content: Optional[bytes]) -> bool:
    """R16: checked before extraction wherever a harvester assumes a body is a PDF. FA-corpus-005:
    the same rule as the extractor (``scraper.parsers.pdf_signature``), signature in the first 1024 bytes."""
    return has_pdf_signature(content)


# FA-corpus-004 / FA-corpus-008: real text has at least one letter (Lu/Ll/Lt/Lo) or digit (N*) that is
# not a default-ignorable filler (the Hangul fillers are Lo); private use, combining marks, symbols
# such as BRAILLE BLANK, U+FFFD and pdfplumber's "(cid:N)" tokens for unmapped glyphs are not text.
# FA-corpus-010: modifier letters (Lm: tatweel U+0640, U+02C6) carry no content on their own.
_TEXT_LETTERS = frozenset({"Lu", "Ll", "Lt", "Lo"})
_IGNORABLE_LETTERS = frozenset("\u115f\u1160\u3164\uffa0")
_CID_TOKEN = re.compile(r"\(cid:\d+\)")


def has_text(text: Optional[str]) -> bool:
    """R16: an extraction with no real letter or digit is a parse failure, never progress. Urdu text
    with ZWNJ/ZWJ between letters still counts; the text is not changed (FA-corpus-004/008)."""
    if not text:
        return False
    return any(
        (unicodedata.category(ch) in _TEXT_LETTERS or unicodedata.category(ch)[0] == "N")
        and ch not in _IGNORABLE_LETTERS
        for ch in _CID_TOKEN.sub("", text)
    )

# ---------------------------------------------------------------------------------------------
# Retry policy (R7)
# ---------------------------------------------------------------------------------------------
MAX_RETRIES = 3
RETRY_BASE_SECONDS = 300
RETRY_MAX_SECONDS = 3600

# HTTP answers worth asking again; every other status is about the URL, not the moment.
TRANSIENT_HTTP_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})
# promotion.py's transient set (connection, transaction rollback, resources, operator intervention,
# lock_not_available), copied rather than imported to keep this module out of promotion's lane.
_TRANSIENT_SQLSTATE_CLASSES = ("08", "40", "53", "57")
_TRANSIENT_SQLSTATES = ("55P03",)
_TRANSIENT_EXCEPTIONS = (
    httpx.TimeoutException,
    httpx.NetworkError,
    httpx.RemoteProtocolError,
    TimeoutError,
    ConnectionError,
    sa_exc.TimeoutError,  # R28: the pool's checkout timeout (every connection busy), not a fault of the data
)
# R28: OSError numbers that describe the network path at this moment, not the configuration.
_TRANSIENT_ERRNOS = frozenset({errno.ENETUNREACH, errno.EHOSTUNREACH})
# R28: getaddrinfo's EAI_AGAIN ("temporary failure in name resolution"), carried as socket.gaierror's
# errno: -3 under glibc and musl (the service's Linux images), 2 on BSD and macOS. The F25 guard keeps
# the socket module out of corpus code, so the class is recognised by its module and name.
_EAI_AGAIN = frozenset({-3, 2})


def _is_transient_os_error(exc: BaseException) -> bool:
    if not isinstance(exc, OSError):
        return False
    if exc.errno in _TRANSIENT_ERRNOS:
        return True
    is_gaierror = any(c.__module__ == "socket" and c.__name__ == "gaierror" for c in type(exc).__mro__)
    return is_gaierror and exc.errno in _EAI_AGAIN

_ERROR_TEXT_LIMIT = 1000


def retry_countdown(attempt: int) -> int:
    """Seconds before retry number ``attempt + 1``: 300, 600, 1200, ... capped at 3600."""
    return min(RETRY_BASE_SECONDS * (2 ** max(int(attempt), 0)), RETRY_MAX_SECONDS)


# ---------------------------------------------------------------------------------------------
# Failures
# ---------------------------------------------------------------------------------------------
# Each exception keeps its constructor arguments as ``args``, in order, so Celery can pickle it or
# rebuild it from a JSON result (``cls(*args)``).
def _errors_text(errors: Dict[str, int]) -> str:
    return ", ".join(f"{key} x{n}" for key, n in sorted(errors.items()))


class SourceRunFailed(Exception):
    """The run could not do its work: every listing request, or every document it tried, failed.
    ``errors`` counts the item failures by error key; ``retryable`` is true only when every one of
    them was transient."""

    def __init__(self, reason: str, errors: Optional[Dict[str, int]] = None, retryable: bool = False):
        self.reason = reason
        self.errors = dict(errors or {})
        self.retryable = bool(retryable)
        super().__init__(reason, self.errors, self.retryable)

    def __str__(self) -> str:
        detail = _errors_text(self.errors)
        return f"{self.reason} ({detail})" if detail else self.reason


class DocumentRejected(Exception):
    """Audit F26: the PDF intake refused one document (``code``: ``not_pdf``, ``empty_pdf_text``, an
    ``ERROR_PDF_*`` / ``ERROR_RAW_STORE_*`` code, or ``http_<status>``). The tally counts it by its code;
    only a transient ``http_<status>`` is worth retrying. ``detail`` never holds document content."""

    def __init__(self, code: str, detail: Optional[str] = None):
        self.code = code
        self.detail = detail
        super().__init__(code, detail)

    def __str__(self) -> str:
        return f"{self.code} ({self.detail})" if self.detail else self.code


class SourceRefused(Exception):
    """The dispatcher cannot run this source: no scraper_sources row, no route, or a route without a
    valid kind (R5). A configuration fault; never retried."""

    def __init__(self, source_name: str, reason: str):
        self.source_name = source_name
        self.reason = reason
        super().__init__(source_name, reason)

    def __str__(self) -> str:
        return f"{self.source_name}: {self.reason}"


class HarvesterContractError(Exception):
    """A harvester returned something other than a HarvestResult (R6). Never retried."""

    def __init__(self, source_name: str, returned: Any):
        self.source_name = source_name
        self.returned = returned if isinstance(returned, str) else type(returned).__name__
        super().__init__(source_name, self.returned)

    def __str__(self) -> str:
        return f"{self.source_name}: harvester returned {self.returned}, not a HarvestResult"


class RunRecordFailed(Exception):
    """The harvest succeeded but its run record could not be written (R8). Never retried: the rows
    are already written, and a retry would write them again."""

    def __init__(self, source_name: str):
        self.source_name = source_name
        super().__init__(source_name)

    def __str__(self) -> str:
        return f"{self.source_name}: the run succeeded but its record could not be written"


class BatchFailed(Exception):
    """An embedding batch tried items and none succeeded (R13)."""

    def __init__(self, errors: Optional[Dict[str, int]] = None):
        self.errors = dict(errors or {})
        super().__init__(self.errors)

    def __str__(self) -> str:
        return f"every embedding in the batch failed ({_errors_text(self.errors)})"


# ---------------------------------------------------------------------------------------------
# Interruptions (R21-R25)
# ---------------------------------------------------------------------------------------------
# Celery's soft time limit (billiard raises it from a signal handler), and the cancellation
# asyncio.run delivers to the run's task when that limit (or anything else) escapes the event loop
# while it waits on I/O. CancelledError is a BaseException, so an `except Exception` never sees it.
# KeyboardInterrupt, SystemExit and GeneratorExit are deliberately not here (R22): they propagate.
INTERRUPTIONS = (SoftTimeLimitExceeded, asyncio.CancelledError)

REASON_TIME_LIMIT = "time limit exceeded"
REASON_CANCELLED = "cancelled before it finished"


def is_interruption(exc: BaseException) -> bool:
    return isinstance(exc, INTERRUPTIONS)


def interruption_reason(exc: BaseException) -> str:
    """``time limit exceeded`` when the soft limit is ``exc`` or what it was raised while handling
    (asyncio.run's cancellation carries the limit as its ``__context__``); otherwise ``cancelled
    before it finished``. Unlike ``_chain``, this follows ``__context__``: that is the only link
    between the cancellation and its cause."""
    seen = set()
    candidate: Optional[BaseException] = exc
    while candidate is not None and id(candidate) not in seen:
        seen.add(id(candidate))
        if isinstance(candidate, SoftTimeLimitExceeded):
            return REASON_TIME_LIMIT
        candidate = candidate.__cause__ or candidate.__context__
    return REASON_CANCELLED


class RunInterrupted(Exception):
    """What a run record says about an interruption (R21): a neutral reason and the class that
    interrupted the run. Recorded in place of the raw exception; never raised to Celery, which gets
    the original."""

    def __init__(self, reason: str, interrupted_by: str):
        self.reason = reason
        self.interrupted_by = interrupted_by
        super().__init__(reason, interrupted_by)

    def __str__(self) -> str:
        return self.reason

    @classmethod
    def of(cls, exc: BaseException) -> "RunInterrupted":
        recorded = cls(interruption_reason(exc), type(exc).__name__)
        return recorded.with_traceback(exc.__traceback__)


_NEVER_RETRIED = (
    SourceRefused, HarvesterContractError, RunRecordFailed, BatchFailed, fetch_policy.FetchRefused,
    RunInterrupted, *INTERRUPTIONS,  # R25
)


# ---------------------------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------------------------
def _chain(exc: BaseException) -> Iterator[BaseException]:
    """``exc``, then what it explicitly wraps: SQLAlchemy's ``orig`` and ``__cause__`` (httpx and
    SQLAlchemy both ``raise ... from`` the error they map). ``__context__`` is not followed: an error
    raised while handling another one says nothing about whether the first was transient."""
    seen = set()
    stack = [exc]
    while stack:
        candidate = stack.pop()
        if candidate is None or id(candidate) in seen:
            continue
        seen.add(id(candidate))
        yield candidate
        stack.extend([getattr(candidate, "orig", None), candidate.__cause__])


def sqlstate(exc: BaseException) -> Optional[str]:
    """The SQLSTATE of a database error, looking through SQLAlchemy's wrapper and the driver's."""
    for candidate in _chain(exc):
        for attr in ("sqlstate", "pgcode"):
            code = getattr(candidate, attr, None)
            if isinstance(code, str) and len(code) == 5:
                return code
    return None


def is_database_error(exc: BaseException) -> bool:
    """A SQLAlchemy error or a driver error carrying a SQLSTATE (R4: it fails the run at once)."""
    return isinstance(exc, sa_exc.SQLAlchemyError) or isinstance(getattr(exc, "sqlstate", None), str)


def _is_transient_http(key: str) -> bool:
    if not key.startswith("http_"):
        return False
    status = key[5:]
    return status.isdigit() and int(status) in TRANSIENT_HTTP_STATUSES


def is_retryable(exc: BaseException) -> bool:
    """R7: only a transient fault is worth retrying."""
    if isinstance(exc, SourceRunFailed):
        return exc.retryable
    if isinstance(exc, DocumentRejected):
        return _is_transient_http(exc.code)
    if isinstance(exc, str):
        return _is_transient_http(exc)
    for candidate in _chain(exc):
        if isinstance(candidate, _NEVER_RETRIED):
            return False
    for candidate in _chain(exc):
        if isinstance(candidate, _TRANSIENT_EXCEPTIONS) or _is_transient_os_error(candidate):
            return True
        if getattr(candidate, "connection_invalidated", False):
            return True
    code = sqlstate(exc)
    return code is not None and (code[:2] in _TRANSIENT_SQLSTATE_CLASSES or code in _TRANSIENT_SQLSTATES)


def will_retry(exc: BaseException, attempt: int, max_retries: int) -> bool:
    """Whether attempt number ``attempt`` (0 = the first) is followed by another one."""
    return is_retryable(exc) and int(attempt) < int(max_retries)


def error_key(error: Any) -> str:
    """How a per-item failure is counted: a code such as ``http_404`` / ``not_pdf`` as is, an F26
    ``DocumentRejected`` by its code, an F25 refusal with its reason, any other exception by its class
    name."""
    if isinstance(error, str):
        return error
    if isinstance(error, DocumentRejected):
        return error.code
    if isinstance(error, fetch_policy.FetchRefused):
        return f"FetchRefused({error.reason})"
    return type(error).__name__


# R29: credential shapes redacted from an error message, in this order. Over-redaction is the safe
# side; the class name, the host and the non-secret parameters stay.
_REDACTIONS = (
    # URL userinfo up to the last "@" of the token, so a password holding "@" or "/" is covered.
    (re.compile(r"(?P<scheme>[A-Za-z][A-Za-z0-9+.\-]*://)\S*@"), lambda m: m.group("scheme") + "***@"),
    # An Authorization-style header, with or without its scheme word.
    (
        re.compile(
            r"(?i)\b(?P<name>(?:proxy-)?authorization|x-api-key|api-key|x-auth-token)(?P<sep>\s*[:=]\s*)"
            r"(?:(?P<scheme>bearer|basic|token|digest)\s+)?[^\s,;'\"]+"
        ),
        lambda m: f"{m.group('name')}{m.group('sep')}{m.group('scheme') + ' ' if m.group('scheme') else ''}***",
    ),
    (re.compile(r"(?i)\b(?P<scheme>bearer)\s+[A-Za-z0-9._~+/=\-]+"), lambda m: m.group("scheme") + " ***"),
    # name=value where the name ends in a credential word: query strings and keyword-style DSNs.
    (
        re.compile(
            r"(?i)(?<![A-Za-z0-9_\-])(?P<name>[A-Za-z0-9_\-]*?(?:token|key|secret|password|passwd|pwd|sig|signature|credential)s?)"
            r"(?P<sep>\s*=\s*)(?:'[^']*'|\"[^\"]*\"|[^&\s'\",;)]+)"
        ),
        lambda m: f"{m.group('name')}{m.group('sep')}***",
    ),
    # sk-... style API keys.
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{8,}"), lambda m: "sk-***"),
)


def _redact(message: str) -> str:
    for pattern, replacement in _REDACTIONS:
        message = pattern.sub(replacement, message)
    return message


def describe_error(exc: BaseException) -> str:
    """The text a run record may hold about ``exc`` (R8). A database error is its class and
    SQLSTATE only; anything else is ``Class: message`` with credentials redacted (R29: URL userinfo,
    credential parameters, Authorization-style headers, bearer tokens, sk- keys), control characters
    escaped and the length capped."""
    name = type(exc).__name__
    if is_database_error(exc):
        code = sqlstate(exc)
        return f"{name} (SQLSTATE {code})" if code else name
    message = _redact(str(exc))
    message = "".join(c if c.isprintable() else c.encode("unicode_escape").decode("ascii") for c in message)
    text = f"{name}: {message}" if message else name
    return text if len(text) <= _ERROR_TEXT_LIMIT else text[: _ERROR_TEXT_LIMIT - 14] + "...(truncated)"


# ---------------------------------------------------------------------------------------------
# Results (R6) and the tally harvesters count into (R3)
# ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class HarvestResult:
    """What a harvester run did. ``attempted`` documents, of which ``succeeded`` loaded and
    ``failed`` did not; ``written`` data rows (or files) produced; ``errors`` per error key.
    ``discovery_failed`` / ``discovery_errors``: secondary discovery requests (the IHC feeds) that
    failed while the run still went on (R17); they make the run partial."""

    attempted: int
    succeeded: int
    failed: int
    written: int
    errors: Dict[str, int] = field(default_factory=dict)
    note: Optional[str] = None
    discovery_failed: int = 0
    discovery_errors: Dict[str, int] = field(default_factory=dict)

    @property
    def outcome(self) -> str:
        if self.failed or self.discovery_failed:
            return OUTCOME_PARTIAL
        return OUTCOME_OK if self.written else OUTCOME_EMPTY

    def summary(self) -> Dict[str, Any]:
        out = {
            "outcome": self.outcome,
            "attempted": self.attempted,
            "succeeded": self.succeeded,
            "failed": self.failed,
            "written": self.written,
            "errors": dict(self.errors),
            "discovery_failed": self.discovery_failed,
            "discovery_errors": dict(self.discovery_errors),
        }
        if self.note:
            out["note"] = self.note
        return out


@dataclass(frozen=True)
class Skipped:
    """The dispatcher decided not to run the source (inactive, trust, a direct route for a source
    that is not trusted): a success with outcome ``skipped`` (R5)."""

    reason: str


@dataclass(frozen=True)
class Refused:
    """The dispatcher cannot run the source (R5); ``run_source`` raises ``SourceRefused``."""

    reason: str


class Tally:
    """Per-item outcomes of one stage of a run (the documents, or the listing pages)."""

    def __init__(self) -> None:
        self.attempted = 0
        self.succeeded = 0
        self.failed = 0
        self.written = 0
        self.transient_failures = 0
        self.errors: Counter = Counter()
        self.discovery_failed = 0
        self.discovery_errors: Counter = Counter()

    def item_ok(self, rows: int = 0) -> None:
        """One item loaded; ``rows`` data rows written from it (0: it held nothing to write)."""
        self.attempted += 1
        self.succeeded += 1
        self.written += int(rows)

    def item_failed(self, error: Any) -> None:
        """One item failed: an exception, or a code such as ``http_404`` or ``not_pdf``. An
        interruption is not an item failure: it is re-raised, uncounted, and ends the run (R23)."""
        if isinstance(error, BaseException) and is_interruption(error):
            raise error
        self.attempted += 1
        self.failed += 1
        self.errors[error_key(error)] += 1
        if is_retryable(error):
            self.transient_failures += 1

    @property
    def all_failed(self) -> bool:
        return self.attempted > 0 and self.failed == self.attempted

    def raise_if_all_failed(self, reason: str) -> None:
        if self.all_failed:
            raise SourceRunFailed(
                reason, errors=dict(self.errors), retryable=self.transient_failures == self.failed
            )

    def add_discovery_failures(self, stage: "Tally") -> None:
        """Carry a discovery stage's failures (the IHC feeds) into this run's result: the run went
        on, but those requests failed, so it is partial (R17)."""
        self.discovery_failed += stage.failed
        self.discovery_errors.update(stage.errors)

    def add_listing_failures(self, stage: "Tally", *, makes_partial: bool = False) -> None:
        """Record a listing stage's failed pages in this run's ``discovery_errors`` under
        ``listing:<key>`` (R30). A court's listings are recorded only (R17: legacy seeds and guessed
        child listings fail as expected noise); Nasir's fixed reporters (``makes_partial``) also count
        in ``discovery_failed``, so the run is partial, not an error-free empty run."""
        for key, n in stage.errors.items():
            self.discovery_errors[f"listing:{key}"] += n
        if makes_partial:
            self.discovery_failed += stage.failed

    def result(self, note: Optional[str] = None) -> HarvestResult:
        return HarvestResult(
            attempted=self.attempted,
            succeeded=self.succeeded,
            failed=self.failed,
            written=self.written,
            errors=dict(self.errors),
            note=note,
            discovery_failed=self.discovery_failed,
            discovery_errors=dict(self.discovery_errors),
        )

    def finish(self, note: Optional[str] = None) -> HarvestResult:
        """The run's result; raises ``SourceRunFailed`` when every document it tried failed."""
        self.raise_if_all_failed(REASON_DOCUMENTS_FAILED)
        return self.result(note)


_RUN_TALLY: contextvars.ContextVar[Optional[Tally]] = contextvars.ContextVar("f28_run_tally", default=None)


def run_tally() -> Tally:
    """The document tally of the run in progress (bound by the dispatcher), or a fresh one when a
    harvester is called on its own."""
    bound = _RUN_TALLY.get()
    return bound if bound is not None else Tally()


@contextlib.contextmanager
def bind_run_tally(tally: Tally) -> Iterator[Tally]:
    token = _RUN_TALLY.set(tally)
    try:
        yield tally
    finally:
        _RUN_TALLY.reset(token)
