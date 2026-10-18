# F37: indexed conflict candidates: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a conflict screen (runConflictCheck, and openMatter's re-screen) reads O(keys + candidates) documents plus one packed name-index read per ~20,000 distinct names, never the whole registry, with exactly the hits of the old full scan, failing closed when the index cannot be trusted.

**Spec:** `docs/superpowers/specs/2026-10-18-f37-indexed-conflict-candidates-design.md` (rulings 1 to 12).

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
- [ ] `match.ts`: extract `nameScore`; `screen` calls it.
- [ ] `engine.ts`: extract `buildRegistry(rows, now)`, `firmMapOf`, `linkRowsOf`; `loadRegistry` = reads + `buildRegistry`.
- [ ] Existing d1 unit and emulator suites stay green.

### Task 3: the projection
- [ ] `registryVersion.ts`: `RegistryState`, `readRegistryState(Tx)`, `bumpRegistryVersion(tx, firmId, patch?)` mirrors `nameIndex.version`; `PROJECTION_SCOPE`.
- [ ] `conflict/nameIndex.ts`: schema, chunk refs, freshness, chunk reading and validation, placement, `stageRegistryWrite`, `reconcileNameIndex`.
- [ ] Writers: `registerClient`, `openMatter`.
- [ ] Unit tests (placement, freshness).

### Task 4: the indexed loader and its callers
- [ ] `conflict/candidates.ts`: `loadScreeningRegistry`.
- [ ] `conflict/screening.ts`: 503 `screening_unavailable` + reindex enqueue.
- [ ] `conflict/ops.ts`, `matter/ops.ts` use it; openMatter's version comes from the loader.

### Task 5: the reconciliation job
- [ ] `conflict/reindexJob.ts`; register in `p2/registry.ts`; schedule in `p2/scheduled.ts`; export `d1ConflictReindexTick` in `p2/functions.ts` and `index.ts`; README.
- [ ] Update the enumerating tests (ledger "changed expectations").

### Task 6: rules, indexes, recorder
- [ ] `firestore.rules` server-only block; `tests/firestore.rules.d1-phase2a.test.ts` SERVER_ONLY list.
- [ ] `firestore.indexes.json` composites and the `names` exemption.
- [ ] Recorder: `conflict_name_index` writes need a bump; `no_name_index` rule.

### Task 7: GREEN tests
- [ ] e2e reads GREEN.
- [ ] Differential recall (300 random registries) and writer-path differential.
- [ ] Fail closed, race, cross-firm, read-set pin.
- [ ] Fix existing tests that seeded registry rows out of band and expect name hits (reconcile after seeding; ledger).

### Task 8: verification and PR body
- [ ] `npm ci`, `npm --prefix functions ci`; functions typecheck, lint, unit; d1/conflict/matter/entity/registry emulator suites; G-2; `test:rules`; root `test:unit` + typechecks if touched; `BASE=origin/main bash ci_gates/gate_g0.sh`; claim gate.
- [ ] PR body in the scratchpad.

---

## RED/GREEN ledger

| Step | Command | Result |
| --- | --- | --- |
| RED 1 | `firebase emulators:exec --config <scratch> --only auth,firestore --project demo-sikander "cd functions && npx vitest run test/f37-conflict-reads.e2e.emu.test.ts"` on main's src | FAIL. openMatter reads 1,519 at N=500 (1,500 rows) and 6,019 at N=2,000 (6,000 rows); runConflictCheck 1,514 and 6,014. `expected 6019 to be less than or equal to 150`. |

## Changed test expectations

(filled as the work lands)
