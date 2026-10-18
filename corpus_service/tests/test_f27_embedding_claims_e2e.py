"""Audit F27 end to end, in process: embedding work is claimed under a lease, paid once per operation,
retried on time, dead-lettered when it cannot succeed, and recoverable after a crash.

The flow is F28's (test_f28_source_outcomes_e2e.py): the real ``process-embeddings`` beat entry of the
real Celery app, its task (``scraper.tasks.embeddings.process_embedding_queue``) run in process with
``Task.apply``, the real batch and run record, on a fresh real Postgres 16 + pgvector database migrated
by the real ``python -m scraper.migrate`` (the ``corpus_db`` fixture), with the Annex A DDL applied to it
twice first, as CI applies it to the server's own database. The two cases that need separate processes
(two worker children at once, a child killed) are test_f27_embedding_prefork_e2e.py.

The OpenAI package is the one stand-in: an in-process module whose ``AsyncOpenAI`` counts every call
per queued row (no network, and the configured key is a plain label, not key-shaped). Time passing is
simulated by moving the queue's timestamps back, as F28's tests do with ``started_at``.

Spec: docs/superpowers/specs/2026-10-18-f27-leased-embedding-claims-design.md (rulings R1-R16).
Expected values are written out from the spec, including the operation identity formula (R4), not
imported from the code under test. Synthetic fixtures only; nothing leaves the machine.
"""

import asyncio
import hashlib
import json
import logging
import re
import signal
import sys
import threading
import types
import uuid

from test_f20_trust_policy_db import _threaded, assert_migrated, execute, fetch, run
from test_f28_source_outcomes_e2e import fire, jobs, no_sleep

PROVIDER_LABEL = "f27-local-stand-in"  # what settings.OPENAI_API_KEY holds here; never sent anywhere
MODEL = "text-embedding-3-small"
DIMENSIONS = 1536
TOKENS = 7
REAL_SLEEP = asyncio.sleep
BACKOFF = [300, 600, 1200, 2400]  # spec R8: outcomes.retry_countdown(attempts - 1), attempts 1-4
MAX_ATTEMPTS = 5  # the row's own max_attempts default (models.EmbeddingQueue)
ROW = re.compile(r"F27-ROW-(\d{3})")
ALERT = "F28 source alert: embedding_queue "


# ---------------------------------------------------------------------------------------------
# the provider stand-in
# ---------------------------------------------------------------------------------------------
def marker_of(text):
    found = ROW.search(text or "")
    return int(found.group(1)) if found else (text or "")[:40]


def vector_for(text):
    """A deterministic vector per input text, so a test can tell which text a stored vector came from."""
    return [((sum(map(ord, text)) % 997) + 1) / 1000.0] + [0.001] * (DIMENSIONS - 1)


class Provider:
    """The OpenAI package as an in-process module. ``calls`` holds (row marker, model, thread id) for
    every request; ``fail`` lists markers whose requests raise; ``latency`` is a real wait inside each
    request; ``during_call`` is awaited inside a request (to change a record while the call is out)."""

    def __init__(self):
        self.calls = []
        self.fail = set()
        self.latency = 0.0
        self.during_call = None
        self._lock = threading.Lock()

    def install(self, monkeypatch):
        from scraper import config

        provider = self
        module = types.ModuleType("openai")

        class F27ProviderOutage(Exception):
            pass

        class _Embeddings:
            async def create(self, model, input):
                marker = marker_of(input)
                with provider._lock:
                    provider.calls.append((marker, model, threading.get_ident()))
                if provider.latency:
                    await REAL_SLEEP(provider.latency)
                if provider.during_call is not None:
                    await provider.during_call(marker)
                if marker in provider.fail:
                    raise F27ProviderOutage("synthetic F27 provider outage")
                return types.SimpleNamespace(
                    data=[types.SimpleNamespace(embedding=vector_for(input))],
                    usage=types.SimpleNamespace(prompt_tokens=TOKENS, total_tokens=TOKENS),
                )

        class AsyncOpenAI:
            def __init__(self, api_key):
                self.embeddings = _Embeddings()

        module.AsyncOpenAI = AsyncOpenAI
        monkeypatch.setitem(sys.modules, "openai", module)
        monkeypatch.setattr(config.settings, "OPENAI_API_KEY", PROVIDER_LABEL)
        return self

    def per_row(self):
        counts = {}
        for marker, _, _ in self.calls:
            counts[marker] = counts.get(marker, 0) + 1
        return counts


# ---------------------------------------------------------------------------------------------
# database helpers (each works on main's schema too, so the RED run fails by assertion)
# ---------------------------------------------------------------------------------------------
def migrated(corpus_db):
    corpus_db.apply_annex_a()
    corpus_db.apply_annex_a()  # twice: the DDL is idempotent (CI applies it twice too)
    assert_migrated(corpus_db.migrate(), corpus_db)


def seed_statutes(first, count, *, age="2 days"):
    """``count`` statute sections, rows ``first`` .. ``first + count - 1``, each queued; row n is
    queued ``age`` ago plus n seconds, so the queue order is the row order."""
    run(execute(
        "INSERT INTO statutes_master (statute_name, short_name, section_number, section_text, source_site) "
        "SELECT 'Synthetic F27 Act 2099', 'F27A', 's' || g, "
        "'Section text F27-ROW-' || lpad(g::text, 3, '0') || '. Synthetic F27 fixture, not a real statute.', 'F27Fixture' "
        "FROM generate_series(CAST(:a AS int), CAST(:b AS int)) g",
        "INSERT INTO embedding_queue (record_id, table_name, created_at) "
        "SELECT id, 'statutes_master', now() - CAST(CAST(:age AS text) AS interval) + substr(section_number, 2)::int * interval '1 second' "
        "FROM statutes_master WHERE source_site = 'F27Fixture' AND substr(section_number, 2)::int BETWEEN :a AND :b",
        params={"a": first, "b": first + count - 1, "age": age},
    ))


def queue_by_row():
    """{row marker: (status, attempts, error_type, has vector)} for every queued statute section."""
    rows = run(fetch(
        "SELECT s.section_text, q.status, q.attempts, q.error_type, s.embedding IS NOT NULL "
        "FROM embedding_queue q JOIN statutes_master s ON s.id = q.record_id"
    ))
    return {marker_of(text): (status, attempts, error_type, has) for text, status, attempts, error_type, has in rows}


def has_column(table, column):
    return bool(run(fetch(
        "SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(:t) AND attname = :c AND NOT attisdropped",
        t=table, c=column,
    )))


