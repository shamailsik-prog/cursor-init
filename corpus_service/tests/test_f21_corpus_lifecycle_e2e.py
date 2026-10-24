"""Audit F21 end to end: scheduled harvesting completes a defined lifecycle.

Spec: docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md (rulings R1-R16).

The flow is the production one. Harvests are the real beat entries (``scrape-nasirlawsite``,
``scrape-pakistancode``, ``scrape-na``) run in process with ``Task.apply`` (F28's harness), through the
real dispatcher, the real harvesters and the real F26 PDF intake. A *tick* fires every other beat entry
of the real Celery app once, in schedule order, except ``process-embeddings``: the flow stops at the
embedding outbox row, so no provider is ever called. Everything runs against a fresh real Postgres 16
+ pgvector database migrated by ``python -m scraper.migrate``, with the Annex A DDL applied and the app
bound to the runtime role (DML on the ORM tables, ``corpus_writer`` by SET ROLE only). F23 decisions
go through the real review routes with the admin key.

Only the edges are replaced: the fetch boundary's client factory serves synthetic 2099 pages (F20's
FakeFetcher pattern, the source's real policy decides what may be requested), the PDF sandbox's parse
returns a synthetic text, and the politeness sleeps return at once. Nothing leaves the machine.

On main (c02ebbc) each test fails by behaviour: the ticks move nothing (no lifecycle consumer is
scheduled), PakistanCode and NationalAssembly write statutes_master during the harvest, and there is no
lifecycle state, report or stalled-row alert. Expected values are written out from the spec.
"""

import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
import textwrap
import threading
import time
import uuid
from collections import Counter
from pathlib import Path

import pytest

from test_f20_trust_policy_db import assert_migrated, fetch, run

PDF = b"%PDF-1.4 synthetic F21 fixture, not a real statute"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
REVIEWER = "Reviewer F21 (synthetic)"
REASON = "Checked against the certified copy (synthetic 2099 fixture)"
TRUSTED_FEED = "F21TrustedFeed"
TICKS = 3
LIFECYCLE_JOB_TYPES = ("normalise", "promote", "publish", "reconcile")

# PakistanCode: two acts answer, the other eight slugs are 404 (a partial run).
PC_ACTS = {
    "ppc1860": "F21 Test Penal Act 2099",
    "crpc1898": "F21 Test Procedure Act 2099",
}
NA_INDEX = "https://na.gov.pk/en/legis.php"
NA_PDF = "https://na.gov.pk/uploads/f21-test-act-2099.pdf"
NA_TEXT = ("Section one of the synthetic F21 Test Act 2099, enacted for this fixture only. " * 2
           + "\n\n" + ("Section two of the synthetic F21 Test Act 2099 fixture. " * 3))


# ---------------------------------------------------------------------------------------------
# the network edge (synthetic pages only)
# ---------------------------------------------------------------------------------------------
class _Resp:
    def __init__(self, body: bytes, status: int = 200, url: str = "", content_type: str = "text/html; charset=utf-8"):
        self.status_code = status
        self.content = body
        self.text = body.decode("latin-1")
        self.headers = {"Content-Type": content_type}
        self.url = url


def _nasir_cases():
    from scraper.tasks import nasirlawsite

    cases = {}
    for n, reporter in enumerate(nasirlawsite.REPORTER_URLS, start=1):
        base = reporter.rsplit("/", 1)[1].split(".")[0]
        cases[reporter] = (f"{base}-f21.htm", f"https://www.nasirlawsite.com/case/{base}-f21.htm", n)
    return cases


class F21Fetcher:
    """Stands in for ``fetch_policy.fetcher_for(name)``: synthetic pages, the source's real policy."""

    def __init__(self, name, *args, **kwargs):
        from scraper.net import fetch_policy

        self.policy = fetch_policy.policy_for(name)
        self.cases = _nasir_cases()

    def allows(self, url):
        return self.policy.allows(url)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, *args, **kwargs):
        url = str(url)
        if url == NA_PDF:
            return _Resp(PDF, url=url, content_type="application/pdf")
        if url == NA_INDEX:
            return _Resp(b"<html><a href='/uploads/f21-test-act-2099.pdf'>F21 Test Act 2099</a></html>", url=url)
        if url == "https://pakistancode.gov.pk/federal":
            return _Resp(b"<html></html>", url=url)
        if "pakistancode.gov.pk/english/statues/details/" in url:
            slug = url.rsplit("/", 1)[1]
            if slug not in PC_ACTS:
                return _Resp(b"not found", status=404, url=url)
            act = PC_ACTS[slug]
            page = (f"<html><h1>{act}</h1>"
                    f"<div class='section'>1. Short title. This Act may be called the {act} (synthetic).</div>"
                    f"<div class='section'>2. Definitions. In the {act} words are synthetic fixture text.</div></html>")
            return _Resp(page.encode(), url=url)
        if url in self.cases:
            href, _full, _n = self.cases[url]
            return _Resp(f"<html><title>F21 reporter</title><a href='{href}'>case</a></html>".encode(), url=url)
        for _href, full, n in self.cases.values():
            if url == full:
                body = f"<html><body><p>Synthetic F21 fixture judgment number {n} of 2099. Not a real judgment.</p></body></html>"
                return _Resp(body.encode(), url=url)
        return _Resp(b"not found", status=404, url=url)


def install_offline_sources(monkeypatch):
    from scraper.net import fetch_policy
    from scraper.parsers import pdf_sandbox

    monkeypatch.setattr(fetch_policy, "fetcher_for", lambda name, *a, **kw: F21Fetcher(name))
    monkeypatch.setattr(
        pdf_sandbox, "parse",
        lambda path, sha256, size, **kw: pdf_sandbox.ParseResult(text=NA_TEXT, pages=1, ocr_applied=False),
    )
    real_sleep = asyncio.sleep

    async def _no_wait(delay=0, result=None):
        return await real_sleep(0, result)

    monkeypatch.setattr(asyncio, "sleep", _no_wait)
    monkeypatch.delenv("P1_EMBEDDING_URL", raising=False)  # FA-D3C-002: embeddings go through P1; none here


