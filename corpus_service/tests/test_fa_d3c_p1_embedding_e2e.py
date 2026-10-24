"""FA-D3C-002 end to end: corpus embeddings go through the P1 gateway, never to a provider directly (spec
docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-boundary-design.md, R17).

Run by tests/e2e/p1_embedding_e2e.sh, which starts the Firestore and Functions emulators with the real
``p1CorpusEmbedding`` (functions/test/harness/fa-d3c-p1-emulator-entry.ts: the real handler, OIDC check,
``callP1Embedding`` and P1 ledger code; a deterministic fake transport and a test key set). Everything else is real:
the ``process-embeddings`` beat entry's task in process, a fresh migrated Postgres 16 + pgvector database per test, the
F25 fetch boundary (its TLS and test hooks, as F25's own e2e uses them), a local TLS front for the emulator (the
boundary speaks https only), and the P1 ledger documents in the Firestore emulator.

The deployment has a provider key and a network tripwire, exactly as the finding describes: ``OPENAI_API_KEY`` is a
fake label and ``OPENAI_BASE_URL`` points at a local recording server. On main the batch builds the OpenAI SDK from
that key and posts every row straight to the tripwire, and nothing in the P1 ledger, budget or kill switch sees it, so
every test here fails (RED). On the branch the tripwire sees nothing: each request goes through P1, the kill switch
stops it, the budget refuses it once exhausted, every decision is in the ledger, and F27's lease and dead-letter
semantics hold.

Skipped unless FA_D3C_P1_E2E=1 (set by the script); then a missing setting fails the run instead of skipping it.
Synthetic fixtures only; the key is a placeholder and the identity a throwaway key pair.
"""

from __future__ import annotations

import base64
import contextlib
import http.client
import json
import math
import os
import ssl
import threading
import time
import unicodedata
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from f25_servers import client_tls_context, make_test_pki, server_tls_context
from test_f20_trust_policy_db import fetch, run
from test_f27_embedding_claims_e2e import marker_of, migrated, queue_by_row, receipts, seed_statutes
from test_f28_source_outcomes_e2e import fire, jobs, no_sleep

E2E = os.environ.get("FA_D3C_P1_E2E") == "1"
pytestmark = pytest.mark.skipif(not E2E, reason="runs under tests/e2e/p1_embedding_e2e.sh (FA_D3C_P1_E2E=1)")

GATEWAY_MODEL = "openai/text-embedding-3-small"
DIMENSIONS = 1536
FAIL_MARKER = "FA-D3C-PROVIDER-FAIL"  # the harness's fake transport fails these as a billable timeout
FAKE_KEY = "fa-d3c-placeholder-not-a-key"
CNIC = "35202-1234567-1"


def env(name):
    value = os.environ.get(name, "")
    assert value, f"{name} is required in the FA-D3C-002 e2e (set by tests/e2e/p1_embedding_e2e.sh)"
    return value


# ---------------------------------------------------------------------------------------------
# The Firestore emulator (REST, as the owner: rules do not apply)
# ---------------------------------------------------------------------------------------------
def _encode(value):
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [_encode(v) for v in value]}}
    if isinstance(value, dict):
        return {"mapValue": {"fields": {k: _encode(v) for k, v in value.items()}}}
    raise TypeError(type(value))


def _decode(value):
    kind, inner = next(iter(value.items()))
    if kind == "integerValue":
        return int(inner)
    if kind == "arrayValue":
        return [_decode(v) for v in inner.get("values", [])]
    if kind == "mapValue":
        return {k: _decode(v) for k, v in inner.get("fields", {}).items()}
    if kind == "nullValue":
        return None
    return inner


