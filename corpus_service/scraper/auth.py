"""Shared auth dependencies for admin-only corpus_service routes."""

from __future__ import annotations

from hmac import compare_digest

from fastapi import Header, HTTPException

from scraper.config import settings


def require_admin_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """
    Enforce the configured ADMIN_API_KEY for admin-only operations.

    Uses constant-time comparison to avoid leaking key match timing.
    """
    expected = settings.ADMIN_API_KEY
    if not expected or not x_api_key or not compare_digest(x_api_key, expected):
        raise HTTPException(status_code=401, detail="Invalid key")
