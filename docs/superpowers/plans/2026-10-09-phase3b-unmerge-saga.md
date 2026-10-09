# Phase 3b Un-merge Saga Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `unmergeEntity` (partner) reverses a human-confirmed entity pair through two saga jobs on the 3a engine: the pair reads as unresolved at once, links reopen as disputed, relying conflict checks go stale, `entity.unmerged` is emitted once.

**Architecture:** One route in `functions/src/d1/entity/unmerge.ts` that writes the revert record and enqueues two `saga: true` jobs in its own transaction; handlers in `unmergeJobs.ts` do fenced steps and the last one completes the saga atomically; the read-time link state `unmerging` in `linkState.ts` carries "in progress".

**Spec:** `docs/superpowers/specs/2026-10-09-phase3b-unmerge-saga-design.md` (P3-24..P3-33). Conventions: the 2b-A and 3a plans. Architecture: L17.2 (L6939), L18 §7.5 (L8411-8414).

## Global Constraints

- Partner only; 404 for a missing, other-firm or above-clearance pair (P2-34); layer gate 404 `feature_disabled`.
- Jobs: `saga: true`, key `${mergeEventId}:${collection}`, payload ids only; no payload value in any row, error, log or event.
- Every write to `entity_links` bumps the registry version in its own transaction (the P3-20 recorder enforces it).
- No new dependency; no rules or index change; no Next.js or `platform/persistence` change; no edit of `docs/LEGAL_OS_PHASE_VERIFICATION.md` or `docs/audits/*`.
- Commit messages end with the session's `Co-Authored-By` line.

## Tasks

- [x] **Task 1: link state.** `unmerging` in `EffectiveLinkState`, `isUnmergeInProgress`; unit rows in `d1.linkState.test.ts`.
- [x] **Task 2: permission.** `entity.unmerge` (partner) in `permissionDecision.ts`; matrix row in `tests/p5.permission-d1-actions.test.ts`.
- [x] **Task 3: decisions and queue honour "in progress".** `runDecision` 409 `unmerge_in_progress`; queue hides the pair; `unmerging` first in the pair precedence.
- [x] **Task 4: saga jobs.** `unmergeJobs.ts` (two handlers, `completeCollection`, `checkReliesOn`); registered in `p2/registry.ts`.
- [x] **Task 5: the route.** `unmerge.ts` and the router entry; boot, http and G-2 lists; G-2 probe.
- [x] **Task 6: emulator tests.** `d1.entity-unmerge.emu.test.ts` (eight tests, see spec §6).
- [x] **Task 7: gate.** `gate_g4_phase3b.sh`, `npm run gate:g4:phase3b`; the 2b-A and 3a gate route counts 20 to 21.
- [ ] **Task 7b: CI step (blocked for the autopilot).** Add `npm run gate:g4:phase3b` after the 3a step in `.github/workflows/gate-g0.yml`; the push was refused for lack of `workflows` permission.
- [x] **Task 8: records.** Spec, this plan, the rulings file, E-43 and O-46..O-48.
- [ ] **Remaining (not in 3b):** O-28 auto-confirm job (3c); O-46 `openMatter` guard on in-progress links; O-47 indexed relying-check lookup; O-48 stuck-saga visibility; a test with more than 200 relying checks (chunk path beyond one step).
