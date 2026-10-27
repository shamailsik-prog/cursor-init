"""Audit F47: corpus_admin_audit append-only triggers (table from ORM create_all)."""

from __future__ import annotations

import logging

from scraper import corpus_admin_ledger

logger = logging.getLogger(__name__)


async def upgrade(conn) -> None:
    changed = await corpus_admin_ledger.ensure_append_only(conn)
    if changed:
        logger.info("migration 008: installed corpus_admin_audit append-only triggers")
