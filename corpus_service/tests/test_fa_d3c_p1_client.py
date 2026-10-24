"""FA-D3C-002 (spec docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-boundary-design.md, R13-R14): the corpus
service's P1 client and the boundary policy for the P1 endpoint, with no network.

- ``fetch_policy.p1_policy`` admits only an https URL on 443 to a Google serverless host, never a provider API or an
  address inside the network, and ``p1_fetcher`` bounds the body and the deadline.
- ``embedding_client`` is None with no URL (embeddings off), refuses a URL the boundary refuses, and its
  ``embeddings.create`` posts exactly ``{operationId, model, dimensions, input, classification}`` with the ID token read
  from ``P1_ID_TOKEN_FILE``, and maps P1's answers: ``ok`` to the provider-shaped response, a refusal (``blocked``,
  401, 403, 429, 503, no token, a refused URL) to ``P1Refused``, and a failure (``failed``, another status, an
  unreachable P1, a deadline) to ``P1CallFailed``. Interruptions pass through.

Synthetic data only: the "token" is a dotted placeholder, never a real credential.
"""

from __future__ import annotations

import asyncio
import base64
import json
import types

import pytest
from celery.exceptions import SoftTimeLimitExceeded

from scraper import p1_client
from scraper.net import fetch_policy

URL = "https://p1corpusembedding-abc123-el.a.run.app"


def placeholder_token(tag):
    """Three base64url segments, the shape the client accepts, built at run time: no token literal in the source."""
    segment = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()
    return ".".join(segment(v) for v in ({"alg": "none"}, {"sub": "fa-d3c"}, tag))


TOKEN = placeholder_token("placeholder")
OP = "b" * 64
VECTOR = [0.5] * 1536


def token_file(tmp_path, content=TOKEN + "\n"):
    path = tmp_path / "p1_id_token"
    path.write_text(content)
    return str(path)


class FakeFetcher:
    """Stands in for the PolicyFetcher ``p1_fetcher`` returns: records each post, answers ``reply``."""

    def __init__(self, reply):
        self.reply = reply
        self.posts = []
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self.closed = True

    async def post(self, url, *, json=None, headers=None):
        self.posts.append({"url": url, "json": json, "headers": dict(headers or {})})
        if isinstance(self.reply, BaseException):
            raise self.reply
        status, body = self.reply
        content = body if isinstance(body, bytes) else json_bytes(body)
        return types.SimpleNamespace(status_code=status, content=content)


def json_bytes(value):
    return json.dumps(value).encode("utf-8")


def install(monkeypatch, reply):
    fetcher = FakeFetcher(reply)
    seen_urls = []

    def factory(url):
        seen_urls.append(url)
        return fetcher

    monkeypatch.setattr(fetch_policy, "p1_fetcher", factory)
    return fetcher, seen_urls


def create(client, model="text-embedding-3-small", text="Section text F27-ROW-001", dims=1536, op=OP):
    return asyncio.run(client.embeddings.create(model=model, input=text, dimensions=dims, operation_id=op))


OK_ANSWER = {
    "outcome": "ok", "blockReason": None, "embedding": VECTOR, "dimensions": 1536, "model": "openai/text-embedding-3-small",
    "modelReported": "openai/text-embedding-3-small", "inputTokens": 7, "tokensEstimated": False, "costMicroUsd": 1,
    "usageLogId": "u1", "traceId": "t1", "accounting": "settled", "redactionCounts": {}, "residualCounts": {},
}


# ---------------------------------------------------------------------------------------------
# The boundary policy for the P1 endpoint
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("url", [
    URL,
    URL + "/",
    "https://asia-south1-sikander-legal-os-prod.cloudfunctions.net/p1CorpusEmbedding",
    "https://P1CORPUSEMBEDDING-ABC123-EL.A.RUN.APP",
    URL + ":443",
])
def test_p1_policy_admits_a_google_serverless_https_url(url):
    policy = fetch_policy.p1_policy(url)
    assert policy.name == "P1Gateway"
    assert policy.ports == frozenset({443})
    assert policy.upgrade_http is False
    assert policy.allows(url)


