# F31 corpus runtime dependencies: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the production image's dependency set (`corpus_service/requirements.txt`) declares every third-party module the runtime imports, starting with `pgvector`, and a clean environment built from that file alone migrates, starts the API against PostgreSQL and loads the Celery app.

**Spec:** `docs/superpowers/specs/2026-10-18-f31-corpus-runtime-dependencies-design.md` (rulings R1 to R9).

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
- [ ] `corpus_service/requirements.txt`: add `pgvector==0.5.0` (R1) and `anyio`, `certifi`, `httpcore`, `pydantic` (R2), additively, with a comment naming F31.
- [ ] Comments only: `requirements-test.txt` (no longer "omits pgvector"; current verified count), `tests/e2e/Dockerfile` (points at the runtime smoke).
- [ ] Run the contract file and the e2e. **Expected: PASS.** Compare the RED and GREEN runtime venvs' `pip freeze`: the only intended addition is `pgvector==0.5.0`.
- [ ] Commit: `fix(F31): declare pgvector and every directly imported runtime dependency`.

### Task 4: CI and docs
- [ ] `gate-g0.yml`: job `corpus-runtime` ("corpus_service runtime dependencies (F31)"), path-gated like `corpus-service`, pgvector service, setup-python 3.12 with the pip cache keyed on `requirements.txt`, then `bash corpus_service/tests/e2e/runtime_smoke.sh`. The `changes` job comment lists what it depends on.
- [ ] `docs/architecture/README.md`: a `corpus-runtime` row with the local command; refresh the `corpus-service` row's verified count.
- [ ] Commit: `ci(F31): run the clean-runtime smoke in Gate G-0`.

### Task 5: Verification
- [ ] The full `corpus_service` pytest suite, as CI runs it (real Postgres, `CI=1`).
- [ ] The e2e once more on the final head.
- [ ] G-0: `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [ ] gitleaks over the branch diff, if available.
- [ ] Claim gate: `ci_gates/check_pr_phase_claims.py` with the PR body. **Expected: PASS.**
- [ ] Push, write the PR body to the scratchpad (the PR is not opened here), stop the local cluster.

---

## Ledger (RED and GREEN evidence)

| # | When | Command | Result |
|---|---|---|---|
| 0 | baseline, main f3bbcc9 | `python -m pytest corpus_service/tests -q` (CI=1, real PG16) | 559 passed, 0 skipped, 157 subtests passed (465 s) |
| 1 | RED, tests on main's manifest | `python -m pytest corpus_service/tests/test_f31_import_contract.py -q` | **2 failed**, 19 passed: `test_every_runtime_import_is_declared_in_requirements_txt` (anyio, certifi, httpcore, pgvector, pydantic undeclared) and `test_models_import_pgvector_and_requirements_txt_declares_it` (`'pgvector' in {…}` false) |
| 2 | RED, tests on main's manifest | `CORPUS_TEST_DATABASE_URL=… bash corpus_service/tests/e2e/runtime_smoke.sh` | **exit 1, 7 checks failed**: strict contract; `import scraper.models` (`ModuleNotFoundError: No module named 'pgvector'`); every scraper module (47; 17 fail on pgvector); `python -m scraper.migrate`; uvicorn `/health`; `celery … report`; the Celery broker/backend probe. Guard checks pass (pytest absent, all 21 declared distributions installed, 79 in all). |
