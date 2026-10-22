"""Audit F26 end to end: every harvested PDF is size-bounded at the fetch boundary, kept once by its
sha256, and parsed in a separate, limited process; every refusal is a failed document and the run
goes on.

The flow is the production one. Each test fires the real ``scrape-lahorehighcourt`` beat entry: the
real Celery task (``Task.apply``), dispatcher and LahoreHighCourt harvester, the real fetch boundary
(``PolicyFetcher``) and the F28 run record, against a fresh Postgres 16 + pgvector database migrated
by the real ``python -m scraper.migrate`` (the ``corpus_db`` fixture, CORPUS_TEST_DATABASE_URL).

Only the network edge is the test's: a local HTTPS court (a throwaway CA) that the boundary reaches
through its own test hooks (``_test_ssl_context``, ``_test_loopback_origins``, refused outside
ENVIRONMENT=development), and LahoreHighCourt's listing discovery, replaced to return that court's
PDF URLs, as the F20 and F28 harnesses do. Small sandbox limits, where a case needs them, replace
``pdf_sandbox.LIMITS`` (on main there is no sandbox, so there is nothing to replace).

Expected values are written out from the spec (docs/superpowers/specs/
2026-10-18-f26-bounded-isolated-pdf-processing-design.md, rulings R1-R11 and section 4), not imported
from the code under test. Every PDF is synthetic (tests/pdf_fixtures.py); the golden texts in
tests/fixtures/f26 were produced by main's unmodified in-process extractor. Citations are dated 2099.
"""

import contextlib
import dataclasses
import hashlib
import os
import select
import ssl
import stat
import threading
import time
import tracemalloc
import types
from pathlib import Path

import pytest

import pdf_fixtures as F
from f25_servers import RecordingServer, client_tls_context, make_test_pki, server_tls_context, serving
from test_f20_trust_policy_db import assert_migrated, fetch, run
from test_f28_source_outcomes_e2e import COURT_PDF_SOURCES, canned_network, fire, jobs, no_proxy, no_sleep, source_row

SOURCE = "LahoreHighCourt"
ENTRY = "scrape-lahorehighcourt"
MIB = 1024 * 1024
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "f26"
PDF_HEADERS = {"Content-Type": "application/pdf"}
# Path operators in the slow fixture: on main's in-process extractor 1,000,000 took 54.6 s at load ~15
# (evidence log). Three million stays far past the 10 s test wall limit on a fast idle machine.
SLOW_OPS = 3_000_000


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
def golden_pdf(name):
    return (FIXTURES / f"{name}.pdf").read_bytes()


def golden_text(name):
    return (FIXTURES / f"{name}.txt").read_text(encoding="utf-8")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def streamed(body):
    """A route that sends ``body`` with no Content-Length (the body ends when the connection closes),
    so only the bytes on the wire can tell the boundary how large it is."""

    def _route(handler):
        handler.send_response(200)
        handler.send_header("Content-Type", "application/pdf")
        handler.send_header("Connection", "close")
        handler.end_headers()
        handler.close_connection = True
        try:
            for start in range(0, len(body), 64 * 1024):
                handler.wfile.write(body[start:start + 64 * 1024])
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError, OSError):
            pass  # the client stopped reading
        return None

    return _route


def sandbox_limits(monkeypatch, **overrides):
    """Smaller sandbox limits for one test (spec R12). On main there is no sandbox: the PDF is parsed
    in the worker (the finding), so there is nothing to set."""
    try:
        from scraper.parsers import pdf_sandbox
    except ImportError:
        return None
    limits = dataclasses.replace(pdf_sandbox.LIMITS, **overrides)
    monkeypatch.setattr(pdf_sandbox, "LIMITS", limits)
    return limits


