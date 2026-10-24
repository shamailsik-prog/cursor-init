"""FA-D3C-002: the corpus service's only way to a paid embedding, through the P1 gateway.

Spec: docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-boundary-design.md (rulings R4, R13, R14).

The corpus holds no provider key and no provider SDK (Layer 18 §9 rule 6: a layer never calls a provider itself). Each
embedding is posted to P1's ``p1CorpusEmbedding`` Cloud Function, which applies the kill switches, the budget
reservation and settlement, the P1 ledger row, the provider policy and the outbound mask, and calls the provider. The
request goes out through the F25 fetch boundary (``fetch_policy.p1_fetcher``: https on 443 to a Google serverless host,
public addresses only, no redirect, a bounded body and deadline) with the corpus service account's Google-signed OIDC
ID token, read fresh from ``P1_ID_TOKEN_FILE`` on every call (the deployment keeps that file current).

``embedding_client()`` is what ``scraper.tasks.embeddings`` uses. Its ``embeddings.create(model, input, dimensions,
operation_id)`` answers like the provider client it replaces (``response.data[0].embedding``, ``response.usage``), so
the F27 batch's provider-call seam is the only place that changed. Two failures, kept apart on purpose (R14):

- ``P1Refused``: P1 decided not to call the provider (a ``blocked`` answer: kill switch, budget, policy, credentials,
  concurrency, accounting), or the call could not be authorised or admitted (401, 403, 429, 503, no identity token, a
  P1 URL the boundary refuses). No provider request was made, so it is not an attempt: the batch stops and the row is
  not charged.
- ``P1CallFailed``: P1 answered ``failed`` (the provider failed, and may have billed it), or P1 could not be reached or
  answered another error. It is a failed attempt, charged under F27 R8 exactly as a provider failure was before.
"""

from __future__ import annotations

import json
import logging
import re
import types
from pathlib import Path
from typing import Any, Optional

from scraper.net import fetch_policy
from scraper.tasks import outcomes

logger = logging.getLogger(__name__)

# The corpus master tables hold published public law (Annex A judgment.classification defaults to public). P1 refuses
# any label above `internal` without an executed DPA (R7).
CLASSIFICATION = "public"
# A Google ID token is about 1 KB; the file is refused above this.
MAX_TOKEN_BYTES = 8192
_JWT = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

# Refusal reasons the corpus decides itself (P1's own block reasons pass through as P1 sends them).
NO_IDENTITY_TOKEN = "no_identity_token"
URL_REFUSED = "p1_url_refused"
# HTTP answers that mean the call was not admitted, before any provider request.
_REFUSED_STATUSES = {401: "unauthenticated", 403: "forbidden", 429: "busy", 503: "unavailable"}
# Boundary refusals raised while the request may already have left (it may have been billed): a failed attempt.
_AFTER_SEND = {fetch_policy.DEADLINE, fetch_policy.TOO_LARGE, fetch_policy.CONTENT_ENCODING, fetch_policy.TOO_MANY_REDIRECTS}


class P1Refused(Exception):
    """P1 refused the embedding before any provider request. Not an attempt: the batch stops, the row is not charged."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return f"P1 refused the embedding call: {self.reason}"


class P1CallFailed(Exception):
    """A failed embedding attempt through P1 (it may have been billed). Charged under F27 R8."""

    def __init__(self, code: str, *, status: Optional[int] = None, tokens: Optional[int] = None):
        self.code = code
        self.status = status
        self.tokens = tokens
        super().__init__(code)

    def __str__(self) -> str:
        return f"P1 embedding call failed: {self.code}" + (f" (HTTP {self.status})" if self.status is not None else "")


def _code(value: Any, default: str) -> str:
    """A fixed code from P1's answer, or ``default``: never free text into a log line or the queue."""
    return value if isinstance(value, str) and _CODE.match(value) else default


def read_identity_token(path: str) -> Optional[str]:
    """The OIDC ID token in ``path``: one JWT of at most MAX_TOKEN_BYTES; None when the file is missing, unreadable,
    too large or holds anything else. Never logged."""
    try:
        file = Path(path)
        if not file.is_file() or file.stat().st_size > MAX_TOKEN_BYTES:
            return None
        token = file.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    return token if _JWT.match(token) else None


