"""Audit F25: the one fetch boundary for every corpus source.

Spec: docs/superpowers/specs/2026-10-18-f25-corpus-fetch-boundary-design.md (rulings R1-R15, and
R17-R22 from the re-audit round).

Source pages are external input. A link on a page is a request the page asks us to make, so no
connector may fetch it on its own judgement. Every outbound request a corpus source makes goes
through a ``PolicyFetcher`` built here, and nothing else in corpus_service builds an HTTP client
(tests/test_f25_fetch_guard.py fails the build if one does).

Enforcement is layered (R2):

1. ``PolicyFetcher.get`` / ``post`` check the URL against the source's ``FetchPolicy`` before
   sending, follow at most ``MAX_REDIRECTS`` redirects themselves (each hop re-checked, an
   https -> http hop refused as a downgrade, a malformed ``Location`` refused), re-check the final
   origin, and bound the body (R17) and the total time. A refusal is logged once and raised as
   ``FetchRefused``; httpx's own URL errors inside the boundary become refusals too (R18).
2. ``_GuardedTransport`` re-checks every request URL that reaches the wire, so a caller that uses
   the underlying client directly is still checked. A response hook holds every redirect
   ``Location`` back from httpx, so httpx itself never builds or follows a redirect.
3. ``_GuardedBackend`` resolves the hostname itself, refuses unless every resolved address is
   public, and connects to the vetted IP address, never to the name. There is no window for DNS
   rebinding between the check and the connect. TLS still verifies the certificate and SNI against
   the hostname (httpcore passes the URL host to ``start_tls``).

URL policy (R3-R5): https only; no userinfo and no ``@`` in the authority; LDH hostnames only (no
IDN or punycode labels, no trailing dot, no percent or underscore); no IP literal in any form a
resolver accepts (dotted, decimal, hex, octal, short, bracketed IPv6); the host is on the policy's
allowlist (exact names plus dot-anchored suffixes); the effective port is in the policy's port set
(443 for every production source); httpx and urllib agree on the host and port.

Address policy (R6): ``is_public_address``. Python's ``is_global`` and an explicit block list that
does not depend on the Python patch version; IPv6 must also be inside 2000::/3.

The environment is ignored (R9): no proxy, no .netrc, no SSL_CERT_FILE; certificates verify
against certifi.

Bodies (R17): only identity or a single gzip/deflate content coding is accepted, and the boundary
inflates it itself in bounded steps (``zlib.decompressobj(...).decompress(chunk, max_length)``);
stacked, brotli, zstd and unknown codings are refused before any decoding. Both the bytes on the
wire and the decoded bytes are capped at ``max_bytes``. The body is held once; ``text`` is decoded
only when a caller asks for it (R19). ``Accept-Encoding: gzip`` is sent on every request.

Test-only hooks (R11, R20) are keyword arguments of ``PolicyFetcher`` that start with ``_test_``,
and ``_GuardedBackend``'s ``resolver`` / ``loopback_origins`` / ``inner``. The production factories
``fetcher_for`` and ``sync_fetcher_for`` accept none of them, no setting turns them on, and both
constructors refuse them unless ENVIRONMENT is explicitly ``development``.
"""

from __future__ import annotations

import asyncio
import io
import ipaddress
import logging
import os
import re
import socket
import ssl
import types
import typing
import zlib
from dataclasses import dataclass
from urllib.parse import urlsplit

import certifi
import httpcore
import httpx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------------------------
# Refusal reasons (the value is what the log line shows)
# ---------------------------------------------------------------------------------------------
SCHEME = "scheme_not_https"
SCHEME_DOWNGRADE = "scheme_downgrade"
USERINFO = "userinfo"
IDN_HOST = "idn_host"
BAD_HOST = "bad_host"
IP_LITERAL = "ip_literal"
UNPARSEABLE = "unparseable_url"
AMBIGUOUS = "ambiguous_url"
HOST_NOT_ALLOWED = "host_not_allowed"
PORT_NOT_ALLOWED = "port_not_allowed"
BLOCKED_ADDRESS = "blocked_address"
NO_ADDRESS = "no_address"
UNIX_SOCKET = "unix_socket"
TOO_MANY_REDIRECTS = "too_many_redirects"
TOO_LARGE = "too_large"
DEADLINE = "deadline_exceeded"
CONTENT_ENCODING = "content_encoding_refused"

# ---------------------------------------------------------------------------------------------
# Bounds (R7, R8)
# ---------------------------------------------------------------------------------------------
DEFAULT_PORT = 443
MAX_REDIRECTS = 5
MAX_BYTES = 100 * 1024 * 1024  # matches pdf_extractor.MAX_PDF_SIZE_BYTES
DEADLINE_SECONDS = 300.0  # one fetch, redirects and body included
TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)
LIMITS = httpx.Limits(max_connections=10, max_keepalive_connections=5, keepalive_expiry=30.0)
_LOG_URL_LIMIT = 2048
ACCEPT_ENCODING = "gzip"  # the only coding advertised (R17); identity and a lone deflate are accepted too
_DECODE_STEP = 64 * 1024  # most bytes one inflate step may produce
_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})
_HELD_LOCATION = "f25.held_location"  # response extension holding the Location httpx never sees


# ---------------------------------------------------------------------------------------------
# Refusal
# ---------------------------------------------------------------------------------------------
_AUTHORITY = re.compile(r"^(\s*(?:[A-Za-z][A-Za-z0-9+.\-]*:)?[/\\]{2})([^/?#]*)")


