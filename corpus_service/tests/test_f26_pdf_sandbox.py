"""Audit F26 unit and component tests: the one PDF path (guard), the sandbox process, the extractor's
caps, the active-content scan, the raw store, the intake's cheap checks and the F28 vocabulary.

Spec: docs/superpowers/specs/2026-10-18-f26-bounded-isolated-pdf-processing-design.md (R1-R12). The
end-to-end flow is tests/test_f26_pdf_intake_e2e.py. Sandbox tests start real children (billiard
spawn) on real synthetic PDFs (tests/pdf_fixtures.py); nothing here needs the network or Postgres.
OCR is exercised with a stand-in for pytesseract: the pinned test set has no tesseract.
"""

import ast
import asyncio
import contextlib
import dataclasses
import hashlib
import json
import os
import pickle
import shutil
import signal
import socket
import stat
import sys
import tempfile
import time
import types
from pathlib import Path

import pytest

import pdf_fixtures as F

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "f26"
GOLDEN = ("golden-one-page", "golden-three-pages", "golden-deflated-special")
MIB = 1024 * 1024
PDF_HARVESTERS = ("shc", "supremecourt", "lahorehighcourt", "peshawarhighcourt", "balochistanhighcourt",
                  "islamabadhighcourt", "nationalassembly")
PARSER_MODULES = ("pdfplumber", "pdfminer", "pypdfium2", "pytesseract", "PIL", "fitz", "pdf2image", "pypdf",
                  "PyPDF2", "pikepdf", "camelot", "tabula")
PROCESS_MODULES = ("billiard", "multiprocessing", "concurrent.futures.process", "pty")
PROCESS_NAMES = ("os.fork", "os.forkpty", "concurrent.futures.ProcessPoolExecutor")


def golden_pdf(name):
    return (FIXTURES / f"{name}.pdf").read_bytes()


def golden_text(name):
    return (FIXTURES / f"{name}.txt").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------------------------
# R1 / R7: one path, one process creator (static)
# ---------------------------------------------------------------------------------------------
def runtime_files():
    """What the image runs: scraper/, migrations/ and bootstrap_harvest.py (F31's runtime roots)."""
    for rel in ("scraper", "migrations"):
        yield from sorted(p for p in (PROJECT_ROOT / rel).rglob("*.py") if "__pycache__" not in p.parts)
    yield PROJECT_ROOT / "bootstrap_harvest.py"


def _rel(path):
    return path.relative_to(PROJECT_ROOT).as_posix()


def references(tree):
    """Every module a file imports and every dotted name it reads, with import aliases resolved."""
    aliases, found = {}, set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name)
                aliases[alias.asname or alias.name.split(".")[0]] = alias.name if alias.asname else alias.name.split(".")[0]
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
            for alias in node.names:
                found.add(f"{node.module}.{alias.name}")
                aliases[alias.asname or alias.name] = f"{node.module}.{alias.name}"

    def dotted(node):
        if isinstance(node, ast.Name):
            return aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            base = dotted(node.value)
            return f"{base}.{node.attr}" if base else None
        return None

    for node in ast.walk(tree):
        if isinstance(node, (ast.Name, ast.Attribute)):
            name = dotted(node)
            if name:
                found.add(name)
    return found


def _under(name, roots):
    return any(name == r or name.startswith(r + ".") for r in roots)


def files_referencing(roots):
    out = {}
    for path in runtime_files():
        hits = sorted(n for n in references(ast.parse(path.read_text(encoding="utf-8"))) if _under(n, roots))
        if hits:
            out[_rel(path)] = hits
    return out


def test_r1_only_the_extractor_imports_a_pdf_parser():
    """Parser libraries run only inside the sandbox: pdf_extractor.py is the one module that imports
    them, and only the sandbox's child imports pdf_extractor (next test)."""
    assert set(files_referencing(PARSER_MODULES)) == {"scraper/parsers/pdf_extractor.py"}, files_referencing(PARSER_MODULES)


def test_r1_only_the_sandbox_imports_the_extractor():
    users = files_referencing(("scraper.parsers.pdf_extractor",))
    assert set(users) == {"scraper/parsers/pdf_sandbox.py"}, users


def test_r1_every_pdf_harvester_takes_its_pdfs_through_the_intake():
    problems = {}
    for module in PDF_HARVESTERS:
        path = PROJECT_ROOT / "scraper" / "tasks" / f"{module}.py"
        tree = ast.parse(path.read_text(encoding="utf-8"))
        names = references(tree)
        calls = {ast.unparse(n.func) for n in ast.walk(tree) if isinstance(n, ast.Call)}
        if "pdf_intake.intake" not in calls:
            problems[module] = "never calls pdf_intake.intake"
        stray = sorted(
            n for n in names
            if "pdf_extractor" in n or n.rsplit(".", 1)[-1] in {"extract_pdf_text", "extract_pdf", "looks_like_pdf"}
        )
        if stray:
            problems[module] = f"still parses or checks PDFs itself: {stray}"
    assert not problems, problems


def test_r1_the_unbounded_downloaders_are_gone():
    tree = ast.parse((PROJECT_ROOT / "scraper" / "parsers" / "pdf_extractor.py").read_text(encoding="utf-8"))
    defined = {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert not defined & {"download_pdf", "download_pdf_sync"}, defined
    assert not any(_under(n, ("httpx",)) for n in references(tree))


def test_r7_only_the_sandbox_starts_a_process_and_only_its_spawn_child():
    """Process creation is pinned to pdf_sandbox.py: billiard's spawn context, one target (_child)."""
    users = files_referencing(PROCESS_MODULES + PROCESS_NAMES)
    assert set(users) == {"scraper/parsers/pdf_sandbox.py"}, users
    tree = ast.parse((PROJECT_ROOT / "scraper" / "parsers" / "pdf_sandbox.py").read_text(encoding="utf-8"))
    billiard_uses = sorted(n for n in references(tree) if _under(n, ("billiard",)))
    assert billiard_uses == ["billiard", "billiard.get_context"], billiard_uses
    contexts = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and ast.unparse(n.func) == "billiard.get_context"]
    assert [ast.unparse(c.args[0]) for c in contexts] == ["'spawn'"], [ast.unparse(c) for c in contexts]
    processes = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and ast.unparse(n.func).endswith(".Process")]
    targets = [ast.unparse(k.value) for p in processes for k in p.keywords if k.arg == "target"]
    assert len(processes) == 1 and targets == ["_child"], [ast.unparse(p) for p in processes]


# ---------------------------------------------------------------------------------------------
# R10: the F28 vocabulary
# ---------------------------------------------------------------------------------------------
def test_r10_a_rejected_document_is_counted_by_its_code_and_only_a_transient_status_is_retried():
    from scraper.tasks import outcomes

    tally = outcomes.Tally()
    for code in ("pdf_too_large", "pdf_active_content", "pdf_parse_timeout", "http_404", "http_503"):
        tally.item_failed(outcomes.DocumentRejected(code, "synthetic detail"))
    assert dict(tally.errors) == {"pdf_too_large": 1, "pdf_active_content": 1, "pdf_parse_timeout": 1,
                                  "http_404": 1, "http_503": 1}
    assert tally.transient_failures == 1  # http_503 only
    assert not outcomes.is_retryable(outcomes.DocumentRejected("pdf_memory_limit"))
    assert outcomes.is_retryable(outcomes.DocumentRejected("http_429"))
    # Celery pickles a failure and may rebuild it from its args (F28 R15).
    exc = outcomes.DocumentRejected("pdf_page_limit", "1001 pages")
    for copy in (pickle.loads(pickle.dumps(exc)), type(exc)(*exc.args)):
        assert (copy.code, copy.detail, outcomes.error_key(copy)) == ("pdf_page_limit", "1001 pages", "pdf_page_limit")


