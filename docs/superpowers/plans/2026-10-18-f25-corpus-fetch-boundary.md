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

---

## Re-audit round (FAIL 7/10)

**Branch:** `claude/remediate-f25-r2`, from origin/main 04d388f (#65 merged). **Spec:** section 6, rulings R17-R22.

### Task R1: RED for every re-audit finding
- [x] `tests/test_f25_reaudit.py`:
  - MEDIUM bombs (stacked, unsupported, single coding at a small cap and at the production cap), each with a tracemalloc peak bound;
  - trailing and truncated gzip;
  - a chunked body over the cap; a declared length over the cap;
  - LOW 4 memory; LOW 3 malformed redirects, through a real court helper;
  - LOW 5 backend hooks; LOW 7 pdf_writer; LOW 8 upgrade;
  - mutant killers (M07, M09, M16, M25, M31, M32, M35, M43, M45).
- [x] `tests/test_f25_fetch_guard.py`: the 20 probe forms plus further bypass forms (positive) and real-code negatives.
- [x] `tests/test_f25_fetch_boundary_e2e.py`: `except ImportError` (LOW 6).
- [x] Commit 6a23472 (RED), pushed.

### Task R2: GREEN
- [x] `fetch_policy.py`:
  - `_BoundedDecoder`, raw reads, the coding policy and forced `Accept-Encoding: gzip` (R17);
  - `_hold_location` and conversion of httpx URL errors (R18);
  - a single-copy body and lazy `text` (R19);
  - gated backend hooks (R20);
  - read-only `SOURCE_POLICIES` (R21);
  - `upgrade_http` (R22).
- [x] Guard scanner rewrite (R21); `pdf_writer` escaping (LOW 7).
- [x] Commit 5a9d4ea, pushed. Then 834d453 (RED) and d434a9e (GREEN): the guard also refuses `exec`/`eval`/`compile`, `sys.modules`, `__builtins__`, ctypes and cffi. Then 7cc0cc2: tests for the three round-2 mutants that survived the first mutation run.

### Task R3: verification and docs
- [x] Full suite, G-0, gitleaks, the auditor's bomb cases and probe file, the mutation re-run.
- [x] Spec section 6, this ledger, the PR body, the claim gate.

### Round-2 ledger

All runs as above (private PG16 + pgvector at 127.0.0.1:55441, Annex A applied, `CI=1`, proxies unset).

| Command (`python -m pytest … -q`) | RED (main 04d388f code) | GREEN |
|---|---|---|
| `corpus_service/tests/test_f25_reaudit.py` | 92 failed, 13 passed (the 13 are the mutant killers, which pass on correct code by design) | 105 passed at 5a9d4ea; 111 passed at 7cc0cc2 (6 mutant killers added) |
| `corpus_service/tests/test_f25_fetch_guard.py` | 38 failed, 43 passed (the PR #65 scanner catches only the probe's p18 control); then 7 failed, 82 passed for the exec/eval/ctypes controls (834d453) | 89 passed (d434a9e) |
| `corpus_service/tests/test_f25_fetch_policy.py` | 139 passed (one changed expectation, R18) | 139 passed |
| `corpus_service/tests/test_f25_fetch_boundary_e2e.py` | the pre-F25 tree with a leftover `scraper/net/__pycache__`: main's fallback is a collection `ImportError`; the new one reaches the RED assertion (the internal service reached) | 1 passed |
| `corpus_service/tests/test_f20_harvesters_db.py` | 3 passed | 3 passed |
| `corpus_service/tests` (full suite) | 393 passed | 561 passed, 3 warnings, 131 subtests (7cc0cc2) |

**Memory, measured.**

| Case | Main 04d388f | This branch |
|---|---|---|
| stacked bomb (< 8 KB), tracemalloc peak | 557.7 MiB | 1.8 MiB |
| single gzip bomb, 2 MiB cap | 45.5 MiB | 2.5 MiB |
| gzip of 256 MiB, production cap (100 MiB) | 142 MiB | 104.4 MiB |
| 24 MiB in-cap body | 48.2 MiB | 26.6 MiB |

The auditor's `bomb_case.py` (process RSS), against this branch:

| Case | Re-audit (main) | This branch |
|---|---|---|
| stacked `gzip, gzip` / `gzip, gzip, gzip` / `deflate, deflate`, `br` | about 2,093 MiB | refused before decoding, about 45 MiB |
| gzip aimed at 1 GiB / 3 GiB | MemoryError at 3 GiB | refused at the cap, 146 / 148 MiB |
| 99 MiB in-cap body | about 477 MiB | about 102 MiB for the fetch (242 MiB peak, 140 MiB before it) |
| gztrail, endless chunked | — | refused (`content_encoding_refused`; `too_large` on the wire) |

**Mutation re-run** (scratch exports, never the worktree; the F25 files and F20 as the suite; helper `f25r2-mutate.py` reads the re-audit's `mutate.py` without editing it):
- **The re-audit's 47:** 43 killed (the re-audit: 34). M06, M14, M17 and M30 survive and are equivalent (spec section 6).
- **17 new mutants (N01–N17):** all killed. N04 (data after the stream end), N08 (httpx URL errors not converted) and N15 (wire cap off) survived the first run against 5a9d4ea and are killed against 7cc0cc2.
- **Killed now, having survived the re-audit:** M07, M09, M16, M25, M31, M32, M35, M43, M45.
- **G-0** static: PASSED. **gitleaks 8.30.1** on `origin/main..HEAD`: no leaks. **Claim gate:** PASS (see the PR body).

**Review round (Codex P2 + Copilot ×3), spec section 6:**

| Thread | RED | GREEN | Fix |
|---|---|---|---|
| Codex 4305386005 and Copilot 4305395619 | 245a08e: 5 failed | 84b5ddb | raw deflate decided on its first two bytes, prefix replayed |
| Copilot 4305395602 | 9a13709: 12 failed | fcee71a | hooks gated by identity; `upgrade_http` must be a bool |
| Copilot 4305395582 | 9a13709: 10 failed | 9331dba | the guard checks calls in annotations, defaults and string annotations |

At 9331dba: `test_f25_reaudit.py` 150 passed, `test_f25_fetch_guard.py` 105, `test_f25_fetch_policy.py` 139, e2e 1, F20 3; full suite 616 passed, 3 warnings; G-0 PASSED.

