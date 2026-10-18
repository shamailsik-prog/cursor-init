"""Audit F26: harvested PDFs are kept once, by sha256, before they are parsed.

Spec: docs/superpowers/specs/2026-10-18-f26-bounded-isolated-pdf-processing-design.md (rulings R5,
R14, R15).

``put(data)`` stores ``data`` at ``<PDF_STORAGE_PATH>/raw-pdf/sha256/<aa>/<bb>/<sha256>.pdf`` and returns
its key (the path relative to ``PDF_STORAGE_PATH``, which staging rows record in ``raw_pdf_path``).

* Content-addressed and immutable: a new object is written to a temporary file, fsynced and
  hard-linked to its name, so a stored object is never overwritten or truncated and a crash leaves no
  partial object. An object that already exists is verified (size and sha256) and reused; one that
  does not match its name is refused and logged.
* Owner-only (R14): objects are 0o400, the lock and the ledger 0o600, every directory the store
  creates 0o700, whatever the umask. Every container that mounts the vault runs as the same uid, and
  the PDF sandbox reads its input before it drops privileges, so nothing needs group or world access.
* Serialised: every write holds an exclusive ``flock`` on ``raw-pdf/.lock``, so workers in different
  containers that share the volume never race.
* Bounded, failing safe (R15): ``raw-pdf/.usage`` holds the bytes stored. A new object is counted in
  the ledger before it is linked, so an interrupted write can only overcount, never leave an object
  the ledger misses. When the ledger says a write would pass ``MAX_STORE_BYTES`` (or the ledger is
  missing or unreadable), the store recounts its objects first, rewrites the ledger and removes
  temporary files left by killed writers (every writer holds the lock, so none can be live), and only
  then refuses. A write that would leave less than ``MIN_FREE_BYTES`` free on the filesystem is
  refused too.

A refusal is ``StoreRefused``; the intake records it as ``raw_store_full`` or ``raw_store_failed`` and
does not parse the document (fail closed: what cannot be kept is not parsed).
"""

from __future__ import annotations

import contextlib
import errno
import fcntl
import hashlib
import logging
import os
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

from scraper import config

logger = logging.getLogger(__name__)

STORE_DIR = "raw-pdf"
MAX_STORE_BYTES = 20 * 1024 ** 3
MIN_FREE_BYTES = 1024 ** 3
# R14: owner-only, whatever the umask.
DIR_MODE = 0o700
OBJECT_MODE = 0o400
PRIVATE_FILE_MODE = 0o600  # the lock and the ledger
_LOCK = ".lock"
_USAGE = ".usage"
_TEMPORARY = ".tmp"
_CHUNK = 1 << 20


class StoreRefused(Exception):
    """The document could not be kept. ``full`` is true when a bound refused it."""

    def __init__(self, reason: str, *, full: bool = False):
        super().__init__(reason)
        self.reason = reason
        self.full = full


@dataclass(frozen=True)
class StoredPdf:
    sha256: str
    size: int
    key: str  # relative to PDF_STORAGE_PATH
    path: Path
    created: bool  # False: the object was already in the store


def vault() -> Path:
    return Path(config.settings.PDF_STORAGE_PATH)


def key_for(sha256: str) -> str:
    return f"{STORE_DIR}/sha256/{sha256[:2]}/{sha256[2:4]}/{sha256}.pdf"


def put(data: bytes, *, root: Optional[Path] = None) -> StoredPdf:
    """Keep ``data``; return where. Raises ``StoreRefused``."""
    base = Path(root) if root is not None else vault()
    digest = hashlib.sha256(data).hexdigest()
    size = len(data)
    key = key_for(digest)
    target = base / key
    store = base / STORE_DIR
    try:
        _makedirs(store)
        with _locked(store):
            if os.path.lexists(target):
                _verify(target, digest, size, key)
                return StoredPdf(digest, size, key, target, created=False)
            used = _usage(store)
            if used + size > MAX_STORE_BYTES:
                used = _recount(store, "a write would pass the cap")  # the ledger may overcount (R15)
            if used + size > MAX_STORE_BYTES:
                raise StoreRefused(f"store at {used} bytes of {MAX_STORE_BYTES}", full=True)
            if shutil.disk_usage(store).free - size < MIN_FREE_BYTES:
                raise StoreRefused(f"less than {MIN_FREE_BYTES} bytes would stay free", full=True)
            _publish(store, target, data, digest, used)
            return StoredPdf(digest, size, key, target, created=True)
    except StoreRefused:
        raise
    except OSError as exc:
        if exc.errno in (errno.ENOSPC, errno.EDQUOT):
            raise StoreRefused(f"{type(exc).__name__}: no space", full=True) from None
        logger.error("F26 raw store: cannot keep %s: %s", key, type(exc).__name__)
        raise StoreRefused(f"{type(exc).__name__} (errno {exc.errno})") from None