def test_r10_the_sandbox_codes_are_tally_codes():
    from scraper.parsers import pdf_sandbox
    from scraper.tasks import outcomes

    vocabulary = {v for k, v in vars(outcomes).items() if k.startswith("ERROR_")}
    assert pdf_sandbox.CODES <= vocabulary, pdf_sandbox.CODES - vocabulary
    assert {"pdf_too_large", "raw_store_full", "raw_store_failed", "not_pdf", "empty_pdf_text"} <= vocabulary


# ---------------------------------------------------------------------------------------------
# R6 / R7 / R8: the sandbox process
# ---------------------------------------------------------------------------------------------
def stored(tmp_path, data):
    from scraper.parsers import raw_store

    return raw_store.put(data, root=tmp_path / "vault")


def sandbox_parse(tmp_path, data, **limits):
    from scraper.parsers import pdf_sandbox

    obj = stored(tmp_path, data)
    chosen = dataclasses.replace(pdf_sandbox.LIMITS, **limits) if limits else None
    return pdf_sandbox.parse(obj.path, obj.sha256, obj.size, limits=chosen)


def refused(tmp_path, data, **limits):
    from scraper.parsers import pdf_sandbox

    with pytest.raises(pdf_sandbox.ParseRefused) as caught:
        sandbox_parse(tmp_path, data, **limits)
    return caught.value


def spawned_children():
    """Live children of this process started by billiard's spawn (not its semaphore tracker)."""
    me, out = os.getpid(), []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            fields = Path(f"/proc/{entry}/stat").read_text().rsplit(")", 1)[1].split()
            cmdline = Path(f"/proc/{entry}/cmdline").read_bytes()
        except OSError:
            continue
        if int(fields[1]) == me and b"spawn_main" in cmdline and fields[0] != "Z":
            out.append(int(entry))
    return out


def test_r6_the_child_holds_no_worker_secret_no_socket_and_its_limits(tmp_path, monkeypatch):
    """The worker's environment (a synthetic secret here), its sockets and its privileges stay out of
    the child; the child runs under the configured limits and reports what isolation held."""
    from scraper.parsers import pdf_sandbox

    monkeypatch.setenv("F26_SYNTHETIC_SECRET", "not-a-real-secret-f26")
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://f26:synthetic@db.invalid/corpus")
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    try:
        obj = stored(tmp_path, golden_pdf("golden-one-page"))
        result = pdf_sandbox.parse(obj.path, obj.sha256, obj.size)
    finally:
        listener.close()

    assert result.text == golden_text("golden-one-page")
    # The input is owner-only (0o400, the worker's uid). The child read it, and as root it then
    # dropped to 65534, which could not have read it: the read happens before the drop (R6 step 4).
    st = obj.path.stat()
    assert (stat.S_IMODE(st.st_mode), st.st_uid) == (0o400, os.geteuid()), (oct(st.st_mode), st.st_uid)
    iso = result.isolation
    assert set(iso["env"]) - {"TESSDATA_PREFIX"} == {"PATH", "LANG", "LC_ALL", "OMP_THREAD_LIMIT", "HOME", "TMPDIR"}, iso["env"]
    assert iso["socket_fds"] == 0, iso
    limits = pdf_sandbox.LIMITS
    assert iso["rlimits"] == {
        "as": limits.memory_bytes, "data": limits.memory_bytes, "cpu": limits.cpu_seconds,
        "fsize": limits.file_bytes, "nofile": limits.open_files, "core": 0,
    }, iso["rlimits"]
    if os.geteuid() == 0:
        assert (iso["uid"], iso["gid"], iso["uid_dropped"]) == (65534, 65534, True), iso
    assert iso["net"] in {"netns", "userns+netns", "none"}, iso
    print(f"F26 isolation here: uid={iso['uid']} net={iso['net']} fds={iso['fds']}")  # recorded in the evidence log
    assert spawned_children() == []


def _parse_in_a_daemon(conn, path, sha256, size):
    """Runs in a daemonic billiard process, as a Celery prefork pool process does."""
    from scraper.parsers import pdf_sandbox

    try:
        import multiprocessing

        multiprocessing.get_context("spawn").Process(target=print).start()
        stdlib = "started"
    except AssertionError as exc:
        stdlib = str(exc)
    result = pdf_sandbox.parse(path, sha256, size)
    conn.send((stdlib, result.text))
    conn.close()


def test_r7_a_daemonic_worker_can_use_the_sandbox_where_stdlib_multiprocessing_cannot(tmp_path):
    import billiard

    obj = stored(tmp_path, golden_pdf("golden-three-pages"))
    reader, writer = billiard.Pipe(duplex=False)
    daemon = billiard.get_context("fork").Process(
        target=_parse_in_a_daemon, args=(writer, str(obj.path), obj.sha256, obj.size), daemon=True
    )
    daemon.start()
    writer.close()
    assert reader.poll(120), "the daemonic worker did not answer"
    stdlib, text = reader.recv()
    daemon.join(30)
    assert stdlib == "daemonic processes are not allowed to have children", stdlib
    assert text == golden_text("golden-three-pages")


def test_r8_a_parse_past_the_wall_limit_is_killed_with_its_process_group(tmp_path):
    """The worker's watchdog ends the parse at the wall limit (4 s here). The child's own alarm, at the
    wall limit + 15 s, is only a backstop for an orphan, so the bound below (wall + 10 s, for a loaded
    machine) fails if the watchdog does not act."""
    started = time.monotonic()
    exc = refused(tmp_path, F.slow_pdf(3_000_000), wall_seconds=4.0, cpu_seconds=60)
    elapsed = time.monotonic() - started
    assert exc.code == "pdf_parse_timeout", exc
    assert elapsed < 4.0 + 10.0, f"refused after {elapsed:.1f} s"
    assert spawned_children() == [], "the killed child is still running"


def test_r8_the_cpu_limit_ends_the_child_as_a_timeout(tmp_path):
    exc = refused(tmp_path, F.slow_pdf(3_000_000), wall_seconds=120.0, cpu_seconds=2)
    assert exc.code == "pdf_parse_timeout", exc


def test_r8_the_production_memory_limit_refuses_a_bomb_past_one_gib(tmp_path):
    """Default limits (1 GiB of address space): a content stream that inflates to 1.5 GiB."""
    from scraper.parsers import pdf_sandbox

    assert pdf_sandbox.LIMITS.memory_bytes == 1 << 30
    exc = refused(tmp_path, F.bomb_pdf(1536))
    assert exc.code == "pdf_memory_limit", exc


def test_r8_an_answer_over_the_result_bound_is_refused(tmp_path):
    exc = refused(tmp_path, golden_pdf("golden-one-page"), max_result_bytes=1000)
    assert exc.code == "pdf_text_limit", exc


def test_r8_a_document_over_the_page_cap_is_refused_in_the_sandbox(tmp_path):
    exc = refused(tmp_path, F.many_pages_pdf(6), max_pages=5)
    assert exc.code == "pdf_page_limit", exc


def test_r4_active_content_in_an_object_stream_is_refused_in_the_sandbox(tmp_path):
    exc = refused(tmp_path, F.javascript_pdf(F.judgment_lines(6), objstm=True))
    assert exc.code == "pdf_active_content" and exc.detail in {"/JavaScript", "/JS"}, exc