@contextlib.contextmanager
def lhc_court(monkeypatch, tmp_path, documents):
    """A local HTTPS LahoreHighCourt serving ``documents`` ((name, route) pairs) at
    /judgments/2099/<name>.pdf, in that order. The LahoreHighCourt boundary allowlists exactly its
    origin; discovery returns its PDF URLs; the raw PDF vault (PDF_STORAGE_PATH) is this test's own."""
    from scraper import config
    from scraper.net import fetch_policy
    import scraper.tasks.lahorehighcourt as lhc

    no_proxy(monkeypatch)
    no_sleep(monkeypatch)
    pki = make_test_pki(tmp_path / "pki")
    server = RecordingServer(tls=server_tls_context(pki))
    origin = f"https://localhost:{server.port}"
    urls = []
    for name, route in documents:
        path = f"/judgments/2099/{name}.pdf"
        server.routes[path] = route if callable(route) else (200, PDF_HEADERS, route) if isinstance(route, bytes) else route
        urls.append(origin + path)
    policy = fetch_policy.FetchPolicy(name=SOURCE, hosts=frozenset({"localhost"}), ports=frozenset({server.port}))
    tls = client_tls_context(pki)

    def _factory(name, **kwargs):
        assert name == SOURCE, name
        return fetch_policy.PolicyFetcher(
            policy, headers=kwargs.get("headers"), _test_ssl_context=tls,
            _test_loopback_origins={("localhost", server.port)},
        )

    async def _discover(*args, **kwargs):
        return list(urls), {url: f"{origin}/reported_judgments" for url in urls}

    vault = tmp_path / "live"
    vault.mkdir(mode=0o700)
    with serving(server):
        monkeypatch.setattr(fetch_policy, "fetcher_for", _factory)
        monkeypatch.setattr(lhc, "_discover_pdf_urls", _discover)
        monkeypatch.setattr(config.settings, "PDF_STORAGE_PATH", str(vault))
        yield types.SimpleNamespace(server=server, origin=origin, urls=urls, vault=vault)


def staged():
    return run(fetch(
        "SELECT source_url, raw_text, raw_pdf_path, pdf_page_count, ocr_applied, parsing_metadata "
        "FROM scraper_staging ORDER BY created_at, source_url"
    ))


def stored_objects(vault):
    """Every object in the raw PDF store: {file name: (relative path, mode, inode, mtime_ns, bytes)}."""
    root = Path(vault) / "raw-pdf"
    out = {}
    if root.is_dir():
        for path in sorted(root.rglob("*.pdf")):
            st = path.stat()
            out[path.name] = (
                path.relative_to(vault).as_posix(), stat.S_IMODE(st.st_mode), st.st_ino, st.st_mtime_ns, path.read_bytes()
            )
    return out


def worker_parser_probe(monkeypatch):
    """Records every PDF document object pdfminer (the parser under pdfplumber) builds in THIS process,
    the worker. A sandboxed parse runs in a fresh interpreter, so nothing is recorded here."""
    calls = []
    try:
        from pdfminer import pdfdocument
    except ImportError:  # no parser installed in this process at all
        return calls
    real = pdfdocument.PDFDocument.__init__

    def _probe(self, *args, **kwargs):
        calls.append(threading.current_thread().name)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(pdfdocument.PDFDocument, "__init__", _probe)
    return calls


class Checks:
    """Collects every expectation of a test, so a failure shows all of what main does at once."""

    def __init__(self):
        self.failed = []

    def __call__(self, ok, what):
        if not ok:
            self.failed.append(what)

    def verify(self):
        assert not self.failed, "\n".join(["F26 expectations not met:"] + [f"- {f}" for f in self.failed])


def run_record(checks, *, status, extracted, failed, errors, outcome=None):
    rows = jobs(SOURCE)
    got = [(r.status, r.records_extracted, r.records_failed) for r in rows]
    checks(got == [(status, extracted, failed)], f"run record: want {[(status, extracted, failed)]}, got {got}")
    summary = rows[-1].result_summary if rows else {}
    checks(summary.get("errors") == errors, f"run errors: want {errors}, got {summary.get('errors')}")
    if outcome is not None:
        checks(summary.get("outcome") == outcome, f"run outcome: want {outcome}, got {summary.get('outcome')}")
    return rows


