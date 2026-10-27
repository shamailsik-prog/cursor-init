"""Audit F47: named scoped corpus admin credentials."""

from __future__ import annotations

import asyncio
import uuid
from unittest import mock

import pytest
from sqlalchemy import select
from fastapi.testclient import TestClient
from scraper.admin_credentials import get_corpus_admin_registry, reset_corpus_admin_registry_for_tests
from scraper.config import settings
from scraper.main import app
from scraper.models import CorpusAdminAudit

ALICE_TRIGGER = "alice-trigger-secret-32chars-long"
BOB_EXPORT = "bob-export-secret-32chars-long!!"
CHARLIE_PROMOTE = "charlie-promote-secret-32chars!!"


def _credentials(include_revoked: str | None = None):
    creds = [
        {
            "id": "alice-trigger",
            "actor": "alice@firm",
            "secret": ALICE_TRIGGER,
            "scopes": ["read", "trigger"],
        },
        {
            "id": "bob-export",
            "actor": "bob@firm",
            "secret": BOB_EXPORT,
            "scopes": ["export"],
        },
        {
            "id": "charlie-promote",
            "actor": "charlie@firm",
            "secret": CHARLIE_PROMOTE,
            "scopes": ["promote", "review"],
        },
    ]
    if include_revoked == "bob-export":
        creds = [c for c in creds if c["id"] != "bob-export"]
    return creds


@pytest.fixture
def scoped_registry():
    reset_corpus_admin_registry_for_tests(_credentials())
    yield
    reset_corpus_admin_registry_for_tests(None)


@pytest.fixture
def client():
    return TestClient(app)


def test_wrong_scope_denied(client, scoped_registry):
    """Export credential cannot start harvest (trigger scope)."""
    res = client.post("/api/start", headers={"X-API-Key": BOB_EXPORT})
    assert res.status_code == 403
    assert res.json()["detail"]["error"] == "insufficient_scope"


def test_missing_key_denied(client, scoped_registry):
    assert client.get("/jobs").status_code == 401


def test_named_actor_recorded_on_privileged_action(client, scoped_registry, corpus_db):
    """Trigger records immutable audit row with operator identity."""
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    with mock.patch("scraper.tasks.dispatcher.run_source_job") as job:
        job.delay.return_value = None
        res = client.post(
            "/admin/sources/example/trigger",
            headers={"X-API-Key": ALICE_TRIGGER},
        )
    assert res.status_code == 200

    async def _fetch():
        from scraper.database import SessionLocal

        async with SessionLocal() as db:
            return (
                await db.execute(
                    select(CorpusAdminAudit).where(CorpusAdminAudit.action == "source.trigger")
                )
            ).scalars().first()

    row = asyncio.run(_fetch())
    assert row is not None
    assert row.actor == "alice@firm"
    assert row.credential_id == "alice-trigger"
    assert row.scopes_used == ["trigger"]


def test_revoking_one_credential_leaves_others_active(client, scoped_registry):
    """After bob-export is removed from the registry, alice still authenticates and bob gets 401."""
    assert get_corpus_admin_registry().authenticate(BOB_EXPORT) is not None
    assert client.post("/api/start", headers={"X-API-Key": BOB_EXPORT}).status_code == 403

    reset_corpus_admin_registry_for_tests(_credentials(include_revoked="bob-export"))
    assert get_corpus_admin_registry().authenticate(BOB_EXPORT) is None
    assert get_corpus_admin_registry().authenticate(ALICE_TRIGGER) is not None
    assert client.post("/api/start", headers={"X-API-Key": BOB_EXPORT}).status_code == 401
    assert get_corpus_admin_registry().authenticate(ALICE_TRIGGER) is not None


def test_promote_requires_promote_scope_not_review_only(client, scoped_registry):
    """Review-only routes reject promote scope mismatch on export key."""
    qid = uuid.uuid4()
    res = client.post(
        f"/quarantine/{qid}/promote",
        headers={"X-API-Key": BOB_EXPORT, "Idempotency-Key": "k1"},
        json={"decision": "promote", "reviewer": "Bob", "reason": "test reason ok"},
    )
    assert res.status_code == 403


def test_development_fallback_still_uses_admin_api_key():
    """Without explicit CORPUS_ADMIN_CREDENTIALS, dev mode keeps ADMIN_API_KEY as all-scope cred."""
    reset_corpus_admin_registry_for_tests(None)
    principal = get_corpus_admin_registry().authenticate(settings.ADMIN_API_KEY)
    assert principal is not None
    assert principal.credential_id == "dev-admin"
    assert principal.scopes == frozenset({"read", "trigger", "review", "export", "promote"})
