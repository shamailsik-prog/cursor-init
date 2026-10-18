# F31: the corpus runtime declares every dependency it imports (design)

**Finding.** Audit F31 (HIGH, P0), `docs/audit/2026-10-13-forensic-audit.md`, "The corpus runtime omits a directly imported dependency": `scraper/models.py` imports `pgvector.sqlalchemy`, but `corpus_service/requirements.txt` (the set the production `Dockerfile` installs) does not declare `pgvector`; only `requirements-test.txt` does. The minimal test environment therefore cannot validate the dependency set of the Docker image. Failure scenario: a clean runtime image has no `pgvector`, model import fails, and the API, the migrate one-shot and the Celery processes die before they start. Recommended correction: declare `pgvector`, audit the direct import-to-dependency contract, and run a clean smoke test that imports the models and starts the API and Celery against PostgreSQL; version pinning in general is F46. The v2 re-audit (`docs/audit/2026-10-14-forensic-audit-v2.md`, row F31) left it OPEN with the same evidence.

**Rule for closure** (`docs/audit/REMEDIATION.md`): a merged PR with an end-to-end test of a real flow that fails on main and passes after, then an independent re-audit.

## 1. What main does today (`origin/main` 33fb1b3; written against f3bbcc9, and the F25 and FA-D5 merges in between change no fact below, only line numbers in `fetch_policy.py`)

**The two dependency sets.**

| File | Installed by | pgvector |
|---|---|---|
| `corpus_service/requirements.txt` (unpinned except httpx) | `corpus_service/Dockerfile` (`pip install -r requirements.txt`), so every compose app service: `api`, `migrate`, `worker-embed`, `celery-beat`, `worker-a`, `worker-b` | **absent** |
| `corpus_service/requirements-test.txt` (pinned, minimal) | CI's "corpus_service pytest" job (`.github/workflows/gate-g0.yml`, job `corpus-service`), the F05 authority job, and the F30 e2e image (`tests/e2e/Dockerfile`) | `pgvector==0.5.0` |

No CI job and no e2e installs `requirements.txt`. The F30 compose e2e deliberately swaps the app image for `tests/e2e/Dockerfile`, built from `requirements-test.txt`; its header says the runtime image's own dependency set is F31. So the production dependency set has never been installed by any test.

**Every third-party module the runtime code imports** (an `ast` walk of `scraper/`, `migrations/` and `bootstrap_harvest.py`, mapped with `importlib.metadata.packages_distributions()` in a Python 3.12 environment):

| Module | Imported at (first site) | Distribution | In `requirements.txt` on main |
|---|---|---|---|
| `pgvector` | `scraper/models.py:58` | pgvector | **no** |
| `anyio` | `scraper/routers/export.py:33` | anyio | **no** (transitive: fastapi → starlette) |
| `certifi` | `scraper/net/fetch_policy.py:66` | certifi | **no** (transitive: httpx) |
| `httpcore` | `scraper/net/fetch_policy.py:67` | httpcore | **no** (transitive: httpx) |
| `pydantic` | `scraper/config.py:26` | pydantic | **no** (transitive: fastapi, pydantic-settings) |
| `bs4` | parsers and every court task | beautifulsoup4 | yes |
| `celery` | `scraper/tasks/*.py` | celery | yes |
| `cryptography` | `scraper/config.py`, `scraper/auth/credential_manager.py` | cryptography | yes |
| `fastapi` | `scraper/main.py`, routers | fastapi | yes |
| `httpx` | `scraper/net/fetch_policy.py` | httpx | yes |
| `openai` | `scraper/tasks/embeddings.py` | openai | yes |
| `pdfplumber` | `scraper/parsers/pdf_extractor.py` | pdfplumber | yes |
| `PIL` | `scraper/parsers/pdf_extractor.py` | pillow | yes |
| `pydantic_settings` | `scraper/config.py` | pydantic-settings | yes |
| `pytesseract` | `scraper/parsers/pdf_extractor.py` | pytesseract | yes |
| `reportlab` | `scraper/parsers/pdf_writer.py` | reportlab | yes |
| `sqlalchemy` | `scraper/database.py`, models, routers | SQLAlchemy | yes |

Three more distributions are loaded by name rather than imported: `asyncpg` (the SQLAlchemy dialect of every `postgresql+asyncpg://` `DATABASE_URL`), `redis` (kombu's transport and Celery's result backend for `redis://`/`rediss://`), and `uvicorn` (the compose `api` command). All three are declared. The one dynamic import, `importlib.import_module(module_name)` in `scraper/tasks/dispatcher.py`, resolves `ROUTES` entries, all of which are `scraper.tasks.*` modules (first-party, and scanned as files).

So `pgvector` is the one module whose absence breaks startup today, and four more are present only because another package happens to depend on them: exactly the "accidental undeclared transitive dependency" the finding names.

