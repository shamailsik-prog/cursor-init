"""Admin API-key gate for corpus-service write and bulk-read routes."""

from __future__ import annotations

from fastapi import Header, HTTPException

from scraper.config import settings


def require_admin_key(x_api_key: str = Header(...)) -> str:
    if not settings.ADMIN_API_KEY or x_api_key != settings.ADMIN_API_KEY:
        raise HTTPException(401, "Invalid key")
    return x_api_key
