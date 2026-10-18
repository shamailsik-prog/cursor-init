"""Audit F25 re-audit round (FAIL 7/10): the gaps the independent re-audit found after PR #65.

Spec: docs/superpowers/specs/2026-10-18-f25-corpus-fetch-boundary-design.md, section "Re-audit
round (FAIL 7/10)", rulings R17-R22.

* MEDIUM, decompression bombs: a 1.7 KB ``gzip, gzip`` / ``deflate, deflate`` / ``br`` body peaked
  at about 2 GiB before the 100 MiB cap refused it, because httpx inflates each network chunk with
  no output limit. Stacked, brotli, zstd and unknown codings are now refused before any decoding.
  A single gzip/deflate coding is inflated by the boundary itself in bounded steps; raw bytes are
  capped as well. Each case carries a peak-memory bound (tracemalloc).
* LOW 3: a malformed ``Location`` (``https:127.0.0.1:PORT/x``) escaped as ``httpx.InvalidURL`` and
  the court retry helpers retried it three times; it is now a refusal, sent once.
* LOW 4: an in-cap body is held once (no chunk list plus join, no eager text copy).
* LOW 5: ``_GuardedBackend``'s own hooks (loopback, resolver, inner backend) are refused outside
  ENVIRONMENT=development.
* LOW 7: ``pdf_writer.write_judgment_pdf`` escapes metadata before reportlab parses it as markup.
* LOW 8: a plain-http link to an allowlisted host on the default port is fetched as https on 443
  (never plaintext); a redirect to http is still refused as a downgrade.
* Mutants that survived the re-audit and are killed here: M07, M09, M16, M25, M31, M32, M35, M43,
  M45 (M06, M14, M17, M30 are equivalent mutants; see the spec).
"""

import asyncio
import gzip
import importlib
import ipaddress
import logging
import ssl
import sys
import time
import tracemalloc
import types
import zlib
from urllib.parse import urlsplit

import httpx
import pytest

from f25_servers import RecordingServer, client_tls_context, make_test_pki, serving, server_tls_context
from scraper.net import fetch_policy as fp
from test_f25_fetch_policy import BLOCKED_ADDRESSES

MIB = 1024 * 1024
NASIR = fp.policy_for("NasirLawSite")


# ---------------------------------------------------------------------------------------------
# Local servers and helpers
# ---------------------------------------------------------------------------------------------
@pytest.fixture
def env(tmp_path):
    pki = make_test_pki(tmp_path / "pki")
    internal = RecordingServer(routes={"/x": (200, {}, b"F25 internal")})
    source = RecordingServer(tls=server_tls_context(pki))
    with serving(internal), serving(source):
        yield types.SimpleNamespace(pki=pki, internal=internal, source=source, origin=f"https://localhost:{source.port}")


async def _loopback(host, port):
    return ["127.0.0.1"]


def _fetcher(env, *, tls=True, **kwargs):
    sp = env.source.port
    policy = kwargs.pop("policy", None) or fp.FetchPolicy(name="T", hosts=frozenset({"localhost"}), ports=frozenset({sp}))
    if tls:
        kwargs["_test_ssl_context"] = client_tls_context(env.pki)
    return fp.PolicyFetcher(policy, _test_loopback_origins={("localhost", sp)}, _test_resolver=_loopback, **kwargs)


def _run_get(fetcher, url):
    async def go():
        async with fetcher as client:
            return await client.get(url)

    return asyncio.run(go())


def _refused(fetcher, url):
    with pytest.raises(fp.FetchRefused) as info:
        _run_get(fetcher, url)
    return info.value


def _peak(fn):
    """(result or raised exception, peak traced bytes) of fn()."""
    tracemalloc.start()
    try:
        try:
            result = fn()
        except BaseException as exc:  # noqa: BLE001 - returned for the caller to assert on
            result = exc
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    return result, peak


def _fixed(status, headers, body, record=None):
    """A route that sends ``body`` with an explicit Content-Length; ``record`` gets the request headers."""

    def route(handler):
        if record is not None:
            record.append(dict(handler.headers))
        handler.send_response(status)
        for name, value in headers.items():
            handler.send_header(name, value)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        try:
            handler.wfile.write(body)
            handler.wfile.flush()
        except OSError:
            pass
        return None

    return route


