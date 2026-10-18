"""Is the client address the quota sees the real client? (audit F24 re-audit L1, L2)

uvicorn's ProxyHeadersMiddleware replaces the peer address with the X-Forwarded-For client only
when the peer is in ``FORWARDED_ALLOW_IPS`` (default ``127.0.0.1``). Behind a reverse proxy on any
other address, the header is ignored and every client shares the proxy's quota bucket; with
``*``, any client may forge the header and choose its own bucket. The right value is the proxy's
address as the api container sees it, which only the deployment knows, so this module makes a
wrong value visible instead of guessing:

* ``log_forwarded_trust_at_startup`` (called from main.py's startup) warns in production when
  ``FORWARDED_ALLOW_IPS`` is unset, trusts only loopback, or is ``*``;
* ``note_ignored_forwarding`` (a public-router dependency) warns once per process when a request
  carries X-Forwarded-For that uvicorn did not apply. It reads the header only to decide whether
  to warn and never logs its content; the quota key never comes from it (scraper.rate_limit).
"""

from __future__ import annotations

import ipaddress
import logging
import os
import re
import threading
from typing import Mapping, Optional

from fastapi import Request

logger = logging.getLogger(__name__)

_UVICORN_DEFAULT = "127.0.0.1"
_warned = threading.Event()
_PRINTABLE_PEER = re.compile(r"[^0-9A-Za-z:.\-\[\]%]")


def _is_loopback(entry: str) -> bool:
    if entry.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_network(entry, strict=False).is_loopback
    except ValueError:
        return False


def forwarded_trust_warning(env: Mapping[str, str]) -> Optional[str]:
    """The startup warning for this environment, or None when the setting looks deliberate."""
    environment = (env.get("ENVIRONMENT") or env.get("APP_ENV") or "").strip().lower()
    if environment != "production":
        return None
    raw = env.get("FORWARDED_ALLOW_IPS")
    entries = [e.strip() for e in (raw if raw is not None else _UVICORN_DEFAULT).split(",") if e.strip()]
    if "*" in entries:
        return (
            "FORWARDED_ALLOW_IPS='*' trusts X-Forwarded-For from every peer, so any client can choose "
            "its own rate-limit key. Set FORWARDED_ALLOW_IPS to the reverse proxy's address."
        )
    if not entries or all(_is_loopback(e) for e in entries):
        return (
            "FORWARDED_ALLOW_IPS trusts only loopback. Behind a reverse proxy on another address uvicorn "
            "ignores X-Forwarded-For and every client shares the proxy's rate-limit bucket. Set "
            "FORWARDED_ALLOW_IPS to the proxy's address as the api container sees it (deploy step; "
            "corpus_service/README.md, Public corpus API)."
        )
    return None


def log_forwarded_trust_at_startup() -> None:
    message = forwarded_trust_warning(os.environ)
    if message:
        logger.warning(message)


def reset_forwarded_warning() -> None:
    _warned.clear()


async def note_ignored_forwarding(request: Request) -> None:
    """Warn once per process when X-Forwarded-For arrives but uvicorn did not apply it (the peer is
    not a trusted proxy). When uvicorn applied it, the client address is one of the header's
    entries, so there is nothing to report."""
    if _warned.is_set():
        return
    forwarded = request.headers.get("x-forwarded-for")
    if not forwarded:
        return
    peer = request.client.host if request.client else ""
    if peer and peer in {entry.strip() for entry in forwarded.split(",")}:
        return
    if _warned.is_set():
        return
    _warned.set()
    logger.warning(
        "X-Forwarded-For arrived from peer %s, which FORWARDED_ALLOW_IPS does not trust: the rate limit "
        "keys on that peer, so every client behind it shares one bucket. If this peer is your reverse "
        "proxy, add its address to FORWARDED_ALLOW_IPS.",
        _PRINTABLE_PEER.sub("?", peer)[:64] or "unknown",
    )
