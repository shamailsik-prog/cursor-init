"""FA-D3C-002 at the F27 batch's provider-call seam, on real Postgres (spec
docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-boundary-design.md, R13-R14).

The real ``process-embeddings`` beat entry runs in process (``Task.apply``) on a fresh, migrated database, with the P1
client replaced at ``scraper.p1_client.embedding_client`` by a stand-in whose answer is scripted per row. The P1
endpoint itself is proven in tests/test_fa_d3c_p1_embedding_e2e.py (the Functions emulator); this file pins what the
corpus does with each kind of answer, in the default CI job:

- the seam sends F27's operation id with the row's model and dimensions;
- a P1 refusal is not an attempt: the batch stops, the refused row and every row after it go back to ``pending`` with
  their attempts unchanged, its ``started`` receipt becomes ``failed`` (``p1_refused``), rows done before it stay done,
  and the run is recorded as a completed batch with ``reason: p1_refused:<code>``; the next batch picks the rows up;
- a P1 failure is a failed attempt, charged under F27 R8 exactly as a provider failure is on main;
- with no ``P1_EMBEDDING_URL`` the batch is skipped and nothing is claimed.

Expected values are written out, not imported from the code under test. Synthetic fixtures only.
"""

import hashlib
import json
import types

from test_f20_trust_policy_db import fetch, run
from test_f27_embedding_claims_e2e import marker_of, migrated, queue_by_row, receipts, seed_statutes, statute_text
from test_f28_source_outcomes_e2e import fire, jobs, no_sleep

MODEL = "text-embedding-3-small"
DIMENSIONS = 1536


class StandIn:
    """The P1 client as an in-process stand-in. ``script`` maps a row marker to what its request answers: "ok", or an
    exception instance to raise. ``calls`` records every request's keyword arguments."""

    def __init__(self, script=None):
        self.script = dict(script or {})
        self.calls = []

    def install(self, monkeypatch):
        from scraper import p1_client

        stand_in = self

        class _Embeddings:
            async def create(self, model, input, dimensions, operation_id):
                marker = marker_of(input)
                stand_in.calls.append({"marker": marker, "model": model, "dimensions": dimensions, "operation_id": operation_id})
                outcome = stand_in.script.get(marker, "ok")
                if isinstance(outcome, BaseException):
                    raise outcome
                return types.SimpleNamespace(
                    data=[types.SimpleNamespace(embedding=[0.001] * DIMENSIONS)],
                    usage=types.SimpleNamespace(prompt_tokens=7, total_tokens=7),
                )

        client = types.SimpleNamespace(embeddings=_Embeddings())
        monkeypatch.setattr(p1_client, "embedding_client", lambda: client)
        return self

    def markers(self):
        return [c["marker"] for c in self.calls]


def summary(result):
    return result.result if isinstance(result.result, dict) else {}


def operation_id(record_id, text):
    """F27 R4 (F45 chunk 0), written out."""
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
    return ec.chunk_operation_id("statutes_master", record_id, MODEL, DIMENSIONS, chunk)


def test_the_seam_sends_the_f27_operation_id_with_the_rows_model_and_dimensions(corpus_db, monkeypatch):
    migrated(corpus_db)
    seed_statutes(1, 2)
    stand_in = StandIn().install(monkeypatch)
    no_sleep(monkeypatch)

    result = fire("process-embeddings")

    assert result.state == "SUCCESS", repr(result.result)
    ids = {marker_of(text): rid for rid, text in run(fetch("SELECT id, section_text FROM statutes_master"))}
    assert stand_in.calls == [
        {"marker": n, "model": MODEL, "dimensions": DIMENSIONS, "operation_id": operation_id(ids[n], statute_text(n))}
        for n in (1, 2)
    ]
    assert set(queue_by_row().values()) == {("completed", 0, None, True)}