def redact_url(url: typing.Any) -> str:
    """``url`` as text that is safe to log: any userinfo becomes ``***@`` (a page cannot get a
    credential written into the logs), control and other non-printable characters are escaped (a
    page cannot forge log lines), and the length is capped."""
    text = str(url)
    match = _AUTHORITY.match(text)
    if match and "@" in match.group(2):
        text = match.group(1) + "***@" + match.group(2).rpartition("@")[2] + text[match.end():]
    text = "".join(c if c.isprintable() else c.encode("unicode_escape").decode("ascii") for c in text)
    if len(text) > _LOG_URL_LIMIT:
        text = text[:_LOG_URL_LIMIT] + "...(truncated)"
    return text


class FetchRefused(Exception):
    """The fetch boundary refused a request. It is a plain ``Exception``, so a connector's
    per-URL ``except Exception`` skips the URL and carries on."""

    def __init__(self, reason: str, url: typing.Any = None, policy: str | None = None, detail: str | None = None):
        super().__init__(reason)
        self.reason = reason
        self.url = None if url is None else redact_url(url)
        self.policy = policy
        self.detail = detail

    def __str__(self) -> str:
        what = self.reason if not self.detail else f"{self.reason}: {self.detail}"
        return f"F25 fetch boundary refused {self.url or '<unknown url>'} ({what}) under policy {self.policy}"


def _scheme_of(url: typing.Any) -> str:
    try:
        return httpx.URL(str(url)).scheme
    except Exception:
        return ""


def _raw_authority(raw: str) -> str:
    match = _AUTHORITY.match(raw)
    return match.group(2) if match else ""


# ---------------------------------------------------------------------------------------------
# URL policy
# ---------------------------------------------------------------------------------------------
_LDH_HOST = re.compile(
    r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
)
_NUMERIC_LABEL = re.compile(r"[0-9]+|0x[0-9a-f]*")


def _is_ip_literal(host: str) -> bool:
    """Any form a resolver would read as an address: ``ipaddress`` (dotted IPv4, IPv6, scoped
    IPv6), ``inet_aton`` (decimal ``2130706433``, hex ``0x7f.0.0.1``, octal ``017700000001``, short
    ``127.1``), and any host whose last label is a number (WHATWG "ends in a number")."""
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    try:
        socket.inet_aton(host)
        return True
    except (OSError, ValueError):
        pass
    last = host.rstrip(".").rsplit(".", 1)[-1]
    return bool(_NUMERIC_LABEL.fullmatch(last))


def _effective_port(port: int | None) -> int:
    return DEFAULT_PORT if port is None else port


@dataclass(frozen=True)
class FetchPolicy:
    """What one source may fetch: exact hostnames, dot-anchored suffixes (``.lhc.gov.pk`` admits
    ``sys.lhc.gov.pk``, never ``evillhc.gov.pk``) and ports. Reviewed configuration in code, never
    page content or the database (R4).

    ``upgrade_http`` (R22): a plain-http link to an allowlisted host on the default port is fetched
    as https on 443 by ``PolicyFetcher``. ``check_url`` and ``allows`` here stay strict (https only);
    the upgrade is a rewrite before that check, never a plaintext fetch."""

    name: str
    hosts: frozenset
    host_suffixes: tuple = ()
    ports: frozenset = frozenset({DEFAULT_PORT})
    upgrade_http: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "hosts", frozenset(h.lower() for h in self.hosts))
        object.__setattr__(self, "host_suffixes", tuple(s.lower() for s in self.host_suffixes))
        object.__setattr__(self, "ports", frozenset(int(p) for p in self.ports))
        if any(not s.startswith(".") for s in self.host_suffixes):
            raise ValueError(f"{self.name}: host suffixes must be dot-anchored, got {self.host_suffixes}")
        if not isinstance(self.upgrade_http, bool):  # a switch, never a truthy object (Copilot review)
            raise TypeError(f"{self.name}: upgrade_http must be True or False, got {self.upgrade_http!r}")

    def host_allowed(self, host: str) -> bool:
        host = host.lower()
        return host in self.hosts or any(host.endswith(s) and len(host) > len(s) for s in self.host_suffixes)

    def _refuse(self, reason: str, url: typing.Any, detail: str | None = None) -> FetchRefused:
        return FetchRefused(reason, url, self.name, detail)

    def check_url(self, url: typing.Any, previous: typing.Any = None) -> httpx.URL:
        """The URL httpx will send, without its fragment, or ``FetchRefused`` with the reason.
        ``previous`` is the URL a redirect came from (an https -> http hop is a downgrade)."""
        raw = str(url)
        authority = _raw_authority(raw)
        try:
            parsed = httpx.URL(raw)
        except Exception as exc:  # httpx.InvalidURL, TypeError
            reason = IDN_HOST if not authority.isascii() else UNPARSEABLE
            raise self._refuse(reason, raw, str(exc)) from None

        scheme = parsed.scheme
        if scheme == "http" and previous is not None and _scheme_of(previous) == "https":
            raise self._refuse(SCHEME_DOWNGRADE, raw, f"redirect from {redact_url(previous)}")
        if scheme != "https":
            raise self._refuse(SCHEME, raw)
        if parsed.userinfo or "@" in authority:
            raise self._refuse(USERINFO, raw)

        host = parsed.raw_host.decode("ascii", errors="replace")
        if not authority.isascii() or any(label.startswith("xn--") for label in host.split(".")):
            raise self._refuse(IDN_HOST, raw)
        if not host:
            raise self._refuse(BAD_HOST, raw, "no host")
        if _is_ip_literal(host):
            raise self._refuse(IP_LITERAL, raw)
        if not _LDH_HOST.fullmatch(host):
            raise self._refuse(BAD_HOST, raw)

        # Parser differential: the URL means the same thing to urllib as to httpx (which sends it).
        try:
            other = urlsplit(raw)
            other_host, other_port = (other.hostname or ""), other.port
        except ValueError as exc:
            raise self._refuse(AMBIGUOUS, raw, str(exc)) from None
        if other_host != host or _effective_port(other_port) != _effective_port(parsed.port):
            raise self._refuse(AMBIGUOUS, raw, f"urllib reads {other_host}:{other_port}")

        if not self.host_allowed(host):
            raise self._refuse(HOST_NOT_ALLOWED, raw)
        if _effective_port(parsed.port) not in self.ports:
            raise self._refuse(PORT_NOT_ALLOWED, raw)
        return parsed.copy_with(fragment=None)

    def https_upgrade(self, url: typing.Any) -> str | None:
        """The https form of a plain-http ``url`` on the default port, if this policy upgrades;
        otherwise None. Only the scheme changes (and an explicit :80 goes); the result still has to
        pass ``check_url``."""
        if not self.upgrade_http:
            return None
        try:
            parsed = httpx.URL(str(url))
        except Exception:
            return None
        if parsed.scheme != "http" or parsed.port not in (None, 80):
            return None
        return str(parsed.copy_with(scheme="https", port=None))

    def allows(self, url: typing.Any) -> bool:
        """Pure check (no logging); ``PolicyFetcher.allows`` is the logged form."""
        try:
            self.check_url(url)
        except FetchRefused:
            return False
        return True