class Firestore:
    def __init__(self):
        self.host = env("FIRESTORE_EMULATOR_HOST")
        self.project = env("FA_D3C_PROJECT")
        self.base = f"http://{self.host}/v1/projects/{self.project}/databases/(default)/documents"

    def _call(self, method, url, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Authorization": "Bearer owner", "Content-Type": "application/json"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=30) as res:
                raw = res.read()
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            raise
        return json.loads(raw) if raw else {}

    def set(self, path, fields):
        self._call("PATCH", f"{self.base}/{path}", {"fields": {k: _encode(v) for k, v in fields.items()}})

    def get(self, path):
        doc = self._call("GET", f"{self.base}/{path}")
        return None if doc is None else {k: _decode(v) for k, v in doc.get("fields", {}).items()}

    def where(self, collection, field, value):
        body = {"structuredQuery": {"from": [{"collectionId": collection}], "where": {"fieldFilter": {
            "field": {"fieldPath": field}, "op": "EQUAL", "value": _encode(value)}}}}
        rows = self._call("POST", f"{self.base}:runQuery", body) or []
        return [{k: _decode(v) for k, v in r["document"].get("fields", {}).items()} for r in rows if "document" in r]

    def all(self, collection):
        doc = self._call("GET", f"{self.base}/{collection}?pageSize=300") or {}
        return [{k: _decode(v) for k, v in d.get("fields", {}).items()} for d in doc.get("documents", [])]

    def clear(self):
        self._call("DELETE", f"http://{self.host}/emulator/v1/projects/{self.project}/databases/(default)/documents")


# ---------------------------------------------------------------------------------------------
# The caller's identity: a Google-shaped OIDC ID token signed with the test key the function trusts
# ---------------------------------------------------------------------------------------------
def id_token(**over):
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    key = serialization.load_pem_private_key((Path(env("FA_D3C_KEY_DIR")) / "key.pem").read_bytes(), password=None)
    now = int(time.time())
    payload = {"iss": "https://accounts.google.com", "aud": env("FA_D3C_AUDIENCE"), "sub": "100200300400500600700",
               "email": env("FA_D3C_CALLER"), "email_verified": True, "iat": now - 5, "exp": now + 3000, **over}
    b64 = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    signing_input = f"{b64(json.dumps({'alg': 'RS256', 'kid': 'fa-d3c-e2e-key', 'typ': 'JWT'}).encode())}." \
                    f"{b64(json.dumps(payload).encode())}"
    signature = key.sign(signing_input.encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{signing_input}.{b64(signature)}"


# ---------------------------------------------------------------------------------------------
# Local servers: the TLS front for the emulator, and the provider tripwire
# ---------------------------------------------------------------------------------------------
class _Front(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        target = self.server.target
        conn = http.client.HTTPConnection(target.hostname, target.port, timeout=120)
        try:
            headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "content-length", "connection"}}
            conn.request("POST", target.path, body=body, headers=headers)
            res = conn.getresponse()
            payload = res.read()
            self.server.forwarded.append(res.status)
            self.send_response(res.status)
            self.send_header("Content-Type", res.getheader("Content-Type") or "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        finally:
            conn.close()


class _Tripwire(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.server.seen.append({"path": self.path, "authorization": self.headers.get("Authorization"), "body": body})
        text = json.loads(body or b"{}").get("input", "")
        payload = json.dumps({"object": "list", "data": [{"object": "embedding", "index": 0, "embedding": vector_for(str(text))}],
                              "model": "text-embedding-3-small", "usage": {"prompt_tokens": 7, "total_tokens": 7}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


@contextlib.contextmanager
def serving(server):
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture(scope="module")
def pki(tmp_path_factory):
    return make_test_pki(tmp_path_factory.mktemp("fa-d3c-pki"))


@pytest.fixture(scope="module")
def front(pki):
    from urllib.parse import urlsplit

    server = ThreadingHTTPServer(("127.0.0.1", int(env("FA_D3C_FRONT_PORT"))), _Front)
    server.daemon_threads = True
    server.target = urlsplit(env("FA_D3C_FUNCTION_URL"))
    server.forwarded = []
    server.socket = server_tls_context(pki).wrap_socket(server.socket, server_side=True)
    with serving(server):
        yield server


@pytest.fixture()
def tripwire():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Tripwire)
    server.daemon_threads = True
    server.seen = []
    with serving(server):
        yield server


@pytest.fixture()
def firestore():
    store = Firestore()
    store.clear()
    yield store
    store.clear()


@pytest.fixture()
def deployment(corpus_db, monkeypatch, tmp_path, pki, front, tripwire, firestore):
    """The corpus deployment under test: a provider key and the tripwire as the provider's base URL (what main reads),
    and the P1 URL with the caller's ID token (what the branch reads). The P1 policy admits the local TLS front with the
    F25 test hooks, as F25's own e2e admits its local source; the production policy is tests/test_fa_d3c_p1_client.py's."""
    from scraper import config
    from scraper.net import fetch_policy

    migrated(corpus_db)
    no_sleep(monkeypatch)
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", FAKE_KEY)
    monkeypatch.setenv("OPENAI_BASE_URL", f"http://127.0.0.1:{tripwire.server_address[1]}/v1")
    if hasattr(config.settings, "OPENAI_API_KEY"):  # main's setting; the branch has none
        monkeypatch.setattr(config.settings, "OPENAI_API_KEY", FAKE_KEY)

    url = env("FA_D3C_AUDIENCE")
    token_file = tmp_path / "p1_id_token"
    token_file.write_text(id_token() + "\n")
    if hasattr(config.settings, "P1_EMBEDDING_URL"):  # the branch's settings; main has none
        monkeypatch.setattr(config.settings, "P1_EMBEDDING_URL", url)
        monkeypatch.setattr(config.settings, "P1_ID_TOKEN_FILE", str(token_file))
    port = int(env("FA_D3C_FRONT_PORT"))
    tls = client_tls_context(pki)

    def policy(u):
        return fetch_policy.FetchPolicy(name="P1Gateway", hosts=frozenset({"localhost"}), ports=frozenset({port}),
                                        upgrade_http=False)

    def fetcher(u):
        return fetch_policy.PolicyFetcher(policy(u), max_bytes=1024 * 1024, deadline=100.0, _test_ssl_context=tls,
                                          _test_loopback_origins={("localhost", port)})

    monkeypatch.setattr(fetch_policy, "p1_policy", policy, raising=False)
    monkeypatch.setattr(fetch_policy, "p1_fetcher", fetcher, raising=False)
    firestore.set(f"ai_config/{env('FA_D3C_FIRM_ID')}", {"monthlyBudgetMicroUsd": 1_000_000})
    return types_namespace(url=url, token_file=token_file, tripwire=tripwire, front=front, store=firestore)


def types_namespace(**kw):
    import types

    return types.SimpleNamespace(**kw)


# ---------------------------------------------------------------------------------------------
# Expected values, written out from the spec
# ---------------------------------------------------------------------------------------------
def vector_for(text):
    """The harness's fake transport: (sum of code units mod 997 + 1) / 1000, then 0.001 (ASCII fixtures)."""
    return [((sum(map(ord, text)) % 997) + 1) / 1000] + [0.001] * (DIMENSIONS - 1)


def worst_case_micro_usd(text):
    """R12: ceil((bodyTokenCeiling(text) + 16) x 20 / 1000), bodyTokenCeiling the largest UTF-8 length of the text and
    its four normal forms."""
    ceiling = max(len(t.encode("utf-8")) for t in [text] + [unicodedata.normalize(f, text) for f in ("NFC", "NFD", "NFKC", "NFKD")])
    return math.ceil((ceiling + 16) * 20 / 1000)


def statute_text(n):
    """What the batch sends for a seeded section (the F27 fixture's formula)."""
    return f"Synthetic F27 Act 2099 s{n} Section text F27-ROW-{n:03d}. Synthetic F27 fixture, not a real statute."


def put_text(n, text):
    from test_f20_trust_policy_db import execute

    run(execute("UPDATE statutes_master SET section_text = :t WHERE section_number = :s", params={"t": text, "s": f"s{n}"}))


def summary(result):
    return result.result if isinstance(result.result, dict) else {}


def ledger(store):
    return sorted(store.where("ai_usage_logs", "firmId", env("FA_D3C_FIRM_ID")), key=lambda r: r.get("corpusOperationId") or "")


def transport_calls(store):
    return store.all("fa_d3c_test_transport_calls")


def month(store):
    rows = store.where("ai_usage_months", "firmId", env("FA_D3C_FIRM_ID"))
    return rows[0] if rows else {}


# ---------------------------------------------------------------------------------------------
# The tests
# ---------------------------------------------------------------------------------------------
def test_embeddings_go_through_p1_and_every_call_is_in_its_ledger(deployment):
    seed_statutes(1, 3)
    masked_row_2 = f"Synthetic F27 Act 2099 s2 Section text F27-ROW-002. Registrar CNIC [CNIC]. Synthetic F27 fixture."
    put_text(2, f"Section text F27-ROW-002. Registrar CNIC {CNIC}. Synthetic F27 fixture.")

    result = fire("process-embeddings")

    assert deployment.tripwire.seen == [], (
        f"FA-D3C-002: the corpus called the provider directly ({len(deployment.tripwire.seen)} request(s) to the "
        "tripwire with the corpus's own key); it must go through P1")
    assert result.state == "SUCCESS", repr(result.result)
    rows = ledger(deployment.store)
    assert len(rows) == 3, f"P1's ledger must hold one usage row per embedding, got {len(rows)}"
    assert {(r["taskType"], r["outcome"], r["model"], r["caller"], r["actorId"], r["classification"], r["outputTokens"])
            for r in rows} == {("embedding", "ok", GATEWAY_MODEL, env("FA_D3C_CALLER"), "system", "public", 0)}
    ops = {r for (r,) in run(fetch("SELECT operation_id FROM embedding_queue"))}
    assert {r["corpusOperationId"] for r in rows} == ops, "each P1 charge names the corpus operation it paid for"
    assert month(deployment.store).get("spentMicroUsd") == 3 and month(deployment.store).get("calls", {}).get("ok") == 3
    sent = sorted(c["input"] for c in transport_calls(deployment.store))
    assert len(sent) == 3 and masked_row_2 in sent and not any(CNIC in s for s in sent), (
        f"only the masked text reaches the provider: {sent}")
    assert set(queue_by_row().values()) == {("completed", 0, None, True)}
    stored = run(fetch("SELECT embedding::text FROM statutes_master WHERE section_number = 's2'"))[0][0]
    stored = json.loads(stored)  # pgvector's text form, "[a,b,...]"
    assert len(stored) == DIMENSIONS
    assert [round(float(x), 6) for x in stored[:2]] == [round(x, 6) for x in vector_for(masked_row_2)[:2]], (
        "the stored vector is the one P1 returned for the masked text")


def test_the_kill_switch_stops_it_and_charges_no_row(deployment):
    seed_statutes(1, 3)
    deployment.store.set("platform/p1", {"killSwitch": {"disableAll": True, "disabledModels": [], "reason": "e2e drill",
                                                         "setBy": "platform", "setAt": 0}})
    result = fire("process-embeddings")

    assert deployment.tripwire.seen == [], "the corpus called the provider directly, past the kill switch"
    assert transport_calls(deployment.store) == [], "nothing may reach the provider while the switch is set"
    rows = ledger(deployment.store)
    assert [(r["outcome"], r["blockReason"], r["costMicroUsd"]) for r in rows] == [("blocked", "kill_switch_platform", 0)]
    s = summary(result)
    assert (result.state, s.get("outcome"), s.get("reason")) == ("SUCCESS", "skipped", "p1_refused:kill_switch_platform"), s
    assert queue_by_row() == {n: ("pending", 0, None, False) for n in (1, 2, 3)}, "R14: a refusal charges no row"
    assert receipts("error_type IS NOT NULL") == [("failed", None, False, False, "p1_refused")]

    # The firm's own switch on the embedding model alone stops it too.
    deployment.store.set("platform/p1", {"killSwitch": {"disableAll": False, "disabledModels": [], "reason": "off",
                                                         "setBy": "platform", "setAt": 0}})
    deployment.store.set(f"ai_config/{env('FA_D3C_FIRM_ID')}", {
        "monthlyBudgetMicroUsd": 1_000_000,
        "killSwitch": {"disableAll": False, "disabledModels": [GATEWAY_MODEL], "reason": "pause corpus", "setBy": "u", "setAt": 0}})
    assert summary(fire("process-embeddings")).get("reason") == "p1_refused:kill_switch_firm"
    assert transport_calls(deployment.store) == []

    # Lifted: the next batch embeds the rows the switch held back, each with one provider call.
    deployment.store.set(f"ai_config/{env('FA_D3C_FIRM_ID')}", {"monthlyBudgetMicroUsd": 1_000_000})
    again = summary(fire("process-embeddings"))
    assert (again.get("completed"), len(transport_calls(deployment.store))) == (3, 3), again
    assert set(queue_by_row().values()) == {("completed", 0, None, True)}


def test_the_budget_refuses_it_once_exhausted(deployment):
    seed_statutes(1, 5)
    # Each call holds its worst case and is charged 1 micro-USD (7 tokens x 20 nano-USD, rounded up). With a budget of
    # 2 x 1 + worst case, the third call still fits (spent 2 + hold <= budget) and the fourth does not.
    worst = worst_case_micro_usd(statute_text(1))
    assert all(worst_case_micro_usd(statute_text(n)) == worst for n in range(1, 6))
    deployment.store.set(f"ai_config/{env('FA_D3C_FIRM_ID')}", {"monthlyBudgetMicroUsd": 2 + worst})

    result = fire("process-embeddings")

    assert deployment.tripwire.seen == []
    s = summary(result)
    assert (s.get("completed"), s.get("reason")) == (3, "p1_refused:budget_exhausted"), s
    outcomes = [(r["outcome"], r["blockReason"]) for r in ledger(deployment.store)]
    assert sorted(outcomes, key=str) == sorted([("ok", None)] * 3 + [("blocked", "budget_exhausted")], key=str), outcomes
    assert month(deployment.store).get("spentMicroUsd") == 3
    states = queue_by_row()
    assert [states[n] for n in (1, 2, 3)] == [("completed", 0, None, True)] * 3
    assert [states[n] for n in (4, 5)] == [("pending", 0, None, False)] * 2, "rows the budget refused are not charged"


def test_a_provider_failure_is_charged_in_p1_and_counted_by_f27_up_to_the_dead_letter(deployment):
    from test_f20_trust_policy_db import execute

    seed_statutes(1, 1)
    put_text(1, f"Section text F27-ROW-001. {FAIL_MARKER}. Synthetic F27 fixture.")
    for attempt in range(1, 6):
        run(execute("UPDATE embedding_queue SET next_attempt_at = now() - interval '1 second' WHERE next_attempt_at IS NOT NULL"))
        fire("process-embeddings")
        status, attempts, error_type, has = queue_by_row()[1]
        expected = ("pending", attempt, "P1CallFailed", False) if attempt < 5 else ("dead_letter", 5, "max_attempts", False)
        assert (status, attempts, error_type, has) == expected, (attempt, queue_by_row())
    assert deployment.tripwire.seen == []
    rows = ledger(deployment.store)
    assert [(r["outcome"], r["costMicroUsd"] > 0, r["tokensEstimated"]) for r in rows] == [("failed", True, True)] * 5, (
        "each provider failure P1 may have been billed for is charged in its ledger")
    assert month(deployment.store).get("spentMicroUsd") == sum(r["costMicroUsd"] for r in rows)
    assert len(transport_calls(deployment.store)) == 5


def test_a_caller_p1_does_not_admit_is_refused_and_nothing_is_spent(deployment):
    seed_statutes(1, 2)
    for token, reason in [
        (id_token(aud="https://elsewhere.example/p1CorpusEmbedding"), "p1_refused:unauthenticated:wrong_audience"),
        (id_token(email="intruder@fa-d3c-e2e.iam.gserviceaccount.com"), "p1_refused:forbidden:caller_not_allowed"),
        (id_token(exp=int(time.time()) - 3600, iat=int(time.time()) - 7200), "p1_refused:unauthenticated:expired"),
    ]:
        deployment.token_file.write_text(token)
        s = summary(fire("process-embeddings"))
        assert s.get("reason") == reason, s
    assert deployment.tripwire.seen == []
    assert ledger(deployment.store) == [], "a refused caller reaches no P1 decision, so nothing is reserved or logged"
    assert transport_calls(deployment.store) == []
    assert queue_by_row() == {1: ("pending", 0, None, False), 2: ("pending", 0, None, False)}
