"""Audit F27 in a real prefork worker: two worker children over the same queue, and a child killed
after the provider answered.

A real ``celery worker --pool=prefork`` subprocess runs the production Celery app
(``scraper.tasks.celery_app``) against a fresh real Postgres 16 + pgvector database (Annex A DDL applied
twice, then ``python -m scraper.migrate``), as F28's prefork harness does (test_f28_fu_prefork_e2e.py):
kombu's filesystem transport and Celery's file backend stand in for Redis, and tasks are sent by name
with ``send_task``, as beat sends them. The production engine (pool_size 20) is the one the children
use. The OpenAI package is the one stand-in, installed by the worker's app module before the pool
forks: each request appends one line (the child's pid and the row it is for) to a file and answers a
1536-number vector; no network, and the configured key is a plain label, not key-shaped. On this
branch the app module also shortens the 0.6 s pause between requests (``embeddings.PACE_SECONDS``);
on main that attribute does not exist and setting it changes nothing.

Spec: docs/superpowers/specs/2026-10-18-f27-leased-embedding-claims-design.md (R1, R2, R3, R5, R6).
Synthetic fixtures only.
"""

import contextlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from test_f20_trust_policy_db import assert_migrated, execute, fetch, run
from test_f27_embedding_claims_e2e import queue_by_row, receipts, seed_statutes

CORPUS = Path(__file__).resolve().parents[1]
EMBED = "scraper.tasks.embeddings.process_embedding_queue"
ROW = re.compile(r"F27-ROW-(\d{3})")

APP_MODULE = '''
import asyncio, json, os, sys, types
from scraper.tasks import celery_app
from scraper.tasks import embeddings

ROOT = os.environ["F27_FS_ROOT"]
LATENCY = float(os.environ.get("F27_PROVIDER_LATENCY", "0"))
app = celery_app.app
app.conf.update(
    broker_url="filesystem://", broker_use_ssl=None, redis_backend_use_ssl=None,
    broker_transport_options={"data_folder_in": ROOT + "/q", "data_folder_out": ROOT + "/q",
                              "processed_folder": ROOT + "/done", "store_processed": False,
                              "control_folder": ROOT + "/control"},
    result_backend="file://" + ROOT + "/results", worker_hijack_root_logger=False,
)
embeddings.PACE_SECONDS = float(os.environ.get("F27_PACE", "0.6"))


class _Embeddings:
    async def create(self, model, input):
        with open(ROOT + "/provider_calls.jsonl", "a") as f:  # one line per request, flushed on close
            f.write(json.dumps({"pid": os.getpid(), "model": model, "input": input}) + "\\n")
        if LATENCY:
            await asyncio.sleep(LATENCY)
        return types.SimpleNamespace(
            data=[types.SimpleNamespace(embedding=[0.001] * 1536)],
            usage=types.SimpleNamespace(prompt_tokens=7, total_tokens=7),
        )


class AsyncOpenAI:
    def __init__(self, api_key):
        self.embeddings = _Embeddings()


_provider = types.ModuleType("openai")
_provider.AsyncOpenAI = AsyncOpenAI
sys.modules["openai"] = _provider
'''


def provider_calls(root):
    path = root / "provider_calls.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def calls_per_row(root):
    counts = {}
    for call in provider_calls(root):
        row = int(ROW.search(call["input"]).group(1))
        counts[row] = counts.get(row, 0) + 1
    return counts