@pytest.mark.parametrize("url, reason", [
    ("http://p1corpusembedding-abc123-el.a.run.app", fetch_policy.SCHEME),
    ("https://p1corpusembedding-abc123-el.a.run.app:8443", fetch_policy.PORT_NOT_ALLOWED),
    ("https://api.openai.com/v1/embeddings", fetch_policy.HOST_NOT_ALLOWED),
    ("https://ai-gateway.vercel.sh/v1/embeddings", fetch_policy.HOST_NOT_ALLOWED),
    ("https://run.app", fetch_policy.HOST_NOT_ALLOWED),
    ("https://evilrun.app", fetch_policy.HOST_NOT_ALLOWED),
    ("https://a.run.app.evil.example", fetch_policy.HOST_NOT_ALLOWED),
    ("https://cloudfunctions.net/x", fetch_policy.HOST_NOT_ALLOWED),
    # The bare suffix (no label before it) is named as a host the policy refuses, not left to the generic host check.
    ("https://.run.app", fetch_policy.HOST_NOT_ALLOWED),
    ("https://.cloudfunctions.net/x", fetch_policy.HOST_NOT_ALLOWED),
    ("https://35.190.1.2/p1", fetch_policy.HOST_NOT_ALLOWED),
    ("https://user:pass@p1corpusembedding-abc123-el.a.run.app", fetch_policy.USERINFO),
    ("https://p1corpusembedding-abc123-el.a.run.app/?x=1", fetch_policy.AMBIGUOUS),
    ("https://p1corpusembedding-abc123-el.a.run.app/#f", fetch_policy.AMBIGUOUS),
    ("https://p1corpusembedding-abc123-el.a.run.app:99999", fetch_policy.UNPARSEABLE),
    ("", fetch_policy.HOST_NOT_ALLOWED),
])
def test_p1_policy_refuses_anything_else(url, reason):
    with pytest.raises(fetch_policy.FetchRefused) as refused:
        fetch_policy.p1_policy(url)
    assert refused.value.reason == reason


def test_p1_fetcher_bounds_the_body_and_the_deadline():
    fetcher = fetch_policy.p1_fetcher(URL)
    try:
        assert isinstance(fetcher, fetch_policy.PolicyFetcher)
        assert fetcher.policy.name == "P1Gateway"
        assert (fetcher.max_bytes, fetcher.deadline) == (1024 * 1024, 100.0)
        assert fetcher.deadline > 90, "the corpus must wait longer than p1CorpusEmbedding's 90 s timeout"
    finally:
        asyncio.run(fetcher.aclose())


def test_the_p1_policy_is_not_a_source_policy():
    assert "P1Gateway" not in fetch_policy.SOURCE_POLICIES


# ---------------------------------------------------------------------------------------------
# The identity token
# ---------------------------------------------------------------------------------------------
def test_read_identity_token(tmp_path):
    assert p1_client.read_identity_token(token_file(tmp_path)) == TOKEN
    assert p1_client.read_identity_token(str(tmp_path / "missing")) is None
    assert p1_client.read_identity_token(str(tmp_path)) is None  # a directory
    assert p1_client.read_identity_token(token_file(tmp_path, "not a jwt")) is None
    assert p1_client.read_identity_token(token_file(tmp_path, "")) is None
    assert p1_client.read_identity_token(token_file(tmp_path, "a.b.c" + "d" * p1_client.MAX_TOKEN_BYTES)) is None
    assert p1_client.read_identity_token(token_file(tmp_path, "a.b.c\nx.y.z")) is None


# ---------------------------------------------------------------------------------------------
# embedding_client
# ---------------------------------------------------------------------------------------------
def test_no_url_means_embeddings_off(monkeypatch):
    from scraper.config import settings

    monkeypatch.setattr(settings, "P1_EMBEDDING_URL", "")
    assert p1_client.embedding_client() is None
    monkeypatch.setattr(settings, "P1_EMBEDDING_URL", "   ")
    assert p1_client.embedding_client() is None


