"""Audit F26 unit and component tests: the one PDF path (guard), the sandbox process, the extractor's
caps, the active-content scan, the raw store, the intake's cheap checks and the F28 vocabulary.

Spec: docs/superpowers/specs/2026-10-18-f26-bounded-isolated-pdf-processing-design.md (R1-R12). The
end-to-end flow is tests/test_f26_pdf_intake_e2e.py. Sandbox tests start real children (billiard
spawn) on real synthetic PDFs (tests/pdf_fixtures.py); nothing here needs the network or Postgres.
OCR is exercised with a stand-in for pytesseract: the pinned test set has no tesseract.
"""

import ast
import asyncio
import dataclasses
import hashlib
import os
import pickle
import socket
import stat
import sys
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
        stray = sorted(n for n in names if "extract_pdf" in n or "pdf_extractor" in n or n.endswith("looks_like_pdf"))
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
        result = sandbox_parse(tmp_path, golden_pdf("golden-one-page"))
    finally:
        listener.close()

    assert result.text == golden_text("golden-one-page")
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
    started = time.monotonic()
    exc = refused(tmp_path, F.slow_pdf(3_000_000), wall_seconds=4.0, cpu_seconds=60)
    elapsed = time.monotonic() - started
    assert exc.code == "pdf_parse_timeout", exc
    assert elapsed < 4.0 + 15.0, f"refused after {elapsed:.1f} s"
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
    assert path.read_bytes() == data and stat.S_IMODE(path.stat().st_mode) == 0o444
    assert (tmp_path / "raw-pdf" / ".usage").read_text() == str(len(data))
    assert [p.name for p in (tmp_path / "raw-pdf").rglob("*.tmp")] == []


def test_r5_an_object_that_does_not_match_its_name_is_refused(tmp_path):
    from scraper.parsers import raw_store

    data = golden_pdf("golden-one-page")
    obj = raw_store.put(data, root=tmp_path)
    path = tmp_path / obj.key
    path.chmod(0o644)
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