def staged_only(checks, url, golden):
    rows = staged()
    checks([r.source_url for r in rows] == [url], f"staged: want only {url}, got {[r.source_url for r in rows]}")
    if rows:
        checks(rows[-1].raw_text == golden_text(golden), "the normal judgment's staged text differs from main's extraction")
    return rows


# ---------------------------------------------------------------------------------------------
# (a)/(b) hostile documents: refused within the limits, counted as failed, the run goes on
# ---------------------------------------------------------------------------------------------
def test_b_a_pdf_over_the_size_cap_is_refused_at_the_boundary_and_the_run_goes_on(corpus_db, monkeypatch, tmp_path, caplog):
    """The operator's PDF_MAX_SIZE_MB (here 1) is the cap. One oversized but valid PDF declares its
    length, one streams it with no Content-Length; the fetch boundary refuses both while it reads, the
    first on its declared length before any body byte, the second once 1 MiB has arrived (spec R2:
    `pdf_too_large`); neither is stored, and the normal judgment after them is staged. On main the
    setting is read by nothing: both are downloaded whole (F25's 100 MiB is the only cap), parsed in
    the worker and staged."""
    import logging

    from scraper import config

    assert_migrated(corpus_db.migrate(), corpus_db)
    monkeypatch.setattr(config.settings, "PDF_MAX_SIZE_MB", 1)
    big = F.padded_pdf(F.judgment_lines(6, seed="OVERSIZE"), 2 * MIB + 4096)
    golden = golden_pdf("golden-one-page")
    with lhc_court(monkeypatch, tmp_path, [("declared", big), ("streamed", streamed(big)), ("normal", golden)]) as court:
        with caplog.at_level(logging.WARNING):
            result = fire(ENTRY)

    checks = Checks()
    checks(result.state == "SUCCESS", f"task state {result.state}: {result.result!r}")
    run_record(checks, status="completed", extracted=1, failed=2, errors={"pdf_too_large": 2}, outcome="partial")
    staged_only(checks, court.urls[2], "golden-one-page")
    checks(set(stored_objects(court.vault)) == {sha256(golden) + ".pdf"},
           f"raw store: want only the normal judgment, got {sorted(stored_objects(court.vault))}")
    # Where each was refused: by the boundary while reading (its reasons), not after a full download.
    refusals = [r.getMessage() for r in caplog.records if r.getMessage().startswith("F26 PDF refused")]
    for name, reason in (("declared", f"Content-Length {len(big)} > {MIB}"), ("streamed", f"body over {MIB} bytes on the wire")):
        checks(any(f"/{name}.pdf (pdf_too_large: {reason})" in m for m in refusals),
               f"{name}: no boundary refusal '{reason}' among {refusals}")
    checks.verify()