# ---------------------------------------------------------------------------------------------
# the production entry points: beat entries and their tasks, run in process
# ---------------------------------------------------------------------------------------------
def beat_schedule():
    from scraper.tasks import celery_app

    return celery_app.app.conf.beat_schedule


def fire(entry_name):
    from scraper.tasks import celery_app

    entry = beat_schedule()[entry_name]
    return celery_app.app.tasks[entry["task"]].apply(args=entry.get("args", ()))


def tick():
    """One scheduled tick: every beat entry that is not a harvest and not the embedding provider, in
    schedule order. Returns {entry: (state, result)}."""
    out = {}
    for name in beat_schedule():
        if name.startswith("scrape-") or name == "process-embeddings":
            continue
        res = fire(name)
        out[name] = (res.state, res.result)
    return out


def harvest(*entries):
    return {name: fire(name).state for name in entries}


# ---------------------------------------------------------------------------------------------
# reading the database as the test's admin (independent of the app's binding)
# ---------------------------------------------------------------------------------------------
async def _admin(db, sql, params, write=False):
    from sqlalchemy import text

    engine = db.engine_for(db.url)
    try:
        async with (engine.begin() if write else engine.connect()) as conn:
            result = await conn.execute(text(sql), params)
            return result.all() if result.returns_rows else None
    finally:
        await engine.dispose()


def admin_fetch(db, sql, **params):
    return run(_admin(db, sql, params))


def admin_exec(db, sql, **params):
    return run(_admin(db, sql, params, write=True))


def has_column(db, table, column):
    return bool(admin_fetch(db, "SELECT 1 FROM information_schema.columns WHERE table_name = :t AND column_name = :c",
                            t=table, c=column))


def has_table(db, table):
    return admin_fetch(db, "SELECT to_regclass(:t) IS NOT NULL", t=table)[0][0]


def lifecycle_counts(db, table):
    """{(source, state): n}. On a database without the lifecycle (main) the state is derived from the
    legacy flags and prefixed 'main:', so the RED output shows where main leaves every row."""
    source = "coalesce(s.source_name, st.source_site, '(none)')"
    if has_column(db, table, "lifecycle_state"):
        state = "st.lifecycle_state"
    else:
        state = ("CASE WHEN st.promoted THEN 'main:promoted' WHEN st.quarantined THEN 'main:quarantined' "
                 "WHEN st.normalised THEN 'main:normalised' ELSE 'main:unnormalised' END")
    rows = admin_fetch(db, f"SELECT {source}, {state}, count(*) FROM {table} st "
                           "LEFT JOIN scraper_sources s ON s.id = st.source_id GROUP BY 1, 2")
    return {(src, st): n for src, st, n in rows}


def count(db, table, where="true", **params):
    return admin_fetch(db, f"SELECT count(*) FROM {table} WHERE {where}", **params)[0][0]


def transition_paths(db, table):
    """Counter of each record's ordered move path, e.g. ('parsed>normalised', 'normalised>approved')."""
    if not has_table(db, "corpus_lifecycle_transitions"):
        return {"main": "no corpus_lifecycle_transitions table"}
    rows = admin_fetch(db, "SELECT record_id, from_state, to_state FROM corpus_lifecycle_transitions "
                           "WHERE record_table = :t AND from_state IS NOT NULL ORDER BY record_id, at, id", t=table)
    paths = {}
    for record_id, src, dst in rows:
        paths.setdefault(record_id, []).append(f"{src}>{dst}")
    return Counter(tuple(p) for p in paths.values())


def lifecycle_jobs(db):
    return admin_fetch(db, "SELECT job_type, status, result_summary FROM scraper_jobs "
                           "WHERE job_type = ANY(:types) ORDER BY started_at", types=list(LIFECYCLE_JOB_TYPES))


def prepare(db):
    db.apply_annex_a()
    assert_migrated(db.migrate(), db)


def outbox(db):
    return Counter(admin_fetch(db, "SELECT table_name, status FROM embedding_queue"))