def test_a_p1_refusal_mid_batch_stops_it_and_charges_nothing(corpus_db, monkeypatch):
    from scraper import p1_client

    migrated(corpus_db)
    seed_statutes(1, 5)
    stand_in = StandIn({3: p1_client.P1Refused("kill_switch_platform")}).install(monkeypatch)
    no_sleep(monkeypatch)

    result = fire("process-embeddings")

    assert result.state == "SUCCESS", f"a refused batch is not a failed one: {result.state} {result.result!r}"
    s = summary(result)
    assert (s["outcome"], s["reason"]) == ("ok", "p1_refused:kill_switch_platform"), s
    assert (s["claimed"], s["completed"], s["failed"], s["provider_calls"], s["released"]) == (5, 2, 0, 2, 3), s
    assert stand_in.markers() == [1, 2, 3], "the batch stops at the refusal"
    assert queue_by_row() == {
        1: ("completed", 0, None, True), 2: ("completed", 0, None, True),
        3: ("pending", 0, None, False), 4: ("pending", 0, None, False), 5: ("pending", 0, None, False),
    }
    leases = run(fetch("SELECT count(*) FROM embedding_queue WHERE lease_owner IS NOT NULL OR next_attempt_at IS NOT NULL"))
    assert leases[0][0] == 0, "every given-back row is due again, with no lease and no backoff"
    assert receipts("error_type IS NOT NULL") == [("failed", None, False, False, "p1_refused")]
    rows = jobs("embedding_queue", job_type="embed")
    assert [(r.status, r.records_extracted, r.records_failed) for r in rows] == [("completed", 2, 0)], rows
    assert rows[0].result_summary["reason"] == "p1_refused:kill_switch_platform"

    # The switch is lifted: the next batch embeds the given-back rows, each with one request.
    stand_in.script.clear()
    again = summary(fire("process-embeddings"))
    assert (again["claimed"], again["completed"]) == (3, 3), again
    assert stand_in.markers() == [1, 2, 3, 3, 4, 5]
    assert set(queue_by_row().values()) == {("completed", 0, None, True)}


def test_a_refusal_on_the_first_row_skips_the_batch(corpus_db, monkeypatch):
    from scraper import p1_client

    migrated(corpus_db)
    seed_statutes(1, 2)
    StandIn({1: p1_client.P1Refused("budget_exhausted")}).install(monkeypatch)
    no_sleep(monkeypatch)

    result = fire("process-embeddings")

    assert result.state == "SUCCESS", repr(result.result)
    s = summary(result)
    assert (s["outcome"], s["reason"], s["claimed"], s["completed"], s["failed"], s["provider_calls"]) == (
        "skipped", "p1_refused:budget_exhausted", 2, 0, 0, 0), s
    assert queue_by_row() == {1: ("pending", 0, None, False), 2: ("pending", 0, None, False)}


def test_a_p1_failure_is_a_charged_attempt_like_a_provider_failure(corpus_db, monkeypatch):
    from scraper import p1_client

    migrated(corpus_db)
    seed_statutes(1, 1)
    StandIn({1: p1_client.P1CallFailed("p1_provider_failed", tokens=7)}).install(monkeypatch)
    no_sleep(monkeypatch)

    result = fire("process-embeddings")

    # One item, failed: F28's BatchFailed, as main records a batch whose provider failed every item.
    assert result.state == "FAILURE" and type(result.result).__name__ == "BatchFailed", repr(result.result)
    assert queue_by_row() == {1: ("pending", 1, "P1CallFailed", False)}
    wait = run(fetch("SELECT round(extract(epoch FROM next_attempt_at - now())) FROM embedding_queue"))[0][0]
    assert 290 <= wait <= 300, f"R8: the first failed attempt waits 300 s, got {wait}"
    assert receipts() == [("failed", None, False, False, "P1CallFailed")]


def test_no_p1_url_skips_the_batch_and_claims_nothing(corpus_db, monkeypatch):
    from scraper.config import settings

    migrated(corpus_db)
    seed_statutes(1, 1)
    monkeypatch.setattr(settings, "P1_EMBEDDING_URL", "")

    result = fire("process-embeddings")

    assert result.state == "SUCCESS", repr(result.result)
    s = summary(result)
    assert (s["outcome"], s["reason"], s["claimed"]) == ("skipped", "no_p1_embedding_url", 0), s
    assert queue_by_row() == {1: ("pending", 0, None, False)}
    assert jobs("embedding_queue", job_type="embed") == [], "a skipped batch writes no run record (F28 R13)"
