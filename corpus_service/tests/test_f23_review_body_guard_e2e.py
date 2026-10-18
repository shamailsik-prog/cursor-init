"""Audit F23 re-audit round 2, M1: the review routes refuse a body before reading it.

The re-audit of PR #74 found that ``POST /quarantine/{id}/promote`` and ``/reject`` buffered and
parsed the whole request body before the admin-key check: FastAPI reads a declared body parameter
before it solves the route's dependencies. An unauthenticated client could hold a connection open
by declaring a large body and sending little of it, or push hundreds of megabytes into the API
process. Spec: docs/superpowers/specs/2026-10-18-f23-auditable-quarantine-promotion-design.md,
section 7, rulings 13-17 and 26.

Everything here runs against ``python -m uvicorn scraper.main:app`` as the compose ``api`` service
starts it, bound to the DML-only runtime role, under both of uvicorn's HTTP implementations (h11,
and httptools, which production's ``uvicorn[standard]`` selects). The probes speak HTTP/1.1 over raw
sockets, so the test, not a client library, decides how much of a body is sent and when.

The limits are written out from the spec (ruling 14: 32 KiB; ruling 15: 10 s), not imported from
the code under test, and this file imports no module main lacks: on main it fails by behaviour.
"""

import asyncio
import contextlib
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest

from test_f23_quarantine_review_db import REASON, REVIEWER, review  # noqa: F401 - fixture

CORPUS_DIR = Path(__file__).resolve().parents[1]
MAX_BODY_BYTES = 32 * 1024  # spec ruling 14
BODY_READ_SECONDS = 10  # spec ruling 15
DECLARED_GB = 1_000_000_000
ANSWER_WITHIN_S = 1.0  # the brief's bound for a refusal that reads nothing
# Spec ruling 17: every admin POST route of the app. Only the two review routes take a body.
ADMIN_POST_PATHS = (
    "/quarantine/{qid}/promote",
    "/quarantine/{qid}/reject",
    "/api/start",
    "/api/stop",
    "/admin/sources/NasirLawSite/trigger",
)
RSS_GROWTH_BOUND_MB = 32  # half of one 64 MB body; PR #74's head grew by 703 MB, main by 2 MB


# ---------------------------------------------------------------------------------------------
# the server
# ---------------------------------------------------------------------------------------------
def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _rss_mb(pid, field):
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith(field + ":"):
            return int(line.split()[1]) / 1024
    raise AssertionError(f"no {field} for pid {pid}")


