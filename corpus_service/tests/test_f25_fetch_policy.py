"""Audit F25: the corpus fetch boundary, class by class (no database).

Spec: docs/superpowers/specs/2026-10-18-f25-corpus-fetch-boundary-design.md (rulings R2-R11).

* URL policy (R3-R5): scheme, userinfo, port, allowlist, IP literals in every form, IDN/punycode,
  malformed hosts, parser-differential tricks.
* Address policy (R6): every private / loopback / link-local / CGNAT / multicast / reserved /
  documentation range, the named cloud metadata addresses, IPv6 loopback, ULA, link-local,
  IPv4-mapped, NAT64, 6to4, Teredo; public controls.
* Connect-time backend (R2): a name resolving privately, mixed answers, DNS rebinding (first answer
  public, second private), pinning to the vetted IP, Unix sockets, empty answers.
* The fetcher against local servers (R7, R8): redirects to a private host, to a non-allowlisted host,
  to an allowlisted name that resolves privately, a scheme downgrade, a loop, a same-origin redirect,
  the byte cap, the deadline, an unredirected POST, the transport's own check.
* The Nasir connector without a database: relative links resolve against the fetched page; refused
  links cost no request.
* Test-only hooks are refused outside ENVIRONMENT=development (R11).
"""

import asyncio
import ipaddress
import logging
import socket
import time
import types
import uuid

import httpcore
import httpx
import pytest

from f25_servers import RecordingServer, client_tls_context, make_test_pki, serving, server_tls_context
from scraper.net import fetch_policy as fp

NASIR = fp.policy_for("NasirLawSite")
LHC = fp.policy_for("LahoreHighCourt")


def _reason(policy, url, previous=None):
    with pytest.raises(fp.FetchRefused) as info:
        policy.check_url(url, previous=previous)
    return info.value.reason


# ---------------------------------------------------------------------------------------------
# URL policy
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "url, expected",
    [
        ("https://www.nasirlawsite.com/case/scmr.htm", "https://www.nasirlawsite.com/case/scmr.htm"),
        ("https://nasirlawsite.com/case/x.htm", "https://nasirlawsite.com/case/x.htm"),
        ("HTTPS://WWW.NasirLawSite.COM:443/case/x.htm#top", "https://www.nasirlawsite.com/case/x.htm"),
    ],
)
def test_allowlisted_https_urls_pass_and_are_normalised(url, expected):
    assert str(NASIR.check_url(url)) == expected
    assert NASIR.allows(url)


def test_dot_anchored_suffix_admits_subdomains_only():
    assert LHC.allows("https://lhc.gov.pk/reported_judgments")
    assert LHC.allows("https://sys.lhc.gov.pk/appjudgments/2099LHC1.pdf")
    for url in ("https://evillhc.gov.pk/x.pdf", "https://notlhc.gov.pk/", "https://lhc.gov.pk.evil.example/x"):
        assert _reason(LHC, url) == fp.HOST_NOT_ALLOWED, url