def _compressed_zeros(n_bytes, wbits):
    """zlib/gzip/raw-deflate of n_bytes zeros, built in 1 MiB steps (never holds the plaintext)."""
    co = zlib.compressobj(9, zlib.DEFLATED, wbits)
    block = b"\0" * MIB
    out, left = [], n_bytes
    while left:
        take = min(left, MIB)
        out.append(co.compress(block[:take]))
        left -= take
    out.append(co.flush())
    return b"".join(out)


def gzip_zeros(n):
    return _compressed_zeros(n, 31)


def zlib_zeros(n):
    return _compressed_zeros(n, 15)


def raw_deflate_zeros(n):
    return _compressed_zeros(n, -15)


# ---------------------------------------------------------------------------------------------
# MEDIUM: content codings and decompression bombs
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "coding, make",
    [
        ("gzip, gzip", lambda: gzip.compress(gzip_zeros(256 * MIB), 9)),
        ("deflate, deflate", lambda: zlib.compress(zlib_zeros(256 * MIB), 9)),
        ("gzip, gzip, gzip", lambda: gzip.compress(gzip.compress(gzip_zeros(256 * MIB), 9), 9)),
        ("gzip, deflate", lambda: zlib.compress(gzip_zeros(256 * MIB), 9)),
    ],
)
def test_stacked_codings_are_refused_before_any_decoding(env, coding, make):
    """The re-audit's 1.7 KB stacked bombs, at the production cap (MAX_BYTES): refused as a coding,
    with nothing inflated."""
    body = make()
    assert len(body) < 8 * 1024
    env.source.routes["/b"] = _fixed(200, {"Content-Encoding": coding}, body)
    result, peak = _peak(lambda: _run_get(_fetcher(env), f"{env.origin}/b"))
    assert peak < 4 * MIB, f"peak {peak / MIB:.1f} MiB ({result!r:.120})"
    assert isinstance(result, fp.FetchRefused), result
    assert result.reason == fp.CONTENT_ENCODING, result


@pytest.mark.parametrize("coding", ["br", "zstd", "compress", "x-f25-unknown", "gzip;q=1"])
def test_unsupported_codings_are_refused(env, coding):
    """brotli is live in production (weasyprint pulls in brotli, so httpx would decode it); zstd,
    compress and anything unknown are refused too, never passed through or decoded."""
    env.source.routes["/b"] = _fixed(200, {"Content-Encoding": coding}, b"\x1b\xff\xff\x07" * 16)
    assert _refused(_fetcher(env), f"{env.origin}/b").reason == fp.CONTENT_ENCODING


@pytest.mark.parametrize(
    "coding, make",
    [("gzip", gzip_zeros), ("x-gzip", gzip_zeros), ("deflate", zlib_zeros), ("deflate", raw_deflate_zeros)],
)
def test_single_coding_bombs_stop_at_the_cap_with_bounded_memory(env, coding, make):
    """64 MiB of zeros (about 64 KB on the wire) against a 2 MiB cap: refused as too_large, and the
    decoded bytes in memory never exceed the cap plus one decode step."""
    cap = 2 * MIB
    env.source.routes["/b"] = _fixed(200, {"Content-Encoding": coding}, make(64 * MIB))
    result, peak = _peak(lambda: _run_get(_fetcher(env, max_bytes=cap), f"{env.origin}/b"))
    assert isinstance(result, fp.FetchRefused) and result.reason == fp.TOO_LARGE, result
    assert peak < cap + 3 * MIB, f"peak {peak / MIB:.1f} MiB for a {cap / MIB:.0f} MiB cap"


def test_single_gzip_bomb_at_the_production_cap(env):
    """The production configuration (MAX_BYTES = 100 MiB): a ~250 KB gzip of 256 MiB is refused,
    and memory stays near the cap instead of the re-audit's ~2 GiB."""
    env.source.routes["/b"] = _fixed(200, {"Content-Encoding": "gzip"}, gzip_zeros(256 * MIB))
    result, peak = _peak(lambda: _run_get(_fetcher(env), f"{env.origin}/b"))
    assert isinstance(result, fp.FetchRefused) and result.reason == fp.TOO_LARGE, result
    assert peak < fp.MAX_BYTES * 1.15 + 4 * MIB, f"peak {peak / MIB:.0f} MiB"  # main: 142 MiB; fixed: ~104 MiB