# ---------------------------------------------------------------------------------------------
# (a) scheduled harvesting carries every record to a defined state
# ---------------------------------------------------------------------------------------------
def test_a_scheduled_ticks_carry_harvested_records_through_the_lifecycle(corpus_db, monkeypatch):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        first = harvest("scrape-nasirlawsite", "scrape-pakistancode", "scrape-na")
        second = harvest("scrape-nasirlawsite", "scrape-pakistancode", "scrape-na")
        master_after_harvest = count(corpus_db, "statutes_master") + count(corpus_db, "case_law_master")
        ticks = [tick() for _ in range(TICKS)]

    observed = {
        "harvests": [first, second],
        "master rows written by the harvests": master_after_harvest,
        "case records": lifecycle_counts(corpus_db, "scraper_staging"),
        "statute records": lifecycle_counts(corpus_db, "statutes_staging"),
        "review queue": Counter(r for (r,) in admin_fetch(corpus_db, "SELECT reason FROM quarantine_queue")),
        "statutes_master by source": dict(admin_fetch(
            corpus_db, "SELECT source_site, count(*) FROM statutes_master GROUP BY 1")),
        "outbox": outbox(corpus_db),
        "case paths": transition_paths(corpus_db, "scraper_staging"),
        "statute paths": transition_paths(corpus_db, "statutes_staging"),
        "every tick succeeded": all(state == "SUCCESS" for t in ticks for state, _r in t.values()),
    }
    stage_paths = ("parsed>normalised", "normalised>approved", "approved>published", "published>embedded")
    expected = {
        "harvests": [{"scrape-nasirlawsite": "SUCCESS", "scrape-pakistancode": "SUCCESS", "scrape-na": "SUCCESS"}] * 2,
        "master rows written by the harvests": 0,
        # Nasir is a review source and its 2099 pages carry no citation the extractor accepts: one
        # review-queue row per document (citation_missing, decided before trust, F22), and the second
        # harvest's copies are duplicates (R6).
        "case records": {("NasirLawSite", "quarantined"): 5, ("NasirLawSite", "duplicate"): 5},
        "statute records": {("PakistanCode", "embedded"): 4, ("PakistanCode", "duplicate"): 4,
                            ("NationalAssembly", "embedded"): 2, ("NationalAssembly", "duplicate"): 2},
        "review queue": Counter({"citation_missing": 5}),
        "statutes_master by source": {"PakistanCode": 4, "NationalAssembly": 2},
        "outbox": Counter({("statutes_master", "pending"): 6}),
        "case paths": Counter({("parsed>normalised", "normalised>quarantined"): 5, ("parsed>duplicate",): 5}),
        "statute paths": Counter({stage_paths: 6, ("parsed>duplicate",): 6}),
        "every tick succeeded": True,
    }
    assert observed == expected

    # Every record names the harvest run that staged it, and every move names the tick that made it.
    unstamped = count(corpus_db, "scraper_staging", "job_id IS NULL") + count(corpus_db, "statutes_staging", "job_id IS NULL")
    assert unstamped == 0
    orphan_moves = admin_fetch(corpus_db,
                               "SELECT count(*) FROM corpus_lifecycle_transitions t LEFT JOIN scraper_jobs j ON j.id = t.job_id "
                               "WHERE t.from_state IS NOT NULL AND (j.id IS NULL OR j.job_type <> ALL(:types))",
                               types=list(LIFECYCLE_JOB_TYPES))[0][0]
    assert orphan_moves == 0
    # The hourly report is the operator's completion boundary: per source, per table, per state.
    reports = [summary for job_type, status, summary in lifecycle_jobs(corpus_db) if job_type == "reconcile"]
    assert len(reports) == TICKS and all(status == "completed" for t, status, _s in lifecycle_jobs(corpus_db) if t == "reconcile")
    last = reports[-1]["report"]
    assert last["PakistanCode"]["statutes_staging"]["embedded"]["count"] == 4
    assert last["NasirLawSite"]["scraper_staging"]["quarantined"]["count"] == 5
    assert last["NasirLawSite"]["scraper_staging"]["quarantined"]["oldest"] is not None
    assert reports[-1]["alerts"] == []


# ---------------------------------------------------------------------------------------------
# (b) a quarantined record stops at review and moves on only after an F23 decision
# ---------------------------------------------------------------------------------------------
def test_b_a_quarantined_record_moves_on_only_after_a_review_decision(corpus_db, monkeypatch):
    from fastapi.testclient import TestClient

    from scraper.config import settings

    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        harvest("scrape-nasirlawsite")
        for _ in range(TICKS):
            tick()
        held = lifecycle_counts(corpus_db, "scraper_staging")
        queue = admin_fetch(corpus_db, "SELECT q.id, q.staging_id FROM quarantine_queue q ORDER BY q.created_at, q.id")
        assert (held, len(queue)) == ({("NasirLawSite", "quarantined"): 5}, 5)
        for _ in range(TICKS):
            tick()
        assert lifecycle_counts(corpus_db, "scraper_staging") == held, "a record left review without a decision"

        (promote_qid, promote_sid), (reject_qid, reject_sid) = queue[0], queue[1]
        from scraper.main import app

        headers = {"X-API-Key": settings.ADMIN_API_KEY}
        with TestClient(app, raise_server_exceptions=False) as client:
            promoted = client.post(f"/quarantine/{promote_qid}/promote", json={"reviewer": REVIEWER, "reason": REASON},
                                   headers=headers)
            rejected = client.post(f"/quarantine/{reject_qid}/reject", json={"reviewer": REVIEWER, "reason": REASON},
                                   headers=headers)
        assert (promoted.status_code, rejected.status_code) == (200, 200), (promoted.text, rejected.text)
        case_id = promoted.json()["case_id"]
        tick()

    states = dict(admin_fetch(corpus_db, "SELECT id, lifecycle_state FROM scraper_staging"))
    assert (states[promote_sid], states[reject_sid]) == ("embedded", "rejected")
    assert Counter(states.values()) == Counter({"quarantined": 3, "embedded": 1, "rejected": 1})
    row = admin_fetch(corpus_db, "SELECT published_id, state_reason FROM scraper_staging WHERE id = :i", i=promote_sid)[0]
    assert str(row[0]) == case_id
    assert admin_fetch(corpus_db, "SELECT state_reason FROM scraper_staging WHERE id = :i", i=reject_sid)[0][0] == "review_rejected"
    # F23 wrote the master row and its outbox row; the lifecycle records them and writes nothing more.
    assert count(corpus_db, "case_law_master") == 1 and outbox(corpus_db) == Counter({("case_law_master", "pending"): 1})
    moves = admin_fetch(corpus_db, "SELECT from_state, to_state, details FROM corpus_lifecycle_transitions "
                                   "WHERE record_id = :i AND from_state IS NOT NULL ORDER BY at, id", i=promote_sid)
    assert [f"{a}>{b}" for a, b, _d in moves] == [
        "parsed>normalised", "normalised>quarantined", "quarantined>approved", "approved>published", "published>embedded"]
    decision_id = admin_fetch(corpus_db, "SELECT id FROM quarantine_decisions WHERE quarantine_id = :q", q=promote_qid)[0][0]
    assert moves[2][2]["decision_id"] == str(decision_id)


