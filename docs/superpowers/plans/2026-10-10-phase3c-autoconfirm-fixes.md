# Phase 3c auto-confirm fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the auto-confirm job's retry, audit, record and flag defects before its first production run, and keep its gate in CI.

**Architecture:** The changes are confined to `functions/src/d1/entity/autoConfirmJob.ts` (positional step ids, per-step flag read, audit row, deterministic event id, `priorState`) and its tests. The CI, gate, claim-gate and docs changes come in a second task.

**Tech Stack:** TypeScript Cloud Functions (`functions/`), Firestore Admin SDK, vitest under the Auth and Firestore emulators.

**Spec:** `docs/superpowers/specs/2026-10-10-phase3c-autoconfirm-fixes-design.md` (rulings P3-53 to P3-59).

Separate from #19's Phase 3c close-out (`docs/superpowers/plans/2026-10-11-phase3c-closeout.md`: P3-51, P3-52, E-46). This plan's rulings were renumbered after #19 landed. The commits made before the renumbering (`9ac02f5`, `3f477b8`, `1342fa1`) cite the old numbers: P3-51..P3-57 and E-46.

## Global Constraints

- Step id is `autoconfirm-${n}`, where n is the chunk index within the attempt.
- `AUTO_CONFIRM_MAX_STEPS = MAX_FENCED_STEPS - 2`.
- Merge event id is `"auto_" + sha256(firmId + "\0" + pairId + "\0" + sortedLinkIds.join(",")).slice(0, 32)`, written with `tx.create`.
- The audit row is `{ actorId: "system", onBehalfOf: "system", action: "entity.confirm", target: "merge_events/<id>", decision: "allow", reason: "auto_confirm", classification: pair.label }`.
- `priorState: "auto_confirmed"`.
- A failed flag read throws `JobError("flag_read_failed")`, which is retryable.
- Functions lint passes at zero warnings, and `npx tsc --noEmit -p functions` is clean. Emulator tests run with `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- <files>"`.
- Never weaken or skip an existing test. An assertion that pins `priorState: "candidate"` changes to `"auto_confirmed"`, and the commit says so.

## Review Focus

1. A retry after committed steps must never reach `fenced_step_limit`, and must never confirm a pair twice.
2. Each of the four re-check cases must be admitted by the scan and rejected only by the transaction. Prove it by mutation: with the re-check forced to `true`, each case's test fails.
3. A flag switched off between steps stops all later writes.
4. The audit row and the merge event must be in the same transaction as the link writes.

---

### Task 1: Job fixes and re-check tests (P3-53..P3-58)

**Files:**
- Modify: `functions/src/d1/entity/autoConfirmJob.ts`
- Test: `functions/test/d1.entity-autoconfirm.emu.test.ts`

- [ ] Write failing emulator tests:
  - each re-check case (a)-(d) of P3-58;
  - a retry after committed steps: use a seam that fails the attempt after 3 committed steps, with more than 480 pairs waiting; the retry finishes with no `fenced_step_limit`, and every pair has exactly one merge event across both attempts plus the next day's run;
  - the audit row fields;
  - `priorState: "auto_confirmed"`;
  - the deterministic event id;
  - the flag switched off between two steps (via a seam), after which no later step writes;
  - a failed flag read gives a retryable `flag_read_failed`.
- [ ] Implement.
- [ ] Mutation check: force the re-check to `true` and see each P3-58 test fail; then restore the re-check. `git diff` must show only the intended change.
- [ ] Run `d1.entity*`, `d1.conflict*`, `p2.registry-*` and the full functions emulator suite once, plus typecheck and lint.
- [ ] Commit: `fix(d1): auto-confirm job — positional fenced steps, audit row, priorState, per-step flag (P3-53..P3-58)`.

### Task 2: CI, gate, claim gate and records (P3-59)

**Files:**
- Modify:
  - `.github/workflows/gate-g0.yml`;
  - `ci_gates/gate_g4_phase3c.sh` (the new tests by exact name, count raised);
  - `ci_gates/check_pr_phase_claims.py` and its test `tests/pr-phase-claim-gate.test.ts`;
  - `docs/architecture/ERRATUM_SET_2_PROPOSED.md` (E-45 amended; E-47 for these fixes; O-50, O-51);
  - `docs/superpowers/specs/2026-10-11-phase3c-autoconfirm-design.md` (date correction note);
  - `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md`;
  - `functions/src/d1/entity/ops.ts` (stale late-dispute comment).

- [ ] Claim gate: fail when `transport_stub` is false while `transport_stub_present()` is true. Add a failing test first.
- [ ] Add the CI step after Phase 3b. (#20 added the same step to `main` first; the merge keeps #20's step and drops this one.)
- [ ] Run `npm run gate:g4:phase3c` locally.
- [ ] Commit: `ci: gate:g4:phase3c in CI; claim gate refuses a false transport_stub; record the Phase 3c close-out (E-47)`.

### Task 3: Merge `main` (#19, #20), renumber, and the final review's findings

- [x] Merge `origin/main` (no rebase). Keep #20's single Phase 3c CI step, and keep #19's E-46, P3-51, P3-52 and the O-43 closure. Re-apply this branch's rulings as P3-53..P3-59, E-47, and its ledger section as "Phase 3c auto-confirm fixes".
- [x] Rename the spec and plan to `2026-10-10-phase3c-autoconfirm-fixes*`. Renumber the code comments, the test names and the gate's `AUTO_TESTS` to match.
- [x] I1: the claim gate counts only line-anchored flag declarations (`flag: value` or `flag=value` at the start of a line, optionally a list item, or a `| flag | value |` table row) and fails when declarations of one flag conflict. Tests are written first, among them this PR's own body as a fixture.
- [x] I2: the autopilot workflow must declare `transport_stub` true while the filing transport stub markers remain.
- [x] M1: the audit row is written in the step transaction that writes its merge event (E-47(b), P3-54). M2: the `ops.ts` late-dispute comment cites P3-46 and E-45(c). M3: an existing event is skipped and logged, `autoconfirm.event_exists_skip` with `firmId` and `pairId` only (the test is written first), and O-52 is opened. M4: O-50 records the starvation of the scan window. M5: the gate derives its expected count from its name arrays.

