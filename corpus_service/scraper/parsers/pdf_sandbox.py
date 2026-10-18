"""Audit F26: PDF parsing in a separate, limited process.

Spec: docs/superpowers/specs/2026-10-18-f26-bounded-isolated-pdf-processing-design.md (rulings R6-R8).

``parse(path, sha256, size)`` runs the extractor (``scraper.parsers.pdf_extractor``) on a stored PDF in
a child started with billiard's ``spawn`` context: a fresh Python interpreter that runs one callable,
``_child``, and inherits only its own pipes (no socket, no database connection). Its first act is to
point fds 0-2 at ``/dev/null`` and disable logging, so nothing it or its ``tesseract`` writes reaches
the worker's stdout or stderr, which in a worker container is the container's log (F26-FU, R16: the
re-audit's 2.8 KB PDF wrote 7,241 MiB there through pdfminer's warnings). Before it reads a
byte of the PDF the child becomes a session leader, arms an alarm, replaces its environment with a
fixed minimal one, sets hard resource limits (address space, data, CPU seconds, file size, open
files, no core dumps), and checks its input against the size and sha256 the worker stored. It then
imports and warms the parser stack, leaves the network when the kernel lets it, drops to uid/gid
65534 when it runs as root, bounds image decoding, refuses active content, and extracts.

It answers with one JSON document on a pipe. The worker reads at most ``max_result_bytes`` of it and
never unpickles anything the child sends. A watchdog kills the child's process group (the child and
any ``tesseract`` it started) at the wall limit, and the group is killed again on every exit path
before the child is reaped. Every way a parse can end without text is a ``ParseRefused`` with one of
the F26 codes (``scraper.tasks.outcomes`` holds the same strings for the run tally). Each parse's
scratch directory is named after the worker's pid, and every parse first removes those whose worker
is gone (R23), so a pool process killed mid-parse does not leave its directory behind.

Why billiard and not ``subprocess`` (R7): F25's guard bans ``subprocess``, ``os.exec*`` and
``os.posix_spawn`` in corpus code (they can run a program such as curl); a spawn-context process can
only re-run this interpreter on billiard's fixed bootstrap and call ``_child``. Stdlib
``multiprocessing`` refuses to start children from Celery's daemonic pool processes; billiard does not.
"""

from __future__ import annotations

import contextlib
import dataclasses
import hashlib
import json
import logging
import os
import resource
import shutil
import signal
import stat
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import billiard

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------------------------
# Codes (spec R8, R10): the same strings as scraper.tasks.outcomes.ERROR_PDF_* (a test pins them).
# ---------------------------------------------------------------------------------------------
PARSE_TIMEOUT = "pdf_parse_timeout"
MEMORY_LIMIT = "pdf_memory_limit"
PAGE_LIMIT = "pdf_page_limit"
TEXT_LIMIT = "pdf_text_limit"
ACTIVE_CONTENT = "pdf_active_content"
PARSE_CRASHED = "pdf_parse_crashed"
PARSE_FAILED = "pdf_parse_failed"
CODES = frozenset({PARSE_TIMEOUT, MEMORY_LIMIT, PAGE_LIMIT, TEXT_LIMIT, ACTIVE_CONTENT, PARSE_CRASHED, PARSE_FAILED})
# What a child may answer with; the timeout and crash codes are the worker's own reading of its death.
_CHILD_CODES = frozenset({MEMORY_LIMIT, PAGE_LIMIT, TEXT_LIMIT, ACTIVE_CONTENT, PARSE_FAILED})

UNPRIVILEGED_ID = 65534  # nobody / nogroup
ALARM_GRACE_SECONDS = 15  # the child's own alarm, past the worker's watchdog: an orphan still ends
CPU_HARD_GRACE_SECONDS = 5  # SIGXCPU at the soft limit first, SIGKILL only at the hard one
SAFE_PATH = "/usr/local/bin:/usr/bin:/bin"
SCRATCH_PREFIX = "f26-pdf-"  # f26-pdf-<worker pid>-<random> in the system temporary directory (R23)
SCRATCH_STALE_SECONDS = 7200  # twice Celery's 3,600 s hard task limit: no live parse is this old
_REAP_SECONDS = 10.0
_DETAIL_LIMIT = 200


