"""Per-client request quota for the public corpus routes (audit F24, spec ruling 7).

An in-process token bucket per client address: ``capacity`` requests, refilled evenly over
``window_seconds``. The key table is an LRU bounded by ``max_keys``, so a spray of addresses cannot
turn the limiter itself into a memory sink (an evicted address simply starts again with a full
bucket).

The key is ``request.client.host``, the peer address uvicorn reports. ``X-Forwarded-For`` is not
read here: a client can forge it. Behind the TLS reverse proxy the compose file asks for, uvicorn's
``--forwarded-allow-ips`` must name the proxy so that the peer address is the real client;
otherwise every client shares the proxy's bucket. The quota is per process, not distributed
(residual 4 in the spec).
"""

from __future__ import annotations

import math
import threading
import time
from collections import OrderedDict
from typing import Callable, Tuple

from fastapi import HTTPException, Request

from scraper.config import settings

_EPSILON = 1e-9


class TokenBucketLimiter:
    """Token buckets keyed by client. Thread-safe; the clock is injectable for tests."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._lock = threading.Lock()
        self._buckets: "OrderedDict[str, Tuple[float, float]]" = OrderedDict()  # key -> (tokens, at)

    def acquire(self, key: str, *, capacity: int, window_seconds: float, max_keys: int) -> Tuple[bool, int]:
        """Take one token for ``key``. Returns (allowed, retry_after_seconds); retry_after is 0 when
        allowed, else the whole seconds until one token is back (at least 1)."""
        capacity = max(1, int(capacity))
        rate = capacity / max(float(window_seconds), 1e-9)  # tokens per second
        with self._lock:
            now = self._clock()
            tokens, at = self._buckets.pop(key, (float(capacity), now))
            tokens = min(float(capacity), tokens + max(0.0, now - at) * rate)
            allowed = tokens >= 1.0 - _EPSILON  # float drift must not refuse an earned token
            if allowed:
                tokens -= 1.0
            self._buckets[key] = (tokens, now)  # most recently used last
            while len(self._buckets) > max(1, int(max_keys)):
                self._buckets.popitem(last=False)
        if allowed:
            return True, 0
        return False, max(1, math.ceil((1.0 - tokens) / rate - _EPSILON))

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._buckets)


public_limiter = TokenBucketLimiter()


async def public_rate_limit(request: Request) -> None:
    """Router dependency for the public corpus routes: 429 with Retry-After once a client address
    has spent its quota. It runs before parameter validation, so an invalid request spends a token
    too."""
    key = request.client.host if request.client else "unknown"
    allowed, retry_after = public_limiter.acquire(
        key,
        capacity=settings.PUBLIC_RATE_LIMIT_REQUESTS,
        window_seconds=settings.PUBLIC_RATE_LIMIT_WINDOW_SECONDS,
        max_keys=settings.PUBLIC_RATE_LIMIT_MAX_CLIENTS,
    )
    if not allowed:
        raise HTTPException(status_code=429, detail="rate limit exceeded", headers={"Retry-After": str(retry_after)})