## 2. Rulings

Each ruling records the decision and the reason (owner's standing instruction).

**R1. Declare `pgvector==0.5.0` in `requirements.txt`.** *Reason:* `scraper/models.py` imports it at module load, and every process imports the models. 0.5.0 is the version `requirements-test.txt` pins and CI's corpus_service suite runs against, so the runtime gets the version the tests prove. pgvector 0.5.0 declares no dependencies of its own (`Requires-Dist` is empty), so the resolved runtime set grows by exactly one distribution. Pinning this one name is part of closing F31; pinning everything else is F46.

**R2. Also declare `anyio`, `certifi`, `httpcore` and `pydantic`, unpinned.** *Reason:* the runtime code imports their APIs directly (`anyio.to_thread` in the export router, `certifi.where()` and `httpcore` network backends in the F25 fetch boundary, `pydantic` models in config, the public corpus and the publication batch). Relying on fastapi, starlette and httpx to keep depending on them is the failure class F31 names. *Unpinned because* declaring a name does not change what pip resolves (each is already installed as a dependency of a declared package, and httpx==0.28.1 still constrains httpcore to 1.x), and pinning belongs to F46. *Steelman against:* "fastapi and httpx guarantee these through their own metadata; declaring them is noise." *Answer:* that guarantee lasts only as long as upstream keeps the dependency, and the code relies on these packages' own APIs (F25's guard even relies on httpcore's backend interface). A declared contract can be checked mechanically (R3); an implied one cannot.

**R3. A static import contract test runs in the normal pytest run** (`corpus_service/tests/test_f31_import_contract.py`, logic in `corpus_service/tests/import_contract.py`, stdlib only).
- *Scope:* `scraper/`, `migrations/` and `bootstrap_harvest.py`: every Python file the image copies and runs. `bootstrap_harvest.py` is the operator's public-harvest entry point (named by `scraper/workers/harvester.py`). `tests/` is `requirements-test.txt`'s domain, and `scripts/` holds shell only.
- *What counts as an import:* every `import` and absolute `from ... import` anywhere in the file (module level, functions, `try` blocks), and `importlib.import_module("literal")` / `__import__("literal")`. Relative imports and `scraper.*` are first-party; `sys.stdlib_module_names` is the standard library.
- *Mapping:* `importlib.metadata.packages_distributions()`. A module maps to a declared distribution when any distribution that provides it is declared in `requirements.txt` (PEP 503 names). `requirements-test.txt` never counts for runtime code.
- *Alias table, small and reviewed:* only for modules the minimal test environment cannot resolve: `PIL` (distribution pillow) and the four runtime-only packages the pinned test set does not install (`openai`, `pdfplumber`, `pytesseract`, `reportlab`). Each entry carries its reason. An alias that disagrees with installed metadata fails, and an alias for a module no longer imported fails as stale.
- *Fail closed:* an import that maps to no declared distribution fails; a module neither installed nor aliased fails as unknown; a non-literal dynamic import at an unreviewed site fails; a reviewed site with no dynamic import left fails as stale; an unparseable or unsupported `requirements.txt` line (`-r`, `-e`, `--index-url`, a bare URL) fails; a missing runtime root or a syntax error fails.
- *Loaded by name:* `asyncpg`, `redis` and `uvicorn` must be declared too (R5 proves them at runtime as well).
- *Dynamic site:* `scraper/tasks/dispatcher.py` is the one reviewed site; the test imports the dispatcher and requires every `ROUTES` module to be a `scraper.*` module whose file is inside the scanned tree.

*Reason:* the static test catches the next undeclared import in the same pytest run every PR already gets, in under a second, without a network or a second environment.

**R4. The end-to-end test is a clean runtime environment built from `requirements.txt` only** (`corpus_service/tests/e2e/runtime_smoke.sh`, which creates the venv, and `corpus_service/tests/e2e/runtime_smoke.py`, which runs inside it). It runs the compose entry points against real PostgreSQL 16 with pgvector:
1. *Environment guard:* `pytest` is not importable (so this is not the test environment) and every distribution `requirements.txt` declares is installed (so the venv was built from it).
2. *Strict contract:* the R3 check with no alias fallback: in the runtime environment every third-party import must be installed and map to a declared distribution, and every alias must agree with real metadata. This proves the alias table against the real packages.
3. *Model import:* `python -c "import scraper.models"`, the exact failure the finding predicts.
4. *Every module imports:* each module under `scraper/` (`pkgutil.walk_packages`) imports in a child process with a development environment.
5. *Migrate:* `python -m scraper.migrate` (the compose `migrate` command) against a fresh database.
6. *API:* `uvicorn scraper.main:app --host 127.0.0.1 --port <free>` (the compose `api` command, from the venv's own `bin/`), then `GET /health` must answer `status: ok` with `db_connected: true`.
7. *Celery:* `celery -A scraper.tasks.celery_app report` (the `-A` target of `worker-embed` and `celery-beat`) exits 0, and in Python the app's broker transport and result backend are constructed (which loads the `redis` client library) and its beat tasks are registered.

On main step 2 fails (pgvector not installed; anyio, certifi, httpcore and pydantic undeclared), step 3 fails with `ModuleNotFoundError: No module named 'pgvector'`, and steps 4 to 7 fail with the same error; after R1 and R2 every step passes. A file the import walk cannot reach by any dotted name (today `scraper/auth/credential_manager.py`, shadowed by `scraper/auth.py` and imported by nothing) is printed as a NOTE, not imported: it is dead code, not a dependency question, and its imports are still covered by step 2. *Reason:* this is the real flow the finding's failure scenario describes (a clean install of the runtime set, then process startup against PostgreSQL), and it uses the image's Python (3.12, `python:3.12-slim`).
*Scope limits, stated:* no Redis server is started. A live broker round trip is F30's compose e2e; F31 is about the dependency set, and constructing the transport and backend is what loads the dependency. The database role is the test server's superuser on a fresh database that is dropped afterwards; the least-privilege roles are F30's e2e.

**R5. CI runs the e2e as its own job, `corpus-runtime` ("corpus_service runtime dependencies (F31)") in `gate-g0.yml`,** path-gated exactly like `corpus-service` and with its own pgvector service. *Reason:* the brief allows the CI step if it is cheap. It is: a pip install of the runtime set with setup-python's pip cache (keyed on `requirements.txt`), a migrate, one uvicorn start and one Celery report, a few minutes in all. A separate job keeps a runtime-set failure from hiding the pytest results and names its own cause (the workflow's "independent jobs" rule). *Accepted cost:* `requirements.txt` is unpinned until F46, so this job resolves the latest releases each run; an upstream release that breaks the runtime fails this job without a source change. That is a true positive about the production image, not noise, and F46 removes it by pinning.

**R6. The production Docker image is not built here: NOT DEMONSTRATED.** In this container the Docker CLI is installed but no daemon runs (`/var/run/docker.sock` is missing), and the shared disk has about 4 to 5 GB free, less than the image (Debian, Tesseract, Pango, Chromium and its system packages) needs with headroom for the other builders. No CI job builds it either. *Reason for not adding one:* a CI job that cannot be run locally first would ship unverified, and building and testing the actual image is F46's correction ("test the actual signed image"). The venv e2e proves the Python dependency set the image installs; it does not prove the image's apt packages or `playwright install chromium --with-deps`. Recorded as residual and follow-up.

**R7. The Dockerfile is unchanged.** *Reason:* it installs `requirements.txt`, so R1 and R2 fix the image's Python set. Nothing else in it bears on F31.

**R8. Comment-only edits elsewhere.** `requirements-test.txt` stops saying that `requirements.txt` omits pgvector (no dependency change), and `tests/e2e/Dockerfile`'s header points at the new smoke. `docs/architecture/README.md` gains the local command for the new job. *Reason:* stale statements about the dependency sets would mislead the re-audit.

**R9. No schema change, no migration, no change to application code.** *Reason:* the finding is about the manifest; the code is already right.

## 3. Lanes

F31 touches `corpus_service/requirements.txt` (additive), adds the contract test and the e2e, and edits comments in `requirements-test.txt` and `tests/e2e/Dockerfile`, plus `gate-g0.yml` and `docs/architecture/README.md`. It does not touch `app/api/**`, the platform files of PRs #44 and #47, `scraper/net/*` or `tests/test_f25_*` (PR #67), F24's routers, F23's `routers/quarantine.py`, or F28's `tasks/dispatcher.py` and `tasks/embeddings.py` (the contract test only reads them). PR #67 (F25), merged as 33fb1b3 while this branch was open, added imports of `xml`, `zlib`, `io`, `types` (stdlib) and `reportlab` (declared); the branch is rebased onto it and the contract holds. F23 and F28 add no third-party imports as briefed; if either does, the contract test names the module and the fix is one line in `requirements.txt`.

## 4. Residual risks

1. The production image itself (apt packages, Chromium) is not built or run (R6).
2. `requirements.txt` stays unpinned except httpx and pgvector, so a rebuild can resolve different versions (F46).
3. Packages the code loads by name but neither imports nor names in the R3 table (for example a SQLAlchemy dialect for another URL scheme) are covered only by the runtime e2e.
4. Declared-but-unused runtime packages (`playwright`, `weasyprint`, `lxml`, `alembic`, `python-dateutil`, `python-multipart`) are left as they are: removing them is outside F31 (FA-D3C-001 owns Playwright).
