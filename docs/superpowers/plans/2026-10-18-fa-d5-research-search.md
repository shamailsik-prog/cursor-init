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
- [ ] Run both files against main's code. **Expected: FAIL.**
  - E2E: `/research` returns `[]` whatever the corpus holds. Hostile queries return 200, not 400. The unconfirmed model switch succeeds.
  - Service: the query object is refused as a model mismatch, because main takes a model string. The model switch never refuses.
- [ ] Save the output as `fa-d5-red-*.log` in the scratchpad, record the counts in the ledger, then commit the tests and push.

### Task 3: The fix
- [ ] `services/d5-1/research.ts`:
  - `searchCorpus(store, query)`: validation (R5), the integrity lock (R6), the keyword, semantic and blended ranking (R4), and treatment (R8).
  - `changeEmbeddingModel(store, nextModel, { confirmed })`: R12.
- [ ] `services/d2-1/whatsapp.ts`:
  - the `/research` row captures its argument;
  - add `whatsAppCommandArgument`;
  - the handler checks P5, then searches, and returns the numbered list (R7, R9).
- [ ] Update the changed expectations:
  - G1-10 in `tests/gate_g1.test.ts`;
  - the 3-float test in `tests/spine.hardening.test.ts`;
  - the G-2 notes in `tests/g2/paths.ts`.
- [ ] Run both new files, G-1, G-2 (memory mode), the G-2 surface guard and the WhatsApp grammar tests. **Expected: PASS.**
- [ ] Commit `fix(FA-D5-001, FA-D5-002, FA-D2WA-001): ...`, then push.

### Task 4: Verification
- [ ] `npm run test:unit` (full).
- [ ] `npm run typecheck` and `npm run typecheck:tests`. The functions typecheck is not applicable: `functions/src` imports neither changed module (grep).
- [ ] `npm run lint`.
- [ ] G-0: `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [ ] G-1: `python3 ci_gates/gate_g1.py`.
- [ ] G-2: `bash ci_gates/gate_g2.sh` if the Firestore emulator can run here; otherwise the memory-mode suite, with the reason recorded.
- [ ] `npm run gate:lockfiles`: it does not exist in package.json (checked), so this is recorded as not applicable.
- [ ] Mutation check, on a scratch copy: remove each load-bearing guard in turn and confirm a test fails.
- [ ] Claim gate: `ci_gates/check_pr_phase_claims.py` with the PR body. **Expected: PASS.**
- [ ] Ledger commit, then push. The PR body goes to the scratchpad; the PR is not opened here.

---

## Ledger

(filled in as the tasks run)