def _makedirs(directory: Path) -> None:
    """Create ``directory`` and any missing parent, each 0o700 whatever the umask (R14)."""
    missing = []
    current = directory
    while not current.exists():
        missing.append(current)
        current = current.parent
    for path in reversed(missing):
        with contextlib.suppress(FileExistsError):
            path.mkdir(mode=DIR_MODE)
            os.chmod(path, DIR_MODE)


@contextlib.contextmanager
def _locked(store: Path) -> Iterator[None]:
    fd = os.open(store / _LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, PRIVATE_FILE_MODE)
    try:
        os.fchmod(fd, PRIVATE_FILE_MODE)  # whatever the umask was
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)  # closing releases the lock


def _sha256_of(fd: int) -> tuple:
    h, size = hashlib.sha256(), 0
    while True:
        chunk = os.read(fd, _CHUNK)
        if not chunk:
            return h.hexdigest(), size
        h.update(chunk)
        size += len(chunk)


def _verify(target: Path, digest: str, size: int, key: str) -> None:
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        same = stat.S_ISREG(st.st_mode) and st.st_size == size and _sha256_of(fd) == (digest, size)
    finally:
        os.close(fd)
    if not same:
        logger.error("F26 raw store: object %s does not match its name; refusing to reuse it", key)
        raise StoreRefused(f"stored object {key} does not match its sha256")


def _publish(store: Path, target: Path, data: bytes, digest: str, used: int) -> None:
    """Write the object beside its name, count it in the ledger, then link it (R15: an interruption
    between the two overcounts, the safe direction). A link that fails puts the ledger back."""
    _makedirs(target.parent)
    temporary = target.parent / f".{digest}.{os.getpid()}{_TEMPORARY}"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, OBJECT_MODE)
    try:
        try:
            os.fchmod(fd, OBJECT_MODE)  # whatever the umask was
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        _set_usage(store, used + len(data))
        try:
            os.link(temporary, target)  # never replaces an existing name
        except OSError:
            with contextlib.suppress(OSError):
                _set_usage(store, used)
            raise
        _fsync_dir(target.parent)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def _fsync_dir(directory: Path) -> None:
    with contextlib.suppress(OSError):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _usage(store: Path) -> int:
    ledger, objects = store / _USAGE, store / "sha256"
    try:
        text = ledger.read_text(encoding="ascii").strip()
        if text.isdigit():
            return int(text)
    except (OSError, UnicodeDecodeError):
        pass
    if not objects.is_dir() and not ledger.exists():
        return 0  # a new store
    return _recount(store, "the ledger is missing or unreadable")


def _recount(store: Path, why: str) -> int:
    """The bytes the store's objects hold, from the tree; the ledger is rewritten to match. Called
    with the lock held, so any temporary file was left by a killed writer and is removed."""
    objects = store / "sha256"
    used = 0
    if objects.is_dir():
        for path in objects.rglob("*"):
            if path.name.endswith(".pdf") and path.is_file():
                used += path.stat().st_size
    for stale in [p for p in store.rglob(f"*{_TEMPORARY}") if p.is_file()]:
        with contextlib.suppress(FileNotFoundError):
            stale.unlink()
    _set_usage(store, used)
    logger.warning("F26 raw store: recounted the store (%s): %d bytes", why, used)
    return used


def _set_usage(store: Path, used: int) -> None:
    temporary = store / f"{_USAGE}.{os.getpid()}{_TEMPORARY}"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, PRIVATE_FILE_MODE)
    try:
        os.fchmod(fd, PRIVATE_FILE_MODE)
        os.write(fd, str(int(used)).encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, store / _USAGE)
    _fsync_dir(store)