def test_compressed_bodies_within_the_cap_decode_and_only_gzip_is_advertised(env):
    html = ("<html><body>" + "Synthetic F25 judgment text. " * 2000 + "</body></html>").encode()
    seen = []
    env.source.routes.update(
        {
            "/gz": _fixed(200, {"Content-Encoding": "gzip", "Content-Type": "text/html; charset=utf-8"}, gzip.compress(html), seen),
            "/zl": _fixed(200, {"Content-Encoding": "deflate"}, zlib.compress(html), seen),
            "/id": _fixed(200, {"Content-Encoding": "identity"}, html, seen),
        }
    )
    co = zlib.compressobj(6, zlib.DEFLATED, -15)
    env.source.routes["/raw"] = _fixed(200, {"Content-Encoding": "deflate"}, co.compress(html) + co.flush(), seen)
    for path in ("/gz", "/zl", "/raw", "/id"):
        response = _run_get(_fetcher(env), f"{env.origin}{path}")
        assert response.content == html, path
        assert response.text.startswith("<html><body>Synthetic F25"), path
    assert [h.get("Accept-Encoding") for h in seen] == ["gzip"] * 4


def test_caller_headers_cannot_reopen_other_codings(env):
    seen = []
    env.source.routes["/b"] = _fixed(200, {}, b"ok", seen)

    async def go():
        async with _fetcher(env, headers={"Accept-Encoding": "br, zstd"}) as client:
            return await client.get(f"{env.origin}/b", headers={"accept-encoding": "br"})

    assert asyncio.run(go()).content == b"ok"
    assert [h.get("Accept-Encoding") for h in seen] == ["gzip"]


def test_data_after_the_end_of_a_gzip_stream_is_refused(env):
    """The re-audit's "gztrail": a tiny gzip member followed by raw bytes the decoder never counts."""

    def gztrail(handler):
        handler.send_response(200)
        handler.send_header("Content-Encoding", "gzip")
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()
        member, junk = gzip.compress(b"F25"), b"\0" * 65536
        try:
            handler.wfile.write(b"%x\r\n" % len(member) + member + b"\r\n")
            for _ in range(64):
                handler.wfile.write(b"%x\r\n" % len(junk) + junk + b"\r\n")
            handler.wfile.write(b"0\r\n\r\n")
        except OSError:
            pass
        return None

    env.source.routes["/b"] = gztrail
    assert _refused(_fetcher(env), f"{env.origin}/b").reason == fp.CONTENT_ENCODING


@pytest.mark.parametrize(
    "coding, member",
    [("gzip", lambda: gzip.compress(b"F25 member")), ("deflate", lambda: zlib.compress(b"F25 member"))],
)
def test_trailing_bytes_in_the_same_chunk_as_the_stream_end_are_refused(env, coding, member):
    """Trailing bytes that arrive in the very read that ends the compressed stream (a small fixed
    body): only the decoder's unused_data check sees them, there is no later chunk to refuse."""
    env.source.routes["/b"] = _fixed(200, {"Content-Encoding": coding}, member() + b"F25 trailing bytes")
    assert _refused(_fetcher(env), f"{env.origin}/b").reason == fp.CONTENT_ENCODING


def test_a_truncated_gzip_stream_is_refused(env):
    env.source.routes["/b"] = _fixed(200, {"Content-Encoding": "gzip"}, gzip.compress(b"F25 " * 5000)[:-12])
    assert _refused(_fetcher(env), f"{env.origin}/b").reason == fp.CONTENT_ENCODING


def test_a_chunked_body_over_the_cap_without_content_length_is_refused(env):
    """No Content-Length to pre-check: only the streaming cap can stop it (kills M31)."""

    def endless(handler):
        handler.send_response(200)
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()
        chunk = b"x" * 65536
        try:
            for _ in range(256):
                handler.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
            handler.wfile.write(b"0\r\n\r\n")
        except OSError:
            pass
        return None

    env.source.routes["/b"] = endless
    result, peak = _peak(lambda: _run_get(_fetcher(env, max_bytes=1 * MIB), f"{env.origin}/b"))
    assert isinstance(result, fp.FetchRefused) and result.reason == fp.TOO_LARGE, result
    assert peak < 4 * MIB