def _answer(content: bytes) -> Optional[dict]:
    try:
        value = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _count(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


class _Embeddings:
    def __init__(self, client: "P1EmbeddingClient"):
        self._client = client

    async def create(self, model: str, input: str, dimensions: int, operation_id: str):  # noqa: A002 (the provider client's keyword)
        return await self._client.embed(model=model, text=input, dimensions=dimensions, operation_id=operation_id)


class P1EmbeddingClient:
    """One P1 endpoint (``P1_EMBEDDING_URL``) and the file holding the caller's ID token (``P1_ID_TOKEN_FILE``)."""

    def __init__(self, url: str, token_file: str):
        try:
            fetch_policy.p1_policy(url)
        except fetch_policy.FetchRefused as exc:
            raise P1Refused(URL_REFUSED) from exc
        self.url = url
        self.token_file = token_file
        self.embeddings = _Embeddings(self)

    async def embed(self, *, model: str, text: str, dimensions: int, operation_id: str):
        token = read_identity_token(self.token_file)
        if token is None:
            raise P1Refused(NO_IDENTITY_TOKEN)
        body = {
            "operationId": operation_id,
            "model": model,
            "dimensions": dimensions,
            "input": text,
            "classification": CLASSIFICATION,
        }
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        try:
            async with fetch_policy.p1_fetcher(self.url) as fetcher:
                response = await fetcher.post(self.url, json=body, headers=headers)
        except fetch_policy.FetchRefused as exc:
            if exc.reason in _AFTER_SEND:
                raise P1CallFailed(f"p1_{exc.reason}") from None
            raise P1Refused(URL_REFUSED) from None
        except Exception as exc:
            if outcomes.is_interruption(exc):
                raise
            # The request may have reached P1 (a reset, a read timeout): a failed attempt, as a provider outage was.
            raise P1CallFailed("p1_unreachable") from None
        return self._result(response.status_code, response.content)

    @staticmethod
    def _result(status: int, content: bytes):
        answer = _answer(content)
        if status in _REFUSED_STATUSES:
            error = _code((answer or {}).get("error"), "status")
            raise P1Refused(f"{_REFUSED_STATUSES[status]}:{error}")
        if status != 200:
            error = _code((answer or {}).get("error"), "status")
            raise P1CallFailed(f"p1_http_{error}", status=status)
        if answer is None:
            raise P1CallFailed("p1_malformed_answer", status=status)
        outcome = answer.get("outcome")
        if outcome == "blocked":
            raise P1Refused(_code(answer.get("blockReason"), "blocked"))
        if outcome == "failed":
            raise P1CallFailed("p1_provider_failed", tokens=_count(answer.get("inputTokens")))
        embedding = answer.get("embedding")
        if outcome != "ok" or not isinstance(embedding, list):
            raise P1CallFailed("p1_malformed_answer", status=status)
        tokens = _count(answer.get("inputTokens"))
        return types.SimpleNamespace(
            data=[types.SimpleNamespace(embedding=embedding)],
            usage=types.SimpleNamespace(prompt_tokens=tokens, total_tokens=tokens),
            model=answer.get("model"),
            p1=types.SimpleNamespace(
                usage_log_id=answer.get("usageLogId"),
                trace_id=answer.get("traceId"),
                cost_micro_usd=_count(answer.get("costMicroUsd")),
                accounting=answer.get("accounting"),
            ),
        )


def embedding_client() -> Optional[P1EmbeddingClient]:
    """The P1 embedding client, or None when ``P1_EMBEDDING_URL`` is empty (embeddings off: the batch is skipped, as
    with no key before FA-D3C-002). A URL the F25 boundary does not admit raises ``P1Refused(URL_REFUSED)``."""
    from scraper.config import settings

    url = (settings.P1_EMBEDDING_URL or "").strip()
    if not url:
        return None
    return P1EmbeddingClient(url, settings.P1_ID_TOKEN_FILE)