@contextlib.contextmanager
def uvicorn_api(database_url, http, admin_key, log_path):
    """``uvicorn scraper.main:app`` with the given HTTP implementation, until /health answers 200."""
    import httpx

    port = _free_port()
    env = {k: v for k, v in os.environ.items() if "proxy" not in k.lower()}
    env.update({"DATABASE_URL": database_url, "REDIS_URL": "", "ENVIRONMENT": "development",
                "ADMIN_API_KEY": admin_key, "SKIP_DIR_CREATE": "1"})
    with open(log_path, "w") as log:
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "scraper.main:app", "--host", "127.0.0.1", "--port", str(port),
             "--http", http, "--log-level", "warning"],
            cwd=str(CORPUS_DIR), env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 90
        while True:
            if proc.poll() is not None:
                raise AssertionError(f"uvicorn exited {proc.returncode}: {Path(log_path).read_text()[-3000:]}")
            try:
                if httpx.get(f"http://127.0.0.1:{port}/health", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            if time.monotonic() > deadline:
                raise AssertionError("uvicorn did not answer /health: " + Path(log_path).read_text()[-3000:])
            time.sleep(0.2)
        yield port, proc
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


# ---------------------------------------------------------------------------------------------
# raw HTTP/1.1 probes
# ---------------------------------------------------------------------------------------------
def _head(path, headers):
    lines = [f"POST {path} HTTP/1.1", "Host: 127.0.0.1"] + [f"{k}: {v}" for k, v in headers.items()]
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")


class RawRequest:
    """One connection: send a request head and some body bytes, then watch for the answer and for
    the server closing the connection. Times are measured from the moment the head was sent."""

    def __init__(self, port, path, headers, first=b""):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.t0 = time.monotonic()
        self.sock.sendall(_head(path, headers) + first)
        self.data = b""
        self.answered_s = None
        self.closed_s = None

    def send(self, data):
        try:
            self.sock.sendall(data)
            return True
        except OSError:
            return False

    def _status(self):
        line = self.data.split(b"\r\n", 1)[0]
        parts = line.split()
        return int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else None

    def watch(self, seconds):
        """Read until the server closes the connection or ``seconds`` pass. Returns the status (None
        while unanswered)."""
        end = time.monotonic() + seconds
        while self.closed_s is None:
            left = end - time.monotonic()
            if left <= 0:
                break
            self.sock.settimeout(left)
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                break
            except OSError:  # a reset after the answer counts as the close
                chunk = b""
            now = time.monotonic() - self.t0
            if chunk and self.answered_s is None:
                self.answered_s = now
            if not chunk:
                self.closed_s = now
                break
            self.data += chunk
        return self._status()

    def close(self):
        self.sock.close()


def _refusal(port, path, headers, first=b"", seconds=3.0):
    req = RawRequest(port, path, headers, first)
    try:
        status = req.watch(seconds)
        return {"status": status,
                "answered within 1 s": req.answered_s is not None and req.answered_s <= ANSWER_WITHIN_S,
                "connection closed within 1 s": req.closed_s is not None and req.closed_s <= ANSWER_WITHIN_S}, {
                    "answered_s": req.answered_s, "closed_s": req.closed_s}
    finally:
        req.close()


def _json_headers(key=None, length=None, chunked=False):
    headers = {"Content-Type": "application/json"}
    if key is not None:
        headers["X-API-Key"] = key
    if chunked:
        headers["Transfer-Encoding"] = "chunked"
    elif length is not None:
        headers["Content-Length"] = str(length)
    return headers


def _chunk(data):
    return f"{len(data):x}\r\n".encode() + data + b"\r\n"


def _slow_body(port, qid, key, out):
    """Authenticated, declares 200 bytes, sends 20, then nothing: the server must give up (408) after
    its body deadline and close the connection."""
    req = RawRequest(port, f"/quarantine/{qid}/promote", _json_headers(key, length=200), b'{"reviewer": "slow"')
    try:
        status = req.watch(BODY_READ_SECONDS + 5)
        out["status"] = status
        out["answered_s"] = req.answered_s
        out["closed_s"] = req.closed_s
    finally:
        req.close()


async def _large_bodies(port, qid, key, mb, unauthenticated):
    """Concurrent requests with a large JSON body each: ``unauthenticated`` without the key and one
    with it. Each result is the status, or "closed" when the server ended the connection before the
    client could read an answer (spec ruling 16)."""
    import httpx

    payload = b'{"reviewer": "' + b"r" * (mb << 20) + b'", "reason": "x"}'

    async def one(ac, headers):
        try:
            res = await ac.post(f"/quarantine/{qid}/promote", content=payload, headers=headers)
            return res.status_code
        except (httpx.ReadError, httpx.WriteError, httpx.RemoteProtocolError):
            return "closed"

    limits = httpx.Limits(max_connections=unauthenticated + 2)
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=120, limits=limits) as ac:
        plain = {"Content-Type": "application/json"}
        results = await asyncio.gather(*[one(ac, plain) for _ in range(unauthenticated)],
                                       one(ac, {**plain, "X-API-Key": key}))
    return list(results[:-1]), results[-1]