def receipts(where="true", **params):
    """(outcome, token_count, held vector, reconciled, error_type) per receipt, oldest first; [] when the
    receipt table does not exist (main)."""
    if not run(fetch("SELECT to_regclass('embedding_attempts') IS NOT NULL"))[0][0]:
        return []
    return [tuple(r) for r in run(fetch(
        "SELECT outcome, token_count, embedding IS NOT NULL, reconciled, error_type FROM embedding_attempts "
        f"WHERE {where} ORDER BY started_at, id", **params,
    ))]


def make_due():
    """Simulated time: every waiting row's retry is due now."""
    run(execute("UPDATE embedding_queue SET next_attempt_at = now() - interval '1 second' WHERE next_attempt_at IS NOT NULL"))


def operation_id(table, record_id, text, model=MODEL, dimensions=DIMENSIONS):
    """Spec R4, written out: sha256 of the canonical JSON array (no whitespace, ASCII)."""
    material = ["f27-embedding-op-v1", table, str(record_id), model, dimensions,
                hashlib.sha256(text.encode("utf-8")).hexdigest()]
    return hashlib.sha256(json.dumps(material, separators=(",", ":")).encode("ascii")).hexdigest()


def statute_text(row):
    """The text main and the branch send for a seeded section (statute name, section number, text)."""
    return (f"Synthetic F27 Act 2099 s{row} Section text F27-ROW-{row:03d}. "
            "Synthetic F27 fixture, not a real statute.")


def summary(result):
    return result.result if isinstance(result.result, dict) else {}


# ---------------------------------------------------------------------------------------------
# R9: missing and malformed rows leave the window
# ---------------------------------------------------------------------------------------------
def test_r9_missing_record_rows_are_dead_lettered_and_stop_holding_the_window(corpus_db, monkeypatch):
    """50 rows whose records are gone sit at the head of the queue, 10 good rows behind them. On main
    every run selects the same 50 missing rows (no order, no state change), so the good rows wait
    forever. Here the first run dead-letters the 50 (record_missing), the second embeds the 10 and the
    third has nothing to claim. Spec R9, R1."""
    migrated(corpus_db)
    run(execute(
        "INSERT INTO embedding_queue (record_id, table_name, created_at) "
        "SELECT gen_random_uuid(), 'statutes_master', now() - interval '3 days' + g * interval '1 second' "
        "FROM generate_series(1, 50) g"
    ))
    seed_statutes(101, 10)
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    runs = [summary(fire("process-embeddings")) for _ in range(3)]

    windows = [(s.get("claimed"), s.get("missing"), s.get("completed"), s.get("dead_lettered")) for s in runs]
    assert windows == [(50, 50, 0, 50), (10, 0, 10, 0), (0, 0, 0, 0)], (
        f"(claimed, missing, completed, dead_lettered) per run: {windows}")
    assert runs[0]["dead_letter_reasons"] == {"record_missing": 50}, runs[0]
    dead = run(fetch("SELECT status, error_type, count(*) FROM embedding_queue "
                     "WHERE record_id NOT IN (SELECT id FROM statutes_master) GROUP BY 1, 2"))
    assert [tuple(r) for r in dead] == [("dead_letter", "record_missing", 50)], dead
    assert provider.per_row() == {n: 1 for n in range(101, 111)}, provider.per_row()
    assert set(queue_by_row().values()) == {("completed", 0, None, True)}


def test_r9_unusable_rows_are_dead_lettered_with_their_reason_and_never_reach_the_provider(corpus_db, monkeypatch):
    """An unknown table, an unsupported model, a record with no text and one with no letter or digit.
    On main the first was looked up in statutes_master and stayed pending, and the other three were
    sent to the provider and paid for. Spec R9."""
    migrated(corpus_db)
    seed_statutes(1, 1)  # the control
    run(execute(
        "INSERT INTO case_law_master (court, source_site) VALUES ('Synthetic F27 Court', 'F27Empty')",
        "INSERT INTO statutes_master (short_name, section_number, section_text, source_site) "
        "VALUES (NULL, NULL, '-- . -- ; --', 'F27Malformed')",
        "INSERT INTO statutes_master (statute_name, short_name, section_number, section_text, source_site) "
        "VALUES ('Synthetic F27 Act 2099', 'F27M', 's900', 'Section text F27-ROW-900. Synthetic.', 'F27Model')",
        "INSERT INTO embedding_queue (record_id, table_name) SELECT id, 'case_law_master' FROM case_law_master WHERE source_site = 'F27Empty'",
        "INSERT INTO embedding_queue (record_id, table_name) SELECT id, 'statutes_master' FROM statutes_master WHERE source_site = 'F27Malformed'",
        "INSERT INTO embedding_queue (record_id, table_name, embedding_model, embedding_dimensions) "
        "SELECT id, 'statutes_master', 'text-embedding-3-large', 3072 FROM statutes_master WHERE source_site = 'F27Model'",
        "INSERT INTO embedding_queue (record_id, table_name) "
        "SELECT id, 'f27_not_a_corpus_table' FROM statutes_master WHERE source_site = 'F27Fixture'",
    ))
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    first = summary(fire("process-embeddings"))
    second = summary(fire("process-embeddings"))

    assert provider.per_row() == {1: 1}, f"only the control may reach the provider: {provider.per_row()}"
    states = sorted((tuple(r) for r in run(fetch("SELECT table_name, status, error_type FROM embedding_queue"))),
                    key=lambda r: tuple(str(x) for x in r))
    assert states == [
        ("case_law_master", "dead_letter", "empty_text"),
        ("f27_not_a_corpus_table", "dead_letter", "unknown_table"),
        ("statutes_master", "completed", None),
        ("statutes_master", "dead_letter", "malformed_text"),
        ("statutes_master", "dead_letter", "unsupported_model"),
    ], states
    assert first.get("dead_letter_reasons") == {
        "empty_text": 1, "malformed_text": 1, "unknown_table": 1, "unsupported_model": 1}, first
    assert (second.get("claimed"), len(provider.calls)) == (0, 1), "a dead letter is never claimed again"


