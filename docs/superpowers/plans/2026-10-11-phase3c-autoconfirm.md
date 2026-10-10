# Phase 3c Implementation Plan (auto-confirm materialisation, O-28)

**Goal:** a daily P2 job writes the `merge_events` row and confirms the rows of every 30-day-old undisputed candidate pair.

**Spec:** `docs/superpowers/specs/2026-10-11-phase3c-autoconfirm-design.md` (P3-42 to P3-50).

**Tech:** TypeScript Cloud Functions, Firestore Admin SDK, vitest under the Auth and Firestore emulators.

## Review focus

1. The in-transaction re-check must use `effectiveLinkState` on every row, so a dispute that lands after the query but before the step is never overwritten.
2. All reads of a step precede its writes; the registry bump is staged only when something is written.
3. The merge event must be accepted by `unmergeEntity` unchanged.

## Tasks

- [x] Task 1: failing emulator tests `functions/test/d1.entity-autoconfirm.emu.test.ts`, then `functions/src/d1/entity/autoConfirmJob.ts` (handler, constants); `snapOf` exported from `d1/entity/ops.ts`.
- [x] Task 2: register the handler (`p2/registry.ts`), the schedule (`p2/scheduled.ts`), the deployed tick `d1AutoConfirmTick` (`p2/functions.ts`, `index.ts`); update the boot, engine and scheduled tests.
- [x] Task 3: gate `ci_gates/gate_g4_phase3c.sh`, `npm run gate:g4:phase3c`. The `gate-g0.yml` step is NOT in this PR (token lacks `workflows` permission): add after the Phase 3b step `- name: Gate G-4 Phase 3c` `run: npm run gate:g4:phase3c`.
- [x] Task 4: rulings P3-42..P3-50 in the rulings file; erratum E-45; O-28 closed; `p2/README.md` note.
- [ ] Remaining (not in 3c): O-43 tick retry, O-47, O-48, O-29, 2b-B probabilistic `resolveEntity`.
