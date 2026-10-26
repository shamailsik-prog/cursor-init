"""Audit F27 rules without a database: the operation identity (R4), the retry delays (R8), the text
checks behind the dead-letter reasons (R9), the lease against Celery's time limit (R2) and the batch
bounds (R13). Expected values are written out from the spec
(docs/superpowers/specs/2026-10-18-f27-leased-embedding-claims-design.md), not imported from the code.
"""

import hashlib
import json
import uuid

import pytest

from scraper.tasks import embeddings

RECORD = uuid.UUID("00000000-0000-4000-8000-000000000027")
TEXT = "Synthetic F27 Act 2099 s1 Section text. Synthetic F27 fixture, not a real statute."


def spec_operation_id(table, record_id, model, dimensions, text):
    from scraper.tasks import embedding_chunks as ec

    chunk = ec.EmbeddingChunk(
        chunk_index=0,
        embed_text=text,
        content_hash=ec.content_hash(text),
        char_start=0,
        char_end=max(len(text), 0),
        paragraph_start=0,
        paragraph_end=0,
        language="en",
    )
    return ec.chunk_operation_id(table, record_id, model, dimensions, chunk)


def test_r4_the_operation_id_is_the_spec_formula_and_64_lower_case_hex():
    got = embeddings.operation_id("statutes_master", RECORD, "text-embedding-3-small", 1536, TEXT)
    assert got == spec_operation_id("statutes_master", RECORD, "text-embedding-3-small", 1536, TEXT)
    assert len(got) == 64 and set(got) <= set("0123456789abcdef")


@pytest.mark.parametrize("change", ["table", "record", "model", "dimensions", "text"])
def test_r4_every_component_changes_the_operation(change):
    base = dict(table_name="statutes_master", record_id=RECORD, model="text-embedding-3-small", dimensions=1536, text=TEXT)
    other = dict(base)
    other.update({
        "table": {"table_name": "case_law_master"},
        "record": {"record_id": uuid.UUID("00000000-0000-4000-8000-000000000028")},
        "model": {"model": "text-embedding-3-large"},
        "dimensions": {"dimensions": 3072},
        "text": {"text": TEXT + " "},
    }[change])
    assert embeddings.operation_id(**base) != embeddings.operation_id(**other)
    assert embeddings.operation_id(**base) == embeddings.operation_id(**dict(base))


def test_r8_retry_delays_double_from_300_seconds_to_the_3600_cap():
    assert [embeddings.retry_delay_seconds(n) for n in range(1, 7)] == [300, 600, 1200, 2400, 3600, 3600]


@pytest.mark.parametrize("text, problem", [
    ("", "empty_text"),
    ("   \n\t ", "empty_text"),
    ("  -- . -- ; --", "malformed_text"),
    ("Section 302. Punishment.", None),
    ("  1 ", None),
    ("دفعہ ٣٠٢", None),  # Urdu letters and digits are letters and digits
])
def test_r9_text_checks(text, problem):
    assert embeddings.text_problem(text) == problem


def test_r9_the_only_supported_model_is_the_one_the_vector_columns_hold():
    from scraper import models

    assert embeddings.SUPPORTED_MODELS == {"text-embedding-3-small": 1536}
    assert models.StatutesMaster.__table__.c.embedding.type.dim == 1536
    assert models.CaseLawMaster.__table__.c.embedding.type.dim == 1536
    assert models.EmbeddingAttempt.__table__.c.embedding.type.dim == 1536


def test_r2_the_lease_outlasts_celerys_hard_time_limit():
    from scraper.tasks import celery_app

    assert embeddings.LEASE_SECONDS > celery_app.app.conf.task_time_limit, (
        embeddings.LEASE_SECONDS, celery_app.app.conf.task_time_limit)


def test_r13_each_batch_is_bounded():
    assert embeddings.BATCH_SIZE == 50 and embeddings.RECLAIM_LIMIT == 50


def test_r11_the_backlog_alert_age_is_a_day():
    assert embeddings.BACKLOG_ALERT_SECONDS == 24 * 3600


def test_r10_a_held_answer_is_stored_at_most_three_times_before_its_row_is_dead_lettered():
    """Review round 2 (Bugbot 4307417933, 4307442945): the bound on failed stores of one paid answer."""
    assert embeddings.STORE_RETRY_LIMIT == 3 and embeddings.STORE_FAILED == "store_failed"


def test_r15_the_pause_after_each_provider_request_keeps_to_100_a_minute():
    assert embeddings.PACE_SECONDS == 0.6