# ---------------------------------------------------------------------------------------------
# Address policy
# ---------------------------------------------------------------------------------------------
_BLOCKED_V4 = tuple(
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8",  # this network, unspecified
        "10.0.0.0/8",  # RFC 1918
        "100.64.0.0/10",  # CGNAT, includes Alibaba metadata 100.100.100.200
        "127.0.0.0/8",  # loopback
        "169.254.0.0/16",  # link-local, includes 169.254.169.254 and 169.254.170.2
        "172.16.0.0/12",  # RFC 1918
        "192.0.0.0/24",  # IETF protocol assignments
        "192.0.2.0/24",  # TEST-NET-1
        "192.88.99.0/24",  # 6to4 relay anycast
        "192.168.0.0/16",  # RFC 1918
        "198.18.0.0/15",  # benchmarking
        "198.51.100.0/24",  # TEST-NET-2
        "203.0.113.0/24",  # TEST-NET-3
        "224.0.0.0/4",  # multicast
        "240.0.0.0/4",  # reserved, broadcast
    )
)
_BLOCKED_V6 = tuple(
    ipaddress.ip_network(n)
    for n in (
        "::/8",  # unspecified, loopback, IPv4-mapped ::ffff:0:0/96, IPv4-compatible
        "64:ff9b::/96",  # NAT64
        "64:ff9b:1::/48",  # local-use NAT64
        "100::/64",  # discard-only
        "2001::/23",  # IETF protocol assignments, Teredo 2001::/32
        "2001:db8::/32",  # documentation
        "2002::/16",  # 6to4 (embeds an IPv4 address)
        "3fff::/20",  # documentation
        "5f00::/16",  # SRv6 SIDs
        "fc00::/7",  # ULA, includes AWS IMDS fd00:ec2::254
        "fe80::/10",  # link-local
        "fec0::/10",  # site-local (deprecated)
        "ff00::/8",  # multicast
    )
)
_GLOBAL_UNICAST_V6 = ipaddress.ip_network("2000::/3")

AddressLike = typing.Union[str, ipaddress.IPv4Address, ipaddress.IPv6Address]


def _listed_non_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Blocked by the explicit lists alone (and, for IPv6, a scope or anything outside 2000::/3),
    whatever this Python's ``is_global`` says."""
    if ip.version == 6:
        return bool(ip.scope_id) or ip not in _GLOBAL_UNICAST_V6 or any(ip in n for n in _BLOCKED_V6)
    return any(ip in n for n in _BLOCKED_V4)


def is_public_address(address: AddressLike) -> bool:
    """True only for a globally routable unicast address outside every blocked range."""
    try:
        ip = address if isinstance(address, (ipaddress.IPv4Address, ipaddress.IPv6Address)) else ipaddress.ip_address(str(address))
    except ValueError:
        return False
    return not _listed_non_public(ip) and bool(ip.is_global)