def test_bytes_on_the_wire_are_capped_even_when_the_decoded_body_fits(env):
    """A stored (level 0) gzip of exactly 1 MiB of random bytes is a little over 1 MiB on the wire.
    Sent chunked (no Content-Length to pre-check) against a 1 MiB cap, only the raw cap stops it:
    the decoded body would fit."""
    import os as _os

    co = zlib.compressobj(0, zlib.DEFLATED, 31)
    body = co.compress(_os.urandom(MIB)) + co.flush()
    assert len(body) > MIB

    def chunked(handler):
        handler.send_response(200)
        handler.send_header("Content-Encoding", "gzip")
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()
        try:
            for i in range(0, len(body), 65536):
                part = body[i:i + 65536]
                handler.wfile.write(b"%x\r\n" % len(part) + part + b"\r\n")
            handler.wfile.write(b"0\r\n\r\n")
        except OSError:
            pass
        return None

    env.source.routes["/b"] = chunked
    refusal = _refused(_fetcher(env, max_bytes=MIB), f"{env.origin}/b")
    assert refusal.reason == fp.TOO_LARGE and "on the wire" in (refusal.detail or ""), refusal


def test_a_declared_length_over_the_cap_is_refused_before_reading_the_body(env):
    """Content-Length says 10 MiB, the server then stalls: refused at once on the header, not after
    the deadline (kills M32)."""

    def stall(handler):
        handler.send_response(200)
        handler.send_header("Content-Length", str(10 * MIB))
        handler.end_headers()
        try:
            handler.wfile.write(b"x" * 10)
            handler.wfile.flush()
            time.sleep(3)
        except OSError:
            pass
        return None

    env.source.routes["/b"] = stall
    started = time.monotonic()
    assert _refused(_fetcher(env, max_bytes=1 * MIB, deadline=2.5), f"{env.origin}/b").reason == fp.TOO_LARGE
    assert time.monotonic() - started < 1.5


# ---------------------------------------------------------------------------------------------
# LOW 4: an in-cap body is held once
# ---------------------------------------------------------------------------------------------
def test_an_in_cap_body_is_held_once(env):
    """A 24 MiB body costs about one copy: no list of chunks plus a joined copy, and no text copy
    unless a caller asks for .text."""
    size = 24 * MIB
    env.source.routes["/b"] = _fixed(200, {"Content-Type": "application/pdf"}, b"%PDF" + b"x" * (size - 4))
    result, peak = _peak(lambda: _run_get(_fetcher(env), f"{env.origin}/b"))
    assert not isinstance(result, BaseException), result
    assert len(result.content) == size and result.content[:4] == b"%PDF"
    assert peak < size * 1.3 + 4 * MIB, f"peak {peak / MIB:.1f} MiB for a {size / MIB:.0f} MiB body"
    assert result.text[:4] == "%PDF"  # still available on demand


# ---------------------------------------------------------------------------------------------
# LOW 3: malformed redirects are refusals, never retried
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "location, reason",
    [
        ("https:127.0.0.1:{ip}/x", "AMBIGUOUS"),  # scheme without "//": parsers disagree
        ("http:127.0.0.1:{ip}/x", "AMBIGUOUS"),
        ("/\\127.0.0.1:{ip}/x", "AMBIGUOUS"),  # a browser reads "\" as "/"
        ("https://[::1/x", "UNPARSEABLE"),
    ],
)
def test_a_malformed_redirect_is_a_refusal(env, location, reason):
    env.source.routes["/r"] = (302, {"Location": location.format(ip=env.internal.port)}, b"")
    refusal = _refused(_fetcher(env), f"{env.origin}/r")
    assert refusal.reason == getattr(fp, reason)
    assert [r["path"] for r in env.source.requests] == ["/r"]
    assert env.internal.connections == 0


@pytest.mark.parametrize(
    "error",
    [lambda: httpx.InvalidURL("synthetic"), lambda: httpx.UnsupportedProtocol("synthetic"), lambda: httpx.TooManyRedirects("synthetic")],
)
def test_httpx_url_errors_inside_the_boundary_are_refusals(env, monkeypatch, error):
    """Defense in depth (R18): with Location held back no known path raises these any more, but
    if httpx ever does, the caller gets a refusal (never retried), not an httpx error."""
    fetcher = _fetcher(env)

    async def broken(request, **kwargs):
        raise error()

    monkeypatch.setattr(fetcher._client, "send", broken)
    assert _refused(fetcher, f"{env.origin}/x").reason == fp.UNPARSEABLE


