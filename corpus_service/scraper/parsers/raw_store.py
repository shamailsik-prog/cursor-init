"""Audit F26: harvested PDFs are kept once, by sha256, before they are parsed.

Spec: docs/superpowers/specs/2026-10-18-f26-bounded-isolated-pdf-processing-design.md (ruling R5).

``put(data)`` stores ``data`` at ``<PDF_STORAGE_PATH>/raw-pdf/sha256/<aa>/<bb>/<sha256>.pdf`` and returns
its key (the path relative to ``PDF_STORAGE_PATH``, which staging rows record in ``raw_pdf_path``).

* Content-addressed and immutable: a new object is written to a temporary file created read-only
  (0444), fsynced and hard-linked to its name, so a stored object is never overwritten or truncated
  and a crash leaves no partial object. An object that already exists is verified (size and sha256)
  and reused; one that does not match its name is refused and logged.
* Serialised: every write holds an exclusive ``flock`` on ``raw-pdf/.lock``, so workers in different
  containers that share the volume never race.
* Bounded: ``raw-pdf/.usage`` holds the bytes stored (rebuilt from the tree when missing or
  unreadable); a write that would pass ``MAX_STORE_BYTES``, or leave less than ``MIN_FREE_BYTES`` free
  on the filesystem, is refused as full.

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
_LOCK = ".lock"
_USAGE = ".usage"
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
    key = key_for(digest)
    target = base / key
    store = base / STORE_DIR
    try:
        store.mkdir(parents=True, exist_ok=True)
        with _locked(store):
            if os.path.lexists(target):
                _verify(target, digest, len(data), key)
                return StoredPdf(digest, len(data), key, target, created=False)
            used = _usage(store)
            if used + len(data) > MAX_STORE_BYTES:
                raise StoreRefused(f"store at {used} bytes of {MAX_STORE_BYTES}", full=True)
            if shutil.disk_usage(store).free - len(data) < MIN_FREE_BYTES:
                raise StoreRefused(f"less than {MIN_FREE_BYTES} bytes would stay free", full=True)
            _write(target, data, digest)
            _set_usage(store, used + len(data))
            return StoredPdf(digest, len(data), key, target, created=True)
    except StoreRefused:
        raise
    except OSError as exc:
        if exc.errno in (errno.ENOSPC, errno.EDQUOT):
            raise StoreRefused(f"{type(exc).__name__}: no space", full=True) from None
        logger.error("F26 raw store: cannot keep %s: %s", key, type(exc).__name__)
        raise StoreRefused(f"{type(exc).__name__} (errno {exc.errno})") from None


@contextlib.contextmanager
def _locked(store: Path) -> Iterator[None]:
    fd = os.open(store / _LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
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


def _write(target: Path, data: bytes, digest: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.parent / f".{digest}.{os.getpid()}.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o444)
    try:
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.chmod(temporary, 0o444)  # whatever the umask was
        os.link(temporary, target)  # never replaces an existing name
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)
    _fsync_dir(target.parent)


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
    used = sum(p.stat().st_size for p in objects.rglob("*.pdf")) if objects.is_dir() else 0
    logger.warning("F26 raw store: usage ledger missing or unreadable; rebuilt from the tree (%d bytes)", used)
    return used


def _set_usage(store: Path, used: int) -> None:
    temporary = store / f"{_USAGE}.{os.getpid()}.tmp"
    temporary.write_text(str(used), encoding="ascii")
    os.replace(temporary, store / _USAGE)