# ---------------------------------------------------------------------------------------------
# R8: retry timing and the dead letter after max_attempts
# ---------------------------------------------------------------------------------------------
def test_r8_a_failed_row_waits_for_next_attempt_at_and_dead_letters_after_max_attempts(corpus_db, monkeypatch):
    """The provider fails every request for one row. On main the next batch retried it at once and
    the third failure parked it `failed` (15 minutes of beat). Here each failure sets next_attempt_at
    300, 600, 1200, 2400 s ahead, a batch before then does not touch it, and the fifth failure (the
    row's max_attempts) dead-letters it. Spec R8, R5."""
    migrated(corpus_db)
    seed_statutes(1, 1)
    provider = Provider().install(monkeypatch)
    provider.fail.add(1)
    no_sleep(monkeypatch)

    first = fire("process-embeddings")
    early = fire("process-embeddings")  # before next_attempt_at

    assert type(first.result).__name__ == "BatchFailed", repr(first.result)
    assert (len(provider.calls), queue_by_row()[1][:2]) == (1, ("pending", 1)), (
        f"a failed row must wait for next_attempt_at, not be retried by the next batch: "
        f"{len(provider.calls)} calls, row {queue_by_row()[1]}, second batch {early.state} {early.result!r}")
    delays = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if attempt > 1:
            make_due()
            fire("process-embeddings")
        assert len(provider.calls) == attempt, provider.calls
        delay = run(fetch(
            "SELECT extract(epoch FROM next_attempt_at - updated_at)::int FROM embedding_queue"))[0][0]
        delays.append(delay)
    assert delays == BACKOFF + [None], f"seconds to the next attempt after each failure: {delays}"
    assert queue_by_row()[1] == ("dead_letter", MAX_ATTEMPTS, "max_attempts", False), queue_by_row()
    message = run(fetch("SELECT error_message FROM embedding_queue"))[0][0]
    assert message == "F27ProviderOutage: synthetic F27 provider outage", message
    make_due()
    after = summary(fire("process-embeddings"))
    assert (after.get("claimed"), len(provider.calls)) == (0, MAX_ATTEMPTS), "a dead letter is never claimed again"
    assert receipts() == [("failed", None, False, False, "F27ProviderOutage")] * MAX_ATTEMPTS, receipts()


# ---------------------------------------------------------------------------------------------
# R1: concurrent batches claim disjoint, bounded windows
# ---------------------------------------------------------------------------------------------
def test_r1_two_concurrent_batches_claim_disjoint_windows_and_pay_once_per_row(corpus_db, monkeypatch):
    """Two task runs at once (two threads, two event loops, two connections) over 120 queued rows,
    each provider request taking 20 ms. On main both batches read the same 50 rows and paid for each
    one twice. Here each claims its own 50 (SKIP LOCKED), every row is paid once, and a third run
    takes the remaining 20. Spec R1, R13."""
    migrated(corpus_db)
    seed_statutes(1, 120)
    provider = Provider().install(monkeypatch)
    provider.latency = 0.02
    no_sleep(monkeypatch)

    results, errors = _threaded(lambda: fire("process-embeddings"), 2)

    assert errors == [], errors
    per_row = provider.per_row()
    paid_twice = sorted(n for n, c in per_row.items() if c > 1)
    assert paid_twice == [], f"{len(paid_twice)} rows paid more than once by two concurrent batches: {paid_twice[:10]}"
    by_thread = {}
    for marker, _, thread in provider.calls:
        by_thread.setdefault(thread, set()).add(marker)
    assert sorted(len(rows) for rows in by_thread.values()) == [50, 50], {t: len(r) for t, r in by_thread.items()}
    assert sorted(summary(r).get("claimed") for r in results) == [50, 50], [summary(r) for r in results]
    third = summary(fire("process-embeddings"))
    assert (third.get("claimed"), len(provider.calls), len(provider.per_row())) == (20, 120, 120), third
    assert set(queue_by_row().values()) == {("completed", 0, None, True)}


# ---------------------------------------------------------------------------------------------
# R4, R6, R7: the operation identity
# ---------------------------------------------------------------------------------------------
def test_r6_an_unchanged_operation_queued_again_is_not_paid_twice(corpus_db, monkeypatch):
    """A completed row is queued again with its record unchanged (an operator's re-run, a re-enqueue).
    On main the batch paid for the same text again. Here the operation is the one the record already
    holds, so it completes with no call; after the text changes it is a new operation, paid once.
    Spec R4, R6."""
    migrated(corpus_db)
    seed_statutes(1, 1)
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    fire("process-embeddings")
    run(execute("UPDATE embedding_queue SET status = 'pending'"))
    again = summary(fire("process-embeddings"))

    assert (len(provider.calls), again.get("completed"), again.get("reused")) == (1, 1, 1), (
        f"the same operation was paid {len(provider.calls)} times: {again}")
    run(execute(
        "UPDATE statutes_master SET section_text = section_text || ' Amended.' WHERE source_site = 'F27Fixture'",
        "UPDATE embedding_queue SET status = 'pending'",
    ))
    changed = summary(fire("process-embeddings"))
    assert (len(provider.calls), changed.get("reused")) == (2, 0), changed
    statute_id = run(fetch("SELECT id FROM statutes_master WHERE source_site = 'F27Fixture'"))[0][0]
    stored = run(fetch("SELECT stored_operation_id FROM embedding_queue"))[0][0]
    assert stored == operation_id("statutes_master", statute_id, statute_text(1) + " Amended."), stored


def test_r7_a_record_changed_during_the_call_is_not_stored_with_the_stale_vector(corpus_db, monkeypatch):
    """The record's text changes while its provider request is out. On main the vector of the old
    text was stored and the row completed. Here the store sees another operation under the record's
    lock: nothing is stored, the receipt is superseded, the row is due again without being charged,
    and the next batch embeds the new text. One call per operation. Spec R7."""
    migrated(corpus_db)
    seed_statutes(1, 1)
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)
    amended = "Section text F27-ROW-001 amended while the request was out. Synthetic F27 fixture."

    async def amend_once(marker):
        if len(provider.calls) == 1:
            await execute("UPDATE statutes_master SET section_text = :t WHERE source_site = 'F27Fixture'",
                          params={"t": amended})

    provider.during_call = amend_once

    first = summary(fire("process-embeddings"))

    assert (queue_by_row()[1], first.get("superseded")) == (("pending", 0, None, False), 1), (
        f"a vector of the old text was stored: row {queue_by_row()[1]}, summary {first}")
    second = summary(fire("process-embeddings"))
    assert (len(provider.calls), second.get("completed")) == (2, 1), second
    head = run(fetch("SELECT (embedding::real[])[1] FROM statutes_master WHERE source_site = 'F27Fixture'"))[0][0]
    want = vector_for(f"Synthetic F27 Act 2099 s1 {amended}")[0]
    assert abs(head - want) < 1e-6, f"stored vector head {head}, the new text's {want}"
    assert [r[0] for r in receipts()] == ["superseded", "stored"], receipts()