def test_court_retry_helpers_send_a_malformed_redirect_once(env, monkeypatch):
    """End to end through the real Balochistan helper: one request, a FetchRefused, no retry."""
    bhc = importlib.import_module("scraper.tasks.balochistanhighcourt")
    real_sleep = asyncio.sleep

    async def _no_wait(delay=0, result=None):
        return await real_sleep(0, result)

    monkeypatch.setattr(asyncio, "sleep", _no_wait)
    env.source.routes["/r"] = (302, {"Location": f"https:127.0.0.1:{env.internal.port}/x"}, b"")

    async def go():
        async with _fetcher(env) as client:
            return await bhc._request_with_retries(client, f"{env.origin}/r")

    with pytest.raises(fp.FetchRefused):
        asyncio.run(go())
    assert [r["path"] for r in env.source.requests] == ["/r"]


class _CountingClient:
    def __init__(self, exc):
        self.exc, self.calls = exc, 0

    async def get(self, url, **kw):
        self.calls += 1
        raise self.exc

    post = get


@pytest.mark.parametrize(
    "module, helper",
    [
        ("peshawarhighcourt", "_request_with_retries"),
        ("balochistanhighcourt", "_request_with_retries"),
        ("islamabadhighcourt", "_request_with_retries"),
        ("islamabadhighcourt", "_post_json_with_retries"),
    ],
)
def test_court_retry_helpers_never_retry_a_refusal(monkeypatch, module, helper):
    """Kills M43. Control: an ordinary network error is still retried three times."""
    mod = importlib.import_module(f"scraper.tasks.{module}")
    real_sleep = asyncio.sleep

    async def _no_wait(delay=0, result=None):
        return await real_sleep(0, result)

    monkeypatch.setattr(asyncio, "sleep", _no_wait)
    args = ({},) if helper == "_post_json_with_retries" else ()
    refused = _CountingClient(fp.FetchRefused(fp.HOST_NOT_ALLOWED, "https://evil.example/", "T"))
    with pytest.raises(fp.FetchRefused):
        asyncio.run(getattr(mod, helper)(refused, "https://evil.example/", *args))
    assert refused.calls == 1
    flaky = _CountingClient(httpx.ConnectError("synthetic"))
    with pytest.raises(httpx.ConnectError):
        asyncio.run(getattr(mod, helper)(flaky, "https://ihc.gov.pk/", *args))
    assert flaky.calls == 3


# ---------------------------------------------------------------------------------------------
# LOW 5: the backend's own hooks
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "hook",
    [
        {"loopback_origins": {("localhost", 8443)}},
        {"resolver": _loopback},
        {"inner": types.SimpleNamespace()},
    ],
)
@pytest.mark.parametrize("environment", ["production", "staging", None])
def test_backend_hooks_are_refused_outside_development(monkeypatch, hook, environment):
    if environment is None:
        monkeypatch.delenv("ENVIRONMENT", raising=False)
    else:
        monkeypatch.setenv("ENVIRONMENT", environment)
    with pytest.raises(RuntimeError):
        fp._GuardedBackend("t", **hook)
    fp._GuardedBackend("t")  # the production shape
    fp.PolicyFetcher(NASIR)  # which is what PolicyFetcher builds outside development


# ---------------------------------------------------------------------------------------------
# Mutant killers
# ---------------------------------------------------------------------------------------------
def test_a_parser_disagreement_is_refused(monkeypatch):
    """Kills M09. No URL that passes the other checks makes httpx 0.28.1 and urllib disagree, so the
    check guards against drift in either parser; simulate one."""
    assert NASIR.allows("https://www.nasirlawsite.com/case/x.htm")
    monkeypatch.setattr(fp, "urlsplit", lambda raw: urlsplit("https://evil.example/case/x.htm"))
    with pytest.raises(fp.FetchRefused) as info:
        NASIR.check_url("https://www.nasirlawsite.com/case/x.htm")
    assert info.value.reason == fp.AMBIGUOUS
    monkeypatch.setattr(fp, "urlsplit", lambda raw: urlsplit("https://www.nasirlawsite.com:8443/case/x.htm"))
    with pytest.raises(fp.FetchRefused) as info:
        NASIR.check_url("https://www.nasirlawsite.com/case/x.htm")
    assert info.value.reason == fp.AMBIGUOUS