@pytest.mark.parametrize(
    "url, reason",
    [
        # scheme (R3)
        ("http://www.nasirlawsite.com/case/x.htm", fp.SCHEME),
        ("ftp://www.nasirlawsite.com/x", fp.SCHEME),
        ("file:///etc/passwd", fp.SCHEME),
        ("javascript:alert(1)", fp.SCHEME),
        ("data:text/html,case.htm", fp.SCHEME),
        ("gopher://www.nasirlawsite.com:70/x", fp.SCHEME),
        ("case.htm", fp.SCHEME),
        # userinfo, including the "allowed@evil" and backslash forms
        ("https://f25:f25@www.nasirlawsite.com/case/x.htm", fp.USERINFO),
        ("https://www.nasirlawsite.com@evil.example/case/x.htm", fp.USERINFO),
        ("https://@www.nasirlawsite.com/case/x.htm", fp.USERINFO),
        ("https://www.nasirlawsite.com\\@evil.example/", fp.USERINFO),
        # ports
        ("https://www.nasirlawsite.com:8443/case/x.htm", fp.PORT_NOT_ALLOWED),
        ("https://www.nasirlawsite.com:80/case/x.htm", fp.PORT_NOT_ALLOWED),
        ("https://www.nasirlawsite.com:0/case/x.htm", fp.PORT_NOT_ALLOWED),
        # allowlist
        ("https://evil.example/case/x.htm", fp.HOST_NOT_ALLOWED),
        ("https://nasirlawsite.com.evil.example/case/x.htm", fp.HOST_NOT_ALLOWED),
        ("https://wwwnasirlawsite.com/case/x.htm", fp.HOST_NOT_ALLOWED),
        ("https://metadata.google.internal/computeMetadata/v1/", fp.HOST_NOT_ALLOWED),
        # IP literals in every form a resolver accepts
        ("https://127.0.0.1/case/x.htm", fp.IP_LITERAL),
        ("https://169.254.169.254/latest/meta-data/", fp.IP_LITERAL),
        ("https://2130706433/case/x.htm", fp.IP_LITERAL),
        ("https://0x7f.0.0.1/case/x.htm", fp.IP_LITERAL),
        ("https://0x7f000001/case/x.htm", fp.IP_LITERAL),
        ("https://017700000001/case/x.htm", fp.IP_LITERAL),
        ("https://127.1/case/x.htm", fp.IP_LITERAL),
        ("https://8.8.8.8/case/x.htm", fp.IP_LITERAL),
        ("https://[::1]/case/x.htm", fp.IP_LITERAL),
        ("https://[::ffff:127.0.0.1]/case/x.htm", fp.IP_LITERAL),
        ("https://[::ffff:a9fe:a9fe]/latest/meta-data/", fp.IP_LITERAL),
        ("https://[fd00:ec2::254]/latest/meta-data/", fp.IP_LITERAL),
        # IDN / punycode homoglyphs of an allowlisted name (Cyrillic "а")
        ("https://www.nasirlаwsite.com/case/x.htm", fp.IDN_HOST),
        ("https://www.xn--nasirlwsite-3ij.com/case/x.htm", fp.IDN_HOST),
        # malformed hosts
        ("https://www.nasirlawsite.com./case/x.htm", fp.BAD_HOST),
        ("https://www.nasir%6cawsite.com/case/x.htm", fp.BAD_HOST),
        ("https://www_nasirlawsite.com/case/x.htm", fp.BAD_HOST),
        ("https:///case/x.htm", fp.BAD_HOST),
        ("https://www.nasirlawsite.com\t.evil.example/", fp.UNPARSEABLE),
    ],
)
def test_url_classes_are_refused_with_their_reason(url, reason):
    assert _reason(NASIR, url) == reason
    assert not NASIR.allows(url)


def test_octal_dotted_literal_never_passes():
    # httpx rejects the leading-zero octal form outright; either way it is never fetched.
    assert _reason(NASIR, "https://0177.0.0.1/case/x.htm") in (fp.IP_LITERAL, fp.UNPARSEABLE)


def test_https_to_http_is_reported_as_a_downgrade():
    previous = httpx.URL("https://www.nasirlawsite.com/case/scmr.htm")
    assert _reason(NASIR, "http://www.nasirlawsite.com/case/x.htm", previous=previous) == fp.SCHEME_DOWNGRADE


# ---------------------------------------------------------------------------------------------
# Address policy
# ---------------------------------------------------------------------------------------------
BLOCKED_ADDRESSES = [
    # IPv4 private, loopback, link-local and the cloud metadata endpoints
    "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.0.1", "192.168.255.254",
    "127.0.0.1", "127.255.255.254", "169.254.0.1", "169.254.169.254", "169.254.170.2", "169.254.169.253",
    # CGNAT (Alibaba metadata 100.100.100.200), unspecified, this-network
    "100.64.0.1", "100.100.100.200", "100.127.255.254", "0.0.0.0", "0.1.2.3",
    # IETF, documentation, benchmarking, 6to4 relay, multicast, reserved, broadcast
    "192.0.0.1", "192.0.0.192", "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "198.19.255.254",
    "192.88.99.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    # IPv6 loopback, unspecified, IPv4-mapped / compatible
    "::1", "::", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:8.8.8.8", "::127.0.0.1",
    # ULA (AWS IMDSv6 fd00:ec2::254), link-local, site-local, multicast
    "fd00:ec2::254", "fc00::1", "fdff:ffff::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "ff05::2",
    # NAT64, discard-only, Teredo / IETF, documentation, 6to4, SRv6, non-2000::/3
    "64:ff9b::7f00:1", "64:ff9b:1::1", "100::1", "2001::1", "2001:0:4136:e378::1", "2001:2::1",
    "2001:db8::1", "3fff::1", "2002:7f00:1::1", "2002:a9fe:a9fe::1", "5f00::1", "4000::1",
]
PUBLIC_ADDRESSES = ["8.8.8.8", "1.1.1.1", "93.184.215.14", "142.250.190.78", "2606:4700:4700::1111", "2001:4860:4860::8888"]