def test_b_a_decompression_bomb_is_refused_in_the_sandbox_and_never_parsed_in_the_worker(corpus_db, monkeypatch, tmp_path):
    """A 0.5 MB PDF whose content stream inflates to 512 MiB. Spec R6/R8: it is parsed in the sandbox,
    whose address space (here 384 MiB) it exceeds: `pdf_memory_limit`. The worker builds no PDF document
    object and allocates nothing bomb-sized; the bytes were stored before parsing (R5); the next
    judgment is staged (R11). On main the worker itself inflates it (its peak RSS reached 1,073 MiB in
    calibration) and records an empty extraction."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    sandbox_limits(monkeypatch, memory_bytes=384 * MIB)
    bomb = F.bomb_pdf(512)
    golden = golden_pdf("golden-three-pages")
    parsed_in_worker = worker_parser_probe(monkeypatch)
    with lhc_court(monkeypatch, tmp_path, [("bomb", bomb), ("normal", golden)]) as court:
        tracemalloc.start()
        try:
            result = fire(ENTRY)
            _, worker_peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()

    checks = Checks()
    checks(result.state == "SUCCESS", f"task state {result.state}: {result.result!r}")
    run_record(checks, status="completed", extracted=1, failed=1, errors={"pdf_memory_limit": 1}, outcome="partial")
    staged_only(checks, court.urls[1], "golden-three-pages")
    checks(parsed_in_worker == [], f"PDF parser code ran in the worker process ({len(parsed_in_worker)} documents opened)")
    checks(worker_peak < 64 * MIB, f"the worker's Python allocations peaked at {worker_peak / MIB:.0f} MiB")
    checks(set(stored_objects(court.vault)) == {sha256(bomb) + ".pdf", sha256(golden) + ".pdf"},
           f"raw store: want the bomb (kept before parsing) and the judgment, got {sorted(stored_objects(court.vault))}")
    checks.verify()


def test_b_a_parse_past_the_wall_limit_is_killed_and_the_run_goes_on(corpus_db, monkeypatch, tmp_path):
    """A 70 KB PDF with three million path operators: the parser grinds on it (no text, little memory).
    Spec R6/R8: the sandbox is killed at its wall limit (here 10 s): `pdf_parse_timeout`, and the run
    goes on to stage the next judgment. On main the worker parses it to the end on its event loop and
    records an empty extraction."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    limits = sandbox_limits(monkeypatch, wall_seconds=10.0, cpu_seconds=10)
    slow = F.slow_pdf(SLOW_OPS)
    golden = golden_pdf("golden-one-page")
    with lhc_court(monkeypatch, tmp_path, [("slow", slow), ("normal", golden)]) as court:
        started = time.monotonic()
        result = fire(ENTRY)
        elapsed = time.monotonic() - started

    checks = Checks()
    checks(result.state == "SUCCESS", f"task state {result.state}: {result.result!r}")
    run_record(checks, status="completed", extracted=1, failed=1, errors={"pdf_parse_timeout": 1}, outcome="partial")
    staged_only(checks, court.urls[1], "golden-one-page")
    # The slow document costs at most its wall limit; the rest of the run (two fetches, the normal
    # parse, the records) gets a generous allowance for a loaded machine.
    budget = (limits.wall_seconds if limits else 10.0) + 50.0
    checks(elapsed < budget, f"the run took {elapsed:.1f} s; the slow document is bounded by the 10 s wall limit")
    checks(sha256(slow) + ".pdf" in stored_objects(court.vault), "the slow PDF was not kept before parsing")
    checks.verify()


@contextlib.contextmanager
def worker_output_counted():
    """Points this process's fds 1 and 2 at a pipe and counts every byte written to it while the
    block runs. In a Celery worker those descriptors are the container's log (Docker's json-file
    driver; compose sets no rotation), and a spawned sandbox child inherits them. billiard's
    semaphore tracker, which a first spawn starts with the same descriptors, is started first so it
    keeps the real ones."""
    from billiard import semaphore_tracker

    semaphore_tracker.ensure_running()
    written = [0]
    read_fd, write_fd = os.pipe()
    stop = threading.Event()

    def _drain():
        while True:
            ready, _, _ = select.select([read_fd], [], [], 0.2)
            if ready:
                chunk = os.read(read_fd, 1 << 20)
                if not chunk:
                    return
                written[0] += len(chunk)
            elif stop.is_set():
                return

    drain = threading.Thread(target=_drain, name="f26-worker-output", daemon=True)
    drain.start()
    saved = (os.dup(1), os.dup(2))
    os.dup2(write_fd, 1)
    os.dup2(write_fd, 2)
    os.close(write_fd)
    try:
        yield written
    finally:
        os.dup2(saved[0], 1)
        os.dup2(saved[1], 2)
        for fd in saved:
            os.close(fd)
        stop.set()
        drain.join(30)
        if not drain.is_alive():
            os.close(read_fd)