# ---------------------------------------------------------------------------------------------
# R3, R5, R6: a crash left in the database (no main equivalent: main holds no lease or receipt)
# ---------------------------------------------------------------------------------------------
def test_r3_an_expired_lease_is_reclaimed_once_and_an_answered_vector_is_stored_without_a_second_call(corpus_db, monkeypatch):
    """The state a killed batch leaves (the real kill is test_f27_embedding_prefork_e2e.py): row 1 was
    in flight (a `started` receipt), row 2 had its answer (an `answered` receipt holding the vector),
    both still `processing` under a lease that has expired; row 3 is held by a live batch. The next
    batch reclaims rows 1 and 2 and leaves row 3 alone. Row 1's request had no known outcome: one
    attempt is counted and its receipt abandoned. Row 2's answer was paid and is held: it is not
    charged (review round 1), is due at once and the same batch stores it from its receipt with no
    call. Once due, row 1 is paid for. Spec R3, R5, R6."""
    migrated(corpus_db)
    seed_statutes(1, 3)
    ids = {marker_of(t): i for i, t in run(fetch("SELECT id, section_text FROM statutes_master"))}
    dead_batch, live_batch = uuid.uuid4(), uuid.uuid4()
    run(execute(
        "UPDATE embedding_queue SET status = 'processing', lease_owner = :dead, "
        "lease_expires_at = now() - interval '1 minute', last_attempt_at = now() - interval '70 minutes' "
        "WHERE record_id IN (:r1, :r2)",
        "UPDATE embedding_queue SET status = 'processing', lease_owner = :live, "
        "lease_expires_at = now() + interval '30 minutes' WHERE record_id = :r3",
        "INSERT INTO embedding_attempts (operation_id, queue_id, table_name, record_id, model, dimensions, "
        "lease_owner, attempt, outcome, started_at) SELECT :op1, id, table_name, record_id, :model, :dims, :dead, 1, "
        "'started', now() - interval '70 minutes' FROM embedding_queue WHERE record_id = :r1",
        "INSERT INTO embedding_attempts (operation_id, queue_id, table_name, record_id, model, dimensions, "
        "lease_owner, attempt, outcome, started_at, answered_at, token_count, embedding) "
        "SELECT :op2, id, table_name, record_id, :model, :dims, :dead, 1, 'answered', now() - interval '69 minutes', "
        "now() - interval '69 minutes', 7, CAST(:vec AS vector) FROM embedding_queue WHERE record_id = :r2",
        params={"dead": dead_batch, "live": live_batch, "r1": ids[1], "r2": ids[2], "r3": ids[3], "model": MODEL,
                "dims": DIMENSIONS, "op1": operation_id("statutes_master", ids[1], statute_text(1)),
                "op2": operation_id("statutes_master", ids[2], statute_text(2)),
                "vec": json.dumps(vector_for(statute_text(2)), separators=(",", ":"))},
    ))
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    recovered = summary(fire("process-embeddings"))

    assert (recovered.get("reclaimed"), recovered.get("claimed"), recovered.get("reused"), len(provider.calls)) == (
        2, 1, 1, 0), recovered
    rows = queue_by_row()
    assert (rows[1], rows[2], rows[3]) == (
        ("pending", 1, "lease_expired", False), ("completed", 0, None, True), ("processing", 0, None, False),
    ), rows
    assert receipts() == [("abandoned", None, False, False, None), ("stored", 7, False, True, None)], receipts()
    record = jobs("embedding_queue", job_type="embed")
    assert [(r.status, r.result_summary["reclaimed"]) for r in record] == [("completed", 2)], record

    make_due()
    done = summary(fire("process-embeddings"))

    assert (done.get("completed"), done.get("reused"), provider.per_row()) == (1, 0, {1: 1}), done
    rows = queue_by_row()
    assert (rows[1], rows[2]) == (("completed", 1, None, True), ("completed", 0, None, True)), rows
    assert receipts() == [
        ("abandoned", None, False, False, None), ("stored", 7, False, True, None), ("stored", TOKENS, False, False, None),
    ], receipts()


# Review round 1 (Codex P2, thread 4307196399): a row on its last attempt whose answer was already paid.
def leave_crashed(section, statute_id, *, outcome, text, attempts_left=1):
    """Queue row ``section`` as a batch that died leaves it: `processing` under a lease that expired a
    minute ago, ``attempts_left`` attempts before its max_attempts, and one receipt for the operation of
    ``text``: `started` (the request was out, its outcome unknown) or `answered` (paid, vector held)."""
    run(execute(
        "UPDATE embedding_queue q SET status = 'processing', attempts = q.max_attempts - :left, lease_owner = :dead, "
        "lease_expires_at = now() - interval '1 minute', last_attempt_at = now() - interval '70 minutes' "
        "FROM statutes_master s WHERE s.id = q.record_id AND s.section_number = :sn",
        "INSERT INTO embedding_attempts (operation_id, queue_id, table_name, record_id, model, dimensions, lease_owner, "
        "attempt, outcome, started_at, answered_at, token_count, embedding) "
        "SELECT :op, q.id, q.table_name, q.record_id, :model, :dims, :dead, q.max_attempts - :left + 1, "
        "CAST(:outcome AS text), now() - interval '69 minutes', "
        "CASE WHEN CAST(:outcome AS text) = 'answered' THEN now() - interval '69 minutes' END, "
        "CASE WHEN CAST(:outcome AS text) = 'answered' THEN 7 END, "
        "CASE WHEN CAST(:outcome AS text) = 'answered' THEN CAST(:vec AS vector) END "
        "FROM embedding_queue q JOIN statutes_master s ON s.id = q.record_id WHERE s.section_number = :sn",
        params={"left": attempts_left, "dead": uuid.uuid4(), "sn": section, "outcome": outcome, "model": MODEL,
                "dims": DIMENSIONS, "op": operation_id("statutes_master", statute_id, text),
                "vec": json.dumps(vector_for(text), separators=(",", ":"))},
    ))


def test_r3_a_row_on_its_last_attempt_whose_answer_was_paid_is_stored_not_dead_lettered(corpus_db, monkeypatch):
    """The batch died on the row's last attempt after the provider answered: the `answered` receipt
    holds the paid vector. At fa56eee the reclaim charged the row unconditionally, so it went straight
    to the dead letter, which is never claimed, and the paid vector was stranded. Now an expired row
    whose current operation has a held answer is not charged: it is due at once and the same batch
    stores it from the receipt, with no request. Spec R3 (review round 1), R6."""
    migrated(corpus_db)
    seed_statutes(1, 1)
    statute_id = run(fetch("SELECT id FROM statutes_master"))[0][0]
    leave_crashed("s1", statute_id, outcome="answered", text=statute_text(1))
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    result = summary(fire("process-embeddings"))

    assert (queue_by_row()[1], len(provider.calls)) == (("completed", MAX_ATTEMPTS - 1, None, True), 0), (
        f"the paid answer of the last attempt was stranded: row {queue_by_row()[1]}, receipts {receipts()}, "
        f"{len(provider.calls)} requests, summary {result}")
    assert receipts() == [("stored", 7, False, True, None)], receipts()
    assert (result.get("reclaimed"), result.get("claimed"), result.get("reused")) == (1, 1, 1), result


