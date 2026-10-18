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
| GREEN iteration 1 (sandbox unit, `-x`) | `test_f26_pdf_sandbox.py` | 1 failed: the 1.5 GiB bomb ended `pdf_parse_crashed` (SIGABRT): pdfplumber wraps the `MemoryError` (`PdfminerException`), the extractor swallowed it, and the OCR fallback aborted inside pdfium. Ruling (spec R9): every broad handler re-raises a `MemoryError` or cap found in the exception chain |
| GREEN iteration 2 | `test_f26_pdf_sandbox.py` (guards deselected) | 28 passed; isolation here (root container): uid 65534, `netns`, 8 fds |
| GREEN iteration 3 | both F26 files | 1 failed: the harvester guard matched IHC's `_extract_pdf_urls_from_feed_payload` (discovery); guard matches exact names (123f136) |
| Neighbour run 1 | F20, F28, F25, F31, trust, F26 | F20 and two F28 IHC cases: `NameError` (the IHC rewrite dropped `provenance = ...`; restored). F25's guard refused `fetch_policy.PolicyFetcher` in `pdf_intake` (an `isinstance`); ruling (spec R2): recognise the client by its public `max_bytes` |
| GREEN, F26 + neighbours, CI-like venv (requirements-test.txt only) | F20 harvesters, F28 e2e + unit, F25 guard/reaudit/policy, F31 contract, trust policy, both F26 files | **636 passed**, 110 subtests |
| F31 runtime smoke, clean venv from requirements.txt | `tests/e2e/runtime_smoke.py` | all checks passed (28 declared, strict import contract, 54 modules import, migrate, API, Celery); in that venv the sandbox returns main's golden text and refuses the 1.5 GiB bomb as `pdf_memory_limit` |
| gitleaks 8.30.1 (006f181) | `gitleaks git --config .gitleaks.toml --log-opts=origin/main..HEAD` | 4 commits, no leaks found |
| GREEN, full suite (006f181), CI-like venv | `python -m pytest corpus_service/tests -q -rf` | **1040 passed**, 3 warnings, 157 subtests, 0 skipped (8:53; main: 995, +45 = 14 e2e + 31 unit) |
| Mutation check (scratch copy of 006f181, one undo per run, both F26 files) | `f26-mutate.py` | M1 parse in the worker: 13 failed; M2 cap not narrowed: 2; M3 nothing kept: 11; M4 no active-content scan: 10; M5 wrapped `MemoryError` swallowed: 2; M6 environment kept: 1; M7 no rlimits: 4; M9 refusals counted by class name: 13; M10 NA parses in the worker: 3. M8 (only the poll unbounded) was **not** caught, because the watchdog still acted; the stronger M8b (no watchdog) was caught only after the unit wall bound was tightened from wall + 15 s to wall + 10 s (`refused after 19.5 s`); the e2e slow case passes under M8b because the child's alarm (wall + 15 s) is inside its run budget |
| Tightened wall test, real code, alone, twice | `-k "wall_limit or cpu_limit"` | 4.20 s / 4.18 s (watchdog at 4 s); CPU test 2.73 s / 2.67 s; all passed |
| GREEN, full suite at e4741c5 (the last code or test change), CI-like venv | `python -m pytest corpus_service/tests -q -rf` | **1040 passed**, 3 warnings, 157 subtests, 0 skipped (7:15) |
| Gate G-0 (e4741c5) | `BASE=origin/main bash ci_gates/gate_g0.sh` | `=== Gate G-0 PASSED (static) ===`, 0 FAIL lines |
| gitleaks 8.30.1 (e4741c5) | `gitleaks git --config .gitleaks.toml --log-opts=origin/main..HEAD` | 5 commits, no leaks found |

## Rulings made while going GREEN

- **R9** (spec): pdfplumber wraps a `MemoryError` (`PdfminerException(e)`); every broad handler in the extractor re-raises a `MemoryError` or a cap found in the exception's chain.
- **R2** (spec): F25's guard refuses any reference to `PolicyFetcher` outside the boundary; the intake recognises the connector's client by its public `max_bytes`.
- **R8** (spec): the wall-limit unit test bound is wall + 10 s, so it fails when only the child's alarm (wall + 15 s) ends a parse.