# ---------------------------------------------------------------------------------------------
# (c) a trusted record: Annex A at the gate, then the retrieval store and the outbox
# ---------------------------------------------------------------------------------------------
def _stage_trusted_cases(db, n, *, page=2200):
    """Rows as a trusted source's harvester stages them (source stamp, provenance, a bench and a
    canonical 2099 citation). Returns the ids, oldest first."""
    admin_exec(db, "INSERT INTO scraper_sources (source_name, source_url, trust_level) "
                   "VALUES (:n, 'https://f21.example.invalid/', 'trusted') ON CONFLICT DO NOTHING", n=TRUSTED_FEED)
    ids = []
    for i in range(n):
        sid = uuid.uuid4()
        admin_exec(db,
                   "INSERT INTO scraper_staging (id, source_id, source_site, source_url, raw_text, raw_html, "
                   "extracted_citation, extracted_title, extracted_bench_type, confidence_score, parsing_metadata, created_at) "
                   "SELECT :id, s.id, s.source_name, :url, :body, '<p>synthetic</p>', :cite, :title, 'single', 0.9, "
                   "jsonb_build_object('source_id', s.id::text, 'source_name', s.source_name, 'extraction_method', 'html'), "
                   "now() - make_interval(secs => :age) FROM scraper_sources s WHERE s.source_name = :n",
                   id=sid, url=f"https://f21.example.invalid/judgment/{page + i}", body=f"F21 SYNTHETIC JUDGMENT {page + i} (2099)",
                   cite=f"PLD 2099 Sindh {page + i}", title=f"F21 Party {page + i} v. The State", age=float(n - i), n=TRUSTED_FEED)
        ids.append(sid)
    return ids


def test_c_a_trusted_record_is_published_into_annex_a_then_the_retrieval_store(corpus_db, monkeypatch):
    from fastapi.testclient import TestClient

    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    (sid,) = _stage_trusted_cases(corpus_db, 1)
    # A second copy of the same judgment from another page of the source: Annex A attaches it
    # (unchanged), and the retrieval store attaches it to the same row (R8), never a second one.
    (copy,) = _stage_trusted_cases(corpus_db, 1)
    admin_exec(corpus_db, "UPDATE scraper_staging SET source_url = source_url || '?copy', created_at = now() WHERE id = :i", i=copy)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        tick()
        from scraper.main import app

        with TestClient(app, raise_server_exceptions=False) as client:
            row = admin_fetch(corpus_db, "SELECT lifecycle_state, published_id, promoted_to_id FROM scraper_staging WHERE id = :i", i=sid)
            assert row and row[0][0] == "embedded", row
            served = client.get(f"/cases/{row[0][1]}")
    assert served.status_code == 200, served.text
    assert served.json()["citation"] == "PLD 2099 Sindh 2200"
    expected_id = uuid.uuid5(uuid.NAMESPACE_URL, f"corpus-service:case_law_master:staging/{sid}")
    assert row[0][1] == expected_id
    judgment = admin_fetch(corpus_db, "SELECT review_status FROM judgment WHERE id = :i", i=row[0][2])
    assert judgment == [("promoted",)]
    attached = admin_fetch(corpus_db, "SELECT lifecycle_state, published_id, promoted_to_id FROM scraper_staging WHERE id = :i", i=copy)
    assert attached == [("embedded", expected_id, row[0][2])]
    assert count(corpus_db, "case_law_master") == 1
    assert outbox(corpus_db) == Counter({("case_law_master", "pending"): 1})
    assert transition_paths(corpus_db, "scraper_staging") == Counter({
        ("parsed>normalised", "normalised>approved", "approved>published", "published>embedded"): 2})
    details = admin_fetch(corpus_db, "SELECT details FROM corpus_lifecycle_transitions WHERE record_id = :i AND to_state = 'published'",
                          i=copy)[0][0]
    assert details["attached"] is True and details["published_id"] == str(expected_id)


# ---------------------------------------------------------------------------------------------
# (d) two workers never move the same record; a locked record is skipped, not waited on
# ---------------------------------------------------------------------------------------------
def _stage_statutes(db, n, *, source="PakistanCode", state=None):
    ids = []
    for i in range(n):
        sid = uuid.uuid4()
        admin_exec(db,
                   "INSERT INTO statutes_staging (id, source_id, source_site, source_url, raw_text, extracted_act_name, "
                   "extracted_short_name, extracted_section_number, extracted_section_text, confidence_score, "
                   "parsing_metadata, created_at) SELECT :id, s.id, s.source_name, :url, :text, 'F21 Concurrency Act 2099', "
                   "'f21conc', :sec, :text, 0.85, jsonb_build_object('source_id', s.id::text, 'source_name', s.source_name), "
                   "now() - make_interval(secs => :age) FROM scraper_sources s WHERE s.source_name = :n",
                   id=sid, url=f"https://pakistancode.gov.pk/english/statues/details/f21conc{i}",
                   text=f"Section {i}. Synthetic F21 concurrency fixture text for section {i}.", sec=str(i),
                   age=float(n - i), n=source)
        ids.append(sid)
    return ids


STEP_FUNCTIONS = {
    "normalise-corpus": ("scraper.tasks.normalise", "normalise"),
    "promote-corpus": ("scraper.tasks.promotion", "gate"),
    "publish-corpus": ("scraper.tasks.publish", "publish"),
}


def _two_workers(entry, monkeypatch):
    """Fire one beat entry from two threads at once. Each worker's first step waits until the other
    worker is inside a step too, so both hold a claimed record at the same moment: the race is real,
    not a sequence."""
    import importlib

    module, name = STEP_FUNCTIONS[entry]
    module = importlib.import_module(module)
    real = getattr(module, name)
    inside = threading.Barrier(2, timeout=60)
    local = threading.local()

    async def held_step(db, row, *, job_id=None):
        if not getattr(local, "met", False):
            local.met = True
            await asyncio.to_thread(inside.wait)
        return await real(db, row, job_id=job_id)

    monkeypatch.setattr(module, name, held_step)
    start = threading.Barrier(2, timeout=60)
    results, errors = [], []

    def worker():
        try:
            start.wait()
            res = fire(entry)
            results.append((res.state, res.result))
        except Exception as exc:  # noqa: BLE001 - reported below
            errors.append(repr(exc))

    threads = [threading.Thread(target=worker) for _ in range(2)]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join(240)
    finally:
        monkeypatch.setattr(module, name, real)
    assert not errors and len(results) == 2, (errors, results)
    return results