@contextlib.contextmanager
def prefork_worker(corpus_db, tmp_path, *, concurrency, env=None):
    """Start the worker; yield (send, root, log path). ``send(wait=True)`` sends one embedding batch
    and returns (state, result); ``send(wait=False)`` returns the AsyncResult."""
    from celery import Celery

    root = tmp_path / "fs"
    for d in ("q", "done", "results", "control"):
        (root / d).mkdir(parents=True)
    (tmp_path / "f27_prefork_app.py").write_text(APP_MODULE)
    log_path = tmp_path / "worker.log"
    worker_env = {
        **os.environ, "F27_FS_ROOT": str(root), "DATABASE_URL": corpus_db.url,
        "REDIS_URL": "redis://127.0.0.1:1/0", "ENVIRONMENT": "development",
        "OPENAI_API_KEY": "f27-local-stand-in",
        "PYTHONPATH": os.pathsep.join([str(tmp_path), str(CORPUS)]), **(env or {}),
    }
    sender = Celery("f27-sender", broker="filesystem://", backend=f"file://{root}/results", set_as_current=False)
    sender.conf.update(broker_transport_options={
        "data_folder_in": f"{root}/q", "data_folder_out": f"{root}/q",
        "processed_folder": f"{root}/done", "store_processed": False, "control_folder": f"{root}/control",
    })

    def send(wait=True):
        result = sender.send_task(EMBED)
        if not wait:
            return result
        result.get(timeout=240, propagate=False)
        return result.state, result.result

    with open(log_path, "w") as log:
        worker = subprocess.Popen(
            [sys.executable, "-m", "celery", "-A", "f27_prefork_app", "worker", "--pool=prefork", "-c", str(concurrency),
             "--loglevel=INFO", "-Q", "celery", "--without-gossip", "--without-mingle", "--without-heartbeat"],
            cwd=str(CORPUS), env=worker_env, stdout=log, stderr=subprocess.STDOUT, text=True,
        )
        try:
            yield send, root, log_path
        finally:
            worker.terminate()
            try:
                worker.wait(timeout=60)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait()


def migrated(corpus_db):
    corpus_db.apply_annex_a()
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)


def wait_for(predicate, timeout, what):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError(f"timed out after {timeout} s waiting for {what}")


def test_r1_two_worker_children_over_the_same_50_rows_pay_once_per_row(corpus_db, tmp_path):
    """Two embedding batches sent together to a worker with two children, over 50 queued rows; each
    provider request takes 100 ms. On main both children selected the same pending rows and paid for
    them twice (the finding's scenario 1). Here the two claims are disjoint (SKIP LOCKED: whichever
    claims second skips the rows the first holds, so they split the window or one finds nothing) and
    together cover the 50: one request per row, every row embedded once. Spec R1."""
    migrated(corpus_db)
    seed_statutes(1, 50)

    with prefork_worker(corpus_db, tmp_path, concurrency=2,
                        env={"F27_PROVIDER_LATENCY": "0.1", "F27_PACE": "0.01"}) as (send, root, log_path):
        first, second = send(wait=False), send(wait=False)
        for sent in (first, second):
            sent.get(timeout=240, propagate=False)
        outcomes = [first.state, second.state]
        results = [first.result, second.result]

    per_row = calls_per_row(root)
    paid_twice = sorted(n for n, c in per_row.items() if c > 1)
    assert (len(provider_calls(root)), paid_twice) == (50, []), (
        f"{len(provider_calls(root))} provider requests for 50 rows; paid more than once: {paid_twice} "
        f"({outcomes}, {results}, {log_path.read_text()[-2000:]})")
    assert sorted(per_row) == list(range(1, 51))
    assert sum(r["claimed"] for r in results) == 50, results
    by_child = {}
    for call in provider_calls(root):
        by_child.setdefault(call["pid"], set()).add(int(ROW.search(call["input"]).group(1)))
    assert sorted(len(rows) for rows in by_child.values()) == sorted(r["claimed"] for r in results if r["claimed"]), (
        by_child, results)
    print(f"F27 prefork concurrency: claims {[r['claimed'] for r in results]}, "
          f"{len(provider_calls(root))} requests for {len(per_row)} rows")  # evidence, shown with -rP
    assert set(queue_by_row().values()) == {("completed", 0, None, True)}