def _is_loopback(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip.version == 4:
        return ip in ipaddress.ip_network("127.0.0.0/8")
    return ip == ipaddress.IPv6Address("::1")


# ---------------------------------------------------------------------------------------------
# Connect-time backend: resolve, vet every answer, connect to the vetted IP
# ---------------------------------------------------------------------------------------------
Resolver = typing.Callable[[str, int], typing.Awaitable[typing.List[str]]]


async def _system_resolve(host: str, port: int) -> list:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    return [info[4][0] for info in infos]


class _GuardedBackend(httpcore.AsyncNetworkBackend):
    """The connection pool's only way onto the network (R2.3).

    ``connect_tcp`` resolves ``host``, refuses the whole name if any answer is not public (fail
    closed: a name that mixes public and private records is suspect), then connects to the vetted
    addresses in turn. The socket goes to the address that was checked, so a rebinding name cannot
    swap it. ``loopback_origins`` (tests only, R11) admits a loopback address for those exact
    (host, port) origins and nothing else.

    ``resolver``, ``loopback_origins`` and ``inner`` are test hooks: refused outside
    ENVIRONMENT=development, exactly like ``PolicyFetcher``'s ``_test_*`` arguments (R20)."""

    def __init__(
        self,
        policy_name: str,
        *,
        resolver: Resolver | None = None,
        loopback_origins: typing.Iterable | None = None,
        inner: httpcore.AsyncNetworkBackend | None = None,
    ):
        # Identity, never truthiness (Copilot review): a hook object whose __bool__ is False is still
        # a hook, and the origins are materialised once, so what is gated is what gets installed.
        origins = tuple(loopback_origins) if loopback_origins is not None else ()
        hooks = [
            name
            for name, present in (("resolver", resolver is not None), ("loopback_origins", len(origins) > 0), ("inner", inner is not None))
            if present
        ]
        if hooks and not _hooks_permitted():
            raise RuntimeError(f"F25: test-only backend hooks {hooks} are refused outside ENVIRONMENT=development")
        self._policy_name = policy_name
        self._resolver = resolver if resolver is not None else _system_resolve
        self._loopback = frozenset((str(h).lower(), int(p)) for h, p in origins)
        self._inner = inner if inner is not None else httpcore.AnyIOBackend()

    def _refuse(self, reason: str, detail: str) -> FetchRefused:
        return FetchRefused(reason, None, self._policy_name, detail)

    def _vet(self, host: str, port: int, answers: typing.Iterable) -> list:
        addresses = []
        for answer in answers:
            try:
                addresses.append(ipaddress.ip_address(str(answer)))
            except ValueError:
                raise self._refuse(BLOCKED_ADDRESS, f"{host} resolved to unparseable {answer!r}") from None
        if not addresses:
            raise self._refuse(NO_ADDRESS, f"{host} resolved to no address")
        loopback_ok = (host.lower(), port) in self._loopback
        blocked = [str(ip) for ip in addresses if not (is_public_address(ip) or (loopback_ok and _is_loopback(ip)))]
        if blocked:
            raise self._refuse(BLOCKED_ADDRESS, f"{host} resolves to {', '.join(blocked)}")
        return list(dict.fromkeys(str(ip) for ip in addresses))

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        try:
            answers = await asyncio.wait_for(self._resolver(host, port), timeout)
        except asyncio.TimeoutError as exc:
            raise httpcore.ConnectTimeout(f"resolving {host} timed out") from exc
        except (OSError, UnicodeError) as exc:  # socket.gaierror is an OSError
            raise httpcore.ConnectError(f"could not resolve {host}: {exc}") from exc
        last_error: Exception | None = None
        for address in self._vet(host, port, answers):
            try:
                return await self._inner.connect_tcp(
                    address, port, timeout=timeout, local_address=local_address, socket_options=socket_options
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_error = exc
        assert last_error is not None
        raise last_error

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise self._refuse(UNIX_SOCKET, "unix sockets are never a corpus source")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


# ---------------------------------------------------------------------------------------------
# Transport: every request that reaches the wire is checked
# ---------------------------------------------------------------------------------------------
class _GuardedTransport(httpx.AsyncHTTPTransport):
    """httpx's own transport with its connection pool replaced by one on ``_GuardedBackend``, and
    a URL check on every request (R2.2). Construction fails closed if httpx's layout changes."""

    def __init__(self, policy: FetchPolicy, *, ssl_context: ssl.SSLContext, backend: _GuardedBackend):
        super().__init__(verify=ssl_context, trust_env=False, http1=True, http2=False, limits=LIMITS, retries=0)
        if not isinstance(getattr(self, "_pool", None), httpcore.AsyncConnectionPool):
            raise RuntimeError("F25: httpx transport layout changed; refusing to build an unguarded client")
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=ssl_context,
            max_connections=LIMITS.max_connections,
            max_keepalive_connections=LIMITS.max_keepalive_connections,
            keepalive_expiry=LIMITS.keepalive_expiry,
            http1=True,
            http2=False,
            retries=0,
            network_backend=backend,
        )
        self._policy = policy

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self._policy.check_url(request.url)
        return await super().handle_async_request(request)


# ---------------------------------------------------------------------------------------------
# The fetcher connectors use
# ---------------------------------------------------------------------------------------------
class FetchedResponse:
    """A fully read, size-bounded response. ``url`` is the final URL (after any redirects).

    The body is held once, as ``content`` (R19). ``text`` decodes it on each access and keeps no
    copy, so a PDF fetch never pays for a text copy of its bytes."""

    __slots__ = ("url", "status_code", "headers", "content", "encoding")

    def __init__(self, url: str, status_code: int, headers: httpx.Headers, content: bytes, encoding: str = "utf-8"):
        self.url = url
        self.status_code = status_code
        self.headers = headers
        self.content = content
        self.encoding = encoding

    @property
    def text(self) -> str:
        try:
            return self.content.decode(self.encoding, errors="replace")
        except LookupError:
            return self.content.decode("utf-8", errors="replace")

    def __repr__(self) -> str:
        return f"FetchedResponse(url={self.url!r}, status_code={self.status_code}, bytes={len(self.content)})"


def _content_coding(headers: httpx.Headers) -> tuple[str | None, str]:
    """(coding, detail): coding is "identity", "gzip" or "deflate", or None (refused) with why."""
    codings = [c.strip().lower() for c in headers.get_list("Content-Encoding", split_commas=True)]
    codings = [c for c in codings if c and c != "identity"]
    if not codings:
        return "identity", ""
    if len(codings) > 1:
        return None, f"stacked content codings {', '.join(codings)}"
    if codings[0] in ("gzip", "x-gzip"):
        return "gzip", ""
    if codings[0] == "deflate":
        return "deflate", ""
    return None, f"unsupported content coding {codings[0][:40]!r}"


_ZLIB_HEADER_BYTES = 2


def _is_zlib_header(head: bytes) -> bool:
    """The RFC 1950 header test zlib's inflate applies to the first two bytes: compression method
    8 (deflate), window bits <= 15 (CINFO <= 7), and (CMF * 256 + FLG) % 31 == 0."""
    cmf, flg = head[0], head[1]
    return (cmf & 0x0F) == 8 and (cmf >> 4) <= 7 and ((cmf << 8) | flg) % 31 == 0


class _BoundedDecoder:
    """Turns raw body chunks into the body, never holding more than ``limit`` decoded bytes (R17).

    identity: chunks are kept as they come. gzip / deflate: ``zlib.decompressobj`` inflates each
    chunk in steps of at most ``_DECODE_STEP`` bytes (``decompress(data, max_length)`` plus
    ``unconsumed_tail``), so a 1 KB bomb can never expand past the cap in one call. Data after the
    end of the compressed stream, and a stream that never ends, are refused.

    deflate is the zlib format; a raw deflate stream (no zlib header) is accepted too, as httpx
    does. Which one it is gets decided on the first two bytes, with zlib's own header test, before
    anything is inflated: until two bytes have arrived, the (at most one byte) prefix is held and
    then replayed into the chosen decoder. So the decision never depends on how the server split
    its chunks (Codex P2 on #67: a one-byte first chunk used to lock in the zlib decoder)."""

    def __init__(self, coding: str, limit: int, refuse: typing.Callable[[str, str], FetchRefused]):
        self._coding = coding
        self._limit = limit
        self._refuse = refuse
        self._out = io.BytesIO()
        self.size = 0
        self._identity = coding == "identity"
        self._prefix = b"" if coding == "deflate" else None  # deflate only: format not yet decided
        self._z = zlib.decompressobj(16 + zlib.MAX_WBITS) if coding == "gzip" else None

    def _emit(self, data: bytes) -> None:
        if self.size + len(data) > self._limit:
            raise self._refuse(TOO_LARGE, f"decoded body over {self._limit} bytes")
        self.size += len(data)
        self._out.write(data)

    def feed(self, chunk: bytes) -> None:
        if not chunk:
            return
        if self._identity:
            self._emit(chunk)
            return
        if self._prefix is not None:
            data = self._prefix + chunk
            if len(data) < _ZLIB_HEADER_BYTES:
                self._prefix = data  # never more than one byte
                return
            self._prefix = None
            self._z = zlib.decompressobj(zlib.MAX_WBITS if _is_zlib_header(data) else -zlib.MAX_WBITS)
            self._inflate(data)
            return
        if self._z.eof:
            raise self._refuse(CONTENT_ENCODING, f"data after the end of the {self._coding} stream")
        self._inflate(chunk)

    def _inflate(self, data: bytes) -> None:
        while True:
            try:
                piece = self._z.decompress(data, _DECODE_STEP)
            except zlib.error as exc:
                raise self._refuse(CONTENT_ENCODING, f"corrupt {self._coding} stream: {exc}") from None
            if piece:
                self._emit(piece)
            if self._z.eof:
                if self._z.unused_data or self._z.unconsumed_tail:
                    raise self._refuse(CONTENT_ENCODING, f"data after the end of the {self._coding} stream")
                return
            data = self._z.unconsumed_tail
            if not data and len(piece) < _DECODE_STEP:
                return

    def finish(self) -> bytes:
        if not self._identity:
            if self._prefix is not None:  # a deflate body shorter than any deflate stream
                raise self._refuse(CONTENT_ENCODING, f"truncated {self._coding} stream")
            if not self._z.eof:
                self._inflate(b"")  # pending output, still in bounded steps
            if not self._z.eof:
                raise self._refuse(CONTENT_ENCODING, f"truncated {self._coding} stream")
        return self._out.getvalue()  # no copy: the buffer is handed over


def _hooks_permitted() -> bool:
    """Test hooks need ENVIRONMENT explicitly ``development`` (and APP_ENV not production or
    staging). Unset means production, as in ``Settings``. The variable can refuse a hook; nothing
    enables one except passing it to the constructor."""
    environment = os.environ.get("ENVIRONMENT", "production").strip().lower()
    app_env = os.environ.get("APP_ENV", "").strip().lower()
    return environment == "development" and app_env not in {"production", "staging"}


def _verified_ssl_context() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=certifi.where())