@pytest.mark.parametrize("address", BLOCKED_ADDRESSES)
def test_non_public_addresses_are_blocked(address):
    assert not fp.is_public_address(address)
    assert not fp.is_public_address(ipaddress.ip_address(address))


@pytest.mark.parametrize("address", PUBLIC_ADDRESSES)
def test_public_addresses_pass(address):
    assert fp.is_public_address(address)


def test_unparseable_address_is_not_public():
    assert not fp.is_public_address("not-an-ip")
    assert not fp.is_public_address("fe80::1%eth0")


# ---------------------------------------------------------------------------------------------
# Connect-time backend: resolution, pinning, rebinding
# ---------------------------------------------------------------------------------------------
class FakeInner(httpcore.AsyncNetworkBackend):
    """Records where the guarded backend asks to connect; opens nothing."""

    def __init__(self, fail_first=0):
        self.calls = []
        self.fail_first = fail_first

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.calls.append((host, port))
        if len(self.calls) <= self.fail_first:
            raise httpcore.ConnectError("synthetic refusal")
        return types.SimpleNamespace(peer=(host, port))

    async def sleep(self, seconds):
        return None


def _resolver(*answers):
    """Each call returns the next answer (the last one repeats)."""
    calls = []

    async def resolve(host, port):
        calls.append((host, port))
        return list(answers[min(len(calls), len(answers)) - 1])

    resolve.calls = calls
    return resolve


def _backend(resolver, inner, loopback=()):
    return fp._GuardedBackend("t", resolver=resolver, loopback_origins=frozenset(loopback), inner=inner)


def _connect(backend, host="source.example", port=443):
    return asyncio.run(backend.connect_tcp(host, port, timeout=5))


def test_a_name_resolving_to_a_private_address_is_refused_before_connect():
    for answer in (["10.0.0.7"], ["169.254.169.254"], ["127.0.0.1"], ["fd00:ec2::254"], ["::ffff:10.0.0.7"]):
        inner = FakeInner()
        with pytest.raises(fp.FetchRefused) as info:
            _connect(_backend(_resolver(answer), inner))
        assert info.value.reason == fp.BLOCKED_ADDRESS, answer
        assert inner.calls == [], answer


def test_mixed_public_and_private_answers_are_refused_whole():
    inner = FakeInner()
    with pytest.raises(fp.FetchRefused):
        _connect(_backend(_resolver(["93.184.215.14", "10.0.0.7"]), inner))
    assert inner.calls == []


def test_dns_rebinding_cannot_swap_the_address_after_the_check():
    """First resolution public, second private (a rebinding name). The first connection goes to the
    vetted IP itself (never the hostname, so nothing re-resolves it); the second is refused before
    any connect."""
    resolver = _resolver(["93.184.215.14"], ["127.0.0.1"])
    inner = FakeInner()
    backend = _backend(resolver, inner)
    stream = _connect(backend, "rebind.example", 443)
    assert stream.peer == ("93.184.215.14", 443)
    with pytest.raises(fp.FetchRefused) as info:
        _connect(backend, "rebind.example", 443)
    assert info.value.reason == fp.BLOCKED_ADDRESS
    assert inner.calls == [("93.184.215.14", 443)]
    assert resolver.calls == [("rebind.example", 443), ("rebind.example", 443)]


def test_connect_falls_through_vetted_addresses_only():
    inner = FakeInner(fail_first=1)
    stream = _connect(_backend(_resolver(["93.184.215.14", "93.184.215.15"]), inner))
    assert stream.peer == ("93.184.215.15", 443)
    assert inner.calls == [("93.184.215.14", 443), ("93.184.215.15", 443)]