@pytest.mark.parametrize("attempts_before", [0, 4], ids=["first-attempt", "last-attempt"])
def test_r5_a_worker_killed_after_the_provider_answered_is_reconciled_from_its_receipt(corpus_db, tmp_path, attempts_before):
    """The child's store transaction is held (a trigger sleeps on the vector write) after the provider
    answered, and the child is killed with SIGKILL: nothing it had not committed survives. On main
    nothing recorded the paid request, the row was still `pending`, and the next batch paid again
    (scenario 3). Here the `answered` receipt shows the paid request (its tokens, its vector held); the
    row stays leased, so a batch before the lease expires does nothing; after expiry the reclaim finds
    the held answer for the row's current operation, so it does not charge the row (review round 1:
    on the row's last attempt, 4 of 5, fa56eee dead-lettered it and stranded the vector) and the same
    batch stores it from the receipt without a second request. Spec R2, R3, R5, R6."""
    migrated(corpus_db)
    seed_statutes(1, 1)
    run(execute("UPDATE embedding_queue SET attempts = :a", params={"a": attempts_before}))
    corpus_db.admin(
        "CREATE FUNCTION f27_hold_vector_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
        "PERFORM pg_sleep(120); RETURN NEW; END $$",
        "CREATE TRIGGER f27_hold_vector_write BEFORE UPDATE ON statutes_master FOR EACH ROW "
        "WHEN (NEW.embedding IS NOT NULL) EXECUTE FUNCTION f27_hold_vector_write()",
    )

    with prefork_worker(corpus_db, tmp_path, concurrency=1, env={"F27_PACE": "0.01"}) as (send, root, log_path):
        killed = send(wait=False)
        held = wait_for(lambda: run(fetch(
            "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'")),
            120, "the store transaction to reach the held vector write")
        child = provider_calls(root)[0]["pid"]
        os.kill(child, signal.SIGKILL)
        corpus_db.admin(f"SELECT pg_terminate_backend({int(held[0][0])})",
                        "DROP TRIGGER f27_hold_vector_write ON statutes_master")
        killed.get(timeout=240, propagate=False)
        after_kill = (killed.state, type(killed.result).__name__, queue_by_row()[1][:2], receipts())

        rerun = send()  # the next scheduled batch, before the lease expires
        after_rerun = (len(provider_calls(root)), queue_by_row()[1][:2], receipts())

        assert after_rerun == (1, ("processing", attempts_before), [("answered", 7, True, False, None)]), (
            f"after the kill: {after_kill}; after the next batch: {after_rerun} (requests, row, receipts); "
            f"rerun {rerun}; worker log {log_path.read_text()[-1500:]}")
        assert after_kill[:2] == ("FAILURE", "WorkerLostError"), after_kill

        run(execute("UPDATE embedding_queue SET lease_expires_at = now() - interval '1 second'"))
        recovered = send()

    assert (queue_by_row()[1], len(provider_calls(root))) == (("completed", attempts_before, None, True), 1), (
        f"after the lease expired: row {queue_by_row()[1]}, receipts {receipts()}, "
        f"{len(provider_calls(root))} requests, batch {recovered}")
    assert (recovered[0], recovered[1]["reclaimed"], recovered[1]["completed"], recovered[1]["reused"]) == (
        "SUCCESS", 1, 1, 1), recovered
    assert receipts() == [("stored", 7, False, True, None)], receipts()


