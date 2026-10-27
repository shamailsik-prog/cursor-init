"""Shared auth dependencies for admin-only corpus_service routes (audit F47)."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from scraper.admin_credentials import (
    ALL_SCOPES,
    CorpusAdminPrincipal,
    get_corpus_admin_registry,
)
from scraper.database import get_db
from scraper.models import CorpusAdminAudit

# Marker for structural tests (F23 ruling 17): any dependency carrying this attribute runs
# before a route reads a request body.
CORPUS_ADMIN_AUTH_MARKER = "__corpus_admin_auth__"


async def authenticate_corpus_admin(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> CorpusAdminPrincipal:
    principal = get_corpus_admin_registry().authenticate(x_api_key)
    if principal is None:
        raise HTTPException(status_code=401, detail="Invalid key")
    return principal


def require_corpus_scopes(*required_scopes: str):
    needed = frozenset(required_scopes)

    async def _dependency(
        principal: CorpusAdminPrincipal = Depends(authenticate_corpus_admin),
    ) -> CorpusAdminPrincipal:
        if not needed <= principal.scopes:
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "insufficient_scope",
                    "required": sorted(needed),
                    "granted": sorted(principal.scopes),
                },
            )
        return principal

    setattr(_dependency, CORPUS_ADMIN_AUTH_MARKER, True)
    return _dependency


# Route scope bundles
require_corpus_read = require_corpus_scopes("read")
require_corpus_trigger = require_corpus_scopes("trigger")
require_corpus_review = require_corpus_scopes("review")
require_corpus_export = require_corpus_scopes("export")
require_corpus_promote = require_corpus_scopes("promote")


async def record_corpus_admin_audit(
    db: AsyncSession,
    principal: CorpusAdminPrincipal,
    action: str,
    *,
    scopes_used: list[str],
    resource: dict[str, Any] | None = None,
) -> uuid.UUID:
    row_id = uuid.uuid4()
    db.add(
        CorpusAdminAudit(
            id=row_id,
            credential_id=principal.credential_id,
            actor=principal.actor,
            scopes_used=scopes_used,
            action=action,
            resource=resource or {},
        )
    )
    await db.flush()
    return row_id


def is_corpus_admin_auth_dependency(callable_obj: Any) -> bool:
    return getattr(callable_obj, CORPUS_ADMIN_AUTH_MARKER, False) is True


# Backward-compatible name for grep/docs; requires every scope (legacy superuser equivalent).
require_admin_api_key = require_corpus_scopes(*sorted(ALL_SCOPES))