def test_d_two_concurrent_workers_never_move_the_same_record(corpus_db, monkeypatch):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    ids = _stage_statutes(corpus_db, 40)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        # Connect once first, as F20's concurrency test does: two event loops racing a brand-new
        # engine's first connect (its dialect initialisation) is a test artefact; each production
        # worker process has an engine of its own.
        for entry in ("normalise-corpus", "promote-corpus", "publish-corpus"):
            assert run(fetch("SELECT 1")) == [(1,)]
            results = _two_workers(entry, monkeypatch)
            assert [state for state, _r in results] == ["SUCCESS", "SUCCESS"], results
            assert all(r["claimed"] > 0 for _s, r in results), results

    moves = admin_fetch(corpus_db, "SELECT record_id, from_state, to_state, job_id FROM corpus_lifecycle_transitions "
                                   "WHERE from_state IS NOT NULL")
    per_move = Counter((r, f"{a}>{b}") for r, a, b, _j in moves)
    assert set(per_move.values()) == {1}, [k for k, v in per_move.items() if v > 1][:5]
    assert Counter(m for _r, m in per_move) == Counter({
        "parsed>normalised": 40, "normalised>approved": 40, "approved>published": 40, "published>embedded": 40})
    by_job = {}
    for record, a, b, job in moves:
        if f"{a}>{b}" == "parsed>normalised":
            by_job.setdefault(job, set()).add(record)
    assert len(by_job) == 2, "both workers claimed records"
    first, second = by_job.values()
    assert not (first & second) and first | second == set(ids)
    assert count(corpus_db, "statutes_master") == 40 and outbox(corpus_db) == Counter({("statutes_master", "pending"): 40})


def test_d_a_record_locked_elsewhere_is_skipped_not_waited_on(corpus_db, monkeypatch):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    ids = _stage_statutes(corpus_db, 5)
    held, release = threading.Event(), threading.Event()

    async def holder():
        from sqlalchemy import text

        engine = corpus_db.engine_for(corpus_db.url)
        try:
            async with engine.begin() as conn:
                await conn.execute(text("SELECT 1 FROM statutes_staging WHERE id = :i FOR UPDATE"), {"i": ids[0]})
                held.set()
                while not release.is_set():
                    await asyncio.sleep(0.05)
        finally:
            await engine.dispose()

    blocker = threading.Thread(target=lambda: asyncio.run(holder()))
    blocker.start()
    assert held.wait(30)
    outcome = {}
    try:
        with corpus_db.app_engine_as(*corpus_db.runtime_role()):
            worker = threading.Thread(target=lambda: outcome.setdefault("r", fire("normalise-corpus").state))
            worker.start()
            worker.join(30)
            waited = worker.is_alive()
            release.set()
            worker.join(60)
    finally:
        release.set()
        blocker.join(30)
    assert not waited, "the tick waited on the locked record instead of skipping it"
    assert outcome == {"r": "SUCCESS"}
    states = dict(admin_fetch(corpus_db, "SELECT id, lifecycle_state FROM statutes_staging"))
    assert states[ids[0]] == "parsed" and [states[i] for i in ids[1:]] == ["normalised"] * 4


# ---------------------------------------------------------------------------------------------
# (e) a worker killed mid-move leaves the record recoverable
# ---------------------------------------------------------------------------------------------
CRASH_RUNNER = '''
import os, sys, time
sys.path.insert(0, os.environ["F21_PROJECT_ROOT"])
from scraper.publication import retrieval
real = retrieval.enqueue_embedding

async def enqueue_then_hang(db, table_name, record_id):
    # The retrieval row is written (flushed, not committed); say so, then wait to be killed.
    await db.flush()
    open(os.environ["F21_MARKER"], "w").write(str(record_id))
    while True:
        time.sleep(0.2)

retrieval.enqueue_embedding = enqueue_then_hang
from scraper.tasks import celery_app
entry = celery_app.app.conf.beat_schedule["publish-corpus"]
celery_app.app.tasks[entry["task"]].apply(args=entry.get("args", ()))
'''