def pool_children(root):
    """The prefork pool's children of this test's worker (its processes carry this test's F27_FS_ROOT;
    a child's parent is one of them)."""
    ours = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/environ", "rb") as f:
                if f"F27_FS_ROOT={root}".encode() not in f.read().split(b"\0"):
                    continue
            with open(f"/proc/{entry}/stat") as f:
                ours[int(entry)] = int(f.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            continue
    return [pid for pid, parent in ours.items() if parent in ours]


def test_r3_a_row_whose_store_kills_the_worker_stops_at_three_lost_stores_and_rows_behind_it_are_never_charged(
        corpus_db, tmp_path):
    """Review round 2 (Bugbot 4307417933's bound; auditor finding 5 and P5). Row 1's answer was paid and
    is held (its batch was killed storing it), and every store of it is killed again: the child is
    SIGKILLed while the vector write is held. Rows 2 and 3 are claimed behind it and never reached. At
    132957c row 1 was spared at every reclaim with no bound, and rows 2 and 3 were charged an attempt
    at every reclaim with no request made. Here the batch takes the held receipt over before it stores
    (R6 (b)), so each reclaim knows the dead batch reached row 1 and counts a lost store; at the third
    the row goes to the dead letter as `store_failed` with the answer kept, and rows 2 and 3 are given
    back uncharged each time and then paid once. A requeue stores the kept answer with no request."""
    from test_f27_embedding_claims_e2e import DIMENSIONS, MODEL, REQUEUE, STORE_RETRY_LIMIT, operation_id, statute_text

    migrated(corpus_db)
    seed_statutes(1, 3)
    first = run(fetch("SELECT id FROM statutes_master WHERE section_number = 's1'"))[0][0]
    run(execute(
        "UPDATE embedding_queue SET status = 'processing', lease_owner = gen_random_uuid(), "
        "lease_expires_at = now() - interval '1 minute' WHERE record_id = :r",
        "INSERT INTO embedding_attempts (operation_id, queue_id, table_name, record_id, model, dimensions, "
        "lease_owner, attempt, outcome, started_at, answered_at, token_count, embedding) "
        "SELECT :op, id, table_name, record_id, :model, :dims, lease_owner, 1, 'answered', now(), now(), 7, "
        "CAST(:vec AS vector) FROM embedding_queue WHERE record_id = :r",
        params={"r": first, "op": operation_id("statutes_master", first, statute_text(1)), "model": MODEL,
                "dims": DIMENSIONS, "vec": json.dumps([0.002] * 1536)},
    ))
    corpus_db.admin(
        "CREATE FUNCTION f27_hold_row_1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
        "PERFORM pg_sleep(120); RETURN NEW; END $$",
        "CREATE TRIGGER f27_hold_row_1 BEFORE UPDATE ON statutes_master FOR EACH ROW "
        "WHEN (NEW.embedding IS NOT NULL AND NEW.section_number = 's1') EXECUTE FUNCTION f27_hold_row_1()",
    )
    killed_states, previous = [], None

    with prefork_worker(corpus_db, tmp_path, concurrency=1, env={"F27_PACE": "0.01"}) as (send, root, log_path):
        for _ in range(STORE_RETRY_LIMIT - 1):
            killed = send(wait=False)
            held = wait_for(lambda: [r for r in run(fetch(
                "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'"))
                if r[0] != previous], 120, "the store of row 1 to be held")
            previous = held[0][0]
            children = pool_children(root)
            assert len(children) == 1, (children, log_path.read_text()[-1500:])
            os.kill(children[0], signal.SIGKILL)
            corpus_db.admin(f"SELECT pg_terminate_backend({int(previous)})")
            killed.get(timeout=240, propagate=False)
            killed_states.append((killed.state, type(killed.result).__name__))
            run(execute("UPDATE embedding_queue SET lease_expires_at = now() - interval '1 second' "
                        "WHERE status = 'processing'"))
        last = send()
        after = (queue_by_row(), calls_per_row(root))
        corpus_db.admin("DROP TRIGGER f27_hold_row_1 ON statutes_master")
        run(execute(REQUEUE + " WHERE status = 'dead_letter'"))
        requeued = send()

    assert killed_states == [("FAILURE", "WorkerLostError")] * (STORE_RETRY_LIMIT - 1), killed_states
    assert after == ({1: ("dead_letter", 0, "store_failed", False), 2: ("completed", 0, None, True),
                      3: ("completed", 0, None, True)}, {2: 1, 3: 1}), (
        f"after {STORE_RETRY_LIMIT - 1} killed stores and one more batch: {after}; batch {last}; "
        f"worker log {log_path.read_text()[-1500:]}")
    assert (last[0], last[1]["reclaimed"], last[1]["reclaimed_unreached"], last[1]["dead_letter_reasons"]) == (
        "SUCCESS", 3, 2, {"store_failed": 1}), last
    assert (queue_by_row()[1], calls_per_row(root), requeued[1]["reused"]) == (
        ("completed", 0, None, True), {2: 1, 3: 1}, 1), (queue_by_row(), requeued)
