# FA-D3C-001 / FA-D3C-002 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the corpus runtime installs no headless browser, and every paid embedding call from `corpus_service` goes through P1 (kill switch, reservation and settlement, P1 ledger row, provider policy, outbound mask), with a guard against either returning.

**Architecture:** see the spec, `docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-boundary-design.md` (rulings R1-R18). The Functions side gets `callP1Embedding` (P1 pipeline on gateway.ts's shared ledger code), an embedding transport, an OIDC service-caller verifier and the `p1CorpusEmbedding` HTTP function. The corpus side gets `scraper/p1_client.py` and a P1 fetcher in the F25 boundary; `embeddings.py` changes only at the provider-call seam.

**Tech stack:** TypeScript (Functions, vitest, Firestore emulator, Functions emulator), Python 3.12 (corpus, pytest, real PostgreSQL 16 + pgvector), the G-0 Python guards.

## Global constraints

- Lane: `corpus_service/requirements*.txt`, `Dockerfile`, `docker-compose.yml`, `scraper/config.py`, `scraper/tasks/embeddings.py` (seam only), `scraper/p1_client.py`, `scraper/net/fetch_policy.py` (one P1 factory, additive), corpus tests; `functions/src/p1/**` (additive), `functions/src/index.ts` (one export), `infra/deploy-manifest.json`, `ci_gates/`, docs.
- Not touched: F45-F48, `scraper/tasks/pakistancode.py`, `functions/src/health.ts`, `firestore.rules`.
- Never skip or weaken a test; a changed expectation is listed in the PR body with its reason.
- No `npm ci` / `npm install`; vitest with `--no-cache`; private ports (PG 55611; emulators firestore 8997, auth 9997, hub 4991, logging 4993, websocket 8998, functions 5397).

## Tasks

### Task 1: spec and plan
- [x] Spec with rulings R1-R18, adversarial check, residuals.
- [x] This plan.

### Task 2: FA-D3C-001 (R1-R3)
- [x] RED: `corpus_service/tests/test_fa_d3c_runtime_boundary.py` (browser half) fails on main.
- [x] Remove `playwright` (requirements.txt), the Chromium install (Dockerfile), `PLAYWRIGHT_*` and `PlaywrightTimeoutError` (config.py); update the comments that name them (requirements-test.txt, tests/e2e/Dockerfile, README source policy).
- [x] Empty `fa_d3c_001_scraper` in `ci_gates/g0_guard_allowlist.json`.
- [x] GREEN: T1 browser half, G-0 [2], F31 import contract.

### Task 3: Functions side of FA-D3C-002 (R5, R9-R12)
- [x] RED: T5 `fa-d3c-service-auth.test.ts`, T6 `fa-d3c-embedding-transport.test.ts`, T7 `fa-d3c-embedding.emu.test.ts` fail (no modules).
- [x] gateway.ts: export `reserve`, `markAttempt`, `recordAttemptOutcomeRetrying`, `commit`; optional output ceiling on `reserve`; `LedgerTaskType` in types.ts.
- [x] costTable.ts: `openai/text-embedding-3-small` price entry.
- [x] `serviceAuth.ts`, `embeddingTransport.ts`, `embedding.ts`, `corpusEmbedding.ts`; export `p1CorpusEmbedding` from index.ts.
- [x] Deploy manifest entry, alert policies for new ERROR lines, terraform re-render; pinned export lists in tests.
- [x] GREEN: T5-T7; P1 suites; typecheck; eslint; G-1, G-2, deploy-contract gate.

### Task 4: corpus side of FA-D3C-002 (R13-R16)
- [x] RED: T4 `test_fa_d3c_p1_client.py`, T1 provider half.
- [x] `fetch_policy.p1_fetcher`; `scraper/p1_client.py`; config `P1_EMBEDDING_URL`, `P1_ID_TOKEN_FILE`; delete `OPENAI_API_KEY`.
- [x] `embeddings.py` seam: client from `p1_client`, `operation_id=op`, `P1Refused` handling (`_refused`), skip reason.
- [x] requirements.txt without `openai`; F31 alias table; compose, `.env.example`, `app.env`, `tests/e2e/lib.sh`.
- [x] Empty `fa_d3c_002_provider`; drop the corpus exemption in `check_next_ai_egress.py`; flip its test row.
- [x] F27/F28 stand-ins move to the seam.
- [x] GREEN: T1, T4, the corpus suite, F27/F28, F31 import contract, runtime smoke.

### Task 5: end-to-end (R17)
- [x] Harness entry `functions/test/harness/fa-d3c-p1-emulator-entry.ts`; runner `corpus_service/tests/e2e/p1_embedding_e2e.sh`; test `test_fa_d3c_p1_embedding_e2e.py`.
- [x] RED on main's corpus code with the tripwire; GREEN on the branch.
- [x] CI job modelled on `authority-f05`.

### Task 6: mutation, gates, PR body
- [x] At least 10 mutants on the added logic; record killed or survived.
- [x] G-0, G-1, G-2, deploy contract, claim gate on the PR body, gitleaks.

## RED/GREEN ledger

Filled in as each test runs. Counts are exact; NOT RUN means not run.

| Test | RED (main) | GREEN (branch) |
|---|---|---|
| T1 corpus runtime boundary guard | 10 failed, 7 passed (main's tree) | 17 passed |
| T2 G-0 [2]/[3] empty allowlists | FAIL on main's tree: [2] Dockerfile Playwright install, requirements `playwright`; [3] requirements `openai`, `embeddings.py` imports `openai` | G-0 PASSED |
| T3 G-0 [19] corpus row | 3 failed, 1 passed (main's gate) | 260 passed (f18 gate + G-0 guard test files) |
| T4 P1 client unit | collection error on main (`scraper.p1_client` absent) | 59 passed |
| T5 service auth unit | module load failure (no `serviceAuth.ts`) | 46 passed |
| T6 embedding transport unit | module load failure (no `embeddingTransport.ts`) | 21 passed |
| T7 callP1Embedding + handler (emulator) | module load failure (no `embedding.ts` / `corpusEmbedding.ts`) | 38 passed |
| T7b seam on real PG (`test_fa_d3c_embedding_seam_db.py`) | 5 failed (4 ImportError `scraper.p1_client`, 1 no `P1_EMBEDDING_URL`) | 5 passed |
| T7c reconciled row keeps caller and corpus operation id (Codex P2 on PR #118, emulator) | 2 failed, 39 passed (the two new propagation tests; the chat-row control passes before and after) | 41 passed |
| T8 e2e corpus to P1 (Functions emulator, real PG) | 5 failed by assertion: the tripwire received the direct `/v1/embeddings` requests with the corpus key; nothing reached P1 | 5 passed |

Neighbours on the branch: full corpus suite 1449 passed, 5 skipped (the T8 e2e, run in its own job), 157 subtests (main: 1370 passed); then 2 rows added to T4 for mutant M23 (59 passed). F27/F28/F21 suites 313 passed. Functions P1 and export-pin suites 366 passed; f09/f15/f16/f17 neighbours 222 passed; G-1 10 passed; G-2 PASS (438 tested, 0 allowed); F31 runtime smoke all checks passed. Mutants: 25 of 25 killed (M7 and M23 survived first; a test was added for each and both were then killed).

Codex P2 on PR #118 (thread 4367413145): an embedding reservation now carries `caller` and `corpusOperationId`, and the lease reconciler copies them into the row it writes when the reservation holds them (a chat reservation has neither, so its row is unchanged). T7c above; mutants M26-M32 (drop either field from the reservation, drop either from the reconciled row, write a null caller on every row, take the caller from the actor, take the operation id from the trace id): 7 of 7 killed. Reconciler suites (f07-f08 35, f17-reconcile 6, f09-atomic-idempotency 43) and the P1, ledger, D3C and neighbour Functions suites: 786 passed in 26 files; T8 e2e 5 passed; D3C and F25 corpus suites 487 passed, 5 skipped (T8, run separately).

CI follow-up on PR #118 (Cloud Functions job at 2798794, `functions/test/http.test.ts:242`, 2643 passed, 1 failed): the U-1 pin expected the HTTP exports other than `health` to be exactly `["api"]`, and this branch's `p1CorpusEmbedding` made them `["api", "p1CorpusEmbedding"]`. Spec R18 rules on it: the function stays separate, because it is a service endpoint and not a P5 operation. The pin is tightened, not loosened:
- no export has a callable trigger;
- the HTTP exports are exactly `api` and `p1CorpusEmbedding`, by name;
- `api` keeps its 120 s timeout under the idempotency lease;
- `p1CorpusEmbedding` is IAM-private, has `ALLOW_ALL` ingress and its own 90 s timeout, matches its F32 manifest entry, and no `api` route serves it.

Mutants M33-M36 (public invoker, no pinned timeout, a further HTTP export, a public invoker in the manifest): 4 of 4 killed. This lane had not run `http.test.ts` before; the whole Functions suite has now been run the way CI runs it.
Whole Functions suite, the way CI runs it (vitest under Auth + Firestore emulators, private ports, CI=true), in two runs because the first stopped at its 60-minute limit on a loaded machine: run 1, 67 files, 2274 passed; run 2, the other 36 files, 370 passed and 1 skipped (f17-eval-live, a live-key test). Total 2644 passed, 1 skipped, 0 failed tests, across all 103 collected files. In run 1, `fa-d3c-embedding.emu.test.ts` was marked failed with all 41 of its tests passing: a file-level error, whose detail was lost when the run stopped before its summary. Run alone, the file passed, 41 of 41 in 22.5 s.
