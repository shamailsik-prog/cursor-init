"""Per-client request quota for the public corpus routes (audit F24, spec rulings 7 and R1a-R1b).

An in-process token bucket per client: ``capacity`` requests, refilled evenly over
``window_seconds``.

* **The client is a network, not an address (R1a).** The key is the peer address uvicorn reports
  (``request.client.host``) reduced to its /64 for IPv6 and /32 for IPv4, with IPv4-mapped IPv6
  read as the IPv4 address. One IPv6 host commonly owns a whole /64, so keying per address let it
  mint a fresh bucket per request. A peer value that is not an IP address at all (a test client
  name, a unix socket, a malformed forwarded value) shares one bucket.
* **Eviction never hands out a fresh bucket (R1b).** The key table is bounded by ``max_keys``. When
  it is full, a new key may take the place of the least recently used bucket only if that bucket
  has refilled to capacity (a fresh full bucket is then exactly the state it had). Otherwise the
  new key shares one overflow bucket with every other key that found the table full. Rotating
  through more keys than the table holds therefore gains at most one extra bucket, never one per
  key.
* **No forwarding header is read here.** The key comes from ``request.client`` only. Behind a
  trusted reverse proxy, uvicorn's ProxyHeadersMiddleware (``FORWARDED_ALLOW_IPS``) has already
  put the forwarded client address there; anything else would let a client choose its own key.
  ``scraper.client_identity`` warns when a deployment looks misconfigured.

The quota is per process, not distributed (residual 4 in the spec).
"""

from __future__ import annotations

import ipaddress
import math
import threading
import time
from collections import OrderedDict
from typing import Callable, Iterable, Optional, Tuple

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from scraper.config import settings

_EPSILON = 1e-9
NON_IP_KEY = "non-ip"


def client_key(host: Optional[str]) -> str:
    """The quota key for a peer address: ``<IPv6 /64>`` or ``<IPv4>/32``; NON_IP_KEY otherwise."""
    if not host:
        return NON_IP_KEY
    value = host.strip()
    if value.startswith("[") and "]" in value:
        value = value[1 : value.index("]")]
    value = value.split("%", 1)[0]  # an IPv6 zone index names an interface, not a client
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return NON_IP_KEY
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    if address.version == 4:
        return f"{address}/32"
    return str(ipaddress.IPv6Network((address, 64), strict=False))


class TokenBucketLimiter:
    """Token buckets keyed by client. Thread-safe; the clock is injectable for tests."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._lock = threading.Lock()
        self._buckets: "OrderedDict[str, Tuple[float, float]]" = OrderedDict()  # key -> (tokens, at)
        self._overflow: Optional[Tuple[float, float]] = None

    @staticmethod
    def _refilled(state: Tuple[float, float], now: float, capacity: int, rate: float) -> float:
        tokens, at = state
        return min(float(capacity), tokens + max(0.0, now - at) * rate)

    def acquire(self, key: str, *, capacity: int, window_seconds: float, max_keys: int) -> Tuple[bool, int]:
        """Take one token for ``key``. Returns (allowed, retry_after_seconds); retry_after is 0 when
        allowed, else the whole seconds until one token is back (at least 1)."""
        capacity = max(1, int(capacity))
        max_keys = max(1, int(max_keys))
        rate = capacity / max(float(window_seconds), 1e-9)  # tokens per second
        with self._lock:
            now = self._clock()
            state = self._buckets.pop(key, None)
            if state is None:
                # Reclaim least recently used buckets only while they are full again: dropping one
                # then gives nothing away. Checking the head keeps this O(1) per request.
                while len(self._buckets) >= max_keys:
                    head_key, head = next(iter(self._buckets.items()))
                    if self._refilled(head, now, capacity, rate) < capacity - _EPSILON:
                        break
                    del self._buckets[head_key]
                if len(self._buckets) >= max_keys:
                    tokens = self._refilled(self._overflow or (float(capacity), now), now, capacity, rate)
                    allowed = tokens >= 1.0 - _EPSILON
                    if allowed:
                        tokens -= 1.0
                    self._overflow = (tokens, now)
                    return self._result(allowed, tokens, rate)
                state = (float(capacity), now)
            tokens = self._refilled(state, now, capacity, rate)
            allowed = tokens >= 1.0 - _EPSILON  # float drift must not refuse an earned token
            if allowed:
                tokens -= 1.0
            self._buckets[key] = (tokens, now)  # most recently used last
        return self._result(allowed, tokens, rate)

    @staticmethod
    def _result(allowed: bool, tokens: float, rate: float) -> Tuple[bool, int]:
        if allowed:
            return True, 0
        return False, max(1, math.ceil((1.0 - tokens) / rate - _EPSILON))

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()
            self._overflow = None

    def __len__(self) -> int:
        with self._lock:
            return len(self._buckets)


public_limiter = TokenBucketLimiter()


def take_public_token(host: Optional[str]) -> Tuple[bool, int]:
    """One token from the public quota for the client at peer address ``host``."""
    return public_limiter.acquire(
        client_key(host),
        capacity=settings.PUBLIC_RATE_LIMIT_REQUESTS,
        window_seconds=settings.PUBLIC_RATE_LIMIT_WINDOW_SECONDS,
        max_keys=settings.PUBLIC_RATE_LIMIT_MAX_CLIENTS,
    )


async def public_rate_limit(request: Request) -> None:
    """Router dependency for the public corpus routes: 429 with Retry-After once a client has spent
    its quota. It runs before parameter validation, so an invalid request spends a token too."""
    allowed, retry_after = take_public_token(request.client.host if request.client else None)
    if not allowed:
        raise HTTPException(status_code=429, detail="rate limit exceeded", headers={"Retry-After": str(retry_after)})


class RateLimitedPathsMiddleware:
    """The same per-client quota for unauthenticated pages outside the public router: the API docs
    (/docs, /redoc, /openapi.json and the OAuth2 redirect page) and the dashboard shell. None of
    them touches the database, but each is anonymous work a client can repeat. /health is F44's
    route and is left to it."""

    def __init__(self, app, paths: Iterable[Optional[str]]):
        self.app = app
        self.paths = frozenset(p for p in paths if p)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] in self.paths:
            client = scope.get("client")
            allowed, retry_after = take_public_token(client[0] if client else None)
            if not allowed:
                response = JSONResponse(
                    {"detail": "rate limit exceeded"}, status_code=429, headers={"Retry-After": str(retry_after)}
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