def test_r3_a_row_on_its_last_attempt_with_only_a_started_receipt_is_dead_lettered(corpus_db, monkeypatch):
    """The batch died on the last attempt with the request out: whether the provider answered (and
    billed) is unknown and no vector is held, so the crash is the row's last failed attempt. The row
    goes to the dead letter (`max_attempts`) and the receipt is `abandoned`; nothing is requested."""
    migrated(corpus_db)
    seed_statutes(1, 1)
    statute_id = run(fetch("SELECT id FROM statutes_master"))[0][0]
    leave_crashed("s1", statute_id, outcome="started", text=statute_text(1))
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    result = summary(fire("process-embeddings"))

    assert queue_by_row()[1] == ("dead_letter", MAX_ATTEMPTS, "max_attempts", False), queue_by_row()
    assert receipts() == [("abandoned", None, False, False, None)], receipts()
    assert (len(provider.calls), result.get("dead_letter_reasons")) == (0, {"max_attempts": 1}), result


def test_r3_a_row_whose_text_changed_since_its_answer_is_charged_and_the_stale_vector_dropped(corpus_db, monkeypatch):
    """The held answer is for text the record no longer has (R7): it can never be stored, so it does
    not spare the row. On its last attempt the row goes to the dead letter, and the stale vector is
    dropped (`superseded`) instead of being held forever. At fa56eee the receipt kept the vector."""
    migrated(corpus_db)
    seed_statutes(1, 1)
    statute_id = run(fetch("SELECT id FROM statutes_master"))[0][0]
    leave_crashed("s1", statute_id, outcome="answered", text=statute_text(1))
    run(execute("UPDATE statutes_master SET section_text = section_text || ' Amended.'"))
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    summary(fire("process-embeddings"))

    assert queue_by_row()[1] == ("dead_letter", MAX_ATTEMPTS, "max_attempts", False), queue_by_row()
    assert receipts() == [("superseded", 7, False, False, None)], (
        f"a vector of text the record no longer has is still held: {receipts()}")
    assert provider.calls == []


# ---------------------------------------------------------------------------------------------
# R2: fencing (no main equivalent: main holds no lease)
# ---------------------------------------------------------------------------------------------
def test_r2_a_batch_that_lost_its_lease_writes_nothing_to_the_row_or_the_record(corpus_db, monkeypatch):
    """While the request is out, the row passes to another holder (what a reclaim and a new claim
    would do to a batch that outlived its lease). Every write to a claimed row is fenced on the
    batch's token, so the old batch's store fails (LeaseLost) and is rolled back: the record gets no
    vector, the row stays with its new holder, and the paid answer stays in its receipt for whoever
    holds the operation next. Spec R2, R5."""
    migrated(corpus_db)
    seed_statutes(1, 1)
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)
    other_batch = uuid.uuid4()

    async def overtaken(marker):
        await execute("UPDATE embedding_queue SET lease_owner = :o", params={"o": other_batch})

    provider.during_call = overtaken

    result = fire("process-embeddings")

    assert (result.state, type(result.result).__name__) == ("FAILURE", "LeaseLost"), repr(result.result)
    assert queue_by_row()[1] == ("processing", 0, None, False), queue_by_row()
    assert run(fetch("SELECT lease_owner FROM embedding_queue"))[0][0] == other_batch
    assert receipts() == [("answered", TOKENS, True, False, None)], receipts()


# ---------------------------------------------------------------------------------------------
# R10: a batch that ends abnormally gives back what it holds
# ---------------------------------------------------------------------------------------------
def test_r10_a_batch_failed_by_the_database_keeps_its_paid_answer_and_gives_back_the_rest(corpus_db, monkeypatch):
    """Three rows; the database refuses row 2's vector write (a trigger, SQLSTATE 23514), after the
    provider answered. The batch fails (F28 R4). On main row 2 stayed `pending` uncharged with nothing
    kept, so the next batch paid for it again. Here row 2's answered vector is kept in its receipt,
    the failed store is counted on that receipt instead of charging the row (review round 2: a store
    of a paid answer is not a provider attempt), row 3 goes back untouched, and the next batch stores
    row 2's answer with no second request. Spec R10, R6, R5."""
    migrated(corpus_db)
    seed_statutes(1, 3)
    corpus_db.admin(
        "CREATE FUNCTION f27_refuse_row_2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
        "IF NEW.embedding IS NOT NULL AND NEW.section_number = 's2' THEN "
        "RAISE EXCEPTION 'synthetic F27 vector write failure' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$",
        "CREATE TRIGGER f27_refuse_row_2 BEFORE UPDATE ON statutes_master FOR EACH ROW EXECUTE FUNCTION f27_refuse_row_2()",
    )
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    failed = fire("process-embeddings")

    assert failed.state == "FAILURE", repr(failed.result)
    rows = queue_by_row()
    assert (rows[1], rows[2], rows[3]) == (
        ("completed", 0, None, True), ("pending", 0, "IntegrityError", False), ("pending", 0, None, False)), rows
    due = run(fetch("SELECT q.next_attempt_at IS NULL FROM embedding_queue q "
                    "JOIN statutes_master s ON s.id = q.record_id WHERE s.section_number = 's2'"))[0][0]
    assert due, "the held answer's store is retried at once"
    assert [r[:3] for r in receipts()] == [("stored", TOKENS, False), ("answered", TOKENS, True)], receipts()
    summary_row = jobs("embedding_queue", job_type="embed")[0].result_summary
    assert (summary_row["claimed"], summary_row["completed"], summary_row["failed"], summary_row["released"]) == (3, 1, 1, 1), summary_row

    corpus_db.admin("DROP TRIGGER f27_refuse_row_2 ON statutes_master")
    make_due()
    done = summary(fire("process-embeddings"))

    assert (provider.per_row(), done.get("reused")) == ({1: 1, 2: 1, 3: 1}, 1), (
        f"requests per row {provider.per_row()}: row 2's paid answer must be stored, not paid for again; {done}")
    assert set(queue_by_row().values()) == {("completed", 0, None, True)}


# Review round 2 (Bugbot 4307417933): a store of a paid answer that fails is bounded on its receipt.
STORE_RETRY_LIMIT = 3  # spec R10 (review round 2)
REFUSE_VECTOR = (
    "CREATE FUNCTION f27_refuse_vector() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
    "IF NEW.embedding IS NOT NULL THEN "
    "RAISE EXCEPTION 'synthetic F27 vector write failure' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER f27_refuse_vector BEFORE UPDATE ON statutes_master FOR EACH ROW EXECUTE FUNCTION f27_refuse_vector()",
)
REQUEUE = ("UPDATE embedding_queue SET status = 'pending', attempts = 0, next_attempt_at = NULL, "
           "error_type = NULL, error_message = NULL")  # the README's requeue statement, for every row


