# FA-D5-003 R1 follow-up (R1-001 to R1-005): implementation plan

Spec: `docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md` §7 (rulings R19-R36).
Branch `claude/remediate-fa-d5-003-fu` from `origin/main` @ 0d9af65. Test-first: every new test ran on main first (RED),
then on the branch (GREEN). Private resources: Postgres 16 + pgvector 0.6 on 127.0.0.1:55631 (data under
`/tmp/pg-fa-d5-003-fu`, removed at the end); emulators firestore 8597, auth 9597, hub 4697, logging 4797, websocket 8598,
functions 5097, UI off, project `demo-fa-d5-003-fu`.

## Tasks

- [x] 1. Spec §7 and this plan.
- [ ] 2. RED tests, committed before production code:
  - `tests/fa-d5-003.scale.e2e.firestore.test.ts` (25,000+ judgments through the route; latency budget);
  - `tests/fa-d5-003.parity.pg.test.ts` (keyword, vector and blend parity with `rankResearchCorpus`; declassify);
  - R1-002 in `tests/fa-d5-003.research-corpus.e2e.firestore.test.ts`;
  - R1-003 and R1-004 in `tests/fa-d5-003.corpus-grants.pg.test.ts` and `functions/test/d4.corpus-authority.pg.test.ts`;
  - `tests/research-terms.golden.test.ts` with `tests/fixtures/corpus/research-terms-golden.json`;
  - `corpus_service/tests/test_research_terms.py`, and F19 index tests in `corpus_service/tests/test_f19_publication_db.py`.
- [ ] 3. Migration 006 (R20) and its harness wiring (`apply-annex-a.sh`, provisioning, conftest, F05 harness, CI DDL
  loops, e2e scripts, inventory counts).
- [ ] 4. `services/d5-1/researchTerms.ts` (R22, R23) and the Python fold `research_terms.py`; the golden generator.
- [ ] 5. F19: `publish_batch` indexes what it writes; `cli index-terms` (R21).
- [ ] 6. `services/d5-1/research.ts`: `stats`, async verdicts, the R1-002 check (R30), the seam (R34).
- [ ] 7. `platform/corpus/pgResearchCorpus.ts`: candidates (R24, R25), top-k treatments (R26), bounds (R27), the lock
  (R29), the allowlist (R31); F05's allowlist (R31).
- [ ] 8. E-52 (R33); README and runbook (the `index-terms` step).
- [ ] 9. GREEN runs, mutation (12+ mutants), gates, PR body, evidence log.

## RED/GREEN ledger

Filled as the runs happen (exact counts in the evidence log).

| Test | Main (RED) | Branch (GREEN) |
|---|---|---|