## Review round on PR #76 (CodeQL py/overly-permissive-file x3; Codex P2 4306132181, 4306132184)

| Step | Command | Result |
|---|---|---|
| RED, the round's tests on 7821f6c code (60f5711) | `-k "r5_ or r15_ or ocr_text or r6_the_child or test_d_"` | **7 failed, 4 passed**: modes 4 (object 0o444; umask 0 gave `raw-pdf` 0o777, `.lock` 0o644, `.usage` 0o666); ledger 2 (an uncounted object let a third object pass the cap; a killed writer left no count); OCR cap 1 |
| GREEN (38f7a5f) | same selection; both F26 files | 11 passed; 49 passed |
| GREEN, full suite (38f7a5f), CI-like venv | `python -m pytest corpus_service/tests -q -rf` | **1044 passed**, 3 warnings, 157 subtests, 0 skipped |

Rulings: **R14** (spec) the raw store is owner-only and requires one uid for every container that mounts it; **R15** (spec) the ledger is written before the link and recounted before any refusal at the cap.

## F26-FU: after the independent re-audit (FAIL 7/10)

**Goal:** close the re-audit's MEDIUM (FA-corpus-009: the sandbox child writes to the worker's stdout and stderr) and its cheap LOWs and INFO items, test-first, in one PR.
**Architecture:** no new module. `pdf_sandbox._child` detaches from the worker's output first; `raw_store` gets a random temporary name, a dirty marker and a rate-limited recount; `main.py` gets one vault-walking helper that skips the raw store; `pdf_extractor.ACTIVE_CONTENT_NAMES` grows; `pdf_intake` refuses a repeated Content-Type; `parse` sweeps scratch directories of dead workers.
**Spec:** section 7 of the F26 spec, rulings R16-R25.
**Branch:** `claude/remediate-f26-fu` from origin/main 53f4450. Evidence log: scratchpad `evidence-f26-fu.txt`. Every RED is the new tests on 53f4450's code.

### Global constraints

- No change to `scraper/net/*` or `tests/test_f25_*` (F25), F23-fu's `routers/quarantine.py` and `main.py` body guard, F28-fu's failure handling, `job_record` and dispatcher. `pdf_intake.py` and `main.py` changes stay small and additive.
- The auditor's mutation patterns for the R8 bounds and the store's two final checks (`if used + size > MAX_STORE_BYTES:` / `if shutil.disk_usage(store).free - size < MIN_FREE_BYTES:`, `payload = reader.recv_bytes(limits.max_result_bytes)`, `if len(body) > max_bytes:`) keep their exact text, so the re-audit's driver still applies.
- No literal that looks like a key, anywhere; gitleaks on `origin/main..HEAD` before every push.

### Review focus

1. A real Celery prefork worker logs to Docker: the e2e flood test captures the worker process's fds 1 and 2 (what a spawned child inherits), not pytest's capture objects. Task 2.
2. A full store keeps getting puts: two refused puts in a row walk the tree at most once (Task 3); an operator's manual removal is still noticed after the interval (Task 3).
3. A writer SIGKILLed mid-put, then the same document from the same pid: stored (Task 3), with real processes and real signals.
4. `/health` on a vault where `raw-pdf/` holds objects: `total_pdfs` counts only the bootstrap PDFs and nothing under `raw-pdf/` is listed (Task 4).
5. CI runs as a non-root user where user namespaces may be refused: the netns test skips with the probe's error, never passes silently (Task 2).

### Tasks