def test_b_a_pdf_that_floods_the_parser_s_log_writes_nothing_to_the_worker_s_output(corpus_db, monkeypatch, tmp_path):
    """FA-corpus-009, the re-audit's MEDIUM: a 2,777-byte PDF whose form XObject makes pdfminer log a
    warning, quoting a 100 KB string, at each of 200,000 invocations. The re-audit measured 7,241 MiB
    written to the worker's stderr in 300 s under the production limits. Spec R16: the child's
    fds 1 and 2 are /dev/null and its logging is off, so the worker's own stdout and stderr receive
    at most 64 KiB during the whole run; the document still ends at the wall limit (here 8 s) as
    `pdf_parse_timeout` and the next judgment is staged."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    sandbox_limits(monkeypatch, wall_seconds=8.0, cpu_seconds=8)
    flood = F.log_flood_pdf()
    golden = golden_pdf("golden-one-page")
    with lhc_court(monkeypatch, tmp_path, [("flood", flood), ("normal", golden)]) as court:
        with worker_output_counted() as written:
            result = fire(ENTRY)

    checks = Checks()
    checks(len(flood) == 2777, f"the flood PDF is {len(flood)} bytes, not the re-audit's 2,777")
    checks(written[0] <= 64 * 1024,
           f"the worker's stdout and stderr received {written[0]:,} bytes ({written[0] / MIB:.1f} MiB) during the run; "
           f"the bound is 64 KiB")
    checks(result.state == "SUCCESS", f"task state {result.state}: {result.result!r}")
    run_record(checks, status="completed", extracted=1, failed=1, errors={"pdf_parse_timeout": 1}, outcome="partial")
    staged_only(checks, court.urls[1], "golden-one-page")
    print(f"F26-FU: the worker's stdout and stderr received {written[0]} bytes during the flood run")  # evidence log
    checks.verify()


# ---------------------------------------------------------------------------------------------
# (c) a normal PDF parses to the same text as before
# ---------------------------------------------------------------------------------------------
def test_c_normal_judgments_are_staged_with_exactly_the_text_main_extracted(corpus_db, monkeypatch, tmp_path):
    """The golden fixtures (one page, three pages, deflated with special characters) were extracted by
    main's unmodified in-process extractor; through the sandbox the staged text is identical (spec R9).
    This is the control: it passes on main too."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    names = ["golden-one-page", "golden-three-pages", "golden-deflated-special"]
    with lhc_court(monkeypatch, tmp_path, [(name, golden_pdf(name)) for name in names]) as court:
        result = fire(ENTRY)

    assert result.state == "SUCCESS", repr(result.result)
    texts = {row.source_url: row.raw_text for row in staged()}
    assert set(texts) == set(court.urls), texts.keys()
    for name, url in zip(names, court.urls):
        assert texts[url] == golden_text(name), f"{name}: the staged text differs from main's extraction"
    rows = jobs(SOURCE)
    assert [(r.status, r.records_extracted, r.records_failed) for r in rows] == [("completed", 3, 0)], rows