def test_loopback_hook_admits_loopback_for_its_exact_origin_only():
    inner = FakeInner()
    backend = _backend(_resolver(["127.0.0.1"]), inner, loopback={("localhost", 8443)})
    assert _connect(backend, "localhost", 8443).peer == ("127.0.0.1", 8443)
    with pytest.raises(fp.FetchRefused):
        _connect(backend, "localhost", 9443)
    private = _backend(_resolver(["10.0.0.7"]), FakeInner(), loopback={("localhost", 8443)})
    with pytest.raises(fp.FetchRefused):  # the hook is loopback only, never other private space
        _connect(private, "localhost", 8443)


def test_empty_answer_and_unix_sockets_are_refused():
    with pytest.raises(fp.FetchRefused) as info:
        _connect(_backend(_resolver([]), FakeInner()))
    assert info.value.reason == fp.NO_ADDRESS
    backend = _backend(_resolver(["93.184.215.14"]), FakeInner())
    with pytest.raises(fp.FetchRefused) as info:
        asyncio.run(backend.connect_unix_socket("/var/run/docker.sock"))
    assert info.value.reason == fp.UNIX_SOCKET


def test_resolution_failure_is_a_connect_error():
    async def fail(host, port):
        raise socket.gaierror("synthetic NXDOMAIN")

    with pytest.raises(httpcore.ConnectError):
        _connect(_backend(fail, FakeInner()))


def test_every_fetcher_pool_connects_through_the_guarded_backend():
    fetcher = fp.PolicyFetcher(NASIR)
    pool = fetcher._transport._pool
    assert isinstance(pool, httpcore.AsyncConnectionPool)
    assert isinstance(pool._network_backend, fp._GuardedBackend)
    assert fetcher._client.follow_redirects is False
    assert fetcher._client._trust_env is False


# ---------------------------------------------------------------------------------------------
# The fetcher against local servers
# ---------------------------------------------------------------------------------------------
@pytest.fixture
def servers(tmp_path):
    pki = make_test_pki(tmp_path / "pki")
    internal = RecordingServer(routes={"/x": (200, {}, b"F25 internal")})
    source = RecordingServer(tls=server_tls_context(pki))
    with serving(internal), serving(source):
        yield types.SimpleNamespace(pki=pki, internal=internal, source=source, origin=f"https://localhost:{source.port}")


def _fetcher(env, **kwargs):
    sp = env.source.port
    resolver = kwargs.pop("resolver", None)

    async def resolve(host, port):
        if resolver is not None:
            return await resolver(host, port)
        return {"localhost": ["127.0.0.1"], "internal.allowed.test": ["127.0.0.1"]}.get(host, ["93.184.215.14"])

    policy = fp.FetchPolicy(name="T", hosts=frozenset({"localhost", "internal.allowed.test"}), ports=frozenset({sp}))
    return fp.PolicyFetcher(
        policy,
        _test_ssl_context=client_tls_context(env.pki),
        _test_loopback_origins={("localhost", sp)},
        _test_resolver=resolve,
        **kwargs,
    )


async def _get(fetcher, url, **kw):
    async with fetcher as client:
        return await client.get(url, **kw)


def _refusal(coro):
    with pytest.raises(fp.FetchRefused) as info:
        asyncio.run(coro)
    return info.value


def _paths(server):
    return [r["path"] for r in server.requests]


def test_allowlisted_fetch_and_same_origin_redirect(servers):
    servers.source.routes.update({"/ok": (200, {"Content-Type": "text/html; charset=utf-8"}, "F25 ok ب".encode()),
                                  "/same": (302, {"Location": "/ok"}, b"")})
    response = asyncio.run(_get(_fetcher(servers), f"{servers.origin}/same"))
    assert (response.status_code, response.url, response.text) == (200, f"{servers.origin}/ok", "F25 ok ب")
    assert _paths(servers.source) == ["/same", "/ok"]


@pytest.mark.parametrize(
    "location, reason",
    [
        ("http://127.0.0.1:{ip}/x", fp.SCHEME_DOWNGRADE),  # private host over http
        ("https://127.0.0.1:{sp}/x", fp.IP_LITERAL),  # private host by literal
        ("https://evil.example/x", fp.HOST_NOT_ALLOWED),  # off the allowlist
        ("https://localhost:{ip}/x", fp.PORT_NOT_ALLOWED),  # the internal port
        ("http://localhost:{sp}/ok", fp.SCHEME_DOWNGRADE),  # scheme downgrade on the same origin
        ("https://f25:f25@localhost:{sp}/ok", fp.USERINFO),
        ("https://internal.allowed.test:{sp}/x", fp.BLOCKED_ADDRESS),  # allowlisted name, private address
    ],
)
def test_each_redirect_hop_is_revalidated(servers, location, reason):
    target = location.format(ip=servers.internal.port, sp=servers.source.port)
    servers.source.routes["/r"] = (302, {"Location": target}, b"")
    refusal = _refusal(_get(_fetcher(servers), f"{servers.origin}/r"))
    assert refusal.reason == reason
    assert (servers.internal.connections, servers.internal.requests) == (0, [])
    assert _paths(servers.source) == ["/r"]  # nothing after the refused hop reached the source either


