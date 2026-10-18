# F31 corpus runtime dependencies: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the production image's dependency set (`corpus_service/requirements.txt`) declares every third-party module the runtime imports, starting with `pgvector`, and a clean environment built from that file alone migrates, starts the API against PostgreSQL and loads the Celery app.

**Spec:** `docs/superpowers/specs/2026-10-18-f31-corpus-runtime-dependencies-design.md` (rulings R1 to R9; review round R10 to R13).

**Base:** `origin/main` f3bbcc9 when written; rebased onto 33fb1b3 (F25 #67 and FA-D5 #69 merged meanwhile; neither touches the files below except `scraper/net/fetch_policy.py` and `scraper/parsers/pdf_writer.py`, which the contract only reads). **Branch:** `claude/remediate-f31`.

**How tests run.**
- Contract test, as CI's "corpus_service pytest" job (`.github/workflows/gate-g0.yml`, job `corpus-service`): Python 3.12, `pip install -r corpus_service/requirements-test.txt`, `CI=1`, `CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@<pg16+pgvector>/corpus_ci`, the Annex A DDL (001, 003, 004) applied twice, then `python -m pytest corpus_service/tests -q`.
- E2E, as the new job `corpus-runtime`: `CORPUS_TEST_DATABASE_URL=… bash corpus_service/tests/e2e/runtime_smoke.sh` (a fresh Python 3.12 venv from `requirements.txt` only, then `tests/e2e/runtime_smoke.py` inside it).

Locally: a PG16 cluster under `/tmp/f31-pg` on 127.0.0.1:55471 (pgvector 0.6.0; the PG16 binaries at `/usr/lib/postgresql/16/bin`, run as the postgres user), a Python 3.12 venv with `requirements-test.txt` for the suite (proxy variables unset, as in CI), and fresh runtime venvs for the e2e (pip goes through the agent proxy).

**Constraints:** no edits to `app/api/**`, the PR #44/#47 platform files, `scraper/net/*`, `tests/test_f25_*`, F24's routers and `public_corpus.py`, F23's `routers/quarantine.py`, or F28's `tasks/dispatcher.py` and `tasks/embeddings.py`. Edits to `requirements*.txt` are additive. Synthetic data only. No test is skipped or weakened.

---

### Task 1: Spec and plan
- [x] Write the spec (rulings and reasons) and this plan.

### Task 2: RED
**Files:**
- Create `corpus_service/tests/import_contract.py`: the stdlib-only contract checker (scan, mapping, alias table, loaded-by-name table, reviewed dynamic-import sites, requirements parser), with `--strict` for the runtime venv.
- Create `corpus_service/tests/test_f31_import_contract.py`: the contract on the real tree, the finding's exact pair (models import pgvector, requirements.txt pins the tested version), the dispatcher's dynamic targets, the alias table's currency, and the checker's fail-closed behaviour on synthetic trees and manifests.
- Create `corpus_service/tests/e2e/runtime_smoke.sh` and `runtime_smoke.py`: the clean-venv e2e (spec R4).

**Steps:**
- [x] Run the contract file against main's `requirements.txt`. **Expected: FAIL** (pgvector, anyio, certifi, httpcore, pydantic undeclared).
- [x] Run the e2e against main's `requirements.txt`. **Expected: FAIL** with `ModuleNotFoundError: No module named 'pgvector'`.
- [x] Record the output in the ledger and commit the tests: `test(F31): RED import contract and clean-runtime smoke`.

### Task 3: The fix
- [x] `corpus_service/requirements.txt`: add `pgvector==0.5.0` (R1) and `anyio`, `certifi`, `httpcore`, `pydantic` (R2), additively, with a comment naming F31.
- [x] Comments only: `requirements-test.txt` (no longer "omits pgvector"; current verified count), `tests/e2e/Dockerfile` (points at the runtime smoke).
- [x] Run the contract file and the e2e. **Expected: PASS.** Compare the RED and GREEN runtime venvs' `pip freeze`: the only intended addition is `pgvector==0.5.0`.
- [x] Commit: `fix(F31): declare pgvector and every directly imported runtime dependency`.

### Task 4: CI and docs
- [x] `gate-g0.yml`: job `corpus-runtime` ("corpus_service runtime dependencies (F31)"), path-gated like `corpus-service`, pgvector service, setup-python 3.12 with the pip cache keyed on `requirements.txt`, then `bash corpus_service/tests/e2e/runtime_smoke.sh`. The `changes` job comment lists what it depends on.
- [x] `docs/architecture/README.md`: a `corpus-runtime` row with the local command; refresh the `corpus-service` row's verified count.
- [x] Commit: `ci(F31): run the clean-runtime smoke in Gate G-0`.

### Task 5: Verification
- [x] The full `corpus_service` pytest suite, as CI runs it (real Postgres, `CI=1`).
- [x] The e2e once more on the final head.
- [x] G-0: `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [x] gitleaks over the branch diff, if available (not installed in the build container: not run; diff checked by hand).
- [x] Claim gate: `ci_gates/check_pr_phase_claims.py` with the PR body. **Expected: PASS.**
- [x] Push, write the PR body to the scratchpad (the PR is not opened here), stop the local cluster.

### Task 6: Review round (Copilot x2, independent re-audit, Cursor Bugbot), PR #71
- [x] **Copilot 4305672181** (`runtime_smoke.sh:28`): RED `tests/test_f31_runtime_smoke_script.py` (4a3310e), fix: resolve `F31_RUNTIME_VENV` to an absolute path first (5da7e35).
- [x] **Copilot 4305672214** (`import_contract.py:145`): RED 16 loader-identity cases (2e5a748), fix: classify dynamic imports by the loader's identity, follow aliases, fail closed on what cannot be resolved (5cb0b9e).
- [x] **Independent re-audit (MEDIUM): lxml loaded by name** (`bootstrap_harvest.py:163, 195, 256, 305`): RED by-name tests and the smoke's harvest step (c9de14e), fix: by-name scan of parser features and URL drivers, lxml in `LOADED_BY_NAME`, reviewed `BY_NAME_EXCEPTIONS` (882c6df).
- [x] Cursor Bugbot thread 4305697404 flagged 2e5a748 (the intentional RED commit); fixed by 5cb0b9e.
- [x] **Cursor Bugbot 4305754112** (bs4 aliases, on 882c6df): RED untracked BeautifulSoup references and star imports (1c3d3c7); Autofix 34ddbf4 (Cursor Agent) arrived on the branch meanwhile, inspected, in scope, no test weakened: merged (3e268c5); fix completing and adjusting it (079e671).
- [x] Re-run: contract and script tests, the smoke (RED and GREEN), the full suite as CI runs it, G-0, the claim gate; spec section 5, this ledger and the PR body updated.
- [x] Before every push: `git fetch origin claude/remediate-f31` and compare (Cursor Bugbot Autofix is on). One foreign commit appeared, 34ddbf4 (Cursor Agent); my push of 1c3d3c7 was refused as non-fast-forward, nothing was overwritten, and it was merged as above. No force-push.

---

## Ledger (RED and GREEN evidence)

| # | When | Command | Result |
|---|---|---|---|
| 0 | baseline, main f3bbcc9 | `python -m pytest corpus_service/tests -q` (CI=1, real PG16) | 559 passed, 0 skipped, 157 subtests passed (465 s) |
| 1 | RED on f3bbcc9 (first RED commit 38dd0b8, before the rebase) | `python -m pytest corpus_service/tests/test_f31_import_contract.py -q` | **2 failed**, 19 passed: `test_every_runtime_import_is_declared_in_requirements_txt` (anyio, certifi, httpcore, pgvector, pydantic undeclared) and `test_models_import_pgvector_and_requirements_txt_declares_it` (`'pgvector' in {…}` false) |
| 2 | RED on f3bbcc9 (38dd0b8) | `CORPUS_TEST_DATABASE_URL=… bash corpus_service/tests/e2e/runtime_smoke.sh` | **exit 1, 7 checks failed**: strict contract; `import scraper.models` (`ModuleNotFoundError: No module named 'pgvector'`); every scraper module (47; 17 fail on pgvector); `python -m scraper.migrate`; uvicorn `/health`; `celery … report`; the Celery broker/backend probe. Guard checks pass (pytest absent, all 21 declared distributions installed, 79 in all). |
| 1b | RED on 33fb1b3 (commit bb382c1, after the rebase) | contract file, as row 1 | **2 failed**, 19 passed; same five modules (`fetch_policy.py` lines now 66 and 67) |
| 2b | RED on 33fb1b3 (commit bb382c1), final test files | e2e, as row 2 | **exit 1, 7 checks failed**, the same seven; 79 distributions installed, pgvector absent |
| 3 | GREEN, fix 98db18b (pre-rebase run on f3bbcc9 gave the same) | contract file | **21 passed** (inside the full suite, row 5) |
| 4 | GREEN, fix 98db18b | e2e | **exit 0, 14 checks passed**: strict contract; `import scraper.models`; 47 modules; migrate (9/9 tables, 15 sources); uvicorn `/health` `{"status": "ok", "db_connected": true, "total_cases": 0, …}`; `celery report`; `kombu.transport.redis.Transport` + `celery.backends.redis.RedisBackend`; 3 beat tasks registered |
| 4b | RED vs GREEN runtime venvs | `pip list --format=freeze`, diffed | the only difference is `+ pgvector==0.5.0` (79 → 80 distributions) |
| 5 | GREEN, fix 98db18b | full suite, as row 0 | **814 passed, 0 skipped**, 157 subtests passed (444 s); 814 collected = 793 on 33fb1b3 + 21 F31 |

**Test correction inside the branch (not a changed expectation of an existing test).** The first GREEN e2e run failed one check: it looked for the app name `legal_scraper` in `celery report`, which the report does not print (root cause read from the report output: it prints `transport:redis`, the `redis:<version>` client on the software line, and the beat schedule). The check now looks for those. Rows 2b and 4 use the corrected check.

**Rebase.** `origin/main` moved from f3bbcc9 to 33fb1b3 (F25 #67, FA-D5 #69) during the work. The branch, then one pushed RED commit, was rebased and the RED commit re-pushed with `--force-with-lease` to this branch only (never `main`), so the RED commit sits directly on current main for the re-audit.

### Review round ledger (PR #71; base of the round c865145)

| # | Item | Tree | Command | Result |
|---|---|---|---|---|
| R1 | Copilot 4305672181 | 4a3310e (RED) | `pytest corpus_service/tests/test_f31_runtime_smoke_script.py` | **6 failed**, 2 passed: relative, nested relative, `~/x` and `~` exit 127 (the venv looked up under `corpus_service/`); existing path not named absolutely; `~user` not refused. Absolute and default pass. |
| G1 | Copilot 4305672181 | 5da7e35 | same | **8 passed** |
| R2 | Copilot 4305672214 | 2e5a748 (RED) | `pytest corpus_service/tests/test_f31_import_contract.py` | **13 failed**, 24 passed: of the 16 identity cases only `module alias`, `star import from importlib` and the control passed; `from importlib import import_module as load; load("missing_dep")` gave `[]` (neither dependency nor dynamic import) |
| G2 | Copilot 4305672214 | 5cb0b9e | same + script tests | **47 passed** (39 contract + 8 script). Two cases added while implementing (class-body alias, `sys.modules`) and a `hasattr` false positive failed against the first draft before passing. Real tree unchanged: one dynamic site, `dispatcher.py:80`. |
| R3a | re-audit: lxml | c865145's smoke, manifest without lxml | `runtime_smoke.sh` | **exit 0, 14/14**, 79 distributions, no lxml: the gap the re-audit showed |
| R3b | re-audit: lxml | c9de14e (RED) | contract file | **18 failed** (every new by-name test), 42 passed |
| R3c | re-audit: lxml | c9de14e, manifest without lxml | `runtime_smoke.sh` | **exit 1**: `bootstrap_harvest` harvest step, `bs4.exceptions.FeatureNotFound: ... lxml` |
| G3a | re-audit: lxml | 882c6df | contract + script tests | **68 passed** (60 + 8) |
| G3b | re-audit: lxml | 882c6df, manifest as committed (lxml declared) | `runtime_smoke.sh` | **exit 0, 15/15** (80 distributions), harvest step included |
| G3c | re-audit: lxml | 882c6df, manifest without lxml | `runtime_smoke.sh` | **exit 1, 2 failed**: strict contract (`undeclared: lxml is loaded by name ... bootstrap_harvest.py:163, 195, 256, 305`) and the harvest step (`FeatureNotFound`) |
| G4a | all three | 882c6df | full suite, as CI | **861 passed, 0 skipped**, 157 subtests passed (533 s) |
| R4 | Bugbot 4305754112 | 1c3d3c7 (RED) | contract file | **7 failed** (five escapes: class-body alias, list, dict, `functools.partial`, escaped bs4 module; star from bs4; star the check cannot enumerate), 64 passed |
| R4b | Bugbot 4305754112 | 34ddbf4 (Autofix) merged as 3e268c5 | contract file | **7 failed**: the five escapes reported as unreviewed dynamic imports, not as BeautifulSoup references; unenumerable star not covered; `isinstance()`/attribute-use control flagged |
| G4b | Bugbot 4305754112 | 079e671 | contract + script tests | **79 passed** (71 + 8). Real tree unchanged (lxml x4 in `bootstrap_harvest.py`, one dynamic site, no by-name problem) |
| G5a | all four | 079e671 | `runtime_smoke.sh`, manifest as committed | **exit 0, 15/15** (80 distributions) |
| R5a | all four | 079e671, `origin/main`'s manifest (no pgvector) | `runtime_smoke.sh` | **exit 1, 7 failed** (the same seven as row 2b; the harvest step passes, since main declares lxml) |
| G5b | all four | 079e671 | full suite, as CI | **872 passed, 0 skipped**, 157 subtests passed (738 s); 872 = 793 pre-existing + 79 F31 |

**Count corrections.** The smoke had **14** checks before this round, not 15: rows 4 and the first PR body said "15 checks passed", and commit c9de14e said the c865145 smoke passed "15/15" on the lxml-free manifest (it was 14/14; the re-audit's own count was 15/15). With the harvest step it has **15** checks: commit 882c6df's "16/16" should read 15/15 (rows R3a, G3b and 4 are corrected above). The counts here are from `grep -c '^PASS'` of each log. Pushed commit messages are not rewritten (no force-push); this note is the correction.