@dataclass(frozen=True)
class Limits:
    """Per-document bounds (spec R8). Reviewed in code like F25's bounds; tests replace ``LIMITS``."""

    wall_seconds: float = 300.0  # watchdog: the whole parse, child start-up included
    cpu_seconds: int = 270  # RLIMIT_CPU of the child (each tesseract it runs inherits the same)
    memory_bytes: int = 1 << 30  # RLIMIT_AS and RLIMIT_DATA
    file_bytes: int = 64 << 20  # RLIMIT_FSIZE: the largest file the child or tesseract writes
    open_files: int = 64  # RLIMIT_NOFILE
    max_result_bytes: int = 24 << 20  # the JSON answer on the pipe
    max_pages: int = 1000
    max_text_chars: int = 4_000_000
    max_ocr_pages: int = 25  # pages sent to OCR; the rest are not OCRed (ocr_truncated)
    max_image_pixels: int = 50_000_000  # a page rendered for OCR, and any image PIL decodes
    tesseract_seconds: int = 30  # one tesseract call


LIMITS = Limits()


class ParseRefused(Exception):
    """The sandbox produced no text for the document: ``code`` is one of ``CODES``; ``detail`` is a
    short, content-free reason (an exception class, a signal number, a PDF name)."""

    def __init__(self, code: str, detail: Optional[str] = None):
        super().__init__(code, detail)
        self.code = code
        self.detail = detail

    def __str__(self) -> str:
        return f"{self.code} ({self.detail})" if self.detail else self.code


@dataclass(frozen=True)
class ParseResult:
    text: str
    pages: int
    ocr_applied: bool
    ocr_pages: int = 0
    ocr_skipped: int = 0
    ocr_truncated: bool = False
    isolation: Dict[str, Any] = field(default_factory=dict)
    seconds: float = 0.0


# ---------------------------------------------------------------------------------------------
# The worker side
# ---------------------------------------------------------------------------------------------
def parse(path: "os.PathLike[str] | str", sha256: str, size: int, *, limits: Optional[Limits] = None) -> ParseResult:
    """Extract the text of the stored PDF at ``path`` in a sandboxed child. Blocking: the intake
    calls it through ``asyncio.to_thread``. Raises ``ParseRefused``; never anything the child raised."""
    limits = LIMITS if limits is None else limits  # looked up per call: tests replace LIMITS
    _sweep_stale_scratch()
    context = billiard.get_context("spawn")
    reader, writer = context.Pipe(duplex=False)
    scratch = tempfile.mkdtemp(prefix=f"{SCRATCH_PREFIX}{os.getpid()}-")
    child = context.Process(
        target=_child,
        args=(writer, os.fspath(path), str(sha256), int(size), scratch, dataclasses.asdict(limits)),
        name="f26-pdf-sandbox",
        daemon=False,
    )
    expired = threading.Event()
    watchdog = threading.Timer(limits.wall_seconds, _expire, args=(child, expired))
    watchdog.daemon = True
    payload: Optional[bytes] = None
    oversized = False
    waited_out = False
    started = time.monotonic()
    try:
        try:
            child.start()
        except Exception as exc:  # the process could not be started (fds, memory): not a document fault
            raise ParseRefused(PARSE_FAILED, f"start: {type(exc).__name__}") from None
        finally:
            writer.close()
        watchdog.start()
        if reader.poll(limits.wall_seconds):
            try:
                payload = reader.recv_bytes(limits.max_result_bytes)
            except EOFError:  # the child died without answering
                payload = None
            except OSError:  # "bad message length": the answer is over max_result_bytes
                oversized = True
        else:
            waited_out = True
    finally:
        watchdog.cancel()
        if watchdog.is_alive():
            watchdog.join()  # a callback already running finishes before the child is reaped
        _kill_group(child)
        if child.pid:
            child.join(_REAP_SECONDS)
        reader.close()
        shutil.rmtree(scratch, ignore_errors=True)
    seconds = time.monotonic() - started
    result = _interpret(payload, oversized, child.exitcode, expired.is_set() or waited_out, seconds)
    logger.info(
        "F26 sandbox parsed %s: %d pages, %d chars, ocr=%s, %.2f s, net=%s, uid=%s",
        str(sha256)[:16], result.pages, len(result.text), result.ocr_applied, seconds,
        result.isolation.get("net"), result.isolation.get("uid"),
    )
    return result


def _scratch_owner(name: str) -> Optional[int]:
    """The worker pid in ``f26-pdf-<pid>-<random>``; None for a name without one (F26's first
    version named them ``f26-pdf-<random>``, and ``mkdtemp``'s random part has no ``-``)."""
    head, sep, _ = name[len(SCRATCH_PREFIX):].partition("-")
    return int(head) if sep and head.isdigit() and int(head) > 0 else None


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # alive, another user's
        return True
    return True


