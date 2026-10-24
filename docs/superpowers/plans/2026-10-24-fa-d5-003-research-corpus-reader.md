# FA-D5-003 / FA-D2WA-001 / FA-DATA-003: implementation plan

Spec: `docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md` (rulings R1-R17).
Branch `claude/remediate-fa-d5-003` from `origin/main` @ 133a346. Test-first: every new test is run on main first (RED), then
on the branch (GREEN). Private resources: Postgres 16 + pgvector on 127.0.0.1:55651 (data under `/tmp/fa-d5-003-pg`, dropped at
the end); emulators firestore 8097, auth 9097, hub 4091, logging 4093, websocket 8098, functions 5697, UI off, project
`demo-fa-d5-003`.

## Tasks

- [ ] 1. Spec and plan (this file).
- [ ] 2. RED tests, committed before any production code:
  - `tests/fa-d5-003.research-corpus.e2e.firestore.test.ts` (route, emulators, real Postgres, F19 CLI seed);
  - `tests/fa-d5-003.corpus-grants.pg.test.ts` (grants, views, inventory, allowlist, caps, timeout);
  - `tests/fa-d5-003.research-source.test.ts` (selection, 503 mapping, multi-citation and verdict rules);
  - fixture `tests/fixtures/corpus/curated-batch.fa-d5-003.json`, helper `tests/helpers/fa-d5-003-corpus.ts`;
  - npm script `test:fa-d5-003` and the vitest exclusions.
  Run each on this commit (no production change yet): record the RED counts.
- [ ] 3. 005 migration (R2-R5) and its harness wiring (`apply-annex-a.sh`, provisioning, corpus_service conftest, the F05
  harness list, the CI DDL loop).
- [ ] 4. Search core refactor (R6, R8): `prepareResearchQuery`, `parseResearchEmbedding`, `rankResearchCorpus`,
  `searchResearch`; `searchCorpus` unchanged in behaviour. Run the #69 suites, G-1, spine hardening.
- [ ] 5. Source seam (R10, R13, R14) and the Postgres adapter (R7, R9, R11, R12).
- [ ] 6. Route seam (R10, R14) and test selection (R15).
- [ ] 7. Manifest and F32 contract (R13).
- [ ] 8. Docs: corpus_service README (login), functions/src/d4 README pointer, architecture README DDL order.
- [ ] 9. GREEN runs, mutation (at least 12 mutants), gates, PR body, evidence log.

## RED/GREEN ledger

Filled in from real runs only; the evidence log holds the raw output.

| Suite | Main (RED) | Branch (GREEN) |
|---|---|---|
| fa-d5-003 e2e | | |
| fa-d5-003 grants (pg) | | |
| fa-d5-003 source (unit) | | |
