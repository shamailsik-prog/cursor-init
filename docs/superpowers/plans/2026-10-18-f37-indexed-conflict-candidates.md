# F37: indexed conflict candidates: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a conflict screen (runConflictCheck, and openMatter's re-screen) reads O(keys + candidates) documents plus one packed name-index read per ~20,000 distinct names, never the whole registry, with exactly the hits of the old full scan, failing closed when the index cannot be trusted.

**Spec:** `docs/superpowers/specs/2026-10-18-f37-indexed-conflict-candidates-design.md` (rulings 1 to 13).

**Base:** `origin/main` 7364b2b. **Branch:** `claude/remediate-f37`.

**Constraints:**
- Lane: `functions/src/d1/conflict/*`, `functions/src/d1/matter/ops.ts`, the projection writers in `functions/src/d1/*`, `firestore.indexes.json`, `firestore.rules`, their tests; the P2 registration points (ruling 10).
- Do not touch `app/api/**`, the #44/#47 platform files, `corpus_service/**`, `.gitleaks.toml`, `functions/src/d1/entity/autoConfirmJob.ts` (F38).
- Synthetic data only. Never skip or weaken a test; every changed expectation is listed in the ledger.
- Emulator runs use a scratch `firebase.json` with private ports (firestore 8197, auth 9197, ui off).

---

### Task 1: RED e2e and spec
- [x] `functions/test/readCounter.ts` (counting wrapper) and `functions/test/f37-conflict-reads.e2e.emu.test.ts` (real flow, N = 500 and 2,000).
- [x] Run against main's src. **Expected: FAIL** (reads linear in N). Record counts (ledger RED 1).
- [x] Spec and this plan. Commit `docs(F37): ...` with the RED test, push.

### Task 2: engine refactor (no behaviour change)
- [x] `match.ts`: extract `nameScore`; `screen` calls it.
- [x] `engine.ts`: extract `buildRegistry(rows, now)`, `firmMapOf`, `linkRowsOf`; `loadRegistry` = reads + `buildRegistry`.
- [x] Existing d1 unit and emulator suites stay green.

### Task 3: the projection
- [x] `registryVersion.ts`: `RegistryState`, `readRegistryState(Tx)`, `bumpRegistryVersion(tx, firmId, patch?)` mirrors `nameIndex.version`; `PROJECTION_SCOPE`.
- [x] `conflict/nameIndex.ts`: schema, chunk refs, freshness, chunk reading and validation, placement, `stageRegistryWrite`, `reconcileNameIndex`.
- [x] Writers: `registerClient`, `openMatter`.
- [x] Unit tests (placement, freshness).

### Task 4: the indexed loader and its callers
- [x] `conflict/candidates.ts`: `loadScreeningRegistry`.
- [x] `conflict/screening.ts`: 503 `screening_unavailable` + reindex enqueue.
- [x] `conflict/ops.ts`, `matter/ops.ts` use it; openMatter's version comes from the loader.

### Task 5: the reconciliation job
- [x] `conflict/reindexJob.ts`; register in `p2/registry.ts`; schedule in `p2/scheduled.ts`; export `d1ConflictReindexTick` in `p2/functions.ts` and `index.ts`; README.
- [x] Update the enumerating tests (ledger "changed expectations").

### Task 6: rules, indexes, recorder
- [x] `firestore.rules` server-only block; `tests/firestore.rules.d1-phase2a.test.ts` SERVER_ONLY list.
- [x] `firestore.indexes.json` composites and the `names` exemption.
- [x] Recorder: `conflict_name_index` writes need a bump; `no_name_index` rule.

### Task 7: GREEN tests
- [x] e2e reads GREEN.
- [x] Differential recall (300 random registries) and writer-path differential.
- [x] Fail closed, race, cross-firm, read-set pin.
- [x] Fix existing tests that seeded registry rows out of band and expect name hits (reconcile after seeding; ledger).