def store_failures():
    return [n for (n,) in run(fetch("SELECT store_failures FROM embedding_attempts ORDER BY started_at, id"))]


def test_r10_a_store_that_fails_on_the_last_attempt_keeps_the_row_and_its_paid_answer(corpus_db, monkeypatch):
    """Review round 2 (Bugbot 4307417933). The row is on its last attempt (4 of 5); the provider
    answers, the `answered` receipt commits, then the database refuses the vector write (a trigger,
    SQLSTATE 23514: a database error inside `_store`). At 132957c the give-back charged the row, which
    sent it to the dead letter with the paid vector held in a receipt nothing claims. Now a failed
    store of a held answer does not charge the row: it is due again at once, and once the database
    accepts the write the answer is stored with no new request."""
    migrated(corpus_db)
    seed_statutes(1, 1)
    run(execute("UPDATE embedding_queue SET attempts = max_attempts - 1"))
    corpus_db.admin(*REFUSE_VECTOR)
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    failed = fire("process-embeddings")

    assert failed.state == "FAILURE", repr(failed.result)
    assert (queue_by_row()[1], receipts()) == (
        ("pending", MAX_ATTEMPTS - 1, "IntegrityError", False), [("answered", 7, True, False, None)]), (
        f"the paid answer was stranded: row {queue_by_row()[1]}, receipts {receipts()}")
    assert store_failures() == [1]
    corpus_db.admin("DROP TRIGGER f27_refuse_vector ON statutes_master")
    done = summary(fire("process-embeddings"))
    assert (queue_by_row()[1], len(provider.calls), done.get("reused")) == (
        ("completed", MAX_ATTEMPTS - 1, None, True), 1, 1), done
    assert receipts() == [("stored", 7, False, True, None)], receipts()


def test_r10_a_paid_answer_the_database_keeps_refusing_is_dead_lettered_after_three_stores_and_kept(corpus_db, monkeypatch):
    """Review round 2: the bound. The database refuses the vector write every time (a deterministic
    refusal). Each batch retries the store of the held answer, uncharged, with no new request; the
    third failed store sends the row to the dead letter as `store_failed`, its attempts untouched and
    the vector kept in the `answered` receipt. No retry-forever loop (with Autofix ee8ee02's uncharged
    give-back the row went back to pending after every failure). After the operator fixes the cause
    and requeues the row (README), the kept answer is stored with no new request."""
    migrated(corpus_db)
    seed_statutes(1, 1)
    corpus_db.admin(*REFUSE_VECTOR)
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    runs = [fire("process-embeddings") for _ in range(STORE_RETRY_LIMIT)]

    assert [r.state for r in runs] == ["FAILURE"] * STORE_RETRY_LIMIT, [repr(r.result) for r in runs]
    assert (queue_by_row()[1], receipts(), len(provider.calls)) == (
        ("dead_letter", 0, "store_failed", False), [("answered", 7, True, False, None)], 1), (
        f"row {queue_by_row()[1]}, receipts {receipts()}, {len(provider.calls)} requests")
    assert store_failures() == [STORE_RETRY_LIMIT]
    assert summary(fire("process-embeddings")).get("claimed") == 0, "a dead letter is never claimed again"
    corpus_db.admin("DROP TRIGGER f27_refuse_vector ON statutes_master")
    run(execute(REQUEUE))
    done = summary(fire("process-embeddings"))
    assert (queue_by_row()[1], len(provider.calls), done.get("reused")) == (("completed", 0, None, True), 1, 1), done


def test_r3_a_row_whose_storing_batch_was_lost_three_times_is_dead_lettered_with_its_answer_kept(corpus_db, monkeypatch):
    """Review round 2: the bound on round 1's residual. A reclaim that finds a held answer counts the
    lost batch as a failed store of that answer; when the count reaches the bound (here the receipt
    already shows 2), the row goes to the dead letter as `store_failed` instead of cycling uncharged
    forever, its attempts untouched and the vector kept; a requeue stores it with no new request. (No
    132957c equivalent: the count is new.)"""
    migrated(corpus_db)
    seed_statutes(1, 1)
    statute_id = run(fetch("SELECT id FROM statutes_master"))[0][0]
    leave_crashed("s1", statute_id, outcome="answered", text=statute_text(1), attempts_left=MAX_ATTEMPTS)
    run(execute("UPDATE embedding_attempts SET store_failures = :n", params={"n": STORE_RETRY_LIMIT - 1}))
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    result = summary(fire("process-embeddings"))

    assert (queue_by_row()[1], receipts()) == (("dead_letter", 0, "store_failed", False), [("answered", 7, True, False, None)]), (
        queue_by_row(), receipts())
    assert (store_failures(), len(provider.calls), result.get("dead_letter_reasons"), result.get("reclaimed_answered")) == (
        [STORE_RETRY_LIMIT], 0, {"store_failed": 1}, 0), result
    run(execute(REQUEUE))
    done = summary(fire("process-embeddings"))
    assert (queue_by_row()[1], len(provider.calls), done.get("reused")) == (("completed", 0, None, True), 0, 1), done


def test_r10_an_interrupted_request_leaves_an_interrupted_receipt_and_its_row_uncharged(corpus_db, monkeypatch):
    """The soft time limit lands while the provider request is out (F28's SIGALRM emulation of
    billiard's handler). F28 R26 already keeps the row `pending` with its attempt count; F27 adds the
    receipt: the request was committed as `started` before it was sent, so the record shows a request
    whose answer never came (it may have been billed), as `interrupted`. On main there was none."""
    from test_f28_fu_e2e import soft_limit_on_sigalrm

    migrated(corpus_db)
    seed_statutes(1, 2)
    provider = Provider().install(monkeypatch)

    async def cut_off(marker):
        signal.setitimer(signal.ITIMER_REAL, 0.3)
        await REAL_SLEEP(3)
        raise AssertionError("the time limit should have cut this request off")

    provider.during_call = cut_off

    with soft_limit_on_sigalrm():
        result = fire("process-embeddings")

    assert (result.state, type(result.result).__name__) == ("FAILURE", "SoftTimeLimitExceeded"), repr(result.result)
    assert receipts() == [("interrupted", None, False, False, None)], receipts()
    assert queue_by_row() == {1: ("pending", 0, None, False), 2: ("pending", 0, None, False)}, queue_by_row()
    summary_row = jobs("embedding_queue", job_type="embed")[0].result_summary
    assert (summary_row["claimed"], summary_row["released"], summary_row["interrupted_by"]) == (2, 2, "CancelledError"), summary_row


