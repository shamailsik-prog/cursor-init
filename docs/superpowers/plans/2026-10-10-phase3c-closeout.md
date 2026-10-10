# Phase 3c close-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the auto-confirm job's retry, audit, record and flag defects before its first production run, and wire its gate into CI.

**Architecture:** The changes are confined to `functions/src/d1/entity/autoConfirmJob.ts` (positional step ids, per-step flag read, audit row, deterministic event id, `priorState`) and its tests. The CI, gate, claim-gate and docs changes come in a second task.

**Tech Stack:** TypeScript Cloud Functions (`functions/`), Firestore Admin SDK, vitest under the Auth and Firestore emulators.

**Spec:** `docs/superpowers/specs/2026-10-10-phase3c-closeout-design.md` (rulings P3-51 to P3-57).

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

### Task 1: Job fixes and re-check tests (P3-51..P3-56)

**Files:**
- Modify: `functions/src/d1/entity/autoConfirmJob.ts`
- Test: `functions/test/d1.entity-autoconfirm.emu.test.ts`

- [ ] Write failing emulator tests:
  - each re-check case (a)-(d) of P3-56;
  - a retry after committed steps: use a seam that fails the attempt after 3 committed steps, with more than 480 pairs waiting; the retry finishes with no `fenced_step_limit`, and every pair has exactly one merge event across both attempts plus the next day's run;
  - the audit row fields;
  - `priorState: "auto_confirmed"`;
  - the deterministic event id;
  - the flag switched off between two steps (via a seam), after which no later step writes;
  - a failed flag read gives a retryable `flag_read_failed`.
- [ ] Implement.
- [ ] Mutation check: force the re-check to `true` and see each P3-56 test fail; then restore the re-check. `git diff` must show only the intended change.
- [ ] Run `d1.entity*`, `d1.conflict*`, `p2.registry-*` and the full functions emulator suite once, plus typecheck and lint.
- [ ] Commit: `fix(d1): auto-confirm job — positional fenced steps, audit row, priorState, per-step flag (P3-51..P3-56)`.

### Task 2: CI, gate, claim gate and records (P3-57)

**Files:**
- Modify:
  - `.github/workflows/gate-g0.yml`;
  - `ci_gates/gate_g4_phase3c.sh` (the new tests by exact name, count raised);
  - `ci_gates/check_pr_phase_claims.py` and its test `tests/pr-phase-claim-gate.test.ts`;
  - `docs/architecture/ERRATUM_SET_2_PROPOSED.md` (E-45 amended; E-46 for this close-out; O-50, O-51);
  - `docs/superpowers/specs/2026-10-11-phase3c-autoconfirm-design.md` (date correction note);
  - `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md`;
  - `functions/src/d1/entity/ops.ts` (stale late-dispute comment).

- [ ] Claim gate: fail when `transport_stub` is false while `transport_stub_present()` is true. Add a failing test first.
- [ ] Add the CI step after Phase 3b.
- [ ] Run `npm run gate:g4:phase3c` locally.
- [ ] Commit: `ci: gate:g4:phase3c in CI; claim gate refuses a false transport_stub; record the Phase 3c close-out (E-46)`.
