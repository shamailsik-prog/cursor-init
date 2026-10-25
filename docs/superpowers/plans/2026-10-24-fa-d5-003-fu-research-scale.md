# FA-D5-003 R1 follow-up (R1-001 to R1-005): implementation plan

Spec: `docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md` §7 (rulings R19-R40).
Branch `claude/remediate-fa-d5-003-fu` from `origin/main` @ 0d9af65. Test-first: every new test ran on main first (RED),
then on the branch (GREEN). Private resources: Postgres 16 + pgvector 0.6 on 127.0.0.1:55631 (data under
`/tmp/pg-fa-d5-003-fu`, removed at the end); emulators firestore 8597, auth 9597, hub 4697, logging 4797, websocket 8598,
functions 5097, UI off, project `demo-fa-d5-003-fu`.

## Tasks

- [x] 1. Spec §7 and this plan.
- [x] 2. RED tests, committed before production code:
  - `tests/fa-d5-003.scale.e2e.firestore.test.ts` (25,000+ judgments through the route; latency budget);
  - `tests/fa-d5-003.parity.pg.test.ts` (keyword, vector and blend parity with `rankResearchCorpus`; declassify);
  - R1-002 in `tests/fa-d5-003.research-corpus.e2e.firestore.test.ts`;
  - R1-003 and R1-004 in `tests/fa-d5-003.corpus-grants.pg.test.ts` and `functions/test/d4.corpus-authority.pg.test.ts`;
  - `tests/research-terms.golden.test.ts` with `tests/fixtures/corpus/research-terms-golden.json`;
  - `corpus_service/tests/test_research_terms.py`, and F19 index tests in `corpus_service/tests/test_f19_publication_db.py`.
- [x] 3. Migration 006 (R20, R37) and its harness wiring (`apply-annex-a.sh`, provisioning, conftest, F05 harness, CI DDL
  loops, e2e scripts, inventory counts).
- [x] 4. `services/d5-1/researchTerms.ts` (R22, R23) and the Python fold `research_terms.py`; the golden generator.
- [x] 5. F19: `publish_batch` indexes what it writes; `cli index-terms` (R21).
- [x] 6. `services/d5-1/research.ts`: `stats`, async verdicts, the R1-002 check (R30), the seam (R34).
- [x] 7. `platform/corpus/pgResearchCorpus.ts`: candidates (R24, R25), top-k treatments (R26), bounds (R27), the lock
  (R29), the allowlist (R31); F05's allowlist (R31).
- [x] 8. E-52 (R33); README and runbook (the `index-terms` step).
- [x] 9. GREEN runs, mutation (12+ mutants), gates, PR body, evidence log.
- [x] 10. After merging #128 (F42): 006's seven relations in `infra/retention/inventory.json` (R39; the merged tree
  failed G-0 [22] with exactly these seven), and both FA-D5-003 emulator suites delete their firms in `afterAll` and
  assert nothing is left (R40, with #131's shared `tests/helpers/firm-cleanup.ts` after the merge of 4a12508).
- [x] 11. `corpus_service/README.md`: `index-terms` exits 1, not 4, on a database without 006 (as `cli.py` does); a test
  pins it.

## RED/GREEN ledger

RED: the RED commits (`61b4d3f`, `9c5d62d`) on main's code. GREEN: the branch. Exact output in the evidence log
(`evidence-fa-d5-003-fu.txt`). Tests added during GREEN are marked (G): they guard the design's own invariants and have
no main counterpart (main has no index).

| Finding | Test (file) | Main (RED) | Branch (GREEN) |
|---|---|---|---|
| R1-001 | scale e2e `tests/fa-d5-003.scale.e2e.firestore.test.ts` (3) | 2 failed (answers, latency: 503 `row_cap`), 1 passed (corpus size) | 3/3 |
| R1-001 | parity `tests/fa-d5-003.parity.pg.test.ts` (6 at 61b4d3f, 8 at the head) | 5 failed (keyword 172/172, vector 40/40, blend 40/40 differ: `row_cap`; declassify; k = 50), 1 passed | 8/8 at 50157bf, 0 diffs in 172 + 40 + 40 + 4 + 4 + 5 + 4 + 4 queries |
| R1-001 | (G) parity: hidden citations and citation writes; R4a outside the keyword top k (826c52f, written after M14 survived parity alone) | n/a | in the 8 above |
| R1-001 | `tests/fa-d5-003.corpus-grants.pg.test.ts` (21 RED, 22 GREEN) | 7 failed for R1-001 (relations, views, inventory, index grants, `v_research_term`, read nothing else, bounds) | 22/22 |
| R1-001 | (G) grants: 006 copies 004's rule verbatim | n/a | in the 22 above |
| R1-001 | `tests/fa-d5-003.research-source.test.ts` R19, R23 (32 in file) | 2 failed | 32/32 |
| R1-001 | (G) `corpus_service/tests/test_research_index_db.py` (6), added with the indexer | n/a (main has no 006 and no indexer) | 6/6 |
| R1-001 | `tests/research-terms.golden.test.ts` (3), `corpus_service/tests/test_research_terms.py` (6) | 3/3, 6/6 (fold parity guard, committed with the RED tests) | 3/3, 6/6 |
| R1-002 | `tests/fa-d5-003.research-corpus.e2e.firestore.test.ts` lock test (14 in file) | 1 failed (400, not 503) | 14/14 |
| R1-002 | `tests/fa-d5-003.research-source.test.ts` R1-002 (2) | 2 failed | pass |
| R1-002 | changed expectations in `tests/fa-d5.research-search.e2e.test.ts` (2 of 23: a lock breach is 503, not 400) | 2 failed (400) | pass |
| R1-003 | corpus-grants R1-003 test (1) | 1 failed | pass |
| R1-003 | `functions/test/d4.corpus-authority.pg.test.ts` new shapes (3 of 61) | 3 failed | 61/61; F05 four files 93/93 |
| R1-004 | corpus-grants allowlist shapes, metadata, nocite and followed tests | pass on main code (missing tests); the audit's surviving mutants X08-X11, X13-X15 ported to the branch are killed (mutation table) | pass |
| R1-005 | E-52 | n/a (document) | written |

**Verification after merging origin/main @ 798cf56.** RED: the head's tests, helpers and harnesses on origin/main
798cf56's production code, in this worktree (the eight production files the branch modifies checked out from main; 006
and `research_index.py` removed; the two fold modules kept, as 61b4d3f carried them). Counts: scale e2e 2 failed, 1
passed (3); research-corpus e2e 1 failed, 13 passed (14); parity 7 failed, 1 passed (8; keyword 172/172, vector 40/40,
blend 40/40, declassify 4/4 and R4a outside k 4/4 differ); corpus-grants 9 failed, 13 passed (22: 8 for R1-001, 1 for
R1-003); research-source 4 failed, 28 passed (32); `tests/fa-d5.research-search.e2e.test.ts` 2 failed, 21 passed (23,
the R1-002 changed expectations); F05 `d4.corpus-authority.pg` 3 failed, 58 passed (61); the fold guards (golden 3,
Python 6) pass. The branch then merged origin/main @ 5840d3d (#128) and @ 4a12508 (#131); the final RED (on the last
merged main's code) and GREEN at the final head, and the mutants rerun there, are in the evidence log and the PR body.