def test_r10_a_charged_failure_records_its_receipt_as_failed_not_interrupted(corpus_db, monkeypatch):
    """Review round 1 (Bugbot 4307214719). The provider answered, but the database refused the
    `answered` write (a trigger, SQLSTATE 23514), so the batch fails with the receipt still `started`.
    The row in flight is charged (R10), so its receipt must say `failed` with the same error type as
    the row, as `_failed` records any charged attempt. At fa56eee the give-back turned it into
    `interrupted`, the outcome R10 keeps for an uncharged time-limit cut-off, so the receipt disagreed
    with the row. Neither `failed` nor `interrupted` is reused (R6) or abandoned (R3)."""
    migrated(corpus_db)
    seed_statutes(1, 1)
    corpus_db.admin(
        "CREATE FUNCTION f27_refuse_answer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
        "IF NEW.outcome = 'answered' THEN "
        "RAISE EXCEPTION 'synthetic F27 receipt write failure' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$",
        "CREATE TRIGGER f27_refuse_answer BEFORE UPDATE ON embedding_attempts FOR EACH ROW EXECUTE FUNCTION f27_refuse_answer()",
    )
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    result = fire("process-embeddings")

    assert result.state == "FAILURE", repr(result.result)
    row = queue_by_row()[1]
    assert receipts() == [("failed", None, False, False, row[2])], (
        f"the charged row says {row}, its receipt {receipts()}")
    assert row[:3] == ("pending", 1, "IntegrityError"), row
    corpus_db.admin("DROP TRIGGER f27_refuse_answer ON embedding_attempts")
    make_due()
    again = summary(fire("process-embeddings"))
    assert (again.get("completed"), again.get("reused"), len(provider.calls)) == (1, 0, 2), (
        "a failed receipt holds no answer: the row is paid for again", again)


# ---------------------------------------------------------------------------------------------
# R11: alerts through F28's corpus alert path
# ---------------------------------------------------------------------------------------------
def test_r11_a_batch_that_fails_after_dead_lettering_still_raises_its_alerts(corpus_db, monkeypatch, caplog):
    """Review round 1 (Bugbot 4307214725). The batch dead-letters a row whose record is gone, then
    fails on the next row (the database refuses its vector write). At fa56eee the alerts were
    evaluated only after a clean item loop, so this failed batch logged no `F28 source alert` line and
    recorded `alerts: []`. R11: every keyed batch evaluates them, failed ones included, and the
    batch's own exception still reaches Celery."""
    migrated(corpus_db)
    seed_statutes(1, 1, age="2 days")
    run(execute(
        "INSERT INTO embedding_queue (record_id, table_name, created_at) "
        "VALUES (gen_random_uuid(), 'statutes_master', now() - interval '3 days')"
    ))
    corpus_db.admin(
        "CREATE FUNCTION f27_refuse_vector() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
        "IF NEW.embedding IS NOT NULL THEN "
        "RAISE EXCEPTION 'synthetic F27 vector write failure' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$",
        "CREATE TRIGGER f27_refuse_vector BEFORE UPDATE ON statutes_master FOR EACH ROW EXECUTE FUNCTION f27_refuse_vector()",
    )
    Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    with caplog.at_level(logging.ERROR):
        result = fire("process-embeddings")

    assert (result.state, type(result.result).__name__) == ("FAILURE", "IntegrityError"), repr(result.result)
    record = jobs("embedding_queue", job_type="embed")
    assert [r.status for r in record] == ["failed"], record
    kinds = sorted(a.split(":")[0] for a in record[0].result_summary.get("alerts", []))
    assert kinds == ["backlog_stale", "dead_letter"], f"the failed batch recorded alerts {record[0].result_summary.get('alerts')}"
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith(ALERT)]
    assert sorted(line[len(ALERT):].split(":")[0] for line in lines) == ["backlog_stale", "dead_letter"], lines


def test_r11_alerts_that_cannot_be_evaluated_never_replace_a_failed_batchs_own_error(corpus_db, monkeypatch, caplog):
    """Review round 1, on Bugbot Autofix c2266ae: evaluating the alerts in a `finally` meant an alert
    query that fails (here it divides by zero, SQLSTATE 22012) replaced the batch's own error, so the
    batch was recorded and raised as the alert's failure instead of its own (an interruption would
    have been lost the same way). The batch's error (the refused vector write, 23514) must reach Celery
    and its record; the alert failure is logged."""
    from scraper.tasks import embeddings

    migrated(corpus_db)
    seed_statutes(1, 1)
    corpus_db.admin(
        "CREATE FUNCTION f27_refuse_vector() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
        "IF NEW.embedding IS NOT NULL THEN "
        "RAISE EXCEPTION 'synthetic F27 vector write failure' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$",
        "CREATE TRIGGER f27_refuse_vector BEFORE UPDATE ON statutes_master FOR EACH ROW EXECUTE FUNCTION f27_refuse_vector()",
    )
    monkeypatch.setattr(embeddings, "ALERT_STATE_SQL", "SELECT now(), now(), 1 / (CAST(:cap_plus_one AS int) * 0)")
    Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    with caplog.at_level(logging.ERROR):
        result = fire("process-embeddings")

    assert (result.state, type(result.result).__name__) == ("FAILURE", "IntegrityError"), repr(result.result)
    record = jobs("embedding_queue", job_type="embed")
    assert [r.status for r in record] == ["failed"] and "23514" in record[0].error_message, (
        [(r.status, r.error_message) for r in record])
    assert any("could not evaluate the embedding alerts" in r.getMessage() and "22012" in r.getMessage()
               for r in caplog.records), [r.getMessage() for r in caplog.records][-5:]


def test_r11_alerts_that_cannot_be_evaluated_never_fail_a_batch_whose_work_succeeded(corpus_db, monkeypatch, caplog):
    """Review round 1 (adopted from Autofix 6cbed24): the batch embeds its row, then the alert query
    fails (22012). The row's vector and the batch's `embed` record stand and Celery records SUCCESS;
    the alert failure is logged at ERROR. At bb02611 the alert error failed a batch whose work had
    already committed."""
    from scraper.tasks import embeddings

    migrated(corpus_db)
    seed_statutes(1, 1)
    monkeypatch.setattr(embeddings, "ALERT_STATE_SQL", "SELECT now(), now(), 1 / (CAST(:cap_plus_one AS int) * 0)")
    Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    with caplog.at_level(logging.ERROR):
        result = fire("process-embeddings")

    assert result.state == "SUCCESS", repr(result.result)
    assert queue_by_row()[1] == ("completed", 0, None, True), queue_by_row()
    assert [r.status for r in jobs("embedding_queue", job_type="embed")] == ["completed"]
    assert any("could not evaluate the embedding alerts" in r.getMessage() and "22012" in r.getMessage()
               for r in caplog.records), [r.getMessage() for r in caplog.records][-5:]
