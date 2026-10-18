# FA-D5-001, FA-D5-002, FA-D2WA-001: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- D5-1 research search takes a query and returns ranked, bounded, scored results.
- WhatsApp `/research <query>` returns them as a numbered list, after the P5 check.
- The live embedding model cannot be switched without confirmation, or away from the stored vectors.

**Spec:** `docs/superpowers/specs/2026-10-18-fa-d5-research-search-design.md` (rulings R1 to R13).

**Base:** `origin/main` 04d388f. **Branch:** `claude/remediate-fa-d5`.

**Constraints:**
- Do not touch `app/api/**`, `corpus_service/**`, or the platform files that PRs #44 and #47 own.
- Synthetic fixtures only, with citations dated 2099.
- Never skip or weaken a test. Every changed expectation is listed in the ledger.

---

### Task 1: Spec and plan
- [x] Write the spec (rulings, residuals, consumer impact) and this plan.
- [x] Commit `docs(FA-D5): research search spec and plan`, then push.

### Task 2: RED tests
**Files:**
- Create `tests/fa-d5.research-search.e2e.test.ts`. It sends the real route, `POST /api/d2/court-ops` `whatsapp_command`, in Firebase session mode with a mocked `verifyIdToken`, for two firms. It covers spec §4 (a) to (e), plus FA-D5-002 through the user path.
- Create `tests/fa-d5.research-search.test.ts`. It covers the service bounds, the hostile query classes, ranking and blending, treatment, and the FA-D5-002 unit cases.

**Steps:**
- [x] Run both files against main's code. **Expected: FAIL.**
  - E2E: `/research` returns `[]` whatever the corpus holds. Hostile queries return 200, not 400. The unconfirmed model switch succeeds.
  - Service: the query object is refused as a model mismatch, because main takes a model string. The model switch never refuses.
- [x] Save the output as `fa-d5-red-*.log` in the scratchpad, record the counts in the ledger, then commit the tests and push.

### Task 3: The fix
- [x] `services/d5-1/research.ts`:
  - `searchCorpus(store, query)`: validation (R5), the integrity lock (R6), the keyword, semantic and blended ranking (R4), and treatment (R8).
  - `changeEmbeddingModel(store, nextModel, { confirmed })`: R12.
- [x] `services/d2-1/whatsapp.ts`:
  - the `/research` row captures its argument;
  - add `whatsAppCommandArgument`;
  - the handler checks P5, then searches, and returns the numbered list (R7, R9).
- [x] Update the changed expectations:
  - G1-10 in `tests/gate_g1.test.ts`;
  - the 3-float test in `tests/spine.hardening.test.ts`;
  - the G-2 notes in `tests/g2/paths.ts`.
- [x] Run both new files, G-1, G-2 (memory mode), the G-2 surface guard and the WhatsApp grammar tests. **Expected: PASS.**
- [x] Commit `fix(FA-D5-001, FA-D5-002, FA-D2WA-001): ...`, then push.

