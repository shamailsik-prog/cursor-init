"""Audit F45: versioned embedding chunks cover body text beyond the legacy 2,000-character window."""

import types
import uuid

import pytest

from scraper.tasks import embedding_chunks as ec
from scraper.tasks import embeddings
from test_f20_trust_policy_db import assert_migrated, execute, fetch, run
from test_f27_embedding_claims_e2e import migrated, no_sleep
from test_f28_source_outcomes_e2e import fire

MODEL = "text-embedding-3-small"
DIMENSIONS = 1536
MARKER = "F45-LATE-MARKER-UNIQUE-PHRASE"
PADDING = "x" * 2100


def test_distinctive_content_after_2000_chars_lands_in_a_later_chunk():
    body = PADDING + MARKER
    chunks = ec.build_embedding_chunks("Title", "s1", body)
    assert len(chunks) >= 2
    assert MARKER not in chunks[0].embed_text
    assert any(MARKER in c.embed_text for c in chunks[1:])
    late = next(c for c in chunks if MARKER in c.embed_text)
    assert late.char_start >= 2000
    assert late.content_hash == ec.content_hash(late.embed_text)


def test_chunk_operation_id_includes_spec_version_and_content_hash():
    chunk = ec.build_embedding_chunks("A", "B", "body one")[0]
    a = ec.chunk_operation_id("statutes_master", uuid.uuid4(), MODEL, DIMENSIONS, chunk)
    other = ec.EmbeddingChunk(
        chunk_index=1,
        embed_text="other",
        content_hash=ec.content_hash("other"),
        char_start=0,
        char_end=5,
        paragraph_start=0,
        paragraph_end=0,
        language="en",
    )
    b = ec.chunk_operation_id("statutes_master", uuid.uuid4(), MODEL, DIMENSIONS, other)
    assert a != b
    assert len(a) == 64


def test_manifest_covers_all_chunk_hashes():
    chunks = ec.build_embedding_chunks("Act", "s2", PADDING + MARKER)
    rid = uuid.uuid4()
    m1 = ec.manifest_operation_id("statutes_master", rid, MODEL, DIMENSIONS, chunks)
    m2 = ec.manifest_operation_id("statutes_master", rid, MODEL, DIMENSIONS, chunks)
    assert m1 == m2
    changed = list(chunks)
    changed[-1] = ec.EmbeddingChunk(
        chunk_index=changed[-1].chunk_index,
        embed_text=changed[-1].embed_text + " ",
        content_hash=ec.content_hash(changed[-1].embed_text + " "),
        char_start=changed[-1].char_start,
        char_end=changed[-1].char_end + 1,
        paragraph_start=changed[-1].paragraph_start,
        paragraph_end=changed[-1].paragraph_end,
        language="en",
    )
    assert ec.manifest_operation_id("statutes_master", rid, MODEL, DIMENSIONS, changed) != m1


def test_embeddings_operation_id_matches_chunk_zero_provider_text():
    rid = uuid.UUID("00000000-0000-4000-8000-000000000027")
    chunk = ec.build_embedding_chunks("Synthetic F27 Act 2099", "s1", "Section body for F45.")[0]
    assert embeddings.operation_id("statutes_master", rid, MODEL, DIMENSIONS, chunk.embed_text) == ec.chunk_operation_id(
        "statutes_master", rid, MODEL, DIMENSIONS, chunk,
    )


@pytest.mark.parametrize("change", ["table", "record", "model", "dimensions", "chunk_index", "content"])
def test_f27_r4_every_manifest_component_changes_the_chunk_operation(change):
    base_chunk = ec.build_embedding_chunks("T", "L", "alpha beta gamma")[0]
    base = dict(
        table_name="statutes_master",
        record_id=uuid.uuid4(),
        model=MODEL,
        dimensions=DIMENSIONS,
        chunk=base_chunk,
    )
    other = dict(base)
    if change == "table":
        other["table_name"] = "case_law_master"
    elif change == "record":
        other["record_id"] = uuid.uuid4()
    elif change == "model":
        other["model"] = "text-embedding-3-large"
    elif change == "dimensions":
        other["dimensions"] = 3072
    elif change == "chunk_index":
        other["chunk"] = ec.EmbeddingChunk(
            chunk_index=1,
            embed_text=base_chunk.embed_text,
            content_hash=base_chunk.content_hash,
            char_start=0,
            char_end=3,
            paragraph_start=0,
            paragraph_end=0,
            language="en",
        )
    else:
        other["chunk"] = ec.EmbeddingChunk(
            chunk_index=0,
            embed_text=base_chunk.embed_text + " ",
            content_hash=ec.content_hash(base_chunk.embed_text + " "),
            char_start=0,
            char_end=len(base_chunk.embed_text) + 1,
            paragraph_start=0,
            paragraph_end=0,
            language="en",
        )
    assert ec.chunk_operation_id(**base) != ec.chunk_operation_id(**other)


def test_long_statute_is_embedded_via_late_chunk_not_truncation(corpus_db, monkeypatch):
    """Provider must receive the late marker; chunk row persisted with offsets past 2,000."""
    migrated(corpus_db)
    body = PADDING + MARKER
    run(execute(
        "INSERT INTO statutes_master (statute_name, short_name, section_number, section_text, source_site) "
        "VALUES ('F45 Act', 'F45', 's1', :body, 'F45Fixture')",
        "INSERT INTO embedding_queue (record_id, table_name) SELECT id, 'statutes_master' "
        "FROM statutes_master WHERE source_site = 'F45Fixture'",
        params={"body": body},
    ))
    record_id = run(fetch("SELECT id FROM statutes_master WHERE source_site = 'F45Fixture'"))[0][0]
    calls = []

    class _Emb:
        async def create(self, model, input, dimensions, operation_id):
            calls.append(input)
            return types.SimpleNamespace(
                data=[types.SimpleNamespace(embedding=[0.01] * DIMENSIONS)],
                usage=types.SimpleNamespace(prompt_tokens=3, total_tokens=3),
            )

    from scraper import p1_client

    monkeypatch.setattr(p1_client, "embedding_client", lambda: types.SimpleNamespace(embeddings=_Emb()))
    no_sleep(monkeypatch)

    result = fire("process-embeddings")
    assert result.state == "SUCCESS"
    assert any(MARKER in c for c in calls), "late marker never reached the provider"
    rows = run(fetch(
        "SELECT chunk_index, char_start, char_end, content_hash, embedding IS NOT NULL "
        "FROM record_embedding_chunks WHERE record_id = :id ORDER BY chunk_index",
        id=record_id,
    ))
    assert len(rows) >= 2
    late_rows = [r for r in rows if r[1] >= 2000]
    assert late_rows, "no chunk anchored after the legacy 2k window"
    assert all(r[4] for r in rows), "every chunk row should hold a vector"
    manifest = ec.manifest_operation_id(
        "statutes_master",
        record_id,
        MODEL,
        DIMENSIONS,
        ec.build_embedding_chunks("F45 Act", "s1", body),
    )
    stored = run(fetch("SELECT stored_operation_id, status FROM embedding_queue WHERE record_id = :id", id=record_id))[0]
    assert stored == (manifest, "completed")