def _with_accept_encoding(headers: typing.Mapping[str, str] | None) -> httpx.Headers:
    """``headers`` with Accept-Encoding forced to ``ACCEPT_ENCODING``: no caller re-opens br/zstd."""
    merged = httpx.Headers(headers or {})
    if "accept-encoding" in merged:
        del merged["accept-encoding"]
    merged["Accept-Encoding"] = ACCEPT_ENCODING
    return merged


async def _hold_location(response: httpx.Response) -> None:
    """Response hook: move a redirect's ``Location`` out of the headers before httpx sees it.

    httpx builds a ``next_request`` for every redirect response even with follow_redirects off, and
    a malformed Location (``https:127.0.0.1:1/x``) makes that raise ``httpx.InvalidURL`` inside
    ``send`` (re-audit LOW 3). With the header held back httpx never interprets it; the boundary
    resolves and checks it itself, and restores it on a 3xx it returns."""
    if response.status_code in _REDIRECT_CODES and "location" in response.headers:
        response.extensions[_HELD_LOCATION] = response.headers.get_list("location")
        del response.headers["location"]


_SCHEME_WITHOUT_AUTHORITY = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*:(?!//)")


class PolicyFetcher:
    """An async HTTP client bound to one ``FetchPolicy``. Use as ``async with``."""

    def __init__(
        self,
        policy: FetchPolicy,
        *,
        headers: typing.Mapping[str, str] | None = None,
        max_bytes: int = MAX_BYTES,
        deadline: float = DEADLINE_SECONDS,
        max_redirects: int = MAX_REDIRECTS,
        _test_ssl_context: ssl.SSLContext | None = None,
        _test_loopback_origins: typing.AbstractSet | None = None,
        _test_resolver: Resolver | None = None,
    ):
        hooks = [
            name
            for name, value in (
                ("_test_ssl_context", _test_ssl_context),
                ("_test_loopback_origins", _test_loopback_origins),
                ("_test_resolver", _test_resolver),
            )
            if value is not None
        ]
        if hooks and not _hooks_permitted():
            raise RuntimeError(f"F25: test-only fetch hooks {hooks} are refused outside ENVIRONMENT=development")
        self.policy = policy
        self.max_bytes = int(max_bytes)
        self.deadline = float(deadline)
        self.max_redirects = int(max_redirects)
        ssl_context = _test_ssl_context if _test_ssl_context is not None else _verified_ssl_context()
        backend = _GuardedBackend(policy.name, resolver=_test_resolver, loopback_origins=_test_loopback_origins)
        self._transport = _GuardedTransport(policy, ssl_context=ssl_context, backend=backend)
        self._client = httpx.AsyncClient(
            transport=self._transport,
            headers=_with_accept_encoding(headers),
            timeout=TIMEOUT,
            follow_redirects=False,
            trust_env=False,
            event_hooks={"response": [_hold_location]},
        )

    async def __aenter__(self) -> "PolicyFetcher":
        await self._client.__aenter__()
        return self

    async def __aexit__(self, *exc_info) -> None:
        await self._client.__aexit__(*exc_info)

    async def aclose(self) -> None:
        await self._client.aclose()

    def _log(self, exc: FetchRefused) -> None:
        what = exc.reason if not exc.detail else f"{exc.reason}: {exc.detail}"
        logger.warning(
            "F25 fetch boundary refused %s (%s) under policy %s", exc.url or "<unknown url>", what, exc.policy or self.policy.name
        )

    def _admit(self, url: typing.Any) -> httpx.URL:
        """The URL to request for a link: ``check_url``, after the policy's http->https upgrade
        (R22) when the link is plain http. A link that fails either way is refused as written."""
        try:
            return self.policy.check_url(url)
        except FetchRefused as exc:
            upgraded = self.policy.https_upgrade(url) if exc.reason == SCHEME else None
            if upgraded is None:
                raise
            try:
                return self.policy.check_url(upgraded)
            except FetchRefused:
                raise exc from None

    def allows(self, url: typing.Any) -> bool:
        """Whether ``url`` would be requested. A refusal is logged; nothing is requested."""
        try:
            self._admit(url)
        except FetchRefused as exc:
            self._log(exc)
            return False
        return True

    async def get(self, url: typing.Any, *, headers: typing.Mapping[str, str] | None = None) -> FetchedResponse:
        return await self._bounded(url, self._get(url, headers))

    async def post(
        self, url: typing.Any, *, json: typing.Any = None, headers: typing.Mapping[str, str] | None = None
    ) -> FetchedResponse:
        """A POST is never redirected (R7): a 3xx is returned to the caller as is."""
        return await self._bounded(url, self._post(url, json, headers))

    async def _bounded(self, url: typing.Any, work: typing.Awaitable[FetchedResponse]) -> FetchedResponse:
        timer = asyncio.timeout(self.deadline)
        try:
            async with timer:
                return await work
        except FetchRefused as exc:
            if exc.url is None:
                exc.url = redact_url(url)
            self._log(exc)
            raise
        except (httpx.InvalidURL, httpx.UnsupportedProtocol, httpx.TooManyRedirects) as error:
            # httpx's own URL handling inside the boundary: a refusal, never retried (R18).
            exc = FetchRefused(UNPARSEABLE, url, self.policy.name, f"{type(error).__name__}: {error}")
            self._log(exc)
            raise exc from None
        except TimeoutError:
            if not timer.expired():
                raise
            exc = FetchRefused(DEADLINE, url, self.policy.name, f"over {self.deadline:g}s")
            self._log(exc)
            raise exc from None

    async def _send(self, method: str, url: httpx.URL, **kwargs) -> httpx.Response:
        kwargs["headers"] = _with_accept_encoding(kwargs.get("headers"))
        request = self._client.build_request(method, url, **kwargs)
        try:
            return await self._client.send(request, stream=True)
        except FetchRefused as exc:
            if exc.url is None:  # refused by the backend, which only knows the host
                exc.url = redact_url(url)
            raise

    def _redirect_target(self, current: httpx.URL, locations: list) -> httpx.URL:
        """The next hop, from the held ``Location`` values, refusing anything parsers disagree on."""
        if len(locations) != 1:
            raise FetchRefused(AMBIGUOUS, current, self.policy.name, f"{len(locations)} Location headers")
        location = locations[0]
        if (
            location != location.strip()
            or "\\" in location
            or not location.isprintable()
            or _SCHEME_WITHOUT_AUTHORITY.match(location)
        ):
            # e.g. "https:127.0.0.1:1/x" (httpx joins it onto this origin, its own redirect builder
            # reads a host) or "/\\host/x" (a browser reads "\\" as "/"): refused, not interpreted.
            raise FetchRefused(AMBIGUOUS, location, self.policy.name, f"redirect from {current}")
        try:
            return current.join(location)
        except Exception as exc:  # httpx.InvalidURL
            raise FetchRefused(UNPARSEABLE, location, self.policy.name, f"redirect from {current}: {exc}") from None

    async def _get(self, url: typing.Any, headers) -> FetchedResponse:
        current = self._admit(url)
        hops = 0
        while True:
            response = await self._send("GET", current, headers=headers)
            locations = response.extensions.get(_HELD_LOCATION)
            if locations is None:
                return await self._finish(response)
            await response.aclose()
            target = self._redirect_target(current, locations)
            if hops >= self.max_redirects:
                raise FetchRefused(TOO_MANY_REDIRECTS, target, self.policy.name, f"more than {self.max_redirects} redirects")
            current = self.policy.check_url(str(target), previous=current)
            hops += 1

    async def _post(self, url: typing.Any, json: typing.Any, headers) -> FetchedResponse:
        target = self._admit(url)
        return await self._finish(await self._send("POST", target, json=json, headers=headers))

    async def _finish(self, response: httpx.Response) -> FetchedResponse:
        try:
            content = await self._read_body(response)
        finally:
            await response.aclose()
        final = self.policy.check_url(str(response.url))  # the final origin, once more
        headers = response.headers
        held = response.extensions.get(_HELD_LOCATION)
        if held:  # a 3xx returned as is (a POST): give the caller the header the server sent
            headers["Location"] = ", ".join(held)
        return FetchedResponse(
            url=str(final),
            status_code=response.status_code,
            headers=headers,
            content=content,
            encoding=response.charset_encoding or "utf-8",
        )

    async def _read_body(self, response: httpx.Response) -> bytes:
        """The body, decoded by ``_BoundedDecoder``, reading raw bytes (httpx decodes nothing).
        Refused: an unsupported or stacked coding, a declared or actual size over ``max_bytes`` on
        the wire, or a decoded size over ``max_bytes``."""

        def refuse(reason: str, detail: str) -> FetchRefused:
            return FetchRefused(reason, response.url, self.policy.name, detail)

        coding, why = _content_coding(response.headers)
        if coding is None:
            raise refuse(CONTENT_ENCODING, why)
        declared = response.headers.get("Content-Length", "")
        if declared.isdigit() and int(declared) > self.max_bytes:
            raise refuse(TOO_LARGE, f"Content-Length {declared} > {self.max_bytes}")
        decoder = _BoundedDecoder(coding, self.max_bytes, refuse)
        received = 0
        async for chunk in response.aiter_raw():
            received += len(chunk)
            if received > self.max_bytes:
                raise refuse(TOO_LARGE, f"body over {self.max_bytes} bytes on the wire")
            decoder.feed(chunk)
        return decoder.finish()


class SyncPolicyFetcher:
    """The same ``PolicyFetcher`` (one enforcement implementation) run on a private event loop,
    for synchronous callers such as bootstrap_harvest.py. Use as ``with``."""

    def __init__(self, fetcher: PolicyFetcher):
        self._fetcher = fetcher
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def policy(self) -> FetchPolicy:
        return self._fetcher.policy

    def _run(self, work):
        if self._loop is None:
            self._loop = asyncio.new_event_loop()
        return self._loop.run_until_complete(work)

    def __enter__(self) -> "SyncPolicyFetcher":
        self._run(self._fetcher.__aenter__())
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def close(self) -> None:
        if self._loop is None:
            return
        try:
            self._loop.run_until_complete(self._fetcher.aclose())
        finally:
            self._loop.close()
            self._loop = None

    def allows(self, url: typing.Any) -> bool:
        return self._fetcher.allows(url)

    def get(self, url: typing.Any, *, headers: typing.Mapping[str, str] | None = None) -> FetchedResponse:
        return self._run(self._fetcher.get(url, headers=headers))

    def post(self, url: typing.Any, *, json: typing.Any = None, headers: typing.Mapping[str, str] | None = None) -> FetchedResponse:
        return self._run(self._fetcher.post(url, json=json, headers=headers))


# ---------------------------------------------------------------------------------------------
# The source registry (R4): one policy per connector, hostnames on 443 only
# ---------------------------------------------------------------------------------------------
def _policy(name: str, hosts: typing.Iterable[str], suffixes: typing.Iterable[str] = ()) -> FetchPolicy:
    # upgrade_http (R22): an http link to one of these hosts on the default port is fetched as https.
    return FetchPolicy(name=name, hosts=frozenset(hosts), host_suffixes=tuple(suffixes), upgrade_http=True)


# Read-only (R21): no module can add or widen a policy at run time.
SOURCE_POLICIES: typing.Mapping[str, FetchPolicy] = types.MappingProxyType({
    p.name: p
    for p in (
        _policy("NasirLawSite", {"www.nasirlawsite.com", "nasirlawsite.com"}),
        _policy("NationalAssembly", {"na.gov.pk", "www.na.gov.pk"}),
        _policy("PakistanCode", {"pakistancode.gov.pk", "www.pakistancode.gov.pk"}),
        # Court scopes are each connector's existing scope; suffix checks are now dot-anchored.
        _policy(
            "SindhHighCourt",
            {"sindhhighcourt.gov.pk", "shc.gov.pk"},
            {".sindhhighcourt.gov.pk", ".shc.gov.pk"},
        ),
        _policy("SupremeCourt", {"supremecourt.gov.pk"}, {".supremecourt.gov.pk"}),
        _policy("LahoreHighCourt", {"lhc.gov.pk"}, {".lhc.gov.pk"}),
        _policy("PeshawarHighCourt", {"peshawarhighcourt.gov.pk", "www.peshawarhighcourt.gov.pk"}),
        _policy("BalochistanHighCourt", {"bhc.gov.pk", "www.bhc.gov.pk", "portal.bhc.gov.pk"}),
        _policy("IslamabadHighCourt", {"ihc.gov.pk", "www.ihc.gov.pk", "mis.ihc.gov.pk", "www.mis.ihc.gov.pk"}),
    )
})


def policy_for(name: str) -> FetchPolicy:
    """The registered policy, or ``KeyError``."""
    return SOURCE_POLICIES[name]


def fetcher_for(name: str, *, headers: typing.Mapping[str, str] | None = None) -> PolicyFetcher:
    """The production factory. Connectors call it as ``fetch_policy.fetcher_for(...)`` (looked up
    at call time, so tests can substitute it). It accepts no test hook."""
    return PolicyFetcher(policy_for(name), headers=headers)


def sync_fetcher_for(name: str, *, headers: typing.Mapping[str, str] | None = None) -> SyncPolicyFetcher:
    """The production factory for synchronous callers. It accepts no test hook."""
    return SyncPolicyFetcher(PolicyFetcher(policy_for(name), headers=headers))


# ---------------------------------------------------------------------------------------------
# FA-D3C-002: the P1 gateway (not a source)
# ---------------------------------------------------------------------------------------------
# The corpus's paid embeddings go to P1's `p1CorpusEmbedding` Cloud Function (scraper/p1_client.py). Its URL is the
# deployment's P1_EMBEDDING_URL, so the policy is built from it, but only a Google serverless host on 443 is admitted
# (reviewed here, R4): never a provider API, never an address inside the network. Everything else about the request is
# the boundary's: https only, the host's addresses vetted at connect, no redirect (a POST is never redirected), a
# bounded body and deadline.
P1_POLICY_NAME = "P1Gateway"
P1_HOST_SUFFIXES = (".run.app", ".cloudfunctions.net")
# An answer is about 30 KB (1,536 numbers); a megabyte is far beyond any honest one.
P1_MAX_BYTES = 1024 * 1024
# Longer than the function's own timeout (90 s), so P1's answer arrives before the corpus gives up on it.
P1_DEADLINE_SECONDS = 100.0


def p1_policy(url: typing.Any) -> FetchPolicy:
    """The policy for the P1 endpoint ``url``, or ``FetchRefused``: an https URL on port 443 whose host ends in one of
    P1_HOST_SUFFIXES (a label before it), with no userinfo, query or fragment, and every other check of ``check_url``."""
    raw = str(url)
    try:
        parts = urlsplit(raw)
        host, port = (parts.hostname or "").lower(), parts.port
    except ValueError as error:
        raise FetchRefused(UNPARSEABLE, url, P1_POLICY_NAME, str(error)) from None
    if parts.query or parts.fragment:
        raise FetchRefused(AMBIGUOUS, url, P1_POLICY_NAME, "a query or fragment in the P1 URL")
    if port not in (None, DEFAULT_PORT):
        raise FetchRefused(PORT_NOT_ALLOWED, url, P1_POLICY_NAME, f"port {port}")
    if not any(host.endswith(suffix) and len(host) > len(suffix) for suffix in P1_HOST_SUFFIXES):
        raise FetchRefused(HOST_NOT_ALLOWED, url, P1_POLICY_NAME, "not a Google serverless host")
    policy = FetchPolicy(name=P1_POLICY_NAME, hosts=frozenset({host}), ports=frozenset({DEFAULT_PORT}), upgrade_http=False)
    policy.check_url(raw)
    return policy


def p1_fetcher(url: typing.Any) -> PolicyFetcher:
    """The production factory for the P1 endpoint (FA-D3C-002). Looked up at call time, so tests can substitute it; it
    accepts no test hook."""
    return PolicyFetcher(p1_policy(url), max_bytes=P1_MAX_BYTES, deadline=P1_DEADLINE_SECONDS)