### Task 8: verification and PR body
- [x] `npm ci`, `npm --prefix functions ci`; functions typecheck, lint, unit; d1/conflict/matter/entity/registry emulator suites; G-2; `test:rules`; root `test:unit` + typechecks if touched; `BASE=origin/main bash ci_gates/gate_g0.sh`; claim gate.
- [x] PR body in the scratchpad.

---

## RED/GREEN ledger

Emulator runs use a scratch `firebase.json` with private ports (firestore 8197, auth 9197, hub 4497, logging 4597, ui off), `firebase emulators:exec --config <scratch> --only auth,firestore --project demo-sikander "cd functions && npx vitest run <files>"`. Reads are counted by `functions/test/readCounter.ts` (a counting wrapper around the Admin client: a query counts max(1, documents returned), `getAll` and `get` one per reference). "main's src" is an export of `origin/main` functions (unchanged since 7364b2b) with only the new test files added.

| Step | Command | Result |
| --- | --- | --- |
| RED 1 | `vitest run test/f37-conflict-reads.e2e.emu.test.ts` on main's src | FAIL. openMatter reads 1,519 at N=500 (1,500 rows) and 6,019 at N=2,000 (6,000 rows); runConflictCheck 1,514 and 6,014. `expected 6019 to be less than or equal to 150`. |
| GREEN 1 | same file on the branch | PASS. runConflictCheck 23 and openMatter 27 reads at both N = 500 and N = 2,000 (flat). |
| RED 2 | the K-candidates case (K = 40 clients the name rule matches, each with a matter) on main's src | FAIL. runConflictCheck 1,634 (N=500) and 6,134 (N=2,000) at K=40, 40 hits; `expected 4500 to be less than or equal to 2` (not flat in N). |
| GREEN 2 | same case on the branch | PASS. 144 reads at both N (K=0: 23); 40 of 40 candidates hit; the 121 added reads are clients 40, matters 39, entity links 2, the caller's matter memberships for the disclosed hits 40 (bound 3K + 3⌈K/30⌉ + 2 = 128). |
| GREEN 3 | `vitest run test/f37-conflict-recall.emu.test.ts` | PASS 3/3. Part 1: 300 random registries, 900 subject sets, 7,749 hits (5,122 non-NONE; 2,946 by key, 4,803 by name, 629 name hits sharing no token, 4,201 involving Urdu script, 25 relying on links, 2,399 with unresolved links), 0 mismatches against the full-scan oracle. Teeth: a name removed from a current index loses exactly its hits. Part 2 (real writers, no reconciliation): 36 subject sets equal (180 to 183 name hits per run; document ids are random). |
| GREEN 4 | `vitest run test/f37-screening-guards.emu.test.ts` | PASS 11/11: missing, stale, other-schema and corrupt indexes answer 503 `screening_unavailable` with nothing written and one reindex job; the job (real P2 worker) heals; a racing fuzzy-match registration gives 409 `check_stale`; cross-firm names, keys, entity ids and chunks unused; the loader's read set pinned. |
| GREEN 5 | `vitest run test/f37-name-index.test.ts test/p2.registry-discipline.emu.test.ts` | PASS 5/5 and 8/8. |
| RED 3 (found in verification) | full functions suite, run 2 | 4 `p2.jobs-scheduled` tests timed out (15 s) after the recall file. Cause: recall leaves ~300 to 390 `firms` docs; the scheduled tick is O(firms). Reproduced in one emulator: first test 0.5 s fresh, 10.9 s after 380 firm docs (backfill test 0.8 s to 19.0 s). |
| GREEN 6 | recall, then a firm-count probe, then `p2.jobs-scheduled`, one emulator | PASS. 0 recall or writer firm docs left; `p2.jobs-scheduled` 6/6 in 6.4 s (first test 1.2 s). |
| Full suite | the whole functions suite (mirrors `test:emu`), run 3 at e8ad3fb | 84 of 85 files pass; 2,351 tests pass, 0 fail, 6 skipped. The 6 are `p2.jobs-scheduled`, whose `beforeAll` (three firm-doc writes) hit the 10 s hook timeout as the first file on a cold emulator (vitest's results cache ran the previously failed file first). Alone on a fresh emulator at load 15: the same timeout on the branch and on main's src. With a warm emulator, right after recall (GREEN 6): 6/6. |
| RED 4 (PR #80 review, thread 4306418755) | `vitest run test/f37-index-integrity.emu.test.ts` at 8c26094 | FAIL 10/10. 200 instead of 503 (fail open) for a state missing `chunk`, a state missing `bytes`, chunk 0 missing under a state claiming an empty index, an empty counted chunk, and a wrong chunk number (`expected an ApiError, the call succeeded`); 503 but the job dead-lettered instead of rebuilding for chunk 0 missing, a middle chunk missing, names not an array, a non-string name, another firm's chunk (`expected 'dead_lettered' to be 'done'`). |
| GREEN 7 | same file after ruling 13 (strict state, whole-or-nothing chunk reads, self-healing reconciliation) | PASS 10/10: both routes answer 503 and write nothing; the job rebuilds the index; the conflict is then found and the matter opens. Parser unit tests 10/10 (5 new). Guards 11/11, e2e 2/2 (reads unchanged: 23 / 27, K=40 144), d1 conflict, matter, client, decisions and limit 131/131, p2 boot, engine and scheduled 17/17. |
| Typecheck | `npm --prefix functions run typecheck` | Was 6 × TS2322 in `f37-name-index.test.ts` (helper type) at dd0b123; 0 after 2480f14. |

Load note: the machine is shared (4 cores, load average 5 to 26). Wall-clock failures were rerun alone; both runs are in the evidence log.

## Changed test expectations

Intent kept in every case; nothing skipped or weakened.

- `d1.conflict.emu.test.ts`: two tests that seed opposing parties out of band now run `reconcileNameIndex` before the check (the production path for out-of-band rows: the daily reconciliation).
- `d1.matter.emu.test.ts`: the simulated per-round registry write also moves the `nameIndex` mirror, as `bumpRegistryVersion` does for every product writer; a bare version bump is the stale case, covered in `f37-screening-guards`.
- `d1.conflict-limit.emu.test.ts`: the wrapped spy is the candidate loader (`loadScreeningRegistry`), the function the screen now calls.
- `p2.boot`, `p2.engine`, `p2.scheduled`, `p5.identity`, `g2.cross-firm` (`NOT_TENANT_ENDPOINTS`): the new job type, schedule and `d1ConflictReindexTick` export are listed.
- `p2.registry-discipline.emu.test.ts`, `setup/registryWriteRecorder.ts`: new recorder rules for the name index (chunk writes bump; `no_name_index`).
- `tests/firestore.rules.d1-phase2a.test.ts`: `conflict_name_index` joins `SERVER_ONLY`.
- `f37-screening-guards.emu.test.ts` (PR #80 review): the corrupt-index case expected the job to fail permanently with `name_index_corrupt`; it now expects the job to rebuild the index and the check to succeed (ruling 13). The reconciliation result gains `rebuilt`, and the job's only error code is `reconcile_contended`.

---

## Follow-up: the re-audit at 2b6ef08 (FAIL 6.5/10)

**Spec:** rulings 14 to 18, and the generation in ruling 16. **Base:** `origin/main` 957fe26; `origin/main` c02ebbc (F38 #84) merged in as 5a2325c. **Branch:** `claude/remediate-f37-fu`.

**Findings:** FA-D1C-001 (MEDIUM, a lowered pointer read as complete), FA-D1C-002 (MEDIUM, out-of-band writes missed by name; ruled fixed, not a residual), FA-D1C-003 (LOW, a heal between the counter and chunk reads), FA-D1C-004 (LOW, a name removed inside a chunk), FA-D1C-005 (LOW, the recorder checked creates only), FA-D1C-006 (LOW, six surviving mutants; INFO, no query concurrency cap). One more was found in review here: a row's stamp could outlive the rebuild that dropped its name (fixed with the index generation).

### Tasks

- [x] RED through the real routes on main: `functions/test/f37-fu-reaudit.emu.test.ts` (001 to 004 and the controls) and the FA-D1C-005 cases in `p2.registry-discipline.emu.test.ts` (adf59fd).
- [x] Fix (76193db): every chunk of the firm read with the counter in one read-only transaction (001, 003); row stamps and the three registry triggers that break the index (002, 004); the recorder checks every screened name a product write sets (005); `inLists` and `QUERY_CONCURRENCY` (006).
- [x] Survivor tests: `f37-fu-gaps.emu.test.ts` (M18, M19, N08, N09, N10), unit tests for M05 and the cap.
- [x] Mutation run on the change; X02 and X06 survived and got tests (d14eba1).
- [x] The real trigger delivery through the Functions emulator, with its latency (`f37-fu-trigger-pipeline.emu.test.ts`; bd22965, 4fb44fd).
- [x] The stale stamp: RED 538a848, fix dec20e6 (`nameIndexGen`), mutants X12 to X18.
- [x] Merge `origin/main` c02ebbc (5a2325c).
- [x] Spec rulings 14 to 18, the P2 README, this ledger, the PR body.

### Recipes

- Emulator suites: a scratch `firebase.json` with firestore 8497, auth 9497, hub 4987, logging 4999, ui off; `firebase emulators:exec --config <scratch> --only auth,firestore --project demo-sikander "cd functions && CI=true npx vitest run --no-cache <files>"`. Parallel reruns used a second set of probed free ports.
- Trigger pipeline: `npm --prefix functions run build`, then a scratch config that adds a functions emulator port and `"functions": {"source": "<path to functions, relative to the config file's directory>"}` (an absolute source loses its leading slash), and `firebase emulators:exec --config <scratch> --only auth,firestore,functions --project demo-sikander "cd functions && F37_TRIGGER_PIPELINE=1 npx vitest run --no-cache test/f37-fu-trigger-pipeline.emu.test.ts"`. On main the same recipe runs main's `functions/lib`.
- Main trees: `git archive` exports of `origin/main` with the branch's test files copied in and `node_modules` symlinked.

### RED/GREEN ledger (follow-up)

| Finding | Command (files under `functions/test/`) | main 957fe26 | branch |
| --- | --- | --- | --- |
| FA-D1C-001 | `f37-fu-reaudit.emu.test.ts`: pointer lowered 1→0; lowered 2→0 with chunk 1 deleted; a chunk beyond the pointer | 3/3 FAIL, "expected an ApiError, the call succeeded" (the screen answered) | 3/3 PASS: both routes 503, nothing written, the job rebuilds, then the hit and the matter |
| FA-D1C-002 | same file: O1 rename, O2 client insert, O3 opposing insert, O5 role flip, O6 move between firms (trigger delivered in process) | 5/5 FAIL, same message | 5/5 PASS |
| FA-D1C-002, delivery | `f37-fu-trigger-pipeline.emu.test.ts` through the Functions emulator, 5 out-of-band renames | FAIL: the mirror never breaks; every screen answers CLEAR for 60 s | PASS in 5 runs (25 renames; the last at dec20e6): first 503 0.1 to 26 s after the write, median 1.4 s, the slowest on each run's first event; one more run at load 16 failed only its old 20 s wait |
| Stale stamp (own review) | same reaudit file, `-t 'stale stamps'`: O7 restore after a reset, O8 rename back after a reset, O9 restore after a chunk removal, a post-reset control | at 4fb44fd: O7, O8 FAIL "expected an ApiError, the call succeeded"; on the pre-fix src all 4 FAIL | 4/4 PASS (dec20e6) |
| FA-D1C-003 | same file: the heal race; the reset-and-partial-rebuild race | 2/2 FAIL, `during=CLEAR` | 2/2 PASS, `during=POSSIBLE_CANDIDATE_REVIEW+HIT` |
| FA-D1C-004 | same file: CT2, the conflicting name removed from chunk 0 | FAIL, "expected an ApiError, the call succeeded" | PASS |
| FA-D1C-005 | `p2.registry-discipline.emu.test.ts` | 2 FAIL, "expected [] to deeply equal [ 'clients:no_name_index' ]" (8 pass) | 10/10 |
| FA-D1C-006 | the auditor's survivors M05, M18, M19, N08, N09, N10 against the new tests | survived the shipped suite | 6/6 killed |
| Controls | product writers, closeMatter, a deletion leave the index current | pass (no triggers) | pass |

The main run of the reaudit and discipline files together: 13 failed, 9 passed (22). The branch run of the reaudit, unit and discipline files: 47/47.

Mutation (each mutant one exact edit in an exported tree, its targeted files): the six survivors and the new mutants X01 to X11 on the fix are all killed, each on its intended assertion. X02 (chunks outside the snapshot), X06 (a break that enqueues no reindex) and X11 (verdicts judging unchanged names) survived at first and were killed by the partial-rebuild race test, an assertion that the trigger enqueues the job before any screen, and running the verdict units. The generation mutants X12 to X18 (trigger ignores the generation; break or reset keeps it; either writer stamps 0; a malformed generation accepted; the trigger never reads it) are all killed by O7 to O9, the post-reset control and the generation unit test. Every earlier mutant, re-run on the final source (X03, X05 and X08 re-anchored to the new code), is still killed: 24 of 24.

Read counts (`f37-conflict-reads.e2e.emu.test.ts`): runConflictCheck 23 and openMatter 27 at N = 500 and N = 2,000 (unchanged; the chunk read is one document per chunk through the id-range query). K = 40 candidates: 144 or 145 at both N, 40 of 40 hits; one `matter_parties` read varies from run to run at the same source. The triggers add no request-path reads. Each one reads one counter document when a write sets a new, stamped screened name.

Recall (`f37-conflict-recall.emu.test.ts`, in the full run at dec20e6): Part 1, 300 registries and 900 subject sets, 7,749 hits (4,803 by name, 629 of them sharing no token), 0 mismatches; Part 2 through the real writers, 36 subject sets and 181 name hits, equal.

| Verification at dec20e6 | Result |
| --- | --- |
| Whole functions suite (mirrors `test:emu`, `CI=true`, `--no-cache`) | 89 of 91 files pass, 1 skipped (the trigger pipeline, which needs the Functions emulator); 2,429 tests pass, 1 fails: `d4.gate` "G-1 test 4" at its 15 s limit (18.1 s) |
| G-2 functions part (`G2_GATE=1`) | 7 of 8; the HTTP-api sweep hit its 15 s limit. Run alone with 120 s limits: 8/8 on the branch (18.2 s) and 8/8 on main (20.4 s) |
| Typecheck, `eslint --max-warnings 0 functions`, `gate_g0.sh` | 0 errors, 0 warnings, PASSED |

Load note: the machine ran at load 4 to 20 with other agents. The two time-outs are wall-clock bound on both trees: "G-1 test 4" takes 11 to 21 s alone on the branch and on main, and the G-2 HTTP sweep fails at 15 s on main too. They are not an F37 effect.

### Changed test expectations (follow-up)

Intent kept in every case; nothing skipped or weakened.

- `f37-index-integrity.emu.test.ts`: the two refusals run at one router clock, so they share the firm's single on-demand reindex run (now keyed per PKT minute); still exactly one job.
- `f37-screening-guards.emu.test.ts`: the burst's job id uses `pktMinuteKey` at a fixed clock; the minute key is unit-tested; index contents are read with `readIndexedNames(firmId).names` (the loader no longer returns them).
- `f37-conflict-recall.emu.test.ts`, `f37-conflict-reads.e2e.emu.test.ts`: `readIndexedNames(firmId).names`; the K = 40 case uses distinct names and matches each hit to its own matter (M05).
- `p2.boot`, `p5.identity`, `g2.cross-firm` (`NOT_TENANT_ENDPOINTS`): the three trigger exports, with their region, document path and retry.
- `p2.registry-discipline.emu.test.ts`, `setup/registryWriteRecorder.ts`: stamped creates carry `{ firmId, name, gen }`; two new cases; the F37 describes delete their firm's documents.
- `f37-name-index.test.ts`: the verdict takes the current generation.