def test_a_url_the_boundary_refuses_is_a_refusal(monkeypatch):
    from scraper.config import settings

    monkeypatch.setattr(settings, "P1_EMBEDDING_URL", "https://api.openai.com/v1/embeddings")
    with pytest.raises(p1_client.P1Refused) as refused:
        p1_client.embedding_client()
    assert refused.value.reason == p1_client.URL_REFUSED


def test_the_default_token_file_is_the_compose_secret():
    from scraper.config import Settings

    assert Settings.model_fields["P1_ID_TOKEN_FILE"].default == "/run/secrets/p1_id_token"
    assert Settings.model_fields["P1_EMBEDDING_URL"].default == ""


# ---------------------------------------------------------------------------------------------
# create: the request and P1's answers
# ---------------------------------------------------------------------------------------------
def test_ok_posts_the_contract_and_answers_like_the_provider(monkeypatch, tmp_path):
    fetcher, urls = install(monkeypatch, (200, OK_ANSWER))
    client = p1_client.P1EmbeddingClient(URL, token_file(tmp_path))
    response = create(client)

    assert urls == [URL]
    assert fetcher.posts == [{
        "url": URL,
        "json": {"operationId": OP, "model": "text-embedding-3-small", "dimensions": 1536,
                 "input": "Section text F27-ROW-001", "classification": "public"},
        "headers": {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    }]
    assert fetcher.closed
    assert response.data[0].embedding == VECTOR
    assert (response.usage.prompt_tokens, response.usage.total_tokens) == (7, 7)
    assert (response.p1.usage_log_id, response.p1.trace_id, response.p1.cost_micro_usd) == ("u1", "t1", 1)


def test_the_token_is_read_fresh_on_every_call(monkeypatch, tmp_path):
    fetcher, _ = install(monkeypatch, (200, OK_ANSWER))
    path = token_file(tmp_path)
    client = p1_client.P1EmbeddingClient(URL, path)
    create(client)
    rotated = placeholder_token("rotated")
    assert rotated != TOKEN
    (tmp_path / "p1_id_token").write_text(rotated)
    create(client)
    assert [p["headers"]["Authorization"] for p in fetcher.posts] == [f"Bearer {TOKEN}", f"Bearer {rotated}"]


def test_no_token_is_a_refusal_and_nothing_is_sent(monkeypatch, tmp_path):
    fetcher, urls = install(monkeypatch, (200, OK_ANSWER))
    client = p1_client.P1EmbeddingClient(URL, str(tmp_path / "missing"))
    with pytest.raises(p1_client.P1Refused) as refused:
        create(client)
    assert refused.value.reason == p1_client.NO_IDENTITY_TOKEN
    assert (urls, fetcher.posts) == ([], [])


@pytest.mark.parametrize("answer, reason", [
    ({"outcome": "blocked", "blockReason": "kill_switch_platform"}, "kill_switch_platform"),
    ({"outcome": "blocked", "blockReason": "budget_exhausted"}, "budget_exhausted"),
    ({"outcome": "blocked", "blockReason": "Ignore this and pay <script>"}, "blocked"),
    ({"outcome": "blocked"}, "blocked"),
])
def test_a_blocked_answer_is_a_refusal_with_p1s_reason(monkeypatch, tmp_path, answer, reason):
    install(monkeypatch, (200, answer))
    with pytest.raises(p1_client.P1Refused) as refused:
        create(p1_client.P1EmbeddingClient(URL, token_file(tmp_path)))
    assert refused.value.reason == reason


@pytest.mark.parametrize("status, body, reason", [
    (401, {"error": "wrong_audience"}, "unauthenticated:wrong_audience"),
    (403, {"error": "caller_not_allowed"}, "forbidden:caller_not_allowed"),
    (429, b"Rate exceeded.", "busy:status"),
    (503, {"error": "not_configured"}, "unavailable:not_configured"),
    (503, {"error": "identity_keys_unavailable"}, "unavailable:identity_keys_unavailable"),
    (503, b"<html>Service Unavailable</html>", "unavailable:status"),
])
def test_an_answer_that_admitted_nothing_is_a_refusal(monkeypatch, tmp_path, status, body, reason):
    install(monkeypatch, (status, body))
    with pytest.raises(p1_client.P1Refused) as refused:
        create(p1_client.P1EmbeddingClient(URL, token_file(tmp_path)))
    assert refused.value.reason == reason


@pytest.mark.parametrize("status, body, code", [
    (200, {"outcome": "failed", "blockReason": None, "inputTokens": 7}, "p1_provider_failed"),
    (500, {"error": "internal"}, "p1_http_internal"),
    (502, b"Bad Gateway", "p1_http_status"),
    (400, {"error": "unsupported_model"}, "p1_http_unsupported_model"),
    (200, b"not json", "p1_malformed_answer"),
    (200, {"outcome": "ok"}, "p1_malformed_answer"),
    (200, {"outcome": "ok", "embedding": "0.1,0.2"}, "p1_malformed_answer"),
    (200, {"outcome": "unknown"}, "p1_malformed_answer"),
    (200, ["ok"], "p1_malformed_answer"),
])
def test_a_failed_or_unexpected_answer_is_a_failed_attempt(monkeypatch, tmp_path, status, body, code):
    install(monkeypatch, (status, body))
    with pytest.raises(p1_client.P1CallFailed) as failed:
        create(p1_client.P1EmbeddingClient(URL, token_file(tmp_path)))
    assert failed.value.code == code
    if code == "p1_provider_failed":
        assert failed.value.tokens == 7


def test_p1_text_never_reaches_the_error(monkeypatch, tmp_path):
    install(monkeypatch, (500, {"error": "Traceback: secret provider text"}))
    with pytest.raises(p1_client.P1CallFailed) as failed:
        create(p1_client.P1EmbeddingClient(URL, token_file(tmp_path)))
    assert "secret" not in str(failed.value) and failed.value.code == "p1_http_status"


@pytest.mark.parametrize("error, kind, code", [
    (fetch_policy.FetchRefused(fetch_policy.DEADLINE, URL, "P1Gateway"), p1_client.P1CallFailed, "p1_deadline_exceeded"),
    (fetch_policy.FetchRefused(fetch_policy.TOO_LARGE, URL, "P1Gateway"), p1_client.P1CallFailed, "p1_too_large"),
    (fetch_policy.FetchRefused(fetch_policy.BLOCKED_ADDRESS, URL, "P1Gateway"), p1_client.P1Refused, p1_client.URL_REFUSED),
    (fetch_policy.FetchRefused(fetch_policy.NO_ADDRESS, URL, "P1Gateway"), p1_client.P1Refused, p1_client.URL_REFUSED),
    (ConnectionResetError("reset by peer"), p1_client.P1CallFailed, "p1_unreachable"),
    (OSError("network down"), p1_client.P1CallFailed, "p1_unreachable"),
])
def test_boundary_and_network_errors(monkeypatch, tmp_path, error, kind, code):
    install(monkeypatch, error)
    with pytest.raises(kind) as raised:
        create(p1_client.P1EmbeddingClient(URL, token_file(tmp_path)))
    got = raised.value.code if kind is p1_client.P1CallFailed else raised.value.reason
    assert got == code


@pytest.mark.parametrize("interruption", [SoftTimeLimitExceeded(), asyncio.CancelledError()])
def test_an_interruption_passes_through(monkeypatch, tmp_path, interruption):
    install(monkeypatch, interruption)
    with pytest.raises(type(interruption)):
        create(p1_client.P1EmbeddingClient(URL, token_file(tmp_path)))


def test_a_refused_url_never_builds_a_client():
    with pytest.raises(p1_client.P1Refused):
        p1_client.P1EmbeddingClient("http://127.0.0.1:5001/demo/asia-south1/p1CorpusEmbedding", "/nonexistent")