def test_r6_input_that_is_not_what_the_worker_stored_is_refused(tmp_path):
    from scraper.parsers import pdf_sandbox

    obj = stored(tmp_path, golden_pdf("golden-one-page"))
    with pytest.raises(pdf_sandbox.ParseRefused) as caught:
        pdf_sandbox.parse(obj.path, "0" * 64, obj.size)
    assert (caught.value.code, caught.value.detail) == ("pdf_parse_failed", "_InputMismatch"), caught.value


# ---------------------------------------------------------------------------------------------
# R4 / R8 / R9: the extractor, in this process (it never runs in the worker in production)
# ---------------------------------------------------------------------------------------------
def test_r9_the_extractor_returns_main_s_text_for_every_golden_fixture():
    from scraper.parsers import pdf_extractor

    for name in GOLDEN:
        data = golden_pdf(name)
        result = pdf_extractor.extract_pdf(data)
        assert result.text == golden_text(name), name
        assert pdf_extractor.extract_pdf_text(data) == golden_text(name), name
        assert (result.ocr_applied, result.ocr_pages, result.ocr_truncated) == (False, 0, False), name


def test_r9_the_golden_fixtures_are_the_builder_s_bytes():
    special = [
        "IN THE HIGH COURT OF SYNTHETICA (F26 fixture, not a real court)",
        "Civil Appeal No. 26/2099 (Synthetic Party A v. Synthetic Party B)",
        "Held: section 302 read with § 34; see 2099 SCMR 2626 & 2099 PLD 77 (i), (ii).",
        "The learned counsel's argument \"in limine\" fails; costs follow the event \\ none.",
        "Disposed of in the above terms. Announced on 01.01.2099. Not a real judgment.",
    ] * 3
    built = {
        "golden-one-page": F.text_pdf([F.judgment_lines(12, seed="G1")]),
        "golden-three-pages": F.text_pdf(F.pages_of(F.judgment_lines(30, seed="G3"), 10)),
        "golden-deflated-special": F.text_pdf(F.pages_of(special, 8), compress=True),
    }
    for name, data in built.items():
        assert data == golden_pdf(name), name


def test_r4_the_structural_scan_finds_active_content_wherever_it_is_spelled():
    from scraper.parsers import pdf_extractor

    lines = F.judgment_lines(4)
    xfa = F._classic({**F._pages([F.text_content(lines)], compress=True),
                      1: b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [] /XFA 5 0 R >> >>",
                      5: F._stream(b"<xdp:xdp/>", compress=False)}, root=1)
    hits = {
        "plain": pdf_extractor.find_active_content(F.javascript_pdf(lines)),
        "escaped": pdf_extractor.find_active_content(F.javascript_pdf(lines, escaped=True)),
        "object stream": pdf_extractor.find_active_content(F.javascript_pdf(lines, objstm=True)),
        "attachment": pdf_extractor.find_active_content(F.attachment_pdf(lines)),
        "xfa": pdf_extractor.find_active_content(xfa),
    }
    assert hits["plain"] in {"JavaScript", "JS"} and hits["escaped"] in {"JavaScript", "JS"}, hits
    assert hits["object stream"] in {"JavaScript", "JS"}, hits
    assert hits["attachment"] in {"FileAttachment", "EF"} and hits["xfa"] == "XFA", hits


def test_r4_a_judgment_that_quotes_the_names_is_not_active_content():
    """Text that spells /JavaScript or /JS (a content-stream string) is not a dictionary name."""
    from scraper.parsers import pdf_extractor

    quoting = F.text_pdf([["Exhibit P-7 cites the path /JS/Launch and the term /JavaScript (2099)."] * 3])
    assert pdf_extractor.find_active_content(quoting) is None
    for name in GOLDEN:
        assert pdf_extractor.find_active_content(golden_pdf(name)) is None, name


def test_r8_the_page_and_text_caps_refuse_and_a_memory_error_is_never_swallowed(monkeypatch):
    from scraper.parsers import pdf_extractor

    small = dataclasses.replace(pdf_extractor.DEFAULT_LIMITS, max_pages=5)
    with pytest.raises(pdf_extractor.PdfLimitExceeded) as caught:
        pdf_extractor.extract_pdf(F.many_pages_pdf(6), small)
    assert caught.value.code == "pdf_page_limit"
    short = dataclasses.replace(pdf_extractor.DEFAULT_LIMITS, max_text_chars=100)
    with pytest.raises(pdf_extractor.PdfLimitExceeded) as caught:
        pdf_extractor.extract_pdf(golden_pdf("golden-three-pages"), short)
    assert caught.value.code == "pdf_text_limit"

    import pdfplumber.page

    def _exhausted(self, *args, **kwargs):
        raise MemoryError()

    monkeypatch.setattr(pdfplumber.page.Page, "extract_text", _exhausted)
    with pytest.raises(MemoryError):  # main's extractor caught it and went on to OCR
        pdf_extractor.extract_pdf(golden_pdf("golden-one-page"))


def fake_tesseract(monkeypatch, calls):
    fake = types.ModuleType("pytesseract")

    def image_to_string(image, config="", timeout=0, **kwargs):
        calls.append((image.size, config, timeout))
        return f"Synthetic F26 OCR text of a scanned page, 2099 SCMR {len(calls)}. " * 2

    fake.image_to_string = image_to_string
    monkeypatch.setitem(sys.modules, "pytesseract", fake)


def test_r8_ocr_is_trimmed_to_the_first_pages_and_runs_under_a_time_limit(monkeypatch):
    from scraper.parsers import pdf_extractor

    calls = []
    fake_tesseract(monkeypatch, calls)
    limits = dataclasses.replace(pdf_extractor.DEFAULT_LIMITS, max_ocr_pages=2, tesseract_seconds=7)
    result = pdf_extractor.extract_pdf(F.blank_pdf(4), limits)
    assert len(calls) == 2 and {timeout for _, _, timeout in calls} == {7}, calls
    assert (result.ocr_applied, result.ocr_pages, result.ocr_truncated, result.pages) == (True, 2, True, 4)
    assert result.text.count("Synthetic F26 OCR text") == 4


def test_r8_ocr_text_is_held_to_the_text_cap(monkeypatch):
    """Codex review (PR #76, thread 4306132184): OCR output counts against max_text_chars like a text
    layer does; a stand-in tesseract returns 600 characters a page, the cap is 1,000."""
    from scraper.parsers import pdf_extractor

    fake = types.ModuleType("pytesseract")
    fake.image_to_string = lambda image, config="", timeout=0, **kwargs: "Synthetic F26 OCR flood, 2099. " * 20
    monkeypatch.setitem(sys.modules, "pytesseract", fake)
    limits = dataclasses.replace(pdf_extractor.DEFAULT_LIMITS, max_text_chars=1000)
    with pytest.raises(pdf_extractor.PdfLimitExceeded) as caught:
        pdf_extractor.extract_pdf(F.blank_pdf(3), limits)
    assert caught.value.code == "pdf_text_limit"


def test_r8_a_page_too_large_to_render_is_not_rendered(monkeypatch):
    """A 20,000 x 20,000 point page at 300 dpi is 6.9 billion pixels: it is never rasterised."""
    from scraper.parsers import pdf_extractor
    import pdfplumber.page

    calls, renders = [], []
    fake_tesseract(monkeypatch, calls)
    real_to_image = pdfplumber.page.Page.to_image

    def _counting(self, *args, **kwargs):
        renders.append(kwargs.get("resolution"))
        return real_to_image(self, *args, **kwargs)

    monkeypatch.setattr(pdfplumber.page.Page, "to_image", _counting)
    result = pdf_extractor.extract_pdf(F.blank_pdf(1, width=20000, height=20000))
    assert (renders, calls) == ([], []), (renders, calls)
    assert (result.text, result.ocr_skipped) == ("", 1)