def test_transport_construction_fails_closed_if_httpx_layout_changes(monkeypatch):
    """Kills M25: if httpx stops keeping its pool in ``_pool``, the guarded pool would not be the one
    used, so construction must refuse."""
    original = httpx.AsyncHTTPTransport.__init__

    def renamed(self, *args, **kwargs):
        original(self, *args, **kwargs)
        self._connection_pool = self.__dict__.pop("_pool")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "__init__", renamed)
    with pytest.raises(RuntimeError):
        fp.PolicyFetcher(NASIR)


def test_production_fetchers_verify_tls(env):
    """Kills M35: production clients verify certificates and hostnames; a server whose certificate
    is not from a public CA is never read."""
    ctx = fp._verified_ssl_context()
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname
    pool_ctx = fp.fetcher_for("NasirLawSite")._transport._pool._ssl_context
    assert pool_ctx.verify_mode == ssl.CERT_REQUIRED and pool_ctx.check_hostname
    env.source.routes["/ok"] = (200, {}, b"F25 must not be read")
    with pytest.raises(httpx.ConnectError) as info:
        _run_get(_fetcher(env, tls=False), f"{env.origin}/ok")
    assert "CERTIFICATE_VERIFY_FAILED" in str(info.value)
    assert env.source.requests == []


@pytest.mark.parametrize("host", ["example.123", "a.0x1f", "1.2.3.4.5"])
def test_numeric_last_labels_are_ip_literals(host):
    """Kills M07: forms inet_aton rejects but a resolver may still read as numbers."""
    with pytest.raises(fp.FetchRefused) as info:
        NASIR.check_url(f"https://{host}/case/x.htm")
    assert info.value.reason in (fp.IP_LITERAL, fp.UNPARSEABLE)
    assert info.value.reason == fp.IP_LITERAL or host == "1.2.3.4.5"


@pytest.mark.parametrize("address", BLOCKED_ADDRESSES)
def test_the_block_lists_alone_cover_every_non_public_address(address):
    """Kills M16: the explicit lists (and the 2000::/3 gate) do not lean on Python's is_global."""
    assert fp._listed_non_public(ipaddress.ip_address(address)), address


def test_bootstrap_checks_the_policy_before_robots(monkeypatch, tmp_path):
    """Kills M45: a URL the source's policy refuses is never requested, robots.txt included."""
    import bootstrap_harvest

    monkeypatch.setattr(bootstrap_harvest, "ROOT", tmp_path)
    monkeypatch.setattr(bootstrap_harvest, "LIVE", tmp_path / "live")
    robots = []
    monkeypatch.setattr(bootstrap_harvest.RobotsGate, "allowed", lambda self, url, client: robots.append(url) or True)
    harvester = bootstrap_harvest.Harvester()
    fetched = []
    for fetcher in harvester.fetchers.values():
        monkeypatch.setattr(fetcher, "get", lambda url, **kw: fetched.append(url))
    try:
        for url, source in [
            ("http://169.254.169.254/latest/meta-data/", "NasirLawSite"),
            ("https://pakistancode.gov.pk.evil.example/x.pdf", "PakistanCode"),
            ("https://www.nasirlawsite.com/x.htm", "NationalAssembly"),
        ]:
            assert harvester.get(url, source) is None
    finally:
        harvester.close()
    assert robots == [] and fetched == []
    assert harvester.counts["refused"] == 3


