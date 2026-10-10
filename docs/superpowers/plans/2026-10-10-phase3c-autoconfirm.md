# Phase 3c: 30-day auto-confirm materialisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily P2 job per firm writes the merge record for every entity pair that has auto-confirmed after 30 undisputed days (O-28), so every confirmed identity has a merge event and an un-merge path.

**Architecture:** A new job type `d1.entity.autoconfirm` runs on the Phase 3a scheduled primitive (period `day`, 02:20 PKT). It finds undisputed candidate links at least 30 days old, groups them by pair, and confirms each qualifying pair in its own transaction. That transaction writes the same `link_confirmed` merge event as `confirmMerge`, with the actor `system`, from a shared helper. Processing runs in fenced chunks with a deterministic event id.

**Tech Stack:** TypeScript Cloud Functions (`functions/`), Firestore Admin SDK, vitest under the Auth and Firestore emulators.

**Spec:** `docs/superpowers/specs/2026-10-10-phase3c-autoconfirm-design.md` (rulings P3-42 to P3-48).

## Global Constraints

- Job type `d1.entity.autoconfirm`; schedule `{ jobType: "d1.entity.autoconfirm", cron: "20 2 * * *", period: "day" }`; exported function `entityAutoConfirmSchedule`.
- Merge event id `"auto_" + sha256(firmId NUL pairId NUL sortedLinkIds.join(",")).slice(0, 32)`.
- Chunk 50 pairs per `runFenced` step; at most 50 steps (2,500 pairs) per run; output `{ materialised, skipped, more }` plus `skipped: "feature_disabled"` when L17_2 is off.
- Fixed note text: `Auto-confirmed: undisputed for 30 days (L18 §7.1)`.
- Reuse `effectiveLinkState`, `LINK_AUTO_CONFIRM_MS`, `DETERMINISTIC_KEY_SCORE`, `pairIdOf`, the registry-version bump and the 3b fenced-step pattern; restate none of them.
- `functions` lint at zero warnings; `npx tsc --noEmit -p functions` clean.
- Emulator tests: `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- <files>"` from the repo root.
- Never weaken or skip an existing test; an existing assertion that pins `SCHEDULED_JOBS` as empty, or the exact list of job types or exports, may be updated to include the new entry, and the commit says so.

## Review Focus

1. A pair changing between the scan and its transaction (disputed, confirmed by a human, un-merge started, a new row added): the transaction must re-read every row of the pair, not only the scanned ones, and write nothing if the pair no longer qualifies.
2. A pair whose rows straddle the 30-day window, or that mixes a confirmed row with candidate rows: skipped, never partly confirmed.
3. Duplicate delivery, a rerun of the same period and the next day's run: one merge event per pair, ever.
4. An auto-confirmed pair, then un-merged, must never auto-confirm again (it reopens as disputed).
5. L17_2 off for the firm: no write at all.

---

### Task 1: Shared confirmation writer and the auto-confirm job handler (P3-43..P3-46)

**Files:**
- Modify: `functions/src/d1/entity/ops.ts` (extract the shared writer from `confirmMergeOp`; behaviour unchanged)
- Create: `functions/src/d1/entity/autoConfirm.ts` (selection, per-pair transaction, handler)
- Modify: `functions/src/p2/registry.ts` (register the handler)
- Test: `functions/test/d1.entity-autoconfirm.emu.test.ts`; existing `d1.entity*.emu.test.ts` must still pass unchanged

**Interfaces:**
- Produces: `stageLinkConfirmation(tx, pair, actor, opts: { mergeRef, priorState, auto?: { autoConfirmAt } }) => { mergeEventId, linkIds }`, used by both `confirmMergeOp` and the job; `autoConfirmHandler: JobHandler` with jobType `d1.entity.autoconfirm`, `saga: false`; `AUTO_CONFIRM_JOB_TYPE`.

- [ ] Write failing emulator tests:
  - a pair with all rows ≥ 30 days old is materialised: exact merge event fields per P3-44, rows confirmed with `confirmation.auto: true`, one `entity.confirmed` event with `auto: true`, one audit row per P3-46, and the registry version bumped once;
  - skipped with no write: a disputed pair, a pair with a row younger than 30 days, a pair mixing a confirmed and a candidate row, a pair with an un-merge in progress, a firm with L17_2 off (output `skipped: "feature_disabled"`);
  - running the job twice for the same period, and then for the next day, writes one event per pair;
  - a pair disputed between the scan and its transaction is not written (use a test seam before the pair's transaction).
- [ ] Extract the shared writer and run the existing entity suites unchanged; they must pass.
- [ ] Implement the handler with fenced chunks of 50 pairs, the deterministic event id and the 2,500 cap (`more: true`; a test seam may lower the cap, and a unit test pins the real constant).
- [ ] Run `d1.entity*`, `d1.conflict*`, `p2.registry-*` and the full p2 suite; typecheck; lint.
- [ ] Commit: `feat(d1): auto-confirm job materialises 30-day entity links (O-28, P3-42..P3-46)`.

### Task 2: Schedule wiring and the un-merge round trip (P3-42, P3-47)

**Files:**
- Modify: `functions/src/p2/scheduled.ts` (`SCHEDULED_JOBS`), `functions/src/p2/functions.ts` or `functions/src/index.ts` (export `entityAutoConfirmSchedule = scheduledJobFunction(spec)`), `functions/src/p2/README.md` (cron table), `functions/test/g2.cross-firm.test.ts` (`NOT_TENANT_ENDPOINTS`: "scheduler, no caller"), `functions/test/deploy.test.ts` (expected export list includes the new function in asia-south1)
- Test: `functions/test/p2.jobs-scheduled.emu.test.ts`, `functions/test/d1.entity-autoconfirm.emu.test.ts`

- [ ] Failing tests:
  - `SCHEDULED_JOBS` holds exactly the spec entry;
  - the exported function is a schedule in asia-south1 with timezone Asia/Karachi and the cron;
  - `enqueueScheduledRuns` at a given time creates one run per firm with key `d1.entity.autoconfirm:<PKT day>`, and a rerun reuses it;
  - a 3-day backfill creates 3 runs per firm, and a rerun creates none;
  - round trip: materialise a pair, `unmergeEntity` it, deliver both saga jobs, and the pair reads as a disputed candidate; the next day's auto-confirm run writes nothing for it;
  - `getEntity` shows the merge history entry with actor `system`.
- [ ] Implement the wiring.
- [ ] Run the full functions emulator suite once; typecheck; lint.
- [ ] Commit: `feat(p2): schedule the daily entity auto-confirm run (P3-42)`.

### Task 3: Gate, CI and records (P3-48)

**Files:**
- Create: `ci_gates/gate_g4_phase3c.sh`; Modify: `package.json` (`gate:g4:phase3c`), `.github/workflows/gate-g0.yml` (step after Phase 3b), `docs/architecture/ERRATUM_SET_2_PROPOSED.md` (E-45; O-28 closed; O-50 opened), `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md` (Phase 3c rulings)

- [ ] Model the gate on `ci_gates/gate_g4_phase3b.sh`: selection by exact test names, an exact expected count, and the same emulator configuration.
- [ ] Run `npm run gate:g4:phase3c` locally; it must pass.
- [ ] Commit: `ci: gate:g4:phase3c; record Phase 3c rulings and errata (E-45, O-28 closed, O-50)`.
