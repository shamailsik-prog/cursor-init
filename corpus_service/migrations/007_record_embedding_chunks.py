"""Migration 007 (audit F45): ``record_embedding_chunks`` for versioned per-chunk vectors.

``create_all`` on a new database already builds the table from the model; this migration creates it
on databases that existed before F45. Idempotent: skips when the table is present.
"""

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

logger = logging.getLogger("scraper.migrate")


async def upgrade(conn: AsyncConnection) -> None:
    exists = (await conn.execute(text("SELECT to_regclass('record_embedding_chunks')"))).scalar()
    if exists is not None:
        return
    await conn.execute(
        text(
            """
CREATE TABLE record_embedding_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name VARCHAR(80) NOT NULL,
  record_id UUID NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_spec_version VARCHAR(32) NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  paragraph_start INTEGER NOT NULL,
  paragraph_end INTEGER NOT NULL,
  language VARCHAR(20) NOT NULL DEFAULT 'en',
  embedding_model VARCHAR(100) NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  operation_id VARCHAR(64),
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_record_embedding_chunk_identity UNIQUE (
    table_name, record_id, chunk_index, chunk_spec_version, embedding_model
  ),
  CONSTRAINT ck_record_embedding_chunks_index_nonneg CHECK (chunk_index >= 0),
  CONSTRAINT ck_record_embedding_chunks_content_hash CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_record_embedding_chunks_operation_id CHECK (
    operation_id IS NULL OR operation_id ~ '^[0-9a-f]{64}$'
  )
);
CREATE INDEX ix_record_embedding_chunks_record ON record_embedding_chunks (table_name, record_id);
"""
        )
    )
    logger.info("migration 007: created record_embedding_chunks")
