# F26 plan: bounded, kept and sandboxed PDF processing

Spec: `docs/superpowers/specs/2026-10-18-f26-bounded-isolated-pdf-processing-design.md` (rulings R1-R13).
Branch: `claude/remediate-f26`, fast-forwarded to origin/main 84025e8 (F31 #71 and F23 #74 landed while the branch had no commits). Evidence log: scratchpad `evidence-f26.txt`.

## Tasks

1. **Spec and plan** (this file).
2. **RED e2e**: `corpus_service/tests/test_f26_pdf_intake_e2e.py` with the synthetic fixture builder `tests/pdf_fixtures.py` and the golden fixtures `tests/fixtures/f26/` (generated with main's unmodified in-process extractor). `requirements-test.txt` gains the parser stack, pinned. Run on main's code, record the failures below. Commit with tasks 1-2, push.
3. **RED unit**: `corpus_service/tests/test_f26_pdf_sandbox.py` (static guard, sandbox isolation and limits, extractor caps, active-content scan, raw store, the F28 vocabulary). Run on main's code, record, commit, push.
4. **`scraper/tasks/outcomes.py`**: the F26 codes and `DocumentRejected` (error key = code; never retried except a transient `http_<status>`).
5. **`scraper/parsers/raw_store.py`**: content-addressed, read-only, flock-serialised, bounded store under `PDF_STORAGE_PATH/raw-pdf`.
6. **`scraper/parsers/pdf_extractor.py`**: `extract_pdf(data, limits)` with the R8 caps, `MemoryError` and limit errors propagated, page caches released, `find_active_content`, the warm-up document; `download_pdf` / `download_pdf_sync` removed; `extract_pdf_text` unchanged in signature and output.
7. **`scraper/parsers/pdf_sandbox.py`**: billiard spawn child, environment scrub, rlimits, network namespace and uid drop when available, JSON answer, watchdog, process-group kill.
8. **`scraper/tasks/pdf_intake.py`** and the seven harvesters (SHC, SC, LHC, PHC, BHC, IHC, NA): one call per PDF; staging rows carry `raw_pdf_path`, `pdf_page_count`, `ocr_applied`, `parsing_metadata.raw_sha256`.
9. **Seams and environment**: F20 harness and F28 marker fixtures stub `pdf_sandbox.parse`; `tests/conftest.py` session vault; `requirements.txt` declares `billiard`; F31's alias table drops `PIL` and `pdfplumber`.
10. **GREEN**: the F26 files, then the F20/F25/F28/F31 suites, then the full suite as CI runs it; G-0; gitleaks; the claim gate; wall-clock tests rerun alone when the machine is loaded. Commit, push after every commit.

## RED / GREEN ledger

Exact commands and full counts are in the evidence log. Wall-clock tests are rerun alone before any failure is believed.

| Step | Command | Result |
|---|---|---|
| Baseline, main 84025e8 | `python -m pytest corpus_service/tests -q` (CI=1, real PG16 + pgvector) | 995 passed, 3 warnings, 157 subtests, 0 skipped (15:24 at load ~20) |
| RED e2e, main 84025e8 code + the F26 e2e test | `python -m pytest corpus_service/tests/test_f26_pdf_intake_e2e.py -q -rf` | **6 failed, 1 passed**: oversized PDFs staged (no `pdf_too_large`); the 512 MiB bomb parsed in the worker (3 PDF documents opened there, Python allocations peaked at 1,071 MiB) and recorded as `empty_pdf_text`; the slow parse ran 200 s in the worker; nothing kept in a raw store and no staging row points at one; both JavaScript PDFs staged; a run of only active-content PDFs a success. The golden control passed (main's own text) |
| RED unit, main 84025e8 code + `test_f26_pdf_sandbox.py` | `python -m pytest corpus_service/tests/test_f26_pdf_sandbox.py -q -rf` | **29 failed, 2 passed**: harvesters parse and check PDFs themselves, the downloaders are still defined, no process creator; every behavioural test fails on the missing intake, store, sandbox and vocabulary. Passing on main: only `pdf_extractor.py` imports a parser library; the golden PDFs rebuild byte for byte |
| RED, final F26 tests on main 84025e8 code (scratch tree from `git archive origin/main` + the F26 tests) | `python -m pytest corpus_service/tests/test_f26_pdf_intake_e2e.py corpus_service/tests/test_f26_pdf_sandbox.py -q -rf` | **42 failed, 3 passed**: the e2e file grew a per-harvester case (7: every court and NA staged or wrote the JavaScript PDF and kept nothing) and the oversize case now asserts the refusal came from the boundary while reading (none on main); the 3 passes are the golden control and the two invariants |