def test_e_a_worker_killed_mid_move_leaves_the_record_recoverable(corpus_db, monkeypatch, tmp_path):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    ids = _stage_statutes(corpus_db, 1)
    user, password = corpus_db.runtime_role()
    with corpus_db.app_engine_as(user, password):
        fire("normalise-corpus")
        fire("promote-corpus")
    assert admin_fetch(corpus_db, "SELECT lifecycle_state FROM statutes_staging") == [("approved",)]

    marker = tmp_path / "in-flight"
    script = tmp_path / "crash_runner.py"
    script.write_text(CRASH_RUNNER)
    env = {**os.environ, "DATABASE_URL": corpus_db.url_as(user, password), "F21_MARKER": str(marker),
           "F21_PROJECT_ROOT": str(PROJECT_ROOT), "PYTHONPATH": str(PROJECT_ROOT)}
    proc = subprocess.Popen([sys.executable, str(script)], cwd=str(PROJECT_ROOT), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 120
        while not marker.exists() and proc.poll() is None and time.monotonic() < deadline:
            time.sleep(0.1)
        assert marker.exists(), corpus_db.redact((proc.stderr.read() if proc.poll() is not None else b"").decode()[-3000:])
        # Inside the transaction: the retrieval row exists for the worker only.
        os.kill(proc.pid, signal.SIGKILL)
        proc.wait(30)
    finally:
        if proc.poll() is None:
            proc.kill()
    # Postgres ends the dead worker's backend and rolls its transaction back.
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and admin_fetch(
            corpus_db, "SELECT count(*) FROM pg_stat_activity WHERE usename = :u AND datname = current_database()", u=user)[0][0]:
        time.sleep(0.2)
    after_crash = {
        "state": admin_fetch(corpus_db, "SELECT lifecycle_state FROM statutes_staging")[0][0],
        "master": count(corpus_db, "statutes_master"),
        "outbox": count(corpus_db, "embedding_queue"),
        "moves": count(corpus_db, "corpus_lifecycle_transitions", "to_state IN ('published', 'embedded')"),
    }
    assert after_crash == {"state": "approved", "master": 0, "outbox": 0, "moves": 0}
    with corpus_db.app_engine_as(user, password):
        assert fire("publish-corpus").state == "SUCCESS"
        assert fire("publish-corpus").state == "SUCCESS"
    assert admin_fetch(corpus_db, "SELECT lifecycle_state FROM statutes_staging") == [("embedded",)]
    assert count(corpus_db, "statutes_master") == 1 and count(corpus_db, "embedding_queue") == 1
    assert count(corpus_db, "corpus_lifecycle_transitions", "record_id = :i AND to_state = 'embedded'", i=ids[0]) == 1


# ---------------------------------------------------------------------------------------------
# (f) stalled records raise the alert on F28's corpus alert line
# ---------------------------------------------------------------------------------------------
def test_f_stalled_records_raise_the_corpus_alert(corpus_db, monkeypatch, caplog):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    stale = _stage_statutes(corpus_db, 3)
    fresh = _stage_statutes(corpus_db, 1, source="NationalAssembly")
    cases = _stage_trusted_cases(corpus_db, 2, page=2300)
    # Age them: two statutes waiting in parsed for 7 h, one in approved for 7 h; one case quarantined
    # for 8 days with its review row, one for 2 days (under the review threshold).
    admin_exec(corpus_db, "UPDATE statutes_staging SET state_changed_at = now() - interval '7 hours' WHERE id = ANY(:i)",
               i=stale[:2])
    admin_exec(corpus_db, "UPDATE statutes_staging SET lifecycle_state = 'approved', normalised = true, "
                          "state_changed_at = now() - interval '7 hours' WHERE id = :i", i=stale[2])
    for sid, days in zip(cases, (8, 2)):
        admin_exec(corpus_db, "UPDATE scraper_staging SET lifecycle_state = 'quarantined', normalised = true, quarantined = true, "
                              "quarantine_reason = 'review_source', state_changed_at = now() - make_interval(days => :d) "
                              "WHERE id = :i", i=sid, d=days)
        admin_exec(corpus_db, "INSERT INTO quarantine_queue (staging_id, source_site, reason) VALUES (:i, :s, 'review_source')",
                   i=sid, s=TRUSTED_FEED)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()), caplog.at_level(logging.ERROR):
        res = fire("reconcile-corpus")
    assert res.state == "SUCCESS", res.result
    lines = sorted(r.getMessage() for r in caplog.records if r.getMessage().startswith("F28 source alert: "))
    assert len(lines) == 3, lines
    assert lines[0].startswith("F28 source alert: F21TrustedFeed stalled: 1 scraper_staging rows in quarantined for more than 168 h")
    assert lines[1].startswith("F28 source alert: PakistanCode stalled: 1 statutes_staging rows in approved for more than 6 h")
    assert lines[2].startswith("F28 source alert: PakistanCode stalled: 2 statutes_staging rows in parsed for more than 6 h")
    summary = lifecycle_jobs(corpus_db)[-1][2]
    assert sorted(summary["alerts"]) == sorted(line[len("F28 source alert: "):] for line in lines)
    assert summary["report"]["NationalAssembly"]["statutes_staging"]["parsed"]["count"] == len(fresh)


# ---------------------------------------------------------------------------------------------
# (g) the reconciler repairs what crossed components
# ---------------------------------------------------------------------------------------------
def test_g_the_reconciler_repairs_published_records_and_dead_letters_unreviewable_ones(corpus_db, monkeypatch):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    with_master, without_master = _stage_statutes(corpus_db, 2)
    (orphan,) = _stage_trusted_cases(corpus_db, 1, page=2400)
    master_id = uuid.uuid4()
    admin_exec(corpus_db, "INSERT INTO statutes_master (id, statute_name, short_name, section_number, section_text, source_site) "
                          "VALUES (:m, 'F21 Concurrency Act 2099', 'f21conc', '0', 'Synthetic text', 'PakistanCode')", m=master_id)
    admin_exec(corpus_db, "UPDATE statutes_staging SET lifecycle_state = 'published', normalised = true, promoted = true, "
                          "published_id = :m WHERE id = :i", m=master_id, i=with_master)
    admin_exec(corpus_db, "UPDATE statutes_staging SET lifecycle_state = 'published', normalised = true, promoted = true, "
                          "published_id = :m WHERE id = :i", m=uuid.uuid4(), i=without_master)
    admin_exec(corpus_db, "UPDATE scraper_staging SET lifecycle_state = 'quarantined', normalised = true, quarantined = true, "
                          "quarantine_reason = 'review_source' WHERE id = :i", i=orphan)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        assert fire("reconcile-corpus").state == "SUCCESS"
        assert fire("reconcile-corpus").state == "SUCCESS"
    statutes = dict(admin_fetch(corpus_db, "SELECT id, lifecycle_state || ':' || coalesce(state_reason, '') FROM statutes_staging"))
    assert statutes == {with_master: "embedded:", without_master: "dead_letter:published_record_missing"}
    assert admin_fetch(corpus_db, "SELECT lifecycle_state, state_reason FROM scraper_staging") == [
        ("dead_letter", "quarantined_without_review_row")]
    assert admin_fetch(corpus_db, "SELECT table_name, record_id FROM embedding_queue") == [("statutes_master", master_id)]


