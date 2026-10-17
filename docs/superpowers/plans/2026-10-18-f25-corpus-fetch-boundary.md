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
- [ ] Run the e2e against main's code. **Expected: FAIL**, because the internal service receives requests (the metadata path among them) and the canary is staged.
- [ ] Run the unit and guard files against main. **Expected: FAIL**: `fetch_policy` is missing, and the guard lists every raw client on main.
- [ ] Save the output as `f25-red-*.log`, record the counts in the ledger, and commit the tests.

### Task 3: The boundary module
- [ ] Create `corpus_service/scraper/net/__init__.py` and `fetch_policy.py` (spec section 3): `FetchPolicy`, `SOURCE_POLICIES`, `_GuardedBackend`, `_GuardedTransport`, `PolicyFetcher`, `SyncPolicyFetcher`, `fetcher_for`, `sync_fetcher_for`, and refusal logging with userinfo redaction.
- [ ] Run the unit file. **Expected:** the policy, address, backend and fetcher classes pass.

### Task 4: Adoption
- [ ] Route the connectors through `fetch_policy.fetcher_for(<policy>)`: nasirlawsite (with `allows` and `urljoin`), nationalassembly, pakistancode, shc, supremecourt, lahorehighcourt, peshawarhighcourt, balochistanhighcourt and islamabadhighcourt. The retry helpers re-raise `FetchRefused`, and IHC's POST goes through `fetcher.post`.
- [ ] Route `bootstrap_harvest.py` through `sync_fetcher_for`, per source, with the policy checked before `robots.txt`.
- [ ] `pdf_extractor`: drop the forced redirects, and stop `download_pdf_sync` from building its own client.
- [ ] `tests/test_f20_harvesters_db.py`: the offline harness substitutes `fetch_policy.fetcher_for` instead of `httpx.AsyncClient` (a changed expectation, listed in the ledger).
- [ ] Run the e2e, the unit file and the guard. **Expected: PASS.**

### Task 5: Verification
- [ ] The full `corpus_service` pytest suite, as CI runs it (real Postgres, `CI=1`).
- [ ] G-0: `BASE=origin/main bash ci_gates/gate_g0.sh` (it scans the full tree, including corpus_service).
- [ ] gitleaks on the branch commits, if the binary is available locally.
- [ ] Claim gate: `ci_gates/check_pr_phase_claims.py` with the PR body. **Expected: PASS.**
- [ ] Commit, push `claude/remediate-f25`, and write the PR body to the scratchpad. The PR is not opened here.

---

## Ledger

| Task | Commit | RED (each new test seen failing first) | GREEN |
|---|---|---|---|
| 1 | (spec and plan commit) | n/a | n/a |
| 2 to 4 | see the PR body | see below | see below |

The RED and GREEN evidence, with exact commands and counts, is filled in below once each run is made.
