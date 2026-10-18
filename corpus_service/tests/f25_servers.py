"""Local servers for the audit F25 fetch-boundary tests (not a test module).

* ``make_test_pki`` generates, at run time, a throwaway CA and a server certificate for
  ``localhost`` / 127.0.0.1 / ::1 under a pytest tmp directory. No key material is committed.
* ``RecordingServer`` is a threaded HTTP(S) server on 127.0.0.1 that records every TCP connection it
  accepts and every request it parses. The F25 tests use one as the corpus source and another as
  the "internal service" a hostile source page points at; the internal one must see nothing.
"""

from __future__ import annotations

import contextlib
import datetime
import ipaddress
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Dict, Iterator, Optional, Tuple, Union

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

Response = Tuple[int, Dict[str, str], bytes]
Route = Union[Response, Callable[["_Handler"], Optional[Response]]]


def make_test_pki(directory: Path) -> Dict[str, Path]:
    """A throwaway CA and a server certificate for localhost, 127.0.0.1 and ::1, valid for a day."""
    directory.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)
    start, end = now - datetime.timedelta(minutes=5), now + datetime.timedelta(days=1)

    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "F25 synthetic test CA")])
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(start)
        .not_valid_after(end)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, content_commitment=False, key_encipherment=False,
                data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )

    key = ec.generate_private_key(ec.SECP256R1())
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
        .issuer_name(ca_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(start)
        .not_valid_after(end)
        .add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.DNSName("localhost"),
                    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                    x509.IPAddress(ipaddress.ip_address("::1")),
                ]
            ),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )

    paths = {"ca": directory / "ca.pem", "cert": directory / "server.pem", "key": directory / "server.key"}
    paths["ca"].write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    paths["cert"].write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    paths["key"].write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
    )
    return paths


def server_tls_context(pki: Dict[str, Path]) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(pki["cert"]), str(pki["key"]))
    return ctx


def client_tls_context(pki: Dict[str, Path]) -> ssl.SSLContext:
    """Verifies the test server against the throwaway CA, hostname checking on."""
    return ssl.create_default_context(cafile=str(pki["ca"]))


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:  # keep pytest output clean
        pass

    def _serve(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body_in = self.rfile.read(length) if length else b""
        self.server.record_request(self.command, self.path, self.headers.get("Host"), body_in)
        route = self.server.routes.get(self.path.split("?", 1)[0])
        if callable(route):
            route = route(self)
            if route is None:  # the route wrote its own response
                return
        status, headers, body = route if route is not None else (404, {}, b"not found")
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = do_OPTIONS = _serve


class RecordingServer(ThreadingHTTPServer):
    """HTTP (or HTTPS with ``tls``) on 127.0.0.1, an ephemeral port, recording what reaches it."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, routes: Optional[Dict[str, Route]] = None, tls: Optional[ssl.SSLContext] = None):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.routes: Dict[str, Route] = dict(routes or {})
        self.tls = tls
        self.connections = 0
        self.requests = []
        self._lock = threading.Lock()

    @property
    def port(self) -> int:
        return self.server_address[1]

    def get_request(self):
        sock, addr = super().get_request()
        with self._lock:
            self.connections += 1
        if self.tls is not None:
            # The handshake runs on the handler thread's first read, not in the accept loop.
            sock = self.tls.wrap_socket(sock, server_side=True, do_handshake_on_connect=False)
        return sock, addr

    def record_request(self, method, path, host, body) -> None:
        with self._lock:
            self.requests.append({"method": method, "path": path, "host": host, "body": body})

    def handle_error(self, request, client_address) -> None:
        # TLS garbage on the plain port, or a client that hangs up: recorded as a connection, no noise.
        pass


@contextlib.contextmanager
def serving(server: RecordingServer) -> Iterator[RecordingServer]:
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