# ---------------------------------------------------------------------------------------------
# (i) a record whose step fails does not stop the tick, and is tried again by the next one
# ---------------------------------------------------------------------------------------------
def test_i_a_failing_record_is_tried_once_per_tick_and_the_rest_move_on(corpus_db, monkeypatch, caplog):
    from scraper.tasks import normalise

    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    bad, *good = _stage_statutes(corpus_db, 4)  # the oldest, so it is claimed first
    real = normalise.normalise

    async def boom_on_bad(db, row, *, job_id=None):
        if row.id == bad:
            raise RuntimeError("synthetic F21 fault with row data")
        return await real(db, row, job_id=job_id)

    monkeypatch.setattr(normalise, "normalise", boom_on_bad)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()), caplog.at_level(logging.WARNING):
        first = fire("normalise-corpus")
        monkeypatch.setattr(normalise, "normalise", real)
        second = fire("normalise-corpus")
    assert first.state == "SUCCESS", f"one failing record failed the whole tick: {first.result!r}"
    assert (first.result["claimed"], first.result["failed"], first.result["moved"]) == (4, 1, {"normalised": 3}), first.result
    assert (second.state, second.result["claimed"], second.result["moved"]) == ("SUCCESS", 1, {"normalised": 1})
    states = dict(admin_fetch(corpus_db, "SELECT id, lifecycle_state FROM statutes_staging"))
    assert set(states.values()) == {"normalised"}
    messages = " ".join(r.getMessage() for r in caplog.records)
    assert f"lifecycle.record_failed consumer=normalise phase=normalise table=statutes_staging id={bad}" in messages
    assert "row data" not in messages
    jobs = [(t, s, r["failed"]) for t, s, r in lifecycle_jobs(corpus_db)]
    assert jobs == [("normalise", "completed", 1), ("normalise", "completed", 0)]


# ---------------------------------------------------------------------------------------------
# (j) trust is read again at publication: a source no longer trusted is never published
# ---------------------------------------------------------------------------------------------
def test_j_a_source_demoted_after_the_gate_is_not_published(corpus_db, monkeypatch):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    _stage_statutes(corpus_db, 1)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        fire("normalise-corpus")
        fire("promote-corpus")
        assert admin_fetch(corpus_db, "SELECT lifecycle_state FROM statutes_staging") == [("approved",)]
        admin_exec(corpus_db, "UPDATE scraper_sources SET trust_level = 'review' WHERE source_name = 'PakistanCode'")
        assert fire("publish-corpus").state == "SUCCESS"
    assert admin_fetch(corpus_db, "SELECT lifecycle_state, state_reason FROM statutes_staging") == [
        ("dead_letter", "source_not_promotable:review_source")]
    assert count(corpus_db, "statutes_master") == 0 and count(corpus_db, "embedding_queue") == 0


# ---------------------------------------------------------------------------------------------
# (k) two workers normalising two copies of one document keep exactly one
# ---------------------------------------------------------------------------------------------
def test_k_two_workers_on_two_copies_of_one_document_keep_one(corpus_db, monkeypatch):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    first, second = _stage_statutes(corpus_db, 2)
    # The same document twice: same source, URL, act, section and text.
    admin_exec(corpus_db, "UPDATE statutes_staging s SET source_url = o.source_url, extracted_section_number = o.extracted_section_number, "
                          "extracted_section_text = o.extracted_section_text, raw_text = o.raw_text "
                          "FROM statutes_staging o WHERE s.id = :b AND o.id = :a", a=first, b=second)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        assert run(fetch("SELECT 1")) == [(1,)]
        results = _two_workers("normalise-corpus", monkeypatch)
    assert sorted(r["claimed"] for _s, r in results) == [1, 1], results
    states = Counter(s for (s,) in admin_fetch(corpus_db, "SELECT lifecycle_state FROM statutes_staging"))
    assert states == Counter({"normalised": 1, "duplicate": 1})
    kept = admin_fetch(corpus_db, "SELECT id FROM statutes_staging WHERE lifecycle_state = 'normalised'")[0][0]
    reason = admin_fetch(corpus_db, "SELECT state_reason FROM statutes_staging WHERE lifecycle_state = 'duplicate'")[0][0]
    assert reason == f"duplicate_of:{kept}"


# ---------------------------------------------------------------------------------------------
# (l) statutes pass the same review gate: a review source's statute waits for a reviewer
# ---------------------------------------------------------------------------------------------
def test_l_a_review_source_statute_is_held_for_review_and_can_be_rejected(corpus_db, monkeypatch):
    from fastapi.testclient import TestClient

    from scraper.config import settings

    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    admin_exec(corpus_db, "UPDATE scraper_sources SET trust_level = 'review' WHERE source_name = 'PakistanCode'")
    (sid,) = _stage_statutes(corpus_db, 1)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        for _ in range(2):
            tick()
        held = admin_fetch(corpus_db, "SELECT lifecycle_state, quarantine_reason FROM statutes_staging")
        queue = admin_fetch(corpus_db, "SELECT id, staging_id, statutes_staging_id, reason, extracted_section FROM quarantine_queue")
        assert held == [("quarantined", "review_source")]
        assert [(q[1], q[2], q[3], q[4]) for q in queue] == [(None, sid, "review_source", "0")]
        from scraper.main import app

        with TestClient(app, raise_server_exceptions=False) as client:
            # F23's promote needs a case record (spec R7, residual R-1); reject works.
            promote = client.post(f"/quarantine/{queue[0][0]}/promote", json={"reviewer": REVIEWER, "reason": REASON},
                                  headers={"X-API-Key": settings.ADMIN_API_KEY})
            reject = client.post(f"/quarantine/{queue[0][0]}/reject", json={"reviewer": REVIEWER, "reason": REASON},
                                 headers={"X-API-Key": settings.ADMIN_API_KEY})
        assert (promote.status_code, promote.json()["detail"]["error"]) == (409, "staging_record_missing")
        assert reject.status_code == 200, reject.text
        tick()
    assert admin_fetch(corpus_db, "SELECT lifecycle_state, state_reason FROM statutes_staging") == [("rejected", "review_rejected")]
    assert count(corpus_db, "statutes_master") == 0 and count(corpus_db, "embedding_queue") == 0