def test_redirect_loops_stop_at_five_hops(servers):
    servers.source.routes["/loop"] = (302, {"Location": "/loop"}, b"")
    assert _refusal(_get(_fetcher(servers), f"{servers.origin}/loop")).reason == fp.TOO_MANY_REDIRECTS
    assert _paths(servers.source) == ["/loop"] * 6


def test_body_cap(servers):
    servers.source.routes["/big"] = (200, {}, b"x" * 4096)
    assert _refusal(_get(_fetcher(servers, max_bytes=1024), f"{servers.origin}/big")).reason == fp.TOO_LARGE
    assert asyncio.run(_get(_fetcher(servers, max_bytes=4096), f"{servers.origin}/big")).content == b"x" * 4096


def test_deadline_bounds_a_drip_fed_body(servers):
    def drip(handler):
        handler.send_response(200)
        handler.send_header("Content-Length", "100")
        handler.end_headers()
        for _ in range(100):
            handler.wfile.write(b"x")
            handler.wfile.flush()
            time.sleep(0.05)
        return None

    servers.source.routes["/drip"] = drip
    started = time.monotonic()
    assert _refusal(_get(_fetcher(servers, deadline=0.5), f"{servers.origin}/drip")).reason == fp.DEADLINE
    assert time.monotonic() - started < 3


def test_post_is_never_redirected(servers):
    servers.source.routes["/feed"] = (307, {"Location": f"http://127.0.0.1:{servers.internal.port}/x"}, b"")

    async def post():
        async with _fetcher(servers) as client:
            return await client.post(f"{servers.origin}/feed", json={})

    assert asyncio.run(post()).status_code == 307
    assert [r["method"] for r in servers.source.requests] == ["POST"]
    assert servers.internal.connections == 0


def test_the_transport_checks_requests_that_bypass_the_helper(servers):
    """A caller using the underlying client directly is still checked on every request that reaches
    the transport, before any DNS lookup, and cannot make httpx follow a redirect. (The resolver answers
    loopback, so the allowlisted source origin is reachable through the loopback hook and the
    redirect is what gets checked; nothing here may dial a real address.)"""
    resolver = _resolver(["127.0.0.1"])
    servers.source.routes["/r"] = (302, {"Location": f"http://127.0.0.1:{servers.internal.port}/x"}, b"")

    async def direct(url, **kw):
        async with _fetcher(servers, resolver=resolver) as client:
            return await client._client.get(url, **kw)

    assert _refusal(direct("https://evil.example/x")).reason == fp.HOST_NOT_ALLOWED
    assert resolver.calls == []
    # Re-audit round (R18): the boundary holds every redirect Location back from httpx, so httpx
    # cannot follow one even when a caller asks it to; the 302 comes back unfollowed ...
    response = asyncio.run(direct(f"{servers.origin}/r", follow_redirects=True))
    assert response.status_code == 302 and "location" not in response.headers
    # ... and the hop's URL, sent directly, is refused by the transport before any lookup.
    assert _refusal(direct(f"http://127.0.0.1:{servers.internal.port}/x")).reason == fp.SCHEME
    assert servers.internal.connections == 0


def test_refusals_are_logged_once_with_userinfo_redacted(servers, caplog):
    async def run():
        async with _fetcher(servers) as client:
            assert not client.allows("https://f25:s3cret@evil.example/case/x.htm")

    with caplog.at_level(logging.WARNING, logger="scraper.net.fetch_policy"):
        asyncio.run(run())
    messages = [r.getMessage() for r in caplog.records]
    assert len(messages) == 1, messages
    assert "https://***@evil.example/case/x.htm" in messages[0] and "userinfo" in messages[0]
    assert "s3cret" not in messages[0]