1. **Spec and plan** (spec section 7, this section). Commit and push.
2. **RED tests**, all in the existing F26 files plus `tests/pdf_fixtures.py` (`log_flood_pdf`, `active_pdf(name)`), run on 53f4450's code and recorded below:
   - e2e `test_b_a_pdf_that_floods_the_parser_s_log_writes_nothing_to_the_worker_s_output`: LHC run of the flood PDF (the auditor's `write_flood_pdf.py`) then a golden judgment, wall 8 s; fds 1 and 2 of the test process point at a counted pipe; want <= 64 KiB, `pdf_parse_timeout` 1, the judgment staged (R16);
   - sandbox: isolation read-backs (`stdio` all `/dev/null`, `logging_disabled`, `session_leader`, `image_pixels`, `image_bomb_error`) (R16, R24, M44); netns compared with the worker's where a forked probe can `unshare` (R24, M37); `_kill_group` on a forked session leader with a grandchild (M38); the worker-bound and child-bound reply details (M14, M15); scratch directories of a killed daemonic pool process are gone after the next parse (R23);
   - extractor: one fixture per listed name (M19-M24) and per R20 name; a URI-link judgment accepted; OCR goes on past a page whose size raises (M48);
   - raw store: killed writer with pid 4242 then the same document with pid 4242 (R17, L1); a killed writer's leftovers reclaimed by the next put (R18 marker); the floor recounts before refusing (R18, L2); two refused puts at a full store walk the tree at most once, and an aged stamp lets a removal be noticed (R18, L3);
   - intake: two Content-Type fields, a comma list, identical duplicates refused `not_pdf`; a comma in a parameter accepted (R21);
   - `/health` and `/api/vault` skip `raw-pdf/` (R19); `requirements-test.txt` pins the installed billiard (R22).
   Commit and push.
3. **`raw_store.py`** (R17, R18): `secrets.token_hex(8)` temporary names; `_mark_dirty`, `_recount_due`, the `.recounted` stamp; recount order: temps, ledger, stamp, then marker.
4. **`main.py`** (R19): `_live_dir()` and `_vault_pdfs(live_dir)` (os.walk, prunes `raw_store.STORE_DIR`, no link following); `/health` and `/api/vault` use them.
5. **`pdf_sandbox.py`** (R16, R23, R24): `_detach_output()` first in `_child`; read-backs; the worker-bound detail; scratch naming and `_sweep_stale_scratch()`.
6. **`pdf_extractor.py`** (R20) and **`pdf_intake.py`** (R21); **`requirements-test.txt`** (R22).
7. **GREEN**: both F26 files, then the neighbours (F20, F25, F28, F31), then the full suite as CI runs it; wall-clock tests rerun alone when the machine is loaded. The auditor's probes (`logflood_probe.py`, `pid_reuse_probe.py`, `floor_recount_probe.py`) on the head. Mutation: the re-audit's survivors M14, M15, M19-M24, M37, M38, M44, M48 and new mutants for R16-R23. Gates: G-0, F31 import contract, F31 runtime smoke, gitleaks, the claim gate on the PR body.

### Ledger

| Step | Command | Result |
|---|---|---|
| RED, the F26-FU tests on 53f4450's code | `python -m pytest corpus_service/tests/test_f26_pdf_sandbox.py corpus_service/tests/test_f26_pdf_intake_e2e.py -q -rfEs` (CI=1, PG16 on 55551) | **21 failed, 59 passed**. Flood: the worker's stdout and stderr received **552,931,560 bytes (527.3 MiB)** in the 8 s-wall run (bound 64 KiB). R16: no stdio/logging read-back; with `/dev/null` refused the child went on (`FileNotFoundError`). M14: no worker-bound detail. M37/M44/session: no read-back. R20: the six new names accepted. L1: `FileExistsError` x3. L2: a killed writer's temporary object survives the next put; the floor refuses without reclaiming it. L3: 20 directories scanned at each of two refused puts in a row. R21: two Content-Type fields accepted. R22: no billiard pin. R23: the killed pool process's scratch directory survives the next parse. R19: `total_pdfs` 0, because this machine has an empty `/app/live` (next row). Passing, as expected: the mutant-killing tests for unchanged code (M15, M38, M48, the six R4 names, the URI control) and every existing test |
| RED, R19 as on a CI runner (no `/app/live`: `/app` hidden by a tmpfs in a private mount namespace) | `unshare -m ... -k r19_` | **1 failed**: `total_pdfs` 5 (2 bootstrap PDFs + 3 raw-store objects), want 2 |