# ---------------------------------------------------------------------------------------------
# (h) migration 005 brings a main-era database into the lifecycle, once
# ---------------------------------------------------------------------------------------------
LIFECYCLE_COLUMNS = ("lifecycle_state", "state_changed_at", "state_reason", "published_id")


def _to_main_shape(db):
    """Undo what 005 adds, so the database looks like one main left behind."""
    for table in ("scraper_staging", "statutes_staging"):
        for column in LIFECYCLE_COLUMNS:
            admin_exec(db, f"ALTER TABLE {table} DROP COLUMN IF EXISTS {column} CASCADE")
    admin_exec(db, "DROP TABLE IF EXISTS corpus_lifecycle_transitions")
    admin_exec(db, "ALTER TABLE scraper_jobs DROP CONSTRAINT IF EXISTS ck_jobs_type_values")
    admin_exec(db, "ALTER TABLE scraper_jobs ADD CONSTRAINT ck_jobs_type_values CHECK (job_type IN "
                   "('full_scrape','incremental','retry_failed','embed','cross_ref','cause_list','bench'))")


def test_h_migration_005_backfills_a_main_era_database_once(corpus_db):
    prepare(corpus_db)
    _to_main_shape(corpus_db)
    nasir = admin_fetch(corpus_db, "SELECT id FROM scraper_sources WHERE source_name = 'NasirLawSite'")[0][0]
    rows = {}

    def stage(label, **flags):
        sid = uuid.uuid4()
        rows[label] = sid
        columns = ", ".join(["id", "source_id", "source_site", "source_url", "raw_text", *flags])
        values = ", ".join([":id", ":src", "'NasirLawSite'", ":url", "'synthetic F21 legacy text'", *(f":{k}" for k in flags)])
        admin_exec(db=corpus_db, sql=f"INSERT INTO scraper_staging ({columns}) VALUES ({values})",
                   id=sid, src=nasir, url=f"https://f21.example.invalid/legacy/{label}", **flags)
        return sid

    reviewed_case, plain_case, f23_outbox = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    for cid, cite in ((reviewed_case, "2099 SCMR 2501"), (plain_case, "2099 SCMR 2502")):
        admin_exec(corpus_db, "INSERT INTO case_law_master (id, citation, is_promoted, source_site) VALUES (:i, :c, true, 'NasirLawSite')",
                   i=cid, c=cite)
    stage("f23_promoted", normalised=True, quarantined=True, promoted=True, promoted_to_id=reviewed_case)
    stage("master_no_outbox", normalised=True, promoted=True, promoted_to_id=plain_case)
    stage("annex_a", normalised=True, promoted=True, promoted_to_id=uuid.uuid4())
    stage("held", normalised=True, quarantined=True, quarantine_reason="review_source")
    stage("label", quarantined=True, quarantine_reason="review source")
    stage("label_normalised", normalised=True, quarantined=True, quarantine_reason="review source")
    stage("normalised", normalised=True)
    stage("plain")
    queue_f23, queue_held = uuid.uuid4(), uuid.uuid4()
    for qid, label in ((queue_f23, "f23_promoted"), (queue_held, "held")):
        admin_exec(corpus_db, "INSERT INTO quarantine_queue (id, staging_id, source_site, reason) VALUES (:q, :s, 'NasirLawSite', 'review_source')",
                   q=qid, s=rows[label])
    admin_exec(corpus_db, "INSERT INTO embedding_queue (id, record_id, table_name) VALUES (:o, :r, 'case_law_master')",
               o=f23_outbox, r=reviewed_case)
    admin_exec(corpus_db,
               "INSERT INTO quarantine_decisions (quarantine_id, staging_id, decision, reviewer, reviewer_auth, reason, prior_state, "
               "new_state, publication_key, published_table, published_id, embedding_outbox_id) VALUES (:q, :s, 'promoted', "
               "'Reviewer F21 (synthetic)', 'shared_admin_key', 'synthetic', '{}', '{}', :k, 'case_law_master', :p, :o)",
               q=queue_f23, s=rows["f23_promoted"], k=f"quarantine/{queue_f23}", p=reviewed_case, o=f23_outbox)

    first = corpus_db.migrate()
    assert_migrated(first, corpus_db)
    got = {label: admin_fetch(corpus_db, "SELECT lifecycle_state, quarantined, quarantine_reason, published_id "
                                         "FROM scraper_staging WHERE id = :i", i=sid)[0]
           for label, sid in rows.items()}
    assert {label: row[0] for label, row in got.items()} == {
        "f23_promoted": "embedded", "master_no_outbox": "published", "annex_a": "approved", "held": "quarantined",
        "label": "parsed", "label_normalised": "normalised", "normalised": "normalised", "plain": "parsed"}
    assert got["label"][1:3] == (False, None) and got["label_normalised"][1:3] == (False, None)
    assert got["held"][1:3] == (True, "review_source")
    assert (got["f23_promoted"][3], got["master_no_outbox"][3]) == (reviewed_case, plain_case)
    backfill = admin_fetch(corpus_db, "SELECT record_id, to_state, actor, details FROM corpus_lifecycle_transitions WHERE from_state IS NULL")
    assert len(backfill) == len(rows) and {actor for _r, _t, actor, _d in backfill} == {"migration_005"}
    label_move = next(d for r, _t, _a, d in backfill if r == rows["label"])
    assert label_move["legacy"]["quarantine_reason"] == "review source"
    assert "migration 005: scraper_staging" in first.stderr + first.stdout

    second = corpus_db.migrate()
    assert_migrated(second, corpus_db)
    assert count(corpus_db, "corpus_lifecycle_transitions") == len(rows)
    assert "migration 005: already current" in second.stderr + second.stdout
    jobs_check = admin_fetch(corpus_db, "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_jobs_type_values'")[0][0]
    assert all(f"'{t}'" in jobs_check for t in LIFECYCLE_JOB_TYPES), jobs_check