def test_sync_fetcher_runs_the_same_boundary(servers):
    servers.source.routes["/ok"] = (200, {}, b"F25 sync ok")
    with fp.SyncPolicyFetcher(_fetcher(servers)) as client:
        assert client.get(f"{servers.origin}/ok").content == b"F25 sync ok"
        assert not client.allows(f"http://127.0.0.1:{servers.internal.port}/x")
        with pytest.raises(fp.FetchRefused):
            client.get(f"http://127.0.0.1:{servers.internal.port}/x")
    assert servers.internal.connections == 0


def test_production_factories_build_registered_policies_only():
    assert fp.fetcher_for("NasirLawSite").policy is NASIR
    with pytest.raises(KeyError):
        fp.fetcher_for("NoSuchSource")
    with pytest.raises(TypeError):
        fp.fetcher_for("NasirLawSite", _test_loopback_origins={("localhost", 1)})
    with fp.sync_fetcher_for("NationalAssembly") as client:
        assert client.allows("https://na.gov.pk/en/acts-tenure.php")
        with pytest.raises(fp.FetchRefused):
            client.get("http://169.254.169.254/latest/meta-data/")


# ---------------------------------------------------------------------------------------------
# Test-only hooks (R11)
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "hook",
    [
        {"_test_loopback_origins": {("localhost", 8443)}},
        {"_test_ssl_context": object()},
        {"_test_resolver": _resolver(["93.184.215.14"])},
    ],
)
@pytest.mark.parametrize("environment", ["production", "staging", None])
def test_test_hooks_are_refused_outside_development(monkeypatch, hook, environment):
    if environment is None:
        monkeypatch.delenv("ENVIRONMENT", raising=False)  # unset means production, as in Settings
    else:
        monkeypatch.setenv("ENVIRONMENT", environment)
    with pytest.raises(RuntimeError):
        fp.PolicyFetcher(NASIR, **hook)
    fp.PolicyFetcher(NASIR)  # the production shape is unaffected


# ---------------------------------------------------------------------------------------------
# The Nasir connector without a database
# ---------------------------------------------------------------------------------------------
class _FakeSession:
    def __init__(self):
        self.rows = []

    def add(self, row):
        self.rows.append(row)

    async def commit(self):
        return None


def test_nasir_resolves_relative_links_against_the_fetched_page_and_skips_refused_ones(servers, monkeypatch):
    import scraper.tasks.nasirlawsite as nasirlawsite

    ip = servers.internal.port
    page = (
        '<a href="2099-rel-1.htm">case</a><a href="/case/2099-rel-2.htm">case</a>'
        '<a href="//evil.example/case/x.htm">case</a><a href="https://evil.example/case/y.htm">case</a>'
        f'<a href="http://127.0.0.1:{ip}/case/x.htm">case</a><a href="mailto:case@example.invalid">case</a>'
    )
    servers.source.routes.update(
        {
            "/case/scmr.htm": (200, {}, f"<html><title>F25</title>{page}</html>".encode()),
            "/case/2099-rel-1.htm": (200, {}, b"<html>Synthetic F25 relative one</html>"),
            "/case/2099-rel-2.htm": (200, {}, b"<html>Synthetic F25 relative two</html>"),
        }
    )
    monkeypatch.setattr(nasirlawsite, "REPORTER_URLS", [f"{servers.origin}/case/scmr.htm"])
    monkeypatch.setattr(fp, "fetcher_for", lambda name, **kw: _fetcher(servers, headers=kw.get("headers")))
    real_sleep = asyncio.sleep

    async def _no_wait(delay=0, result=None):
        return await real_sleep(0, result)

    monkeypatch.setattr(asyncio, "sleep", _no_wait)
    session = _FakeSession()
    source = types.SimpleNamespace(id=uuid.uuid4(), source_name="NasirLawSite")
    asyncio.run(nasirlawsite.scrape_nasirlawsite(source, session))

    assert sorted(r.source_url for r in session.rows) == [
        f"{servers.origin}/case/2099-rel-1.htm",
        f"{servers.origin}/case/2099-rel-2.htm",
    ]
    assert _paths(servers.source) == ["/case/scmr.htm", "/case/2099-rel-1.htm", "/case/2099-rel-2.htm"]
    assert servers.internal.connections == 0