# ---------------------------------------------------------------------------------------------
# LOW 8: http links to allowlisted hosts are fetched as https
# ---------------------------------------------------------------------------------------------
def test_plain_http_links_to_allowlisted_hosts_are_upgraded_to_https(monkeypatch, caplog):
    shc = fp.fetcher_for("SindhHighCourt")
    sent = []

    async def capture(method, url, **kwargs):
        sent.append(str(url))
        raise fp.FetchRefused(fp.NO_ADDRESS, url, "SindhHighCourt", "captured, not sent")

    monkeypatch.setattr(shc, "_send", capture)
    for link in (
        "http://enotices.sindhhighcourt.gov.pk/notices/2099.pdf",
        "http://shc.gov.pk:80/judgments",
        "HTTP://www.shc.gov.pk/a?b=1",
    ):
        assert shc.allows(link), link
        with pytest.raises(fp.FetchRefused):
            asyncio.run(shc.get(link))
    assert sent == [
        "https://enotices.sindhhighcourt.gov.pk/notices/2099.pdf",
        "https://shc.gov.pk/judgments",
        "https://www.shc.gov.pk/a?b=1",
    ]
    with caplog.at_level(logging.WARNING, logger="scraper.net.fetch_policy"):
        for link in (
            "http://shc.gov.pk:8080/judgments",  # another port: never rewritten
            "http://evil.example/x.pdf",  # not allowlisted: refused as written
            "http://169.254.169.254/latest/meta-data/",
            "http://f25:s3cret@shc.gov.pk/x",
        ):
            assert not shc.allows(link), link
    messages = [r.getMessage() for r in caplog.records]
    assert any("http://shc.gov.pk:8080/judgments (scheme_not_https)" in m for m in messages), messages
    assert any("http://169.254.169.254/latest/meta-data/ (scheme_not_https)" in m for m in messages), messages
    assert not [m for m in messages if "s3cret" in m]


def test_a_redirect_to_http_is_still_a_downgrade_even_where_links_are_upgraded(env):
    sp = env.source.port
    policy = fp.FetchPolicy(name="U", hosts=frozenset({"localhost"}), ports=frozenset({sp}), upgrade_http=True)
    env.source.routes["/r"] = (302, {"Location": "http://localhost/ok"}, b"")
    assert _refused(_fetcher(env, policy=policy), f"{env.origin}/r").reason == fp.SCHEME_DOWNGRADE


def test_every_production_policy_upgrades_and_strict_policies_do_not():
    assert all(p.upgrade_http for p in fp.SOURCE_POLICIES.values())
    assert not fp.FetchPolicy(name="S", hosts=frozenset({"x.example"})).upgrade_http
    strict = fp.PolicyFetcher(fp.FetchPolicy(name="S", hosts=frozenset({"x.example"})))
    assert not strict.allows("http://x.example/a")


# ---------------------------------------------------------------------------------------------
# LOW 7: reportlab markup in pdf_writer
# ---------------------------------------------------------------------------------------------
def test_pdf_writer_escapes_metadata_before_reportlab_parses_it(monkeypatch, tmp_path):
    """reportlab's Paragraph parses its text as markup, and an <img src=...> there is fetched.
    Metadata comes from harvested pages, so it is escaped. reportlab itself is not in the test set,
    so a recording stand-in takes its place."""
    paragraphs = []

    class _Doc:
        def __init__(self, filename, **kw):
            self.filename = filename

        def build(self, story):
            open(self.filename, "wb").write(b"%PDF-1.4 F25 stand-in")

    stand_ins = {
        "reportlab": types.ModuleType("reportlab"),
        "reportlab.lib": types.ModuleType("reportlab.lib"),
        "reportlab.lib.pagesizes": types.SimpleNamespace(A4=(595, 842)),
        "reportlab.platypus": types.SimpleNamespace(
            SimpleDocTemplate=_Doc, Paragraph=lambda text, style: paragraphs.append(text), Spacer=lambda *a: None
        ),
        "reportlab.lib.styles": types.SimpleNamespace(getSampleStyleSheet=lambda: {"Heading3": 0, "Normal": 0, "Italic": 0}),
        "reportlab.lib.units": types.SimpleNamespace(inch=72),
    }
    for name, module in stand_ins.items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.delitem(sys.modules, "scraper.parsers.pdf_writer", raising=False)
    pdf_writer = importlib.import_module("scraper.parsers.pdf_writer")

    hostile = '<img src="http://169.254.169.254/latest/meta-data/" width="1" height="1"/>'
    meta = {key: f"{key} {hostile} & <b>" for key in ("court", "title", "citation", "journal", "year", "caseId", "timestamp", "seat")}
    pdf_writer.write_judgment_pdf(tmp_path / "out" / "j.pdf", meta, f"Body {hostile}\n\nSecond paragraph")

    assert paragraphs, "nothing rendered"
    assert not [p for p in paragraphs if "<img" in p], paragraphs
    assert "&lt;img src=" in paragraphs[0] and "&amp; &lt;b&gt;" in paragraphs[0]
    assert paragraphs[0].startswith("<b>court ")  # the writer's own markup is kept
    assert (tmp_path / "out" / "j.pdf").read_bytes().startswith(b"%PDF")
