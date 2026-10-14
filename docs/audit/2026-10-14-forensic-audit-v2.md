# SIKANDER AI — §1A Forensic Audit of `main` — v2 (full local)
Auditor: Legal OS Master Engineer (read-only on GitHub). 14 Oct 2026, 05:51–06:45 PKT.
Commit: **0f72cd8fa8ec8fde352c42e0fc8e80ac0a4f04d7** (2026-10-14 04:46 PKT, merge of PR #33 "remediate-f03"). v1 audited 0c06854 through the connector only; v2 is a local clone run.
Environment: Node 20.19.2 / npm 9.2.0 (Node 22.23.3 portable for Stryker), portable Temurin JRE 21 for Firebase emulators, Python 3.13 venv, embedded PostgreSQL 16 (npm embedded-postgres; no pgvector). Logs: /workspace/audit/logs/.

## 1. Commands and real results
| Command | Result |
|---|---|
| `npm ci` | exit 0 (35 audit findings) |
| `npm --prefix functions ci` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0, 0 errors / 79 warnings |
| `npm run build` (next build) | exit 0 |
| `npx vitest run` (unit) | **154 files / 3151 tests passed** |
| `npm run test:rules` (Firestore emulator) | **8 files / 614 tests passed** |
| `npm run functions:build`, functions typecheck | exit 0 / exit 0 |
| `npm --prefix functions run test:emu` (Auth+Firestore emulators) | **exit 1: 56/58 files, 1424/1426 tests; 2 failed** — p2.jobs-scheduled.emu (15 s timeout), p5.mfa concurrency (expected 30, got 2). Re-run of the two files alone: 51/51 pass → load-dependent (FA-P5-001) |
| `npm run gate:g0` | PASS (41 PASS lines) — but blind, see FA-CI-001 probe |
| `npm run gate:g1` | PASS, 10/10 (in-memory; see FA-CI-002) |
| `npm run gate:g2` | PASS, 138 + 8 tests |
| gate:g3 | **does not exist** (no script, no ci_gates file) |
| gate:g4 phase2a … phase4a | 7/7 PASS (§1a) |
| `pytest corpus_service/tests -q` (requirements-test.txt) | 33 passed, 8 subtests |
| `npx stryker run --mutate uploadDocument.ts,documentObjectStore.ts,providerPolicy.ts,checkPermission.ts` (Node 22, 14 min) | **65.95 % overall, exit 1 (break threshold)**: providerPolicy 100.00; checkPermission 86.84; documentObjectStore 57.65 (54 survived, 29 no-cov); uploadDocument 50.00 (52 survived, 18 no-cov). D4 gate (functions-side Stryker with emulator sets) NOT RUN — time |
| `npm audit` / `--omit=dev` | 35 (3 critical, 20 high, 12 moderate) / 2 moderate |
| Probe: Postgres DDL 001 applied to real PG16 + bypass | see FA-DATA-001 (runtime-proven) |
| Probe: G-0 with `import OpenAI`+`playwright` in app/ and functions/ | G-0 PASSED → FA-CI-001 runtime-proven |
| Probe: F06 / F15 via vitest | reproduced (ledger table) |

### 1a. Gate G-4
All seven PASS (exit 0): `npm run gate:g4:phase2a`, `phase2b-a`, `phase3a`, `phase3b`, `phase3c`, `phase3d`, `phase4a` (run 06:33–07:05 PKT; logs/a_g4_*.log). These are phase-close gates over the same emulator suites, not proof of production behaviour (F01).


## 2. OR-1..OR-4 full-tree greps (rg, excluding node_modules)
- OR-1 SMS: no SMS provider code; hits only in architecture text and a Firebase-emulator comment. PASS.
- OR-3 court fee: identifiers only in gate_g0.sh and architecture text. PASS.
- OR-4 scraper: `corpus_service/requirements.txt:11 playwright`, `corpus_service/Dockerfile:5 playwright install chromium`, `scraper/config.py:129-131 PLAYWRIGHT_ENABLED=True`. Architecture Layer 18 W-6 (v19 txt ~L7929-7932): "The corpus service is a separate repository (Layer 17 L17.12)". FAIL.
- Provider SDKs outside P1: `corpus_service/scraper/tasks/embeddings.py:14-15`. FAIL. (`@ai-sdk/provider` types in platform/p1 = allowed.)
- corpus_service imports from TS: none. PASS.
- firestore.rules: 239 match blocks, catch-all deny `firestore.rules:500`; 614 rules tests green.

## 3. Scorecard (§1A.7, one decimal, never rounded up)
| # | Service | Score | Basis |
|---|---|---|---|
| 1 | P1 Committee Brain (+P3 Opik) | 4.0 | F07,F08,F09,F15(rt),F16,F17,F18,F34 open; providerPolicy mutation 100% |
| 2 | P2 Job Engine | 3.5 | F04,F14 HIGH; F35,F36 MEDIUM |
| 3 | P4 Notification Centre | 1.5 | intimation.ts only; F43 |
| 4 | P5 Identity/Tenancy/Privilege | 3.5 | F01,F02,F12,F13 HIGH; checkPermission mutation 86.8%; FA-P5-001 |
| 5 | P6 Master Knowledge | 1.5 | proposeChange.ts only |
| 6 | D1 Firm/Client/Matter | 4.0 | F13,F37,F38 HIGH |
| 7 | D1 Evidence & Documents (d1-6) | 3.0 | F03 PARTIAL; FA-D16-001/002 HIGH; F04 (cap 5) |
| 8 | D1 Document workflow (d1-7) | 3.5 | F11 |
| 9 | D1 Limitation & Deadlines | 0.0 | no service |
| 10 | D1 Client Reporting | 2.5 | F01 blocks persistence |
| 11 | D2 WhatsApp (d2-1) | 1.5 | FA-D2WA-001 constant stub |
| 12 | D2 Email / Voice / Translation | 0.5 | translate.ts only |
| 13 | D3 Ingestion / OCR | 1.5 | no OCR consumer (F04) |
| 14 | D3 Corpus Service | 1.0 | F30 CRITICAL partial (cap 2); F19-F29,F31; FA-D3C-001/002 |
| 15 | D4 Drafts / Ghost Writer | 4.0 | F05,F06(rt) |
| 16 | D4 Citation-Safety Gate | 4.0 | empty adapter in prod |
| 17 | D4 159-Type Generator | 1.0 | seed + guard only |
| 18 | D4 Filings (d4-3) | 2.5 | frozen E-24 chains, 19,051-line route (F41) |
| 19 | D5 Research (d5-1) | 1.0 | FA-D5-001 |
| 20 | D6 Court Ops & Roster | 2.5 | FA-D2CO-001/002 |
| 21 | D7 Trial & Case Strategy | 0.0 | no code |
| 22 | Data layer (rules + DDL) | 3.5 | rules 614/614 pass, default deny :500; FA-DATA-001 runtime-proven |
| 23 | CI gates & supply chain | 3.5 | FA-CI-001 runtime-proven, FA-CI-002; F40 reproduced |
**Overall: 2.3 / 10 (mean 2.3; cap 3.0 — open CRITICAL F30). FAIL. Gap to 7.0: 4.7.**

## 4. 48-finding ledger, re-tested individually at 0f72cd8
Corpus-side items whose evidence files show an empty `git diff e7e18e6 HEAD` are OPEN because the audited code is unchanged.
| ID | Sev | Status | Evidence |
|---|---|---|---|
| F01 | HIGH | OPEN | platform/persistence/runtimeRepositories.ts:50-58 — firestore mode throws unless test-injected DB; "Production Firestore persistence … not wired yet" |
| F02 | HIGH | OPEN | app/foundation-console.tsx:119,153 fetch with no Authorization/X-Firm-Id; app/ops/operator-audit-console.tsx:209+ body actorId |
| F03 | CRITICAL | PARTIAL (residual HIGH) | PR #33: bytes now AES-256-GCM encrypted + round-trip verified (platform/documents/documentObjectStore.ts:181-202); backend is local fs:// (:9,147-158), not R2; durability/backup unproven → FA-D16-001 |
| F04 | HIGH | OPEN | functions/src/p2/registry.ts:51-57 (diagnostic, unmerge×2, autoConfirm only); services/d1-6/uploadDocument.ts:108 still writes jobType "ocr" with no consumer |
| F05 | HIGH | OPEN | functions/src/d4/authority.ts:101-102 `testStore ?? EMPTY_AUTHORITY_STORE`; used at gateOps.ts:534,740 |
| F06 | HIGH | OPEN — runtime reproduced | runGate("Limitation … thirty days", [], EMPTY) → {"status":"OK","citations":[],"temporal":[]}; functions/src/d4/gate.ts:65 |
| F07 | HIGH | OPEN | functions/src/p1/gateway.ts:185 `spentOf(...) >= budget` pre-call read, no reservation |
| F08 | HIGH | OPEN | functions/src/p1/gateway.ts:292 logs p1.usage_log_failed and returns result |
| F09 | HIGH | OPEN | functions/src/http/idempotency.ts:179-208 settle/release in a separate transaction after the effect |
| F10 | HIGH | OPEN | platform/http/idempotency.ts:31 ("Still process-local"), :97 `new Map` |
| F11 | HIGH | OPEN | platform/http/withSession.ts:263 flushRequestAudit after handler commit; no outbox |
| F12 | HIGH | OPEN | platform/persistence/firestoreSpineRepositories.ts:215-224 getDocs(collection()) + JS firmId filter; 122 full-collection getDocs, 0 query() in file |
| F13 | HIGH | OPEN | functions/src/d1/matter/ops.ts:292-298 (matterNo/stage/optional courtId) vs firestoreSpineRepositories.ts:198,212,222 blind `as T` casts |
| F14 | HIGH | OPEN | functions/src/p2/view.ts:27-28 compares clearance to stored job.classification only; no current-matter read |
| F15 | HIGH | OPEN — runtime reproduced | maskOutboundPII("CNIC ４２１０１-１２３４５６７-１ phone ۰۳۰۰۱۲۳۴۵۶۷") → 0 redactions; ASCII control → 2; maskOutboundPII.ts:28-36 ASCII \d, no normalisation |
| F16 | HIGH | OPEN | platform/p1/promptText.ts:9-20 system+user flattened to one string |
| F17 | HIGH | OPEN | functions/src/p1/transport.ts — no output schema/grounding (grep empty) |
| F18 | HIGH | OPEN | platform/p1/gatewayTransport.ts:19-34 generateText live when AI_GATEWAY_API_KEY set; no callP1 |
| F19 | HIGH | OPEN | corpus_service/scraper/models.py:198 case_law_master, :286 is_promoted boolean; no Annex A ETL |
| F20 | HIGH | OPEN | models.py:167 trust_level default 'trusted'; promotion.py:23 missing source → "trusted"; :24 checks "blocked", not in vocabulary (:128) |
| F21 | HIGH | OPEN | promote_staging_records (promotion.py:7) has no caller (rg) |
| F22 | MEDIUM | OPEN | promotion.py:15 `sel` imported only inside citation branch, used unconditionally :21 |
| F23 | HIGH | OPEN | quarantine.py unchanged since e7e18e6 (git diff empty) |
| F24 | HIGH | OPEN | routers/search.py, export.py unchanged since e7e18e6 |
| F25 | HIGH | OPEN | tasks/nasirlawsite.py unchanged since e7e18e6 |
| F26 | HIGH | OPEN | lahorehighcourt.py / pdf_extractor.py unchanged |
| F27 | HIGH | OPEN | embeddings.py unchanged (no SKIP LOCKED/lease) |
| F28 | HIGH | OPEN | dispatcher.py / pakistancode.py / embeddings.py unchanged |
| F29 | MEDIUM | OPEN | main.py / harvester.py / dispatcher.py unchanged |
| F30 | CRITICAL | PARTIAL (still CRITICAL-open) | docker-compose.yml: no published ports (:82,:94), required creds (:71-72), internal net (:99) ✔; no TLS (no ssl/sslmode in compose or config.py), no least-privilege app role |
| F31 | HIGH | OPEN | models.py:58 `from pgvector.sqlalchemy import Vector`; requirements.txt lacks pgvector |
| F32 | HIGH | OPEN | deployConfig.ts / firebase.json unchanged; no IaC manifest |
| F33 | HIGH | OPEN | no backup/restore drill; documentObjectStore.ts:215-236 file-copy helpers only |
| F34 | HIGH | OPEN | opik.ts / gateway.ts / committeeBrainModel.ts unchanged |
| F35 | MEDIUM | OPEN | functions/src/p2/worker.ts:243 setTimeout race; :45 "AbortSignal … is the later fix" |
| F36 | MEDIUM | OPEN | functions/src/p2/fanout.ts:34 `SUBSCRIBERS = []` |
| F37 | HIGH | OPEN | functions/src/d1/conflict/engine.ts:113-118 loadRegistry reads every firm client/matter/party/link |
| F38 | HIGH | OPEN | functions/src/d1/entity/autoConfirmJob.ts:201-202 orderBy(createdAt).limit fixed window |
| F39 | HIGH | NOT REPRODUCED | `npm ci` exit 0 locally (npm 9.2.0/Node 20) and in CI; not closed (no fix PR, rule 2) |
| F40 | MEDIUM | OPEN — reproduced | `npm audit`: 35 (3 critical, 20 high, 12 moderate); `--omit=dev`: 2 moderate |
| F41 | MEDIUM | OPEN | ops-reporting route 33,127 lines; filings 19,051; operator console 7,352 |
| F42 | HIGH | OPEN | no retention/deletion protocol; 002_platform.sql:13 TODO O-8 |
| F43 | HIGH | OPEN | alerts remain log lines (gateway.ts:294 logger.warn) |
| F44 | MEDIUM | OPEN | functions/src/health.ts:15 constant 200 {status:"ok"} |
| F45 | MEDIUM | OPEN | embeddings.py:26 full_text[:2000] |
| F46 | MEDIUM | OPEN | requirements.txt unpinned; Dockerfile:5 `playwright install` |
| F47 | MEDIUM | OPEN | auth.py / routers unchanged (single admin key) |
| F48 | MEDIUM | OPEN | eve needs Node ≥24; CI/Functions Node 22; Stryker refuses Node 20 (local) |

Tally: CLOSED 0 · PARTIAL 2 (F03, F30) · NOT REPRODUCED 1 (F39) · OPEN 45. Issue #30 ticks F03 as "fixed #33" before any independent re-audit (REMEDIATION.md rule 3) — FA-OPS-002.

## 5. Defect records
### Carried from v1 (re-verified at 0f72cd8, lines unchanged)
FA-CI-001 HIGH `ci_gates/gate_g0.sh:7` APP_DIRS omits app, functions, lib, components, corpus_service — **now runtime-proven**: adding `import OpenAI from "openai"` + `import { chromium } from "playwright"` to app/api/probe/route.ts and functions/src/probe.ts (scratch worktree) → `[2] PASS`, `[3] PASS`, "Gate G-0 PASSED".
FA-D3C-001 HIGH `corpus_service/requirements.txt:11` Playwright in app repo (OR-4, L17.12).
FA-D3C-002 HIGH `corpus_service/scraper/tasks/embeddings.py:14-15` direct OpenAI outside P1.
FA-DATA-001 HIGH `postgres/ddl/001_corpus_contract.sql:48` — **runtime-proven** on PG16 (script /workspace/audit/probe_fa_data_001.mjs): role app_writer (UPDATE on judgment) plain downgrade privileged→public REJECTED; after `SET app.declassify_reason='anything'` DOWNGRADE ALLOWED, row now public. `declassify()` does not exist (pg_proc count 0) though the trigger message demands it.
FA-DATA-002 MEDIUM `:54` trigger on judgment only. FA-DATA-003 MEDIUM `:65,:69` unfiltered provenance and embeddings granted to corpus_reader.
FA-D2WA-001 HIGH `services/d2-1/whatsapp.ts:50-53` constant `research: []`. FA-D2WA-002 MEDIUM `:11-15` 3 of 8 commands.
FA-D5-001 HIGH `services/d5-1/research.ts:4-25` query-less, unranked, unbounded "search". FA-D5-002 LOW `:28-30`.
FA-D2CO-001 MEDIUM `services/d2-2/courtOps.ts:101-108`. FA-D2CO-002 LOW `:66`.
FA-OPS-001 MEDIUM autopilot ran at HEAD despite REMEDIATION.md rule 5. FA-DATA-004 LOW `002_platform.sql:13` O-8 TODO.

### New in v2
### FA-D16-001 — HIGH — F03 residual: document vault is the local filesystem, not R2
- Evidence: `platform/documents/documentObjectStore.ts:9` `STORAGE_SCHEME="fs://"`, `:147-158` writeFile to `SIKANDER_DOCUMENT_OBJECT_ROOT`; issue #30 itself: "R2 adapter still outstanding". Architecture data layer = Cloudflare R2.
- Failure: on Vercel/Cloud Run the disk is per-instance and ephemeral; a "verified" upload is lost on redeploy or is unreadable from another instance. No replication or backup (F33).
- Fix: R2 adapter (SigV4, O-2 live test), object-lock/versioning, read-after-write from a second instance, restore drill.
### FA-D16-002 — HIGH — F03 fix is weakly tested: integrity check and key validation have no test coverage
- Evidence: Stryker uploadDocument.ts 50.00 % (52 survived, 18 no-cov), documentObjectStore.ts 57.65 % (54 survived, 29 no-cov). NoCoverage mutants at `documentObjectStore.ts:112-113` (content-hash mismatch throw), `:47-49` (32-byte key check), `:93-94` (format-version check).
- Consequence: tamper/corruption detection, the core of the F03 claim, is never exercised; a regression removing it passes CI.
- Fix: tests for tampered ciphertext, wrong key, wrong version, hash mismatch; raise per-file break threshold.
### FA-D16-003 — LOW — Round-trip hash failure leaves the written object behind
- Evidence: `documentObjectStore.ts:190-191` assertExpectedHash throws before the delete at `:193`; outer rollback (uploadDocument.ts:116-117) only runs if storagePath was assigned — UNVERIFIED for this path.
### FA-CI-002 — HIGH — G-1 "trigger exception" test never touches Postgres; no test anywhere applies the DDL
- Evidence: `tests/gate_g1.test.ts:261-275` G1-8 runs on the in-memory SpineStore (`newStore()`, `uploadDocument`); `rg` finds no pg client, psql or postgres URL in tests/, functions/test/, ci_gates/. The real trigger is bypassable (FA-DATA-001) while G-1 reports PASS. CORRECTION_LOG.md:197 records the declassify bypass as fixed — true only for the TS store.
- Fix: a CI job applying 001/002 to PG16+pgvector and running trigger, grant and view tests as corpus_reader / writer roles.
### FA-P5-001 — MEDIUM — MFA attempt-cap invariant is load-dependent
- Evidence: full `test:emu` run: `functions/test/p5.mfa.test.ts:666` expected invalid+voided = 30, received 2 (28 responses outside the contract); same file alone passes. Plus `p2.jobs-scheduled.emu.test.ts:18` timeout.
- Consequence: under contention disableMfa returns undocumented outcomes; CI green is luck-of-load. Root cause UNVERIFIED (response codes not captured).
### FA-OPS-002 — MEDIUM — F03 marked fixed and PR merged against the stated process
- Evidence: PR #33 body "Do not merge (per owner instruction)" and flags `transport_stub: true`, `frontend_real: false`; PR merged as 0f72cd8; issue #30 box ticked "[x] F03 … fixed #33" with no independent re-audit (REMEDIATION.md rules 2-3).

Counts — new FA (v1+v2): HIGH 9 · MEDIUM 7 · LOW 4 (FA-D16-001 is F03's residual and replaces it in the totals).
Totals incl. ledger: **CRITICAL 1 (F30) · HIGH 44 · MEDIUM 18 · LOW 4**; F39 not reproduced.

## 6. Claims vs reality
1. README "No Playwright / Puppeteer in this repository" — false (requirements.txt:11, Dockerfile:5).
2. README "Provider SDKs only under platform/p1" — false (embeddings.py:14).
3. README "Corpus harvest is a separate repo" — corpus_service/ is in this repo.
4. gate_g0.sh "Every check FAILS the build" — G-0 passes with OpenAI + Playwright imports in app/ and functions/ (probe).
5. G-1 G1-8 "classification downgrade without declassify() → trigger exception" — tests a TS map, not the trigger; the real trigger is bypassable.
6. CORRECTION_LOG.md:197 "declassify bypass … now requires a partner actor" — TS only; Postgres bypass proven.
7. Issue #30 "F03 fixed #33" — partial: local fs, not R2; integrity path untested (Stryker).
8. PR #33 "Do not merge" — merged.
9. PR #33 "Verified locally … functions test:emu (1426)" — my full run: 1424/1426 (2 load-dependent failures).
10. REMEDIATION.md rule 5 autopilot disabled — still runs (v1).

## 7. Unverified
Functions-side Stryker (D4 gate, P1 gateway, P5 ops); pgvector/HNSW behaviour (embedded PG has no pgvector; lines 36-38 stubbed in probe); live Firebase/R2/provider paths; cause of FA-P5-001; Python runtime install of requirements.txt (Playwright/weasyprint) not attempted; deep reading of the 33k-line ops-reporting and 19k-line filings routes beyond flag gating (E-24 off by default) — F41 stands.

## 8. Top 5 fixes
1. F30 remainder (TLS, least-privilege role) — the only open CRITICAL and the score cap.
2. FA-CI-001 + FA-CI-002: full-tree G-0 guards; real Postgres DDL tests in CI. Then FA-DATA-001 (SECURITY DEFINER declassify()) and FA-D3C-001/002 (move corpus_service out or route via P1).
3. F03 to closure: R2 adapter + tests killing the integrity mutants (FA-D16-001/002) + independent re-audit before ticking.
4. F05/F06: real authority adapter over promoted Annex A views (needs F19) and NOT_ASSESSED for empty gates.
5. F01/F09/F10/F12: one durable persistence and idempotency path (Functions canonical), indexed firm-scoped queries; retire Next mutating routes.

## 9. Changes vs v1
- Local run replaced CI-reported numbers: unit 3151 (v1 CI 3139), rules 614, functions 1424/1426 (v1 CI 1426/1426 — 2 load-dependent failures found), Stryker run (v1 none).
- F03 CRITICAL → PARTIAL (bytes persisted, residual HIGH FA-D16-001/002). F39 not reproduced. Other 45 confirmed OPEN.
- FA-CI-001 and FA-DATA-001 moved from static to runtime-proven.
- New: FA-D16-001/002/003, FA-CI-002, FA-P5-001, FA-OPS-002. gate:g3 confirmed non-existent.
- Score 2.2 → 2.3 (D1-6 1.0→3.0, ingestion 1.0→1.5; data and CI 4.0→3.5). Still FAIL, still capped by F30.
