# FA-D5-003 / FA-D2WA-001 / FA-DATA-003: implementation plan

Spec: `docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md` (rulings R1-R18).
Branch `claude/remediate-fa-d5-003` from `origin/main` @ 133a346, merged with `origin/main` @ 3c8ccb9 (FA-D3C #118, F34
#121, F32 #122) before the last push. Test-first: every new test ran on main first (RED), then on the branch (GREEN).
Private resources: Postgres 16 + pgvector on 127.0.0.1:55651 (data under `/tmp/fa-d5-003-pg`, dropped at the end);
emulators firestore 8097, auth 9097, hub 4091, logging 4093, websocket 8098, UI off, project `demo-fa-d5-003`.

## Tasks

- [x] 1. Spec and plan (this file).
- [x] 2. RED tests, committed before any production code (2f66405, b0b43d2):
  - `tests/fa-d5-003.research-corpus.e2e.firestore.test.ts` (route, emulators, real Postgres, F19 CLI seed);
  - `tests/fa-d5-003.corpus-grants.pg.test.ts` (grants, views, inventory, allowlist, caps, timeout);
  - `tests/fa-d5-003.research-source.test.ts` (selection, 503 mapping, multi-citation and verdict rules, F05 parity);
  - PG-DDL-33 in `tests/postgres.ddl.integration.test.ts`;
  - fixture `tests/fixtures/corpus/curated-batch.fa-d5-003.json`, helper `tests/helpers/fa-d5-003-corpus.ts`;
  - npm script `test:fa-d5-003` and the vitest exclusions.
- [x] 3. 005 migration (R2-R5) and its harness wiring (`apply-annex-a.sh`, provisioning, corpus_service conftest, the F05
  harness list, the CI DDL loop, the compose e2e expectations).
- [x] 4. Search core refactor (R6, R8): `prepareResearchQuery`, `parseResearchEmbedding`, `rankResearchCorpus`,
  `searchResearch`; `searchCorpus` unchanged in behaviour (the #69 suites pass unchanged).
- [x] 5. Source seam (R10, R13, R14) and the Postgres adapter (R7, R9, R11, R12).
- [x] 6. Route seam (R10, R14) and test selection (R15).
- [x] 7. Manifest and F32 contract (R13); F18 pure-module list (R18); `pg` to dependencies (R16).
- [x] 8. Docs: corpus_service README (login), F05 README, architecture README, release runbook step 7.
- [x] 9. GREEN runs, mutation (20 mutants), gates, PR body, evidence log.

## RED/GREEN ledger

Final test versions; RED is main's production code (`origin/main` @ 3c8ccb9) under those tests. Raw output in the
evidence log.

| Suite | Main (RED) | Branch (GREEN) |
|---|---|---|
| e2e through `POST /api/d2/court-ops` (emulators + Postgres) | 11 failed, 3 passed (14) | 14 passed |
| Postgres: grants, views, reader | 13 failed, 3 passed (16) | 16 passed |
| Unit: research seam | 26 failed, 2 passed (28) | 28 passed |
| PG-DDL-33 (FA-DATA-003) | 1 failed | passed (PG-DDL 35 of 35) |

The tests that pass on main are guards whose answer does not change: the fixture precondition, a query that matches
nothing (200 `[]`), P5 before the corpus (403), G-0's `corpus_reader` views, the F05 gate role unchanged, the research
login reading nothing else, an explicitly selected in-memory store, and a client's 403.

## Mutation

20 mutants on the promoted-only filter, the grants, the role allowlist, the `corpus_unavailable` path, the row cap, the
timeout and the ranking hand-off: 20 killed by their suites. Eight re-run against the e2e alone: 7 killed; the
FA-DATA-003 revoke (a grant, not a route answer) is killed by the Postgres suite and PG-DDL-33 only.