# ---------------------------------------------------------------------------------------------
# (d) raw bytes are stored once, by hash, before parsing
# ---------------------------------------------------------------------------------------------
def test_d_raw_bytes_are_kept_once_by_hash_and_every_row_points_at_them(corpus_db, monkeypatch, tmp_path):
    """The same judgment at two URLs, harvested by two runs: one owner-read-only object named by its sha256
    under raw-pdf/sha256/<aa>/<bb>/, written once (the second run neither rewrites nor replaces it), and
    all four staging rows carry its key, the page count, `ocr_applied` false and the sha256 (spec R5).
    On main nothing is kept."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    golden = golden_pdf("golden-three-pages")
    digest = sha256(golden)
    key = f"raw-pdf/sha256/{digest[:2]}/{digest[2:4]}/{digest}.pdf"
    with lhc_court(monkeypatch, tmp_path, [("first", golden), ("copy", golden)]) as court:
        first = fire(ENTRY)
        after_first = stored_objects(court.vault)
        second = fire(ENTRY)
        after_second = stored_objects(court.vault)

    checks = Checks()
    checks(first.state == "SUCCESS" and second.state == "SUCCESS", f"task states {first.state}, {second.state}")
    checks(list(after_first) == [digest + ".pdf"], f"raw store after run 1: want one object {digest}.pdf, got {list(after_first)}")
    if after_first:
        rel, mode, _inode, _mtime, body = after_first.get(digest + ".pdf") or next(iter(after_first.values()))
        checks(rel == key, f"object path: want {key}, got {rel}")
        checks(mode == 0o400, f"object mode: want 0o400 (owner read-only), got {oct(mode)}")
        checks(body == golden, "the stored bytes differ from the bytes served")
    checks(after_second == after_first, "the second run rewrote or replaced the stored object")
    rows = staged()
    checks(len(rows) == 4, f"want 4 staging rows (2 URLs x 2 runs), got {len(rows)}")
    for row in rows:
        metadata = row.parsing_metadata or {}
        got = (row.raw_pdf_path, row.pdf_page_count, row.ocr_applied, metadata.get("raw_sha256"))
        checks(got == (key, 3, False, digest), f"{row.source_url}: want {(key, 3, False, digest)}, got {got}")
    checks.verify()


# ---------------------------------------------------------------------------------------------
# (e) a PDF with JavaScript is refused
# ---------------------------------------------------------------------------------------------
def test_e_pdfs_with_javascript_are_refused_and_the_run_goes_on(corpus_db, monkeypatch, tmp_path):
    """Two PDFs whose catalog opens a JavaScript action: one as plain objects, one hidden in a deflated
    object stream (its bytes never spell /JS or /JavaScript). Spec R4: both `pdf_active_content`, no
    text staged; the next judgment is staged. On main both are extracted and staged."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    plain = F.javascript_pdf(F.judgment_lines(6, seed="JS1"))
    hidden = F.javascript_pdf(F.judgment_lines(6, seed="JS2"), objstm=True)
    golden = golden_pdf("golden-one-page")
    with lhc_court(monkeypatch, tmp_path, [("js-plain", plain), ("js-objstm", hidden), ("normal", golden)]) as court:
        result = fire(ENTRY)

    checks = Checks()
    checks(result.state == "SUCCESS", f"task state {result.state}: {result.result!r}")
    run_record(checks, status="completed", extracted=1, failed=2, errors={"pdf_active_content": 2}, outcome="partial")
    staged_only(checks, court.urls[2], "golden-one-page")
    checks.verify()


