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
import ssl
import stat
import threading
import time
import tracemalloc
import types
from pathlib import Path

import pdf_fixtures as F
from f25_servers import RecordingServer, client_tls_context, make_test_pki, server_tls_context, serving
from test_f20_trust_policy_db import assert_migrated, fetch, run
from test_f28_source_outcomes_e2e import fire, jobs, no_proxy, no_sleep, source_row

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
    vault.mkdir()
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
def test_b_a_pdf_over_the_size_cap_is_refused_at_the_boundary_and_the_run_goes_on(corpus_db, monkeypatch, tmp_path):
    """The operator's PDF_MAX_SIZE_MB (here 1) is the cap. One oversized but valid PDF declares its
    length, one streams it with no Content-Length; both are refused by the fetch boundary while it reads
    (spec R2: `pdf_too_large`), never stored, and the normal judgment after them is staged. On main the
    setting is read by nothing: both are downloaded whole (F25's 100 MiB is the only cap), parsed in
    the worker and staged."""
    from scraper import config

    assert_migrated(corpus_db.migrate(), corpus_db)
    monkeypatch.setattr(config.settings, "PDF_MAX_SIZE_MB", 1)
    big = F.padded_pdf(F.judgment_lines(6, seed="OVERSIZE"), 2 * MIB + 4096)
    golden = golden_pdf("golden-one-page")
    with lhc_court(monkeypatch, tmp_path, [("declared", big), ("streamed", streamed(big)), ("normal", golden)]) as court:
        result = fire(ENTRY)

    checks = Checks()
    checks(result.state == "SUCCESS", f"task state {result.state}: {result.result!r}")
    run_record(checks, status="completed", extracted=1, failed=2, errors={"pdf_too_large": 2}, outcome="partial")
    staged_only(checks, court.urls[2], "golden-one-page")
    checks(set(stored_objects(court.vault)) == {sha256(golden) + ".pdf"},
           f"raw store: want only the normal judgment, got {sorted(stored_objects(court.vault))}")
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
    """The same judgment at two URLs, harvested by two runs: one read-only object named by its sha256
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
        checks(mode == 0o444, f"object mode: want 0o444 (read-only), got {oct(mode)}")
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