def test_r8_image_decoding_is_bounded():
    """PIL's bomb check at the sandbox's pixel cap, with its warning (cap to 2x cap) raised as an error."""
    import io
    import warnings

    from PIL import Image

    from scraper.parsers import pdf_extractor

    def png(side):
        buf = io.BytesIO()
        Image.new("L", (side, side)).save(buf, format="PNG")
        buf.seek(0)
        return buf

    saved = Image.MAX_IMAGE_PIXELS
    try:
        with warnings.catch_warnings():
            pdf_extractor.bound_image_decoding(1000)
            assert Image.MAX_IMAGE_PIXELS == 1000
            with pytest.raises(Image.DecompressionBombWarning):
                Image.open(png(40))  # 1,600 pixels: over the cap, under twice it
            with pytest.raises(Image.DecompressionBombError):
                Image.open(png(100))
            Image.open(png(30)).load()  # 900 pixels: decoded
    finally:
        Image.MAX_IMAGE_PIXELS = saved


# ---------------------------------------------------------------------------------------------
# R5: the raw store
# ---------------------------------------------------------------------------------------------
def test_r5_an_object_is_kept_once_read_only_under_its_sha256(tmp_path):
    from scraper.parsers import raw_store

    data = golden_pdf("golden-one-page")
    digest = hashlib.sha256(data).hexdigest()
    first = raw_store.put(data, root=tmp_path)
    again = raw_store.put(data, root=tmp_path)
    assert (first.created, again.created) == (True, False)
    assert first.key == again.key == f"raw-pdf/sha256/{digest[:2]}/{digest[2:4]}/{digest}.pdf"
    path = tmp_path / first.key
    assert path.read_bytes() == data and stat.S_IMODE(path.stat().st_mode) == 0o400
    assert (tmp_path / "raw-pdf" / ".usage").read_text() == str(len(data))
    assert [p.name for p in (tmp_path / "raw-pdf").rglob("*.tmp")] == []


def test_r5_an_object_that_does_not_match_its_name_is_refused(tmp_path):
    from scraper.parsers import raw_store

    data = golden_pdf("golden-one-page")
    obj = raw_store.put(data, root=tmp_path)
    path = tmp_path / obj.key
    path.chmod(0o600)
    path.write_bytes(data[:-1] + b"X")
    with pytest.raises(raw_store.StoreRefused) as caught:
        raw_store.put(data, root=tmp_path)
    assert caught.value.full is False


def test_r5_the_store_is_bounded_and_its_ledger_rebuilds(tmp_path, monkeypatch):
    from scraper.parsers import raw_store

    one, three = golden_pdf("golden-one-page"), golden_pdf("golden-three-pages")
    raw_store.put(one, root=tmp_path)
    (tmp_path / "raw-pdf" / ".usage").unlink()
    raw_store.put(three, root=tmp_path)  # the ledger is rebuilt from the tree, then grows
    assert (tmp_path / "raw-pdf" / ".usage").read_text() == str(len(one) + len(three))
    monkeypatch.setattr(raw_store, "MAX_STORE_BYTES", len(one) + len(three) + 10)
    with pytest.raises(raw_store.StoreRefused) as caught:
        raw_store.put(golden_pdf("golden-deflated-special"), root=tmp_path)
    assert caught.value.full is True
    monkeypatch.setattr(raw_store, "MAX_STORE_BYTES", 1 << 40)
    monkeypatch.setattr(raw_store, "MIN_FREE_BYTES", 1 << 60)
    with pytest.raises(raw_store.StoreRefused) as caught:
        raw_store.put(golden_pdf("golden-deflated-special"), root=tmp_path)
    assert caught.value.full is True


def test_r5_the_store_is_owner_only_whatever_the_umask(tmp_path):
    """CodeQL py/overly-permissive-file (PR #76): objects 0o400, the lock and the ledger 0o600, every
    directory the store creates 0o700, even with a umask of 0. Nothing needs group or world access:
    every container that mounts the vault runs as one uid (spec R14), and the sandbox reads its input
    before it drops privileges."""
    from scraper.parsers import raw_store

    saved = os.umask(0)
    try:
        obj = raw_store.put(golden_pdf("golden-one-page"), root=tmp_path)
    finally:
        os.umask(saved)
    store = tmp_path / "raw-pdf"
    digest = obj.sha256
    modes = {p.relative_to(tmp_path).as_posix(): stat.S_IMODE(p.stat().st_mode) for p in [store, *store.rglob("*")]}
    assert modes == {
        "raw-pdf": 0o700,
        "raw-pdf/.lock": 0o600,
        "raw-pdf/.usage": 0o600,
        "raw-pdf/sha256": 0o700,
        f"raw-pdf/sha256/{digest[:2]}": 0o700,
        f"raw-pdf/sha256/{digest[:2]}/{digest[2:4]}": 0o700,
        f"raw-pdf/sha256/{digest[:2]}/{digest[2:4]}/{digest}.pdf": 0o400,
    }, {k: oct(v) for k, v in modes.items()}


class _Killed(BaseException):
    """Stands for the worker being killed: no handler in the store runs for it."""


def test_r15_a_ledger_write_that_fails_leaves_no_uncounted_object(tmp_path, monkeypatch):
    """Codex review (PR #76, thread 4306132181): the object was linked before the ledger was updated,
    so a failed ledger write left an object the ledger did not count, a later put of the same bytes
    took the existing-object branch without repairing it, and the store passed MAX_STORE_BYTES. Spec
    R15: the ledger is written first; if that fails, nothing is stored."""
    from scraper.parsers import raw_store

    one, three, special = (golden_pdf(n) for n in GOLDEN)
    monkeypatch.setattr(raw_store, "MAX_STORE_BYTES", len(one) + len(three) + 10)
    raw_store.put(three, root=tmp_path)
    real = raw_store._set_usage
    failures = []

    def _fails_once(store, used):
        if not failures:
            failures.append(used)
            raise OSError(28, "synthetic F26 ledger failure")
        return real(store, used)

    monkeypatch.setattr(raw_store, "_set_usage", _fails_once)
    with pytest.raises(raw_store.StoreRefused):
        raw_store.put(one, root=tmp_path)
    raw_store.put(one, root=tmp_path)  # a retry of the same document
    with pytest.raises(raw_store.StoreRefused) as caught:
        raw_store.put(special, root=tmp_path)  # one + three + special is over the cap
    assert caught.value.full is True
    on_disk = sum(p.stat().st_size for p in (tmp_path / "raw-pdf" / "sha256").rglob("*.pdf"))
    assert on_disk == len(one) + len(three) <= raw_store.MAX_STORE_BYTES, on_disk
    assert (tmp_path / "raw-pdf" / ".usage").read_text() == str(on_disk)