def test_e_a_run_of_only_active_content_pdfs_fails_and_is_not_retried(corpus_db, monkeypatch, tmp_path):
    """Every document refused for active content (JavaScript with #xx-escaped names, a file attachment
    whose stream has no /Type): the run fails (F28 R2: SourceRunFailed), once, since a refusal is not
    transient (spec R10), and the source's failure streak grows. On main both are staged and the run
    succeeds."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    escaped = F.javascript_pdf(F.judgment_lines(6, seed="JS3"), escaped=True)
    attached = F.attachment_pdf(F.judgment_lines(6, seed="ATT"))
    with lhc_court(monkeypatch, tmp_path, [("js-escaped", escaped), ("attachment", attached)]):
        result = fire(ENTRY)

    checks = Checks()
    checks(result.state == "FAILURE", f"task state {result.state}: {result.result!r}")
    checks(type(result.result).__name__ == "SourceRunFailed", f"task result {result.result!r}")
    rows = run_record(checks, status="failed", extracted=0, failed=2, errors={"pdf_active_content": 2})
    if rows:
        checks(rows[-1].result_summary.get("retryable") is False, f"retryable: {rows[-1].result_summary.get('retryable')}")
    checks(staged() == [], "an active-content PDF was staged")
    checks(source_row(SOURCE).consecutive_failures == 1, f"failure streak {source_row(SOURCE).consecutive_failures}")
    checks.verify()


# ---------------------------------------------------------------------------------------------
# R1: every PDF harvester takes the same path (the six courts and National Assembly)
# ---------------------------------------------------------------------------------------------
# Their hostnames cannot be served locally (port 443, a certificate for the court's name), so the
# network edge here is F28's canned client (every URL still checked against the source's real
# registered policy); discovery, the harvester, the intake, the raw store, the sandbox, the dispatcher
# and Postgres are real.
PDF_HARVEST_ENTRIES = sorted(COURT_PDF_SOURCES) + ["scrape-na"]


@pytest.mark.parametrize("entry", PDF_HARVEST_ENTRIES)
def test_r1_every_pdf_harvester_refuses_active_content_and_keeps_its_judgment(corpus_db, monkeypatch, tmp_path, entry):
    """Each PDF harvester gets one JavaScript PDF and one golden judgment: the first is refused
    (`pdf_active_content`) and counted, the second is parsed in the sandbox, kept by its sha256 and
    written (a court stages it with its raw key; National Assembly writes its sections). On main every
    harvester extracts and writes both."""
    from scraper import config

    assert_migrated(corpus_db.migrate(), corpus_db)
    no_sleep(monkeypatch)
    vault = tmp_path / "live"
    vault.mkdir(mode=0o700)
    monkeypatch.setattr(config.settings, "PDF_STORAGE_PATH", str(vault))
    hostile = F.javascript_pdf(F.judgment_lines(6, seed="R1"))
    golden = golden_pdf("golden-three-pages")
    digest = sha256(golden)
    if entry == "scrape-na":
        source = "NationalAssembly"
        js_url, golden_url = "https://na.gov.pk/uploads/f26-js-act-2099.pdf", "https://na.gov.pk/uploads/f26-act-2099.pdf"
        canned_network(monkeypatch, {
            "https://na.gov.pk/en/legis.php": (200, b"<html><a href='/uploads/f26-js-act-2099.pdf'>Hostile Act 2099</a>"
                                                    b"<a href='/uploads/f26-act-2099.pdf'>Synthetic Act 2099</a></html>"),
            js_url: (200, hostile), golden_url: (200, golden),
        })
    else:
        source, module, js_url = COURT_PDF_SOURCES[entry]
        golden_url = js_url.replace(".pdf", "-golden.pdf")
        canned_network(monkeypatch, {js_url: (200, hostile), golden_url: (200, golden)})
        mod = __import__(f"scraper.tasks.{module}", fromlist=["_discover_pdf_urls"])
        listing = "https://f26.example.invalid/list"
        provenance = {"listing_url": listing, "feed_url": None, "discovery_method": "f26"}

        async def _discover(*args, **kwargs):
            urls = [js_url, golden_url]
            return urls, {u: provenance if module == "islamabadhighcourt" else listing for u in urls}

        monkeypatch.setattr(mod, "_discover_pdf_urls", _discover)

    result = fire(entry)

    checks = Checks()
    checks(result.state == "SUCCESS", f"{source}: task state {result.state}: {result.result!r}")
    rows = jobs(source)
    got = [(r.status, r.result_summary.get("errors")) for r in rows]
    checks(got == [("completed", {"pdf_active_content": 1})], f"{source}: run records {got}")
    checks(set(stored_objects(vault)) == {sha256(hostile) + ".pdf", digest + ".pdf"},
           f"{source}: raw store {sorted(stored_objects(vault))}")
    if entry == "scrape-na":
        # Audit F21 (spec R12): NationalAssembly stages statutes (statutes_staging, with the PDF's raw-store
        # key) instead of writing statutes_master; before F21 this read statutes_master.
        written = run(fetch("SELECT source_url, raw_pdf_path FROM statutes_staging"))
        checks(written and {u for u, _ in written} == {golden_url}, f"{source}: statutes_staging rows from {sorted({u for u, _ in written})}")
        key = f"raw-pdf/sha256/{digest[:2]}/{digest[2:4]}/{digest}.pdf"
        checks({k for _, k in written} == {key}, f"{source}: staged raw keys {sorted({str(k) for _, k in written})}")
        checks(run(fetch("SELECT count(*) FROM statutes_master"))[0][0] == 0, f"{source}: the harvest wrote statutes_master")
    else:
        key = f"raw-pdf/sha256/{digest[:2]}/{digest[2:4]}/{digest}.pdf"
        got_rows = [(r.source_url, r.raw_pdf_path, r.pdf_page_count, (r.parsing_metadata or {}).get("raw_sha256")) for r in staged()]
        checks(got_rows == [(golden_url, key, 3, digest)], f"{source}: staged {got_rows}")
        if got_rows:
            checks(staged()[0].raw_text == golden_text("golden-three-pages"), f"{source}: staged text differs from main's")
    checks.verify()
