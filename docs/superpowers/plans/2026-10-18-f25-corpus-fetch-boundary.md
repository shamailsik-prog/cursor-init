# F25 corpus fetch boundary: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every outbound HTTP request a corpus source makes goes through one fetch policy. That policy is HTTPS-only, uses per-source host allowlists, checks the port, refuses userinfo, refuses non-public resolved addresses (pinned at connect time), re-validates each redirect and the final origin, and bounds time and bytes. A link outside the allowlist is skipped and logged, never fetched.

**Spec:** `docs/superpowers/specs/2026-10-18-f25-corpus-fetch-boundary-design.md` (rulings R1 to R14).

**Base:** `origin/main` 1f0cc27. **Branch:** `claude/remediate-f25`.

**How tests run (as CI's "corpus_service pytest" job, `.github/workflows/gate-g0.yml:420-471`):**
- Python 3.12, `pip install -r corpus_service/requirements-test.txt`.
- `CI=1`, with `CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@<pg16+pgvector>/corpus_ci`.
- The Annex A DDL (001, 003, 004) is applied twice first.
- Then `python -m pytest corpus_service/tests -q`.

Locally: a PG16 cluster under `/tmp/f25-pg` on 127.0.0.1:55441 (the PG16 binaries at `/usr/lib/postgresql/16/bin`, run as the postgres user), and a Python 3.12 venv. Proxy env vars are unset, because CI has none.

**Constraints:**
- Do not touch the routers F24 owns (`routers/search.py`, `routers/export.py`), `app/api/**` or the platform files PRs #44 and #47 own.
- Edits to shared files stay additive.
- Synthetic fixtures only.
- Never skip or weaken a test. Every changed expectation is listed in the ledger.

---

### Task 1: Spec and plan
- [x] Write the spec, with the rulings and their reasons, and this plan.
- [x] Commit: `docs(F25): fetch boundary spec and plan`.

### Task 2: RED tests
**Files:**
- Create `corpus_service/tests/test_f25_fetch_boundary_e2e.py`: the real Celery task path `dispatcher.run_source_job("NasirLawSite")` against a local HTTPS source server and a local "internal service", on real Postgres (spec section 4).
- Create `corpus_service/tests/test_f25_fetch_policy.py`: the URL, address, backend (DNS rebinding), fetcher (redirects, downgrade, loop, cap, deadline, POST) and connector classes, plus the hooks.
- Create `corpus_service/tests/test_f25_fetch_guard.py`: the raw-client and redirect guard with positive controls, the connector-adoption check, and registry/seed consistency.

**Steps:**
- [x] Run the e2e against main's code. **Expected: FAIL**, because the internal service receives requests (the metadata path among them) and the canary is staged.
- [x] Run the unit and guard files against main. **Expected: FAIL**: `fetch_policy` is missing, and the guard lists every raw client on main.
- [x] Save the output as `f25-red-*.log`, record the counts in the ledger, and commit the tests.

### Task 3: The boundary module
- [x] Create `corpus_service/scraper/net/__init__.py` and `fetch_policy.py` (spec section 3): `FetchPolicy`, `SOURCE_POLICIES`, `_GuardedBackend`, `_GuardedTransport`, `PolicyFetcher`, `SyncPolicyFetcher`, `fetcher_for`, `sync_fetcher_for`, and refusal logging with userinfo redaction.
- [x] Run the unit file. **Expected:** the policy, address, backend and fetcher classes pass.

### Task 4: Adoption
- [x] Route the connectors through `fetch_policy.fetcher_for(<policy>)`: nasirlawsite (with `allows` and `urljoin`), nationalassembly, pakistancode, shc, supremecourt, lahorehighcourt, peshawarhighcourt, balochistanhighcourt and islamabadhighcourt. The retry helpers re-raise `FetchRefused`, and IHC's POST goes through `fetcher.post`.
- [x] Route `bootstrap_harvest.py` through `sync_fetcher_for`, per source, with the policy checked before `robots.txt`.
- [x] `pdf_extractor`: drop the forced redirects, and stop `download_pdf_sync` from building its own client.
- [x] `tests/test_f20_harvesters_db.py`: the offline harness substitutes `fetch_policy.fetcher_for` instead of `httpx.AsyncClient` (a changed expectation, listed in the ledger).
- [x] Run the e2e, the unit file and the guard. **Expected: PASS.**

### Task 5: Verification
- [x] The full `corpus_service` pytest suite, as CI runs it (real Postgres, `CI=1`).
- [x] G-0: `BASE=origin/main bash ci_gates/gate_g0.sh` (it scans the full tree, including corpus_service).
- [x] gitleaks on the branch commits, if the binary is available locally.
- [x] Claim gate: `ci_gates/check_pr_phase_claims.py` with the PR body. **Expected: PASS.**
- [x] Commit, push `claude/remediate-f25`, and write the PR body to the scratchpad. The PR is not opened here.

---

## Ledger

All runs: Python 3.12.3 venv with `corpus_service/requirements-test.txt` (httpx 0.28.1, httpcore 1.0.9), `CI=1`, proxy variables unset, `CORPUS_TEST_DATABASE_URL` on a private PG16 + pgvector with the Annex A DDL (001, 003, 004) applied twice, `python -m pytest -p no:cacheprovider`.

| Task | Commit | RED (seen failing first) | GREEN |
|---|---|---|---|
| 1 | 43a0508 | n/a | n/a |
| 2 | 4a58671 | e2e on main code: 1 failed (the internal service got 4 connections; requests included `GET /latest/meta-data/iam/security-credentials/case.htm`, `/case/admin.htm`, `/case/decimal.htm`). Unit file: collection error, `No module named 'scraper.net'`. Guard file: 4 failed, 28 passed (the scan lists 31 raw-client and `follow_redirects=True` sites on main). | (see 3-4) |
| 3-4 | cb9a85e | as task 2 | e2e 1 passed; unit 139 passed; guard 32 passed; `test_f20_harvesters_db.py` 3 passed |
| 5 | (docs commit) | n/a | full suite 393 passed, 3 warnings, 131 subtests (main baseline 1f0cc27: 221 passed, the same 3 warnings); G-0 static PASSED; gitleaks 8.30.1 on `origin/main..HEAD`: no leaks; claim gate PASS (PR body) |

**RED reproduced with the final tests.** The four F25 test files at cb9a85e, copied onto a `git archive` export of main 1f0cc27, give the same RED: e2e 1 failed (4 connections, 3 parsed requests: the metadata path, `/case/admin.htm`, `/case/decimal.htm`; the 4th connection is the https link to the internal port, a TLS handshake against a plain-HTTP server); unit file `No module named 'scraper.net'`; guard 4 failed, 28 passed.

**Mutation check** (a scratch copy; each mutation alone, unit file + e2e, 140 tests). Each layer is load-bearing:

| Mutation | Result |
|---|---|
| backend admits every resolved address | 5 failed |
| transport skips its URL check | 1 failed |
| `get` does not re-check redirect hops | 2 failed |
| IP-literal check removed | 13 failed |
| test hooks accepted in production | 9 failed |
| backend connects to the hostname instead of the vetted IP | 3 failed |
| URL policy and address check both off | 54 failed; the e2e reports the internal service reached (4 connections, metadata path included) |

**Changed expectations** (spec section 4):
- `tests/test_f20_harvesters_db.py`: the offline harness substitutes `fetch_policy.fetcher_for` instead of `httpx.AsyncClient`. Assertions unchanged.
- `tests/test_f25_fetch_policy.py::test_the_transport_checks_requests_that_bypass_the_helper` (a defect in the RED commit): its resolver sent the allowlisted `localhost` to a real public IP, so the request timed out on the internet instead of reaching the check. It now answers loopback. Assertions unchanged.

**Not run:** `npm run test:unit` (no TypeScript touched).