def test_r11_a_stale_backlog_and_new_dead_letters_raise_the_corpus_alert(corpus_db, monkeypatch, caplog):
    """A row queued two days ago is waiting for its retry, and a row whose record is gone is next.
    On main nothing alerted (and the waiting row was retried at once). Here the batch dead-letters
    the missing row and raises `dead_letter` and `backlog_stale` on the F28 alert line, in its summary
    and in its `embed` record. Spec R11."""
    migrated(corpus_db)
    seed_statutes(1, 1, age="2 days")
    run(execute(
        "UPDATE embedding_queue SET attempts = 1, next_attempt_at = now() + interval '1 hour'",
        "INSERT INTO embedding_queue (record_id, table_name, created_at) "
        "VALUES (gen_random_uuid(), 'statutes_master', now() - interval '1 hour')",
    ))
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    with caplog.at_level(logging.ERROR):
        result = summary(fire("process-embeddings"))

    kinds = sorted(a.split(":")[0] for a in result.get("alerts", []))
    assert kinds == ["backlog_stale", "dead_letter"], f"alerts {result.get('alerts')}, calls {provider.calls}"
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith(ALERT)]
    assert sorted(line[len(ALERT):].split(":")[0] for line in lines) == ["backlog_stale", "dead_letter"], lines
    assert "record_missing x1" in next(a for a in result["alerts"] if a.startswith("dead_letter")), result["alerts"]
    record = jobs("embedding_queue", job_type="embed")
    assert sorted(a.split(":")[0] for a in record[0].result_summary["alerts"]) == ["backlog_stale", "dead_letter"]
    assert provider.calls == [], "the waiting row is not due"


# ---------------------------------------------------------------------------------------------
# R16: least privilege
# ---------------------------------------------------------------------------------------------
def test_r16_the_runtime_role_runs_a_batch_with_dml_only(corpus_db, monkeypatch):
    """The worker's database role in production has DML on the application tables only. A batch run
    as that role claims, records its receipts and stores the vector."""
    migrated(corpus_db)
    seed_statutes(1, 2)
    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)

    with corpus_db.app_engine_as(*corpus_db.runtime_role(corpus_writer="none")):
        result = fire("process-embeddings")

    assert result.state == "SUCCESS" and summary(result).get("completed") == 2, repr(result.result)
    assert set(queue_by_row().values()) == {("completed", 0, None, True)}
    assert [r[0] for r in receipts()] == ["stored", "stored"], receipts()
    assert len(provider.calls) == 2


# ---------------------------------------------------------------------------------------------
# R14: migration 004 on a queue created before F27 (no main equivalent)
# ---------------------------------------------------------------------------------------------
QUEUE_TABLES = ("embedding_queue", "embedding_attempts")


def catalog():
    """Columns (name, type, not null, default), constraints and indexes of the two queue tables, as
    sets (an upgraded table has its new columns at the end)."""
    columns = run(fetch(
        "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid) "
        "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid "
        "LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum "
        "WHERE c.relname = ANY(:t) AND a.attnum > 0 AND NOT a.attisdropped", t=list(QUEUE_TABLES)))
    constraints = run(fetch(
        "SELECT c.relname, k.conname, pg_get_constraintdef(k.oid), k.convalidated FROM pg_constraint k "
        "JOIN pg_class c ON c.oid = k.conrelid WHERE c.relname = ANY(:t)", t=list(QUEUE_TABLES)))
    indexes = run(fetch("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename = ANY(:t)",
                        t=list(QUEUE_TABLES)))
    return {"columns": {tuple(r) for r in columns}, "constraints": {tuple(r) for r in constraints},
            "indexes": {tuple(r) for r in indexes}}


def object_ids():
    return {tuple(r) for r in run(fetch(
        "SELECT 'constraint', k.conname, k.oid::bigint FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid "
        "WHERE c.relname = ANY(:t) UNION ALL SELECT 'index', i.relname, i.oid::bigint FROM pg_index x "
        "JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid WHERE c.relname = ANY(:t)",
        t=list(QUEUE_TABLES)))}


def test_r14_migration_004_brings_a_pre_f27_queue_onto_the_schema_a_new_database_gets(corpus_db, monkeypatch):
    """A database whose queue was created before F27 (no lease, operation or receipt objects; a row
    left `processing` by hand, a `failed` row, a pending row with two attempts) is migrated by
    `python -m scraper.migrate`. Its queue then matches a new database's exactly, the `processing` row
    is pending with its attempts unchanged, the `failed` row is untouched, a second migrate changes
    nothing, and a batch embeds the pending rows. Spec R14."""
    migrated(corpus_db)
    fresh = catalog()
    corpus_db.admin(
        "DROP TABLE embedding_attempts",
        "ALTER TABLE embedding_queue DROP COLUMN lease_owner CASCADE, DROP COLUMN lease_expires_at CASCADE, "
        "DROP COLUMN operation_id CASCADE, DROP COLUMN stored_operation_id CASCADE",
        "ALTER TABLE embedding_queue DROP CONSTRAINT ck_embedding_dead_letter_reason",
        "DROP INDEX ix_embedding_claim_order",
        "DROP INDEX ix_embedding_waiting_created",
    )
    seed_statutes(1, 3)
    run(execute(
        "UPDATE embedding_queue SET status = 'processing' FROM statutes_master s "
        "WHERE s.id = record_id AND s.section_number = 's1'",
        "UPDATE embedding_queue SET status = 'failed', attempts = 3, error_message = 'legacy failure' "
        "FROM statutes_master s WHERE s.id = record_id AND s.section_number = 's2'",
        "UPDATE embedding_queue SET attempts = 2 FROM statutes_master s WHERE s.id = record_id AND s.section_number = 's3'",
    ))

    assert_migrated(corpus_db.migrate(), corpus_db)

    upgraded = catalog()
    for part in ("columns", "constraints", "indexes"):
        assert upgraded[part] == fresh[part], (
            f"{part}: missing {sorted(fresh[part] - upgraded[part])}, extra {sorted(upgraded[part] - fresh[part])}")
    assert queue_by_row() == {
        1: ("pending", 0, None, False), 2: ("failed", 3, None, False), 3: ("pending", 2, None, False)}, queue_by_row()
    before = object_ids()
    assert_migrated(corpus_db.migrate(), corpus_db)
    assert object_ids() == before, "a second migrate re-created queue constraints or indexes"

    provider = Provider().install(monkeypatch)
    no_sleep(monkeypatch)
    done = summary(fire("process-embeddings"))
    assert (done.get("completed"), sorted(provider.per_row())) == (2, [1, 3]), done
    assert done.get("dead_letter_total") == 1, "a legacy failed row counts with the dead letters"