def test_r15_a_writer_killed_after_the_ledger_overcounts_and_the_recount_corrects_it(tmp_path, monkeypatch):
    """Spec R15: killed between the ledger write and the link, a writer leaves the ledger counting an
    object that does not exist (the safe direction) and perhaps a temporary file. When the ledger
    says a write would pass the cap, the store recounts its objects (and removes temporary files no
    live writer can own: every writer holds the lock) before it refuses; the cap still holds."""
    from scraper.parsers import raw_store

    one, three, special = (golden_pdf(n) for n in GOLDEN)
    monkeypatch.setattr(raw_store, "MAX_STORE_BYTES", len(three) + 10)

    def _killed(*args, **kwargs):
        raise _Killed()

    monkeypatch.setattr(raw_store.os, "link", _killed)
    with pytest.raises(_Killed):
        raw_store.put(one, root=tmp_path)
    monkeypatch.undo()
    monkeypatch.setattr(raw_store, "MAX_STORE_BYTES", len(three) + 10)
    store = tmp_path / "raw-pdf"
    assert int((store / ".usage").read_text()) == len(one), "the ledger must count the interrupted write"
    killed_dir = (tmp_path / raw_store.key_for(hashlib.sha256(one).hexdigest())).parent  # made by the killed write
    stale = killed_dir / ".dead.1.tmp"
    fd = os.open(stale, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(fd, b"left by a killed writer")
    os.close(fd)
    stored = raw_store.put(three, root=tmp_path)  # fits only once the phantom object is recounted away
    assert stored.created and (store / ".usage").read_text() == str(len(three))
    assert not stale.exists(), "a temporary file no writer can own was left behind"
    with pytest.raises(raw_store.StoreRefused) as caught:
        raw_store.put(special, root=tmp_path)
    assert caught.value.full is True


def test_r5_a_store_that_cannot_be_written_refuses(tmp_path):
    from scraper.parsers import raw_store

    (tmp_path / "raw-pdf").write_text("not a directory")
    with pytest.raises(raw_store.StoreRefused) as caught:
        raw_store.put(golden_pdf("golden-one-page"), root=tmp_path)
    assert caught.value.full is False


# ---------------------------------------------------------------------------------------------
# R2 / R3: the intake's bound and cheap checks (no network, no sandbox)
# ---------------------------------------------------------------------------------------------
def _response(status=200, body=b"%PDF-1.4 synthetic", content_type=None):
    headers = {"Content-Type": content_type} if content_type else {}
    return types.SimpleNamespace(status_code=status, content=body, headers=headers, url="https://lhc.gov.pk/x.pdf")


def _intake(client, fetch, monkeypatch, tmp_path, *, parse=None):
    from scraper import config
    from scraper.parsers import pdf_sandbox
    from scraper.tasks import pdf_intake

    monkeypatch.setattr(config.settings, "PDF_STORAGE_PATH", str(tmp_path / "vault"))
    parsed = []

    def _parse(path, sha256, size, **kwargs):
        parsed.append(sha256)
        if parse is not None:
            return parse(path, sha256, size)
        return pdf_sandbox.ParseResult(text="Synthetic F26 judgment, 2099.", pages=1, ocr_applied=False)

    monkeypatch.setattr(pdf_sandbox, "parse", _parse)
    try:
        return asyncio.run(pdf_intake.intake(client, "https://lhc.gov.pk/judgments/2099/x.pdf", fetch=fetch)), parsed
    except Exception as exc:  # noqa: BLE001 - returned for the assertions
        return exc, parsed


def test_r3_the_cheap_checks_refuse_before_anything_is_kept(monkeypatch, tmp_path):
    from scraper.tasks import outcomes

    cases = {
        "http_404": _response(404, b"not found"),
        "not_pdf (html page)": _response(200, b"<html>login</html>", "text/html; charset=utf-8"),
        "not_pdf (html polyglot)": _response(200, b"%PDF-1.4 but served as a page", "text/html"),
        "not_pdf (image)": _response(200, b"%PDF-1.4", "image/png"),
        "not_pdf (no signature)": _response(200, b"PK\x03\x04 a zip", "application/pdf"),
        "not_pdf (empty)": _response(200, b"", None),
    }
    for label, response in cases.items():
        async def _fetch(client, url, _r=response):
            return _r

        result, parsed = _intake(object(), _fetch, monkeypatch, tmp_path)
        assert isinstance(result, outcomes.DocumentRejected), (label, result)
        assert result.code == label.split(" ")[0], (label, result.code)
        assert parsed == [] and not (tmp_path / "vault" / "raw-pdf" / "sha256").exists(), label
    for content_type in (None, "application/pdf", "application/octet-stream", "application/x-download", "text/plain"):
        async def _fetch(client, url, _t=content_type):
            return _response(200, golden_pdf("golden-one-page"), _t)

        result, parsed = _intake(object(), _fetch, monkeypatch, tmp_path)
        assert not isinstance(result, Exception) and len(parsed) == 1, (content_type, result)


def test_r2_the_boundary_s_cap_is_narrowed_to_the_operator_setting(monkeypatch, tmp_path):
    from scraper import config
    from scraper.net import fetch_policy
    from scraper.tasks import outcomes

    monkeypatch.setattr(config.settings, "PDF_MAX_SIZE_MB", 3)
    client = fetch_policy.fetcher_for("LahoreHighCourt")  # production factory; no request is made
    seen = []

    async def _fetch(c, url):
        seen.append(c.max_bytes)
        raise fetch_policy.FetchRefused(fetch_policy.TOO_LARGE, url, "LahoreHighCourt", "body over 3145728 bytes")

    result, parsed = _intake(client, _fetch, monkeypatch, tmp_path)
    assert seen == [3 * MIB], seen
    assert isinstance(result, outcomes.DocumentRejected) and result.code == "pdf_too_large", result
    assert parsed == []

    async def _too_big(c, url):  # a client without the boundary's cap (a harness): checked after
        return _response(200, b"%PDF-1.4" + b" " * (3 * MIB))

    result, parsed = _intake(object(), _too_big, monkeypatch, tmp_path)
    assert isinstance(result, outcomes.DocumentRejected) and result.code == "pdf_too_large", result


def test_r5_a_document_that_cannot_be_kept_is_not_parsed(monkeypatch, tmp_path):
    from scraper.parsers import raw_store
    from scraper.tasks import outcomes

    monkeypatch.setattr(raw_store, "MAX_STORE_BYTES", 10)

    async def _fetch(c, url):
        return _response(200, golden_pdf("golden-one-page"), "application/pdf")

    result, parsed = _intake(object(), _fetch, monkeypatch, tmp_path)
    assert isinstance(result, outcomes.DocumentRejected) and result.code == "raw_store_full", result
    assert parsed == []


# =============================================================================================
# F26-FU: the independent re-audit (FAIL 7/10). Spec section 7, rulings R16-R25. Expected values
# come from the spec; every test below was run on 53f4450 (the F26 merge) first (plan ledger).
# =============================================================================================
def _alive(pid):
    """True while ``pid`` is a running (not zombie) process."""
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    return state != "Z"


@pytest.fixture(scope="module")
def golden_isolation(tmp_path_factory):
    """The isolation record of one real sandbox parse of a golden judgment, with default limits."""
    from scraper.parsers import pdf_sandbox, raw_store

    obj = raw_store.put(golden_pdf("golden-one-page"), root=tmp_path_factory.mktemp("f26fu-isolation"))
    result = pdf_sandbox.parse(obj.path, obj.sha256, obj.size)
    assert result.text == golden_text("golden-one-page")
    return result.isolation


# ---------------------------------------------------------------------------------------------
# R16 (FA-corpus-009): the child never writes to the worker's stdout or stderr
# ---------------------------------------------------------------------------------------------
def test_r16_the_child_is_detached_from_the_worker_s_output(golden_isolation):
    """Read back inside the child: fds 0-2 are /dev/null and logging is disabled (the e2e flood test,
    tests/test_f26_pdf_intake_e2e.py, measures the bytes)."""
    iso = golden_isolation
    assert iso.get("stdio") == {"0": "/dev/null", "1": "/dev/null", "2": "/dev/null"}, iso
    assert iso.get("logging_disabled") is True, iso


def test_r16_a_child_that_cannot_detach_from_the_worker_s_output_never_reads_the_pdf(tmp_path):
    """If /dev/null cannot be opened the child answers pdf_parse_failed (stdio) at once: it never
    parses while attached to the worker's log. Run in a forked copy of this process (the child's own
    set-up must not touch the test process); the input path does not exist, so a child that went on
    would answer FileNotFoundError instead."""
    import billiard

    from scraper.parsers import pdf_sandbox

    reader, writer = billiard.Pipe(duplex=False)
    pid = os.fork()
    if pid == 0:
        try:
            reader.close()
            real_open = os.open

            def _no_devnull(path, *args, **kwargs):
                if path == os.devnull:
                    raise PermissionError(13, "F26 synthetic: /dev/null refused")
                return real_open(path, *args, **kwargs)

            pdf_sandbox.os.open = _no_devnull
            pdf_sandbox._child(writer, str(tmp_path / "never-read.pdf"), "0" * 64, 1, str(tmp_path),
                               dataclasses.asdict(pdf_sandbox.LIMITS))
        finally:
            os._exit(0)
    writer.close()
    try:
        assert reader.poll(60), "the child did not answer"
        answer = json.loads(reader.recv_bytes())
    finally:
        reader.close()
        os.waitpid(pid, 0)
    assert (answer.get("ok"), answer.get("code"), answer.get("detail")) == (False, "pdf_parse_failed", "stdio"), answer


# ---------------------------------------------------------------------------------------------
# R24 (L6): what the tests can see, one test per surviving mutant
# ---------------------------------------------------------------------------------------------
def test_r24_the_worker_s_read_bound_refuses_an_answer_the_child_did_not_cap(tmp_path):
    """M14. A bound below even the child's own refusal answer (which carries the isolation record):
    only the worker's read bound can refuse it, and says so."""
    exc = refused(tmp_path, golden_pdf("golden-one-page"), max_result_bytes=64)
    assert (exc.code, exc.detail) == ("pdf_text_limit", "answer over max_result_bytes (worker bound)"), exc


def test_r24_the_child_caps_its_own_answer(tmp_path):
    """M15. About 13 KB of text against an 8 KiB bound: the child answers with its own short
    refusal, which the worker reads whole."""
    big = F.text_pdf(F.pages_of(F.judgment_lines(120, seed="CAP"), 40))
    exc = refused(tmp_path, big, max_result_bytes=8192)
    assert (exc.code, exc.detail) == ("pdf_text_limit", "answer over max_result_bytes"), exc


def _network_namespace_refused():
    """Can a process here enter a new network namespace the way the sandbox tries (as root:
    CLONE_NEWNET, then as uid 65534: CLONE_NEWUSER | CLONE_NEWNET; as anyone else: the latter)?
    Probed in a forked child. Returns None when it can, else the errors."""
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(read_fd)
            errors = []
            if os.geteuid() == 0:
                try:
                    os.unshare(os.CLONE_NEWNET)
                    os.write(write_fd, b"ok")
                    os._exit(0)
                except OSError as exc:
                    errors.append(f"CLONE_NEWNET as root: {exc.strerror}")
                os.setgroups([])
                os.setgid(65534)
                os.setuid(65534)
            try:
                os.unshare(os.CLONE_NEWUSER | os.CLONE_NEWNET)
                os.write(write_fd, b"ok")
            except OSError as exc:
                errors.append(f"CLONE_NEWUSER|CLONE_NEWNET as uid {os.getuid()}: {exc.strerror}")
                os.write(write_fd, "; ".join(errors).encode())
        finally:
            os._exit(0)
    os.close(write_fd)
    out = b""
    while True:
        chunk = os.read(read_fd, 4096)
        if not chunk:
            break
        out += chunk
    os.close(read_fd)
    os.waitpid(pid, 0)
    return None if out == b"ok" else out.decode()


def test_r24_the_child_is_in_a_network_namespace_of_its_own_where_the_kernel_allows(golden_isolation):
    """M37. Compared from outside: the child's network namespace (read back inside it after
    isolation) is not the worker's, and it sees only the loopback interface. Where this kernel or
    container refuses every route the sandbox tries, the child must say net=none and share the
    worker's namespace, and the test is skipped with the probe's errors."""
    iso = golden_isolation
    ours = os.readlink("/proc/self/ns/net")
    refused_here = _network_namespace_refused()
    if refused_here:
        assert iso.get("net") == "none" and iso.get("netns") == ours, iso
        pytest.skip(f"this kernel refuses a new network namespace here ({refused_here}); the child reports net=none")
    assert iso.get("net") in {"netns", "userns+netns"}, iso
    assert iso.get("netns") not in (None, ours), (iso.get("netns"), ours)
    assert iso.get("interfaces") == ["lo"], iso


def test_r24_the_child_leads_its_own_session_and_process_group(golden_isolation):
    assert golden_isolation.get("session_leader") is True, golden_isolation


def test_r24_the_kill_reaches_the_child_s_whole_process_group():
    """M38. A real session leader with a grandchild (tesseract stands in the child's group the same
    way): the worker's kill ends both."""
    from scraper.parsers import pdf_sandbox

    read_fd, write_fd = os.pipe()
    leader = os.fork()
    if leader == 0:
        try:
            os.close(read_fd)
            os.setsid()
            grandchild = os.fork()
            if grandchild == 0:
                time.sleep(120)
                os._exit(0)
            os.write(write_fd, str(grandchild).encode())
            time.sleep(120)
        finally:
            os._exit(0)
    os.close(write_fd)
    grandchild = int(os.read(read_fd, 64))
    os.close(read_fd)
    try:
        pdf_sandbox._kill_group(types.SimpleNamespace(pid=leader))
        deadline = time.monotonic() + 10
        status = None
        while status is None and time.monotonic() < deadline:
            done, status = os.waitpid(leader, os.WNOHANG)
            status = status if done else None
            time.sleep(0.02)
        assert status is not None and os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL, status
        while _alive(grandchild) and time.monotonic() < deadline:
            time.sleep(0.02)
        assert not _alive(grandchild), "the grandchild outlived the kill of its process group"
    finally:
        for pid in (grandchild, leader):
            with contextlib.suppress(OSError):
                os.kill(pid, signal.SIGKILL)
        with contextlib.suppress(ChildProcessError):
            os.waitpid(leader, os.WNOHANG)


def test_r24_the_child_bounds_image_decoding_at_the_pixel_cap(golden_isolation):
    """M44. PIL's bound as it holds inside the child: the configured cap, and the bomb warning raised
    as an error (tests/test_f26_pdf_sandbox.py::test_r8_image_decoding_is_bounded shows what that
    refuses)."""
    from scraper.parsers import pdf_sandbox

    iso = golden_isolation
    assert (iso.get("image_pixels"), iso.get("image_bomb_error")) == (pdf_sandbox.LIMITS.max_image_pixels, True), iso


def test_r24_one_page_whose_size_cannot_be_read_does_not_stop_ocr_of_the_others(monkeypatch):
    """M48 (the Bugbot commit 5121394): the second of three scanned pages fails when its size is
    read; the first and third are still OCRed."""
    from scraper.parsers import pdf_extractor

    calls = []
    fake_tesseract(monkeypatch, calls)
    real = pdf_extractor._render_pixels
    seen = []

    def _second_page_breaks(page, dpi):
        seen.append(page)
        if len(seen) == 2:
            raise ValueError("F26 synthetic: an unreadable page size")
        return real(page, dpi)

    monkeypatch.setattr(pdf_extractor, "_render_pixels", _second_page_breaks)
    result = pdf_extractor.extract_pdf(F.blank_pdf(3))
    assert len(calls) == 2, calls
    assert (result.ocr_applied, result.ocr_pages, result.pages) == (True, 2, 3), result
    assert result.text.count("Synthetic F26 OCR text") == 4


# Spec R4 (the first six) and R20 (the rest), written out from the spec.
R4_R20_NAMES = ("Launch", "EmbeddedFile", "EmbeddedFiles", "EF", "FileAttachment", "RichMedia",
                "OnInstantiate", "3DD", "GoToR", "GoToE", "SubmitForm", "ImportData")


@pytest.mark.parametrize("name", R4_R20_NAMES)
def test_r20_each_active_content_name_is_refused_on_its_own(name, monkeypatch):
    """M19-M24 and R20: a document whose only listed name is ``name`` is refused for it, and (the
    fixture's own check) nothing else in the policy would refuse it."""
    from scraper.parsers import pdf_extractor

    data = F.active_pdf(name, F.judgment_lines(4, seed=f"AC-{name}"))
    assert pdf_extractor.find_active_content(data) == name
    monkeypatch.setattr(pdf_extractor, "ACTIVE_CONTENT_NAMES", frozenset(pdf_extractor.ACTIVE_CONTENT_NAMES) - {name})
    assert pdf_extractor.find_active_content(data) is None


def test_r20_a_judgment_with_a_web_link_is_accepted():
    """R20: URI actions stay accepted (judgments link to statutes and reports)."""
    from scraper.parsers import pdf_extractor

    lines = F.judgment_lines(6, seed="URI")
    data = F.uri_link_pdf(lines)
    assert pdf_extractor.find_active_content(data) is None
    assert "C.A. 1/2099" in pdf_extractor.extract_pdf_text(data)


# ---------------------------------------------------------------------------------------------
# R17 / R18 (L1-L3): the raw store, with real processes and real SIGKILLs
# ---------------------------------------------------------------------------------------------
def _killed_writer(root, data, *, pid=None):
    """A forked writer that SIGKILLs itself inside ``raw_store.put``, at the fsync of its temporary
    object: the object's bytes are written, the ledger is not. ``pid``: what it reports as its
    process id (the re-audit's pid-reuse case)."""
    digest = hashlib.sha256(data).hexdigest()
    child = os.fork()
    if child == 0:
        try:
            from scraper.parsers import raw_store

            me, real_fsync = os.getpid(), os.fsync

            def _fsync(fd):
                if os.path.basename(os.readlink(f"/proc/self/fd/{fd}")).startswith("." + digest):
                    os.kill(me, signal.SIGKILL)
                return real_fsync(fd)

            if pid is not None:
                raw_store.os.getpid = lambda: pid
            raw_store.os.fsync = _fsync
            raw_store.put(data, root=root)
        finally:
            os._exit(3)
    _, status = os.waitpid(child, 0)
    assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL, status
    return sorted((Path(root) / "raw-pdf").rglob("*.tmp"))


def _objects_bytes(root):
    return sum(p.stat().st_size for p in (Path(root) / "raw-pdf" / "sha256").rglob("*.pdf"))


def test_r17_a_stale_temporary_object_and_a_reused_pid_never_block_its_document(tmp_path, monkeypatch):
    """L1 (the re-audit's pid_reuse_probe.py): a writer reporting pid 4242 is killed after writing its
    temporary object; the same document, put three times by a process reporting pid 4242, is stored
    once and then found. The dirty marker is removed first, so only the temporary name (R17), not a
    recount (R18), can let the put through."""
    from scraper.parsers import raw_store

    one, three = golden_pdf("golden-one-page"), golden_pdf("golden-three-pages")
    raw_store.put(three, root=tmp_path)  # the ledger exists: no recount for a missing one
    assert _killed_writer(tmp_path, one, pid=4242), "the killed writer left no temporary object"
    with contextlib.suppress(FileNotFoundError):
        (tmp_path / "raw-pdf" / ".dirty").unlink()
    monkeypatch.setattr(raw_store.os, "getpid", lambda: 4242)
    outcomes = []
    for _ in range(3):
        try:
            outcomes.append(raw_store.put(one, root=tmp_path).created)
        except raw_store.StoreRefused as exc:
            outcomes.append(f"refused: {exc.reason}")
    assert outcomes == [True, False, False], outcomes


def test_r18_a_write_killed_midway_is_reclaimed_by_the_next_put(tmp_path):
    """L2, the dirty marker: far from any bound, the next put after a killed write recounts, so the
    killed writer's temporary object is removed and the ledger matches the objects."""
    from scraper.parsers import raw_store

    one, three, special = (golden_pdf(n) for n in GOLDEN)
    raw_store.put(three, root=tmp_path)
    assert _killed_writer(tmp_path, one), "the killed writer left no temporary object"
    raw_store.put(special, root=tmp_path)
    store = tmp_path / "raw-pdf"
    assert sorted(store.rglob("*.tmp")) == [], "the killed writer's temporary object is still there"
    assert int((store / ".usage").read_text()) == _objects_bytes(tmp_path) == len(three) + len(special)


def test_r18_the_free_space_floor_recounts_before_it_refuses(tmp_path, monkeypatch):
    """L2 (the re-audit's floor_recount_probe.py): a killed writer's temporary object holds the
    space the next document needs. The marker is gone (as after a power failure), so only the
    floor's own recount can find it; the filesystem reports the space back once it is removed."""
    from scraper.parsers import raw_store

    one, three, special = (golden_pdf(n) for n in GOLDEN)
    raw_store.put(three, root=tmp_path)
    stale = _killed_writer(tmp_path, one)
    assert stale, "the killed writer left no temporary object"
    stale_bytes = sum(p.stat().st_size for p in stale)
    with contextlib.suppress(FileNotFoundError):
        (tmp_path / "raw-pdf" / ".dirty").unlink()
    real = shutil.disk_usage

    def _tight(path):
        reclaimed = 0 if any(p.exists() for p in stale) else stale_bytes
        return real(path)._replace(free=raw_store.MIN_FREE_BYTES + len(special) - 1 + reclaimed)

    monkeypatch.setattr(raw_store.shutil, "disk_usage", _tight)
    try:
        stored_obj = raw_store.put(special, root=tmp_path)
    except raw_store.StoreRefused as exc:
        pytest.fail(f"refused at the floor without reclaiming the stale temporary object: {exc.reason}")
    assert stored_obj.created and not any(p.exists() for p in stale)


def test_r18_a_full_store_refuses_from_its_ledger_without_walking_the_tree_each_time(tmp_path, monkeypatch):
    """L3: two refused puts in a row at a full store walk the tree at most once between them (the
    re-audit measured 3.8-5.2 s per walk at 100,000 objects, under the global lock). Once the last
    recount is older than the interval, an object an operator removed is noticed."""
    from scraper.parsers import raw_store

    one, three, special = (golden_pdf(n) for n in GOLDEN)
    raw_store.put(one, root=tmp_path)
    kept_three = raw_store.put(three, root=tmp_path)
    monkeypatch.setattr(raw_store, "MAX_STORE_BYTES", len(one) + len(three) + 10)
    objects = str(tmp_path / "raw-pdf" / "sha256")
    walked = []
    real_scandir = os.scandir

    def _spy(path=".", *args, **kwargs):
        if isinstance(path, (str, os.PathLike)) and os.path.abspath(os.fspath(path)).startswith(objects):
            walked.append(os.fspath(path))
        return real_scandir(path, *args, **kwargs)

    monkeypatch.setattr(os, "scandir", _spy)
    per_put = []
    for _ in range(2):
        before = len(walked)
        with pytest.raises(raw_store.StoreRefused) as caught:
            raw_store.put(special, root=tmp_path)
        assert caught.value.full is True
        per_put.append(len(walked) - before)
    assert per_put[1] == 0, f"directories scanned per refused put: {per_put}"

    # An operator removes an object by hand; once the interval has passed, the next put notices.
    path = kept_three.path
    path.chmod(0o600)
    path.unlink()
    stamp = tmp_path / "raw-pdf" / ".recounted"
    if stamp.exists():
        aged = time.time() - getattr(raw_store, "RECOUNT_INTERVAL_SECONDS", 600) - 1
        os.utime(stamp, (aged, aged))
    assert raw_store.put(special, root=tmp_path).created


# ---------------------------------------------------------------------------------------------
# R21 (INFO): one Content-Type, or not a PDF
# ---------------------------------------------------------------------------------------------
def test_r21_a_response_with_more_than_one_content_type_is_not_a_pdf(monkeypatch, tmp_path):
    import httpx

    from scraper.tasks import outcomes

    body = golden_pdf("golden-one-page")
    cases = {
        "two fields": httpx.Headers([("Content-Type", "application/pdf"), ("Content-Type", "text/html")]),
        "the same field twice": httpx.Headers([("Content-Type", "application/pdf"), ("Content-Type", "application/pdf")]),
        "a list in one field": {"Content-Type": "application/pdf, text/html"},
    }
    for label, headers in cases.items():
        response = types.SimpleNamespace(status_code=200, content=body, headers=headers, url="https://lhc.gov.pk/x.pdf")

        async def _fetch(client, url, _r=response):
            return _r

        result, parsed = _intake(object(), _fetch, monkeypatch, tmp_path)
        assert isinstance(result, outcomes.DocumentRejected) and result.code == "not_pdf", (label, result)
        assert parsed == [] and not (tmp_path / "vault" / "raw-pdf" / "sha256").exists(), label

    async def _with_a_comma_in_a_parameter(client, url):
        return types.SimpleNamespace(status_code=200, content=body, url="https://lhc.gov.pk/x.pdf",
                                     headers=httpx.Headers({"Content-Type": 'application/pdf; name="judgment,2099.pdf"'}))

    result, parsed = _intake(object(), _with_a_comma_in_a_parameter, monkeypatch, tmp_path)
    assert not isinstance(result, Exception) and len(parsed) == 1, result


# ---------------------------------------------------------------------------------------------
# R19 (L5): /health and /api/vault never walk the raw store
# ---------------------------------------------------------------------------------------------
def test_r19_health_and_the_vault_listing_never_walk_the_raw_store(tmp_path, monkeypatch):
    """The vault holds two bootstrap PDFs over 15,000 bytes, one small one, and three raw-store
    objects under raw-pdf/. /health's total_pdfs counts the two (what it counted before F26),
    /api/vault lists the two, and neither scans a directory under raw-pdf/."""
    from fastapi.testclient import TestClient

    from scraper import config, database, main
    from scraper.parsers import raw_store

    live = tmp_path / "live"
    pdfs = live / "PakistanCode" / "pdfs"
    pdfs.mkdir(parents=True)
    names = ["Synthetic Act A 2099.pdf", "Synthetic Act B 2099.pdf"]
    for name in names:
        (pdfs / name).write_bytes(b"%PDF-1.4 F26 synthetic bootstrap file " + b"x" * 20000)
    (pdfs / "small.pdf").write_bytes(b"%PDF-1.4 under 15,000 bytes")
    for i in range(3):
        raw_store.put(F.padded_pdf(F.judgment_lines(2, seed=f"RAW{i}"), 20000), root=live)
    assert len(list((live / "raw-pdf").rglob("*.pdf"))) == 3

    monkeypatch.chdir(tmp_path)  # without /app/live (CI), the routes resolve ./live
    monkeypatch.setattr(main, "_live_dir", lambda: live, raising=False)

    def _no_database():
        raise ConnectionRefusedError("F26 synthetic: no database for this test")

    monkeypatch.setattr(database, "SessionLocal", _no_database)
    store = str(live / "raw-pdf")
    walked = []
    real_scandir = os.scandir

    def _spy(path=".", *args, **kwargs):
        if isinstance(path, (str, os.PathLike)) and os.path.abspath(os.fspath(path)).startswith(store):
            walked.append(os.fspath(path))
        return real_scandir(path, *args, **kwargs)

    monkeypatch.setattr(os, "scandir", _spy)
    client = TestClient(main.app)
    health = client.get("/health").json()
    vault = client.get("/api/vault", headers={"X-API-Key": config.settings.ADMIN_API_KEY}).json()
    assert health.get("total_pdfs") == 2, health
    assert sorted(f["path"] for f in vault.get("files", [])) == [f"PakistanCode/pdfs/{n}" for n in names], vault
    assert walked == [], walked


# ---------------------------------------------------------------------------------------------
# R22 / R23 (INFO): the test set's billiard; a killed pool process's scratch directory
# ---------------------------------------------------------------------------------------------
def test_r22_the_test_set_pins_the_billiard_it_runs():
    import importlib.metadata

    pins = [line.strip() for line in (PROJECT_ROOT / "requirements-test.txt").read_text(encoding="utf-8").splitlines()
            if line.strip().lower().startswith("billiard")]
    assert pins == [f"billiard=={importlib.metadata.version('billiard')}"], pins


def _parse_in_a_pool_process(path, sha256, size, limits):
    """A Celery prefork pool process stands here: it parses, and the test kills it mid-parse."""
    from scraper.parsers import pdf_sandbox

    pdf_sandbox.parse(path, sha256, size, limits=limits)


def test_r23_a_killed_pool_process_s_scratch_directory_is_swept_by_the_next_parse(tmp_path, monkeypatch):
    """A daemonic pool process is SIGKILLed while its sandbox parses (its watchdog and finally never
    run); the next parse in this process removes the scratch directory it left. A directory of a
    live worker (this process) stays; one of F26's first naming stays while fresh and goes once it
    is older than the age bound."""
    import billiard

    from scraper.parsers import pdf_sandbox

    root = Path(tempfile.mkdtemp(prefix="f26fu-scratch-"))
    root.chmod(0o711)  # the child, as uid 65534, must reach its own directory inside
    monkeypatch.setattr(tempfile, "tempdir", str(root))
    try:
        slow = stored(tmp_path, F.slow_pdf(3_000_000))
        limits = dataclasses.replace(pdf_sandbox.LIMITS, wall_seconds=60.0, cpu_seconds=3)
        pool = billiard.get_context("fork").Process(
            target=_parse_in_a_pool_process, args=(str(slow.path), slow.sha256, slow.size, limits), daemon=True
        )
        pool.start()
        deadline = time.monotonic() + 60
        while not any(root.iterdir()) and time.monotonic() < deadline:
            time.sleep(0.05)
        left_by_pool = sorted(p.name for p in root.iterdir())
        assert left_by_pool, "the pool process never started a parse"
        os.kill(pool.pid, signal.SIGKILL)
        pool.join(10)

        live = root / f"f26-pdf-{os.getpid()}-live"
        live.mkdir()
        fresh_legacy, old_legacy = root / "f26-pdf-legacyfresh", root / "f26-pdf-legacyold"
        fresh_legacy.mkdir()
        old_legacy.mkdir()
        aged = time.time() - getattr(pdf_sandbox, "SCRATCH_STALE_SECONDS", 7200) - 60
        os.utime(old_legacy, (aged, aged))

        result = sandbox_parse(tmp_path, golden_pdf("golden-one-page"))
        assert result.text == golden_text("golden-one-page")
        remaining = sorted(p.name for p in root.iterdir())
        assert remaining == sorted([live.name, fresh_legacy.name]), (left_by_pool, remaining)
    finally:
        shutil.rmtree(root, ignore_errors=True)
