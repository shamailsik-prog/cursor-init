"""Named, scoped corpus admin credentials (audit F47).

Operators authenticate with X-API-Key. Each configured credential has a stable id, a named actor,
an explicit scope set, and optional validity window (rotation overlap: two active secrets for one
actor). Secrets are compared with constant-time digest checks.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from hmac import compare_digest
from typing import Any, Iterable, Sequence

from pydantic import BaseModel, Field, ValidationError, field_validator

from scraper.config import settings

logger = logging.getLogger(__name__)

# Scopes are coarse roles; each admin route requires one or more of them.
SCOPE_READ = "read"
SCOPE_TRIGGER = "trigger"
SCOPE_REVIEW = "review"
SCOPE_EXPORT = "export"
SCOPE_PROMOTE = "promote"

ALL_SCOPES: frozenset[str] = frozenset(
    {SCOPE_READ, SCOPE_TRIGGER, SCOPE_REVIEW, SCOPE_EXPORT, SCOPE_PROMOTE}
)


class _CredentialSpec(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    actor: str = Field(min_length=1, max_length=120)
    secret: str = Field(min_length=16, max_length=512)
    scopes: list[str] = Field(min_length=1)
    not_before: datetime | None = None
    not_after: datetime | None = None

    @field_validator("scopes")
    @classmethod
    def _scopes_known(cls, value: list[str]) -> list[str]:
        unknown = set(value) - ALL_SCOPES
        if unknown:
            raise ValueError(f"unknown corpus admin scopes: {sorted(unknown)}")
        return sorted(set(value))

    @field_validator("id")
    @classmethod
    def _id_chars(cls, value: str) -> str:
        if not all(ch.isalnum() or ch in "-_" for ch in value):
            raise ValueError("credential id must be alphanumeric, hyphen, or underscore")
        return value


@dataclass(frozen=True, slots=True)
class CorpusAdminPrincipal:
    credential_id: str
    actor: str
    scopes: frozenset[str]

    def reviewer_auth_token(self) -> str:
        """Compact value stored on quarantine_decisions.reviewer_auth (<= 50 chars)."""
        return f"ca:{self.credential_id}"


@dataclass(frozen=True, slots=True)
class _LoadedCredential:
    spec: _CredentialSpec

    def active_at(self, now: datetime) -> bool:
        if self.spec.not_before is not None and now < self.spec.not_before:
            return False
        if self.spec.not_after is not None and now >= self.spec.not_after:
            return False
        return True


class CorpusAdminRegistry:
    def __init__(self, credentials: Sequence[_LoadedCredential]) -> None:
        self._credentials = list(credentials)

    def authenticate(self, presented: str | None, *, now: datetime | None = None) -> CorpusAdminPrincipal | None:
        if not presented:
            return None
        now = now or datetime.now(timezone.utc)
        try:
            presented_bytes = presented.encode("utf-8")
        except UnicodeEncodeError:
            return None
        for loaded in self._credentials:
            if not loaded.active_at(now):
                continue
            secret = loaded.spec.secret
            try:
                expected_bytes = secret.encode("utf-8")
            except UnicodeEncodeError:
                continue
            if compare_digest(presented_bytes, expected_bytes):
                return CorpusAdminPrincipal(
                    credential_id=loaded.spec.id,
                    actor=loaded.spec.actor,
                    scopes=frozenset(loaded.spec.scopes),
                )
        return None


_registry: CorpusAdminRegistry | None = None


def _parse_credentials_json(raw: str) -> list[_LoadedCredential]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"CORPUS_ADMIN_CREDENTIALS is not valid JSON: {exc}") from exc
    if not isinstance(payload, list) or not payload:
        raise ValueError("CORPUS_ADMIN_CREDENTIALS must be a non-empty JSON array")
    specs: list[_LoadedCredential] = []
    seen: set[str] = set()
    for item in payload:
        try:
            spec = _CredentialSpec.model_validate(item)
        except ValidationError as exc:
            raise ValueError(f"invalid corpus admin credential entry: {exc}") from exc
        if spec.id in seen:
            raise ValueError(f"duplicate corpus admin credential id: {spec.id}")
        seen.add(spec.id)
        specs.append(_LoadedCredential(spec=spec))
    return specs


def _bootstrap_credentials() -> list[_LoadedCredential]:
    raw = (getattr(settings, "CORPUS_ADMIN_CREDENTIALS", "") or "").strip()
    if raw:
        return _parse_credentials_json(raw)
    if settings.is_prodish():
        raise ValueError(
            "CORPUS_ADMIN_CREDENTIALS must be set in production/staging "
            "(named operators with scoped secrets; see corpus_service/.env.example)"
        )
    # Development / tests: one synthetic credential backed by ADMIN_API_KEY (all scopes).
    key = settings.ADMIN_API_KEY
    if not key:
        return []
    return [
        _LoadedCredential(
            spec=_CredentialSpec(
                id="dev-admin",
                actor="development",
                secret=key,
                scopes=sorted(ALL_SCOPES),
            )
        )
    ]


def get_corpus_admin_registry() -> CorpusAdminRegistry:
    global _registry
    if _registry is None:
        _registry = CorpusAdminRegistry(_bootstrap_credentials())
    return _registry


def reset_corpus_admin_registry_for_tests(credentials: Iterable[dict[str, Any]] | None = None) -> None:
    """Test helper: rebuild the registry from explicit dicts or from current settings."""
    global _registry
    if credentials is None:
        _registry = None
        return
    loaded = [_LoadedCredential(spec=_CredentialSpec.model_validate(item)) for item in credentials]
    _registry = CorpusAdminRegistry(loaded)