def _sweep_stale_scratch() -> None:
    """R23: remove every scratch directory whose worker is no longer a live process, or that has not
    changed for ``SCRATCH_STALE_SECONDS``: a pool process killed mid-parse (Celery's hard limit, the
    OOM killer) never ran its ``finally``. Best effort; links are never followed (``rmtree`` refuses
    a link and does not follow links inside)."""
    root = tempfile.gettempdir()
    now = time.time()
    try:
        entries = list(os.scandir(root))
    except OSError:
        return
    for entry in entries:
        if not entry.name.startswith(SCRATCH_PREFIX):
            continue
        try:
            if not entry.is_dir(follow_symlinks=False):
                continue
            age = now - entry.stat(follow_symlinks=False).st_mtime
        except OSError:
            continue
        owner = _scratch_owner(entry.name)
        if age > SCRATCH_STALE_SECONDS or (owner is not None and not _process_alive(owner)):
            shutil.rmtree(entry.path, ignore_errors=True)


def _expire(child: Any, expired: threading.Event) -> None:
    expired.set()
    _kill_group(child)


def _kill_group(child: Any) -> None:
    """SIGKILL the child's process group (it is a session leader, so its pgid is its pid: the child
    and every tesseract it started) and the child itself (in case it died before ``setsid``). Called
    only before the child is reaped, so its pid cannot have been reused."""
    pid = child.pid
    if not pid:
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:  # no such group: the child never became a session leader, or it is gone
        pass
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def _safe_detail(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = "".join(c for c in str(value) if c.isprintable())
    return text[:_DETAIL_LIMIT]


def _interpret(payload: Optional[bytes], oversized: bool, exitcode: Optional[int], timed_out: bool, seconds: float) -> ParseResult:
    if payload is not None:
        try:
            answer = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ParseRefused(PARSE_FAILED, "unreadable answer") from None
        if not isinstance(answer, dict):
            raise ParseRefused(PARSE_FAILED, "unreadable answer")
        if answer.get("ok") is True:
            text, pages = answer.get("text"), answer.get("pages")
            isolation = answer.get("isolation")
            if not isinstance(text, str) or not isinstance(pages, int) or not isinstance(isolation, dict):
                raise ParseRefused(PARSE_FAILED, "malformed answer")
            return ParseResult(
                text=text,
                pages=pages,
                ocr_applied=answer.get("ocr_applied") is True,
                ocr_pages=int(answer.get("ocr_pages") or 0),
                ocr_skipped=int(answer.get("ocr_skipped") or 0),
                ocr_truncated=answer.get("ocr_truncated") is True,
                isolation=isolation,
                seconds=seconds,
            )
        code = answer.get("code")
        raise ParseRefused(code if code in _CHILD_CODES else PARSE_FAILED, _safe_detail(answer.get("detail")))
    if oversized:  # the worker's read bound; the child's own cap answers without "(worker bound)" (R24)
        raise ParseRefused(TEXT_LIMIT, "answer over max_result_bytes (worker bound)")
    if timed_out or exitcode in (-signal.SIGXCPU, -signal.SIGALRM):
        raise ParseRefused(PARSE_TIMEOUT, f"after {seconds:.1f} s")
    if exitcode is not None and exitcode < 0:
        raise ParseRefused(PARSE_CRASHED, f"signal {-exitcode}")
    raise ParseRefused(PARSE_FAILED, f"exit {exitcode}")


# ---------------------------------------------------------------------------------------------
# The child side: runs in the spawned interpreter, never in the worker
# ---------------------------------------------------------------------------------------------
class _InputMismatch(Exception):
    """The file the child was given is not the one the worker stored."""


def _child(conn: Any, path: str, sha256: str, size: int, scratch: str, limits: Dict[str, Any]) -> None:
    """The sandbox. Answers through ``conn`` and nothing else; writes nothing to the worker's stdout
    or stderr (R16)."""
    try:
        _detach_output()  # first: before anything can write to the worker's stdout or stderr
    except OSError:
        # Never parse while attached to the worker's log: answer at once, without the PDF.
        answer = {"ok": False, "code": PARSE_FAILED, "detail": "stdio", "isolation": {}, "seconds": 0.0}
        try:
            conn.send_bytes(_encode(answer, int(limits["max_result_bytes"])))
        finally:
            conn.close()
        return
    try:
        os.setsid()
    except OSError:
        pass
    signal.alarm(int(limits["wall_seconds"]) + ALARM_GRACE_SECONDS)
    signal.signal(signal.SIGXFSZ, signal.SIG_IGN)  # an oversized write fails instead of killing
    started = time.monotonic()
    isolation: Dict[str, Any] = {}
    try:
        _scrub_environment(scratch)
        _apply_limits(limits)
        data = _read_input(path, sha256, size)
        answer = _parse(data, scratch, limits, isolation)
    except MemoryError:
        answer = {"ok": False, "code": MEMORY_LIMIT}
    except BaseException as exc:  # noqa: BLE001 - the child answers every failure with a code
        answer = {"ok": False, "code": PARSE_FAILED, "detail": type(exc).__name__}
    answer["isolation"] = isolation
    answer["seconds"] = round(time.monotonic() - started, 3)
    try:
        conn.send_bytes(_encode(answer, int(limits["max_result_bytes"])))
    finally:
        conn.close()


def _detach_output() -> None:
    """R16: fds 0, 1 and 2 become /dev/null and logging is disabled. The child inherits the worker's
    stdout and stderr (in a container, its log, where ``RLIMIT_FSIZE`` does not apply to a pipe), and
    pdfminer's warnings, Python warnings, a native library's messages or ``tesseract``'s output would
    otherwise land there. Raises OSError if /dev/null cannot be opened."""
    devnull = os.open(os.devnull, os.O_RDWR)
    try:
        for fd in (0, 1, 2):
            os.dup2(devnull, fd)
    finally:
        if devnull > 2:
            os.close(devnull)
    logging.disable(logging.CRITICAL)


def _scrub_environment(scratch: str) -> None:
    """A fixed minimal environment: nothing of the worker's (database URLs, keys, tokens) reaches the
    parser or tesseract. TESSDATA_PREFIX is kept only because tesseract needs it to find its models."""
    tessdata = os.environ.get("TESSDATA_PREFIX")
    os.environ.clear()
    os.environ.update({
        "PATH": SAFE_PATH,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "OMP_THREAD_LIMIT": "1",
        "HOME": scratch,
        "TMPDIR": scratch,
    })
    if tessdata:
        os.environ.update({"TESSDATA_PREFIX": tessdata})
    tempfile.tempdir = scratch


def _apply_limits(limits: Dict[str, Any]) -> None:
    def cap(kind: int, soft: int, hard: Optional[int] = None) -> None:
        hard = soft if hard is None else hard
        _, current_hard = resource.getrlimit(kind)
        if current_hard != resource.RLIM_INFINITY:
            soft, hard = min(soft, current_hard), min(hard, current_hard)
        resource.setrlimit(kind, (soft, hard))

    memory = int(limits["memory_bytes"])
    cap(resource.RLIMIT_AS, memory)
    cap(resource.RLIMIT_DATA, memory)
    cpu = int(limits["cpu_seconds"])
    cap(resource.RLIMIT_CPU, cpu, cpu + CPU_HARD_GRACE_SECONDS)
    cap(resource.RLIMIT_FSIZE, int(limits["file_bytes"]))
    cap(resource.RLIMIT_NOFILE, int(limits["open_files"]))
    cap(resource.RLIMIT_CORE, 0)


def _read_input(path: str, sha256: str, size: int) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size != size:
            raise _InputMismatch()
        chunks, remaining = [], size
        while remaining > 0:
            chunk = os.read(fd, min(remaining, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    finally:
        os.close(fd)
    data = b"".join(chunks)
    if len(data) != size or hashlib.sha256(data).hexdigest() != sha256:
        raise _InputMismatch()
    return data


def _isolate(scratch: str) -> Dict[str, Any]:
    """Leave the network and drop root, as far as this kernel and container allow; report what held.
    As root: a new network namespace (needs CAP_SYS_ADMIN), then uid/gid 65534 with no groups. As any
    other user (or if root could not): an unprivileged user + network namespace, if permitted."""
    net = "none"
    uid_dropped = False
    if os.geteuid() == 0:
        try:
            os.unshare(os.CLONE_NEWNET)
            net = "netns"
        except (AttributeError, OSError):
            pass
        os.chown(scratch, UNPRIVILEGED_ID, UNPRIVILEGED_ID)
        os.setgroups([])
        os.setgid(UNPRIVILEGED_ID)
        os.setuid(UNPRIVILEGED_ID)
        uid_dropped = True
    if net == "none":
        try:
            os.unshare(os.CLONE_NEWUSER | os.CLONE_NEWNET)
            net = "userns+netns"
        except (AttributeError, OSError):
            pass
    os.umask(0o077)
    return {"net": net, "uid": os.getuid(), "gid": os.getgid(), "uid_dropped": uid_dropped}


def _describe_process() -> Dict[str, Any]:
    """What the child holds, for the record and the isolation tests: environment variable names (never
    values), open descriptors and how many are sockets, its resource limits, where fds 0-2 point,
    whether logging is disabled and whether it leads its own session and process group (R24)."""
    stdio: Dict[str, Optional[str]] = {}
    for fd in (0, 1, 2):
        try:
            stdio[str(fd)] = os.readlink(f"/proc/self/fd/{fd}")
        except OSError:
            stdio[str(fd)] = None
    fds, sockets = 0, 0
    try:
        for name in os.listdir("/proc/self/fd"):
            fds += 1
            try:
                if os.readlink(f"/proc/self/fd/{name}").startswith("socket:"):
                    sockets += 1
            except OSError:
                pass
    except OSError:
        fds = -1
    return {
        "env": sorted(os.environ),
        "fds": fds,
        "socket_fds": sockets,
        "rlimits": {
            "as": resource.getrlimit(resource.RLIMIT_AS)[0],
            "data": resource.getrlimit(resource.RLIMIT_DATA)[0],
            "cpu": resource.getrlimit(resource.RLIMIT_CPU)[0],
            "fsize": resource.getrlimit(resource.RLIMIT_FSIZE)[0],
            "nofile": resource.getrlimit(resource.RLIMIT_NOFILE)[0],
            "core": resource.getrlimit(resource.RLIMIT_CORE)[0],
        },
        "stdio": stdio,
        "logging_disabled": logging.root.manager.disable >= logging.CRITICAL,
        "session_leader": os.getsid(0) == os.getpid() == os.getpgrp(),
    }


def _read_back_network() -> Dict[str, Any]:
    """R24: after ``_isolate``, the network namespace this process is in and the interfaces it sees,
    read from /proc (not what ``_isolate`` set): a test compares them with the worker's."""
    out: Dict[str, Any] = {"netns": None, "interfaces": None}
    with contextlib.suppress(OSError):
        out["netns"] = os.readlink("/proc/self/ns/net")
    with contextlib.suppress(OSError, UnicodeDecodeError):
        with open("/proc/self/net/dev", encoding="ascii") as dev:
            out["interfaces"] = sorted(line.split(":", 1)[0].strip() for line in dev.readlines()[2:] if ":" in line)
    return out


def _parse(data: bytes, scratch: str, limits: Dict[str, Any], isolation: Dict[str, Any]) -> Dict[str, Any]:
    from scraper.parsers import pdf_extractor  # the parser stack loads here, inside the limits

    pdf_extractor.warm_up()  # everything the parser loads lazily, while still able to read it
    isolation.update(_describe_process())
    isolation.update(_isolate(scratch))
    pdf_extractor.bound_image_decoding(int(limits["max_image_pixels"]))
    isolation.update(_read_back_network())
    isolation.update(pdf_extractor.image_decoding_bound())
    caps = pdf_extractor.Limits(
        max_pages=int(limits["max_pages"]),
        max_text_chars=int(limits["max_text_chars"]),
        max_ocr_pages=int(limits["max_ocr_pages"]),
        max_image_pixels=int(limits["max_image_pixels"]),
        tesseract_seconds=int(limits["tesseract_seconds"]),
    )
    try:
        active = pdf_extractor.find_active_content(data)
        if active:
            return {"ok": False, "code": ACTIVE_CONTENT, "detail": f"/{active}"}
        extraction = pdf_extractor.extract_pdf(data, caps)
    except pdf_extractor.PdfLimitExceeded as exc:
        return {"ok": False, "code": exc.code}
    return {
        "ok": True,
        "text": extraction.text,
        "pages": extraction.pages,
        "ocr_applied": extraction.ocr_applied,
        "ocr_pages": extraction.ocr_pages,
        "ocr_skipped": extraction.ocr_skipped,
        "ocr_truncated": extraction.ocr_truncated,
    }


def _encode(answer: Dict[str, Any], max_bytes: int) -> bytes:
    # ASCII JSON: any text, even a lone surrogate from a broken font encoding, encodes; at most six
    # bytes per character, so 4,000,000 characters fit the 24 MiB default.
    body = json.dumps(answer, ensure_ascii=True).encode("ascii")
    if len(body) > max_bytes:
        body = json.dumps({"ok": False, "code": TEXT_LIMIT, "detail": "answer over max_result_bytes",
                           "isolation": answer.get("isolation", {})}).encode("utf-8")
    return body
