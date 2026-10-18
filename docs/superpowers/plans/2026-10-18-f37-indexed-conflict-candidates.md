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