### Task 4: Verification
- [x] `npm run test:unit` (full).
- [x] `npm run typecheck` and `npm run typecheck:tests`. `functions/src` imports neither changed module (grep); the functions typecheck was run anyway.
- [x] `npm run lint`.
- [x] G-0: `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [x] G-1: `python3 ci_gates/gate_g1.py`.
- [x] G-2: `bash ci_gates/gate_g2.sh` if the Firestore emulator can run here; otherwise the memory-mode suite, with the reason recorded.
- [x] `npm run gate:lockfiles`: it does not exist in package.json (checked), so this is recorded as not applicable.
- [x] Mutation check, on a scratch copy: remove each load-bearing guard in turn and confirm a test fails.
- [x] Claim gate: `ci_gates/check_pr_phase_claims.py` with the PR body. **Expected: PASS.**
- [x] Ledger commit, then push. The PR body goes to the scratchpad; the PR is not opened here.

---

## Ledger

### Commits on `claude/remediate-fa-d5`

| Commit | What it holds |
|---|---|
| cfec299 | Spec and plan |
| 27fb496 | RED tests |
| 0bbfd83 | Fix, changed expectations, spec R5 tightening |
| (this commit) | Ledger |

### Environment

- node v22.22.2, npm 10.9.7.
- `npm ci` and `npm --prefix functions ci` were run privately in the worktree.
- First attempt: the shared checkout's `node_modules` was symlinked in, after `npm ci` hit ENOSPC. It was abandoned when another session's install left that tree missing `@playwright/test`, `@types/pg` and `firebase-functions`, so typechecks failed for environmental reasons.
- Baselines on main: a `git archive` export of origin/main 04d388f, linked to the same private install.

### RED: final test files on main 04d388f

| File | Result on main |
|---|---|
| `tests/fa-d5.research-search.e2e.test.ts` | **13 failed**, 10 passed (23) |
| `tests/fa-d5.research-search.test.ts` | **66 failed**, 1 passed (67) |
| `tests/gate_g1.test.ts` (changed G1-10) | **1 failed**, 9 passed (10) |

**Why the 13 E2E tests fail on main:**
- "expected [] to have a length of 10": the constant `research: []`.
- "expected 0 to be greater than 0".
- "expected 200 to be 400": hostile queries are answered 200.
- "expected [Function] to throw": the unconfirmed model switch succeeds.

**The 10 that pass on main are regression guards:**
- the denied roles get 403;
- the firm and identity spoofs get `FIRM_MISMATCH` and `IDENTITY_MISMATCH`;
- the grammar 400s;
- the P5 audit row is written.

**The service file on main:**
- Every query object is refused as `search refuses: embedding_model mismatch`, because main's signature takes a model string.
- `changeEmbeddingModel` never refuses.
- The one test passing is the metadata-dim lock, which main already enforced.

**G1-10 on main:** the unconfirmed switch did not throw.

### GREEN: branch HEAD

| Run | Result |
|---|---|
| Both new files | **90 passed** (23 + 67) |
| `gate_g1`, `spine.hardening`, `d2-1.whatsapp-commands`, `api.court-ops`, `g2.surface-guard`, `g2.cross-firm` (memory mode), plus both new files | **240 passed**, 8 files |
| Mutation check (scratch export of 0bbfd83, 20 mutants, each removing one guard) | **20 of 20 killed** (see below) |

**The 20 mutants:**
- the P5 check;
- the k upper and lower bounds;
- the length cap;
- the no-terms refusal;
- the top-k slice;
- the score > 0 filter;
- IDF;
- the blend weights;
- the sort;
- digit folding;
- treatment;
- the stored-vector lock;
- the query model, dimension and finite checks;
- the switch's confirmation, re-embed guard and id validation;
- the handler ignoring the query.

### Changed expectations

- **`tests/gate_g1.test.ts` G1-10:**
  - The in-app switch now refuses while embeddings exist (asserted).
  - The out-of-band `corpus_metadata` change is set directly.
  - The seed is a judgment with a non-zero vector.
  - The final search is a vector query that asserts the one hit.
- **`tests/spine.hardening.test.ts`:** the 3-float row test calls the new signature; it still expects `/refuses/`.
- **`tests/g2/paths.ts`:** two notes only; no attack changed.

### Gates and checks at 0bbfd83

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run typecheck:tests` | exit 0 |
| `npm --prefix functions run typecheck` | exit 0 |
| `npm run lint` | 0 errors, 89 warnings (see note 1) |
| G-0, `BASE=origin/main bash ci_gates/gate_g0.sh` | PASSED (static), 42 PASS lines |
| G-1, `python3 ci_gates/gate_g1.py` | 10 of 10 |
| `npm run test:unit`, second run, alone on HEAD | 5705 passed, **1 failed**, 54 skipped, 197 files (see note 2) |
| `npm run test:unit`, first run, concurrent with typecheck, lint, G-0, G-1 and the main RED runs | 5703 passed, **3 failed** (see note 3) |
| `tests/f15-r4-bounds.test.ts` and `tests/citations.time-budget.test.ts` alone | 65 of 65 on the branch; 65 of 65 on main |
| G-2 emulator gate, `bash ci_gates/gate_g2.sh` (Auth and Firestore emulators, Java 21) | **FAIL, identically on main** (see note 4) |
| `npm run gate:lockfiles` | Not applicable: no such script in package.json at 04d388f (the gate scripts are g0, f17-eval-record, g1, g2, and g4:*) |
| Claim gate, `ci_gates/check_pr_phase_claims.py` | PASS (run on the final head) |

**Notes:**

1. Lint: the 89 warnings are the same count as main, and none is in a changed file.
2. The second unit run's one failure is the wall-clock bound in `tests/f15-r4-bounds.test.ts` ("Urdu باشندہ, repeated"): 1506.6 ms against 1500 ms. Other sessions were running on the same machine at the time.
3. The first unit run's three failures are the SEC-1 wall-clock budget in `tests/citations.time-budget.test.ts`, at 3031 to 3921 ms against 3000 ms. The same tests take about 1.4 to 1.9 s alone.
4. G-2, in detail:
   - **Branch, two runs:** the Next suite passes 138 of 138 in memory and Firestore persistence. `/research` was tested in both modes, with 12 attempts and 0 allowed. Totals: 174 tested, 0 allowed.
   - **What fails:** `functions/test/g2.cross-firm.test.ts` times out in this sandbox: the Firestore-rules `beforeAll` hook at 10 s, and the P5 HTTP api test at 15 s.
   - **Main export:** the same two timeouts. The Next suite passes 138 of 138, with 161 tested and 0 allowed.
   - **Why the totals differ:** only in the `http` rows (52 vs 39), which the functions suite records route by route before it times out. The web and WhatsApp rows are identical (116 + 6).
   - The branch changes nothing under `functions/`, `firestore.rules` or `firebase.json`.
   - **Result:** the gate is environmental and pre-existing here. CI's G-2 run is the gate of record.

The timing failures in notes 2 and 3 do not touch `services/d5-1` or `services/d2-1`: the branch changes nothing under `services/d4-2` or `platform`. They are reported by name, not skipped.

### Decisions recorded while executing

- **The E2E seeds firm A through the frozen Next D1 write path, as G-2 does.** It turns `SIKANDER_FLAG_LEGACY_D1_NEXT_WRITES` on for the seed only. The research requests then run with the production default (off).
- **The length cap is counted in code points, before folding (spec R5, corrected).** That way an over-long input is refused before any folding work.
- **The IDF test asserts a strict score gap.** Without it, a mutant with no IDF would survive on the specificity tie-break.