# ---------------------------------------------------------------------------------------------
# the test
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("http", ["h11", "httptools"])
def test_m1_review_routes_refuse_before_reading_the_body(review, corpus_db, http, tmp_path):
    import httpx

    records, user, password = review
    qid = records["nocite"].qid
    key = "f23-guard-" + secrets.token_urlsafe(24)
    observed, measured = {}, {}
    with uvicorn_api(corpus_db.url_as(user, password), http, key, tmp_path / "uvicorn.log") as (port, proc):
        # The slow body runs in the background for its whole deadline while the rest is probed.
        slow = {}
        slow_thread = threading.Thread(target=_slow_body, args=(port, records["race1"].qid, key, slow))
        slow_thread.start()

        # Ruling 13: no key, or a wrong one, is 401 before any of a declared 1 GB body is read.
        for label, headers in (("no key", _json_headers(length=DECLARED_GB)),
                               ("wrong key", _json_headers("wrong-" + key, length=DECLARED_GB))):
            observed[f"{label}, 1 GB declared, 1000 bytes sent"], measured[label] = _refusal(
                port, f"/quarantine/{qid}/promote", headers, b'{"reviewer": "' + b"r" * 986)

        # Ruling 17: every admin POST route answers an unauthenticated 1 GB declaration at once.
        every = {}
        for template in ADMIN_POST_PATHS:
            result, _times = _refusal(port, template.format(qid=uuid.uuid4()), _json_headers(length=DECLARED_GB),
                                      b"x" * 1000)
            every[template] = (result["status"], result["answered within 1 s"])
        observed["every admin POST route, no key, 1 GB declared"] = every

        # Ruling 14: with the key, a Content-Length over the cap is 413 before anything is read.
        observed["key, Content-Length over the cap, nothing sent"], measured["over cap"] = _refusal(
            port, f"/quarantine/{qid}/promote", _json_headers(length=MAX_BODY_BYTES + 1, key=key))

        # Ruling 14: a chunked body is read up to the cap, and refused as soon as it passes it.
        req = RawRequest(port, f"/quarantine/{qid}/promote", _json_headers(key, chunked=True),
                         _chunk(b"r" * MAX_BODY_BYTES))
        try:
            observed["key, chunked, exactly the cap sent: still waiting"] = req.watch(0.5) is None
            req.send(_chunk(b"r" * 100))
            t_past = time.monotonic() - req.t0
            status = req.watch(3.0)
            observed["key, chunked, past the cap"] = {
                "status": status,
                "answered within 1 s of passing the cap": req.answered_s is not None
                and req.answered_s - t_past <= ANSWER_WITHIN_S,
                "connection closed": req.closed_s is not None,
            }
            measured["chunked"] = {"past_s": t_past, "answered_s": req.answered_s, "closed_s": req.closed_s}
        finally:
            req.close()

        # Ruling 16 / M1 p2: concurrent large bodies do not grow the server (4 x 64 MB without the
        # key, 1 x 64 MB with it).
        before = _rss_mb(proc.pid, "VmHWM")
        unauthenticated, authenticated = asyncio.run(_large_bodies(port, qid, key, 64, 4))
        growth = _rss_mb(proc.pid, "VmHWM") - before
        observed["4 x 64 MB without the key"] = sorted(set(unauthenticated), key=str)
        observed["64 MB with the key"] = authenticated
        observed[f"peak RSS growth under {RSS_GROWTH_BOUND_MB} MB"] = growth < RSS_GROWTH_BOUND_MB
        measured["peak RSS growth MB"] = round(growth, 1)

        # The guard does not get in the way of a real decision: a body sent in two parts is read whole,
        # and a promote and its replay work over the real server.
        two_part = RawRequest(port, f"/quarantine/{records['reject_me'].qid}/reject",
                              _json_headers(key, length=len(b'{"reviewer": "R", "reason": "Two parts"}')),
                              b'{"reviewer": "R", ')
        try:
            time.sleep(0.3)
            two_part.send(b'"reason": "Two parts"}')
            observed["key, valid body sent in two parts"] = two_part.watch(5.0)
        finally:
            two_part.close()
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=30) as hc:
            headers = {"X-API-Key": key, "Idempotency-Key": f"f23-guard-{http}"}
            first = hc.post(f"/quarantine/{qid}/promote", json={"reviewer": REVIEWER, "reason": REASON},
                            headers=headers)
            again = hc.post(f"/quarantine/{qid}/promote", json={"reviewer": REVIEWER, "reason": REASON},
                            headers=headers)
        observed["valid promote, then its replay"] = [
            (r.status_code, r.json().get("replayed") if r.status_code == 200 else r.text[:120]) for r in (first, again)]

        slow_thread.join(BODY_READ_SECONDS + 10)
        measured["slow"] = dict(slow)
        answered = slow.get("answered_s")
        observed["key, body stalls"] = {
            "status": slow.get("status"),
            "answered after the deadline, not long after": answered is not None
            and BODY_READ_SECONDS - 0.5 <= answered <= BODY_READ_SECONDS + 4,
            "connection closed": slow.get("closed_s") is not None,
        }

    refused_at_once = {"answered within 1 s": True, "connection closed within 1 s": True}
    expected = {
        "no key, 1 GB declared, 1000 bytes sent": {"status": 401, **refused_at_once},
        "wrong key, 1 GB declared, 1000 bytes sent": {"status": 401, **refused_at_once},
        "every admin POST route, no key, 1 GB declared": {template: (401, True) for template in ADMIN_POST_PATHS},
        "key, Content-Length over the cap, nothing sent": {"status": 413, **refused_at_once},
        "key, chunked, exactly the cap sent: still waiting": True,
        "key, chunked, past the cap": {"status": 413, "answered within 1 s of passing the cap": True,
                                       "connection closed": True},
        # The server closes the connection after its answer (ruling 16); a client still pushing its
        # body may see the close before it reads the answer.
        "4 x 64 MB without the key": observed["4 x 64 MB without the key"]
        if set(observed["4 x 64 MB without the key"]) <= {401, "closed"} else [401],
        "64 MB with the key": authenticated if authenticated in (413, "closed") else 413,
        f"peak RSS growth under {RSS_GROWTH_BOUND_MB} MB": True,
        "key, valid body sent in two parts": 200,
        "valid promote, then its replay": [(200, False), (200, True)],
        "key, body stalls": {"status": 408, "answered after the deadline, not long after": True,
                             "connection closed": True},
    }
    print(f"[f23 body guard, {http}] measured: {measured!r}")  # shown with -s, for the ledger
    assert observed == expected, f"measured: {measured!r}"
