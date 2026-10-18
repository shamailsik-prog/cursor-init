"""Audit F28: what a corpus job run ended as, and whether Celery may retry it.

Spec: docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md (rulings R1-R15).

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
database error only its SQLSTATE, since a driver message can carry row data or the DSN.
"""

from __future__ import annotations

import contextlib
import contextvars
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, Optional

import httpx
from sqlalchemy import exc as sa_exc

from scraper.net import fetch_policy

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
ERROR_NOT_PDF = "not_pdf"  # a body assumed to be a PDF does not start with the %PDF- signature
ERROR_EMPTY_PDF_TEXT = "empty_pdf_text"  # a PDF whose extraction is empty or whitespace only

PDF_SIGNATURE = b"%PDF-"


def looks_like_pdf(content: Optional[bytes]) -> bool:
    """R16: checked before extraction wherever a harvester assumes a body is a PDF."""
    return bool(content) and content.startswith(PDF_SIGNATURE)


def has_text(text: Optional[str]) -> bool:
    """R16: an extraction that is empty or whitespace only is a parse failure, never progress."""
    return bool(text) and bool(text.strip())

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
)

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


_NEVER_RETRIED = (SourceRefused, HarvesterContractError, RunRecordFailed, BatchFailed, fetch_policy.FetchRefused)


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
    if isinstance(exc, str):
        return _is_transient_http(exc)
    for candidate in _chain(exc):
        if isinstance(candidate, _NEVER_RETRIED):
            return False
    for candidate in _chain(exc):
        if isinstance(candidate, _TRANSIENT_EXCEPTIONS):
            return True
        if getattr(candidate, "connection_invalidated", False):
            return True
    code = sqlstate(exc)
    return code is not None and (code[:2] in _TRANSIENT_SQLSTATE_CLASSES or code in _TRANSIENT_SQLSTATES)


def will_retry(exc: BaseException, attempt: int, max_retries: int) -> bool:
    """Whether attempt number ``attempt`` (0 = the first) is followed by another one."""
    return is_retryable(exc) and int(attempt) < int(max_retries)


def error_key(error: Any) -> str:
    """How a per-item failure is counted: a code such as ``http_404`` / ``not_pdf`` as is, an F25
    refusal with its reason, any other exception by its class name."""
    if isinstance(error, str):
        return error
    if isinstance(error, fetch_policy.FetchRefused):
        return f"FetchRefused({error.reason})"
    return type(error).__name__


_USERINFO = re.compile(r"(?P<scheme>[A-Za-z][A-Za-z0-9+.\-]*://)[^/\s@]*@")


def describe_error(exc: BaseException) -> str:
    """The text a run record may hold about ``exc`` (R8). A database error is its class and
    SQLSTATE only; anything else is ``Class: message`` with URL userinfo redacted, control characters
    escaped and the length capped."""
    name = type(exc).__name__
    if is_database_error(exc):
        code = sqlstate(exc)
        return f"{name} (SQLSTATE {code})" if code else name
    message = _USERINFO.sub(lambda m: m.group("scheme") + "***@", str(exc))
    message = "".join(c if c.isprintable() else c.encode("unicode_escape").decode("ascii") for c in message)
    text = f"{name}: {message}" if message else name
    return text if len(text) <= _ERROR_TEXT_LIMIT else text[: _ERROR_TEXT_LIMIT - 14] + "...(truncated)"


# ---------------------------------------------------------------------------------------------
# Results (R6) and the tally harvesters count into (R3)
# ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class HarvestResult:
    """What a harvester run did. ``attempted`` documents, of which ``succeeded`` loaded and
    ``failed`` did not; ``written`` data rows (or files) produced; ``errors`` per error key."""

    attempted: int
    succeeded: int
    failed: int
    written: int
    errors: Dict[str, int] = field(default_factory=dict)
    note: Optional[str] = None

    @property
    def outcome(self) -> str:
        if self.failed:
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

    def item_ok(self, rows: int = 0) -> None:
        """One item loaded; ``rows`` data rows written from it (0: it held nothing to write)."""
        self.attempted += 1
        self.succeeded += 1
        self.written += int(rows)

    def item_failed(self, error: Any) -> None:
        """One item failed: an exception, or a code such as ``http_404`` or ``not_pdf``."""
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

    def result(self, note: Optional[str] = None) -> HarvestResult:
        return HarvestResult(
            attempted=self.attempted,
            succeeded=self.succeeded,
            failed=self.failed,
            written=self.written,
            errors=dict(self.errors),
            note=note,
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
